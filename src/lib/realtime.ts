/**
 * Realtime fanout — SRS §3.
 *
 * One Socket.io server riding on the same HTTP server as Next, so the browser
 * needs a single origin, the session cookie is sent automatically, and no
 * separate port has to be proxied.
 *
 * Sockets are authenticated with the same signed cookie as the pages: an
 * unauthenticated socket is closed at the handshake, so a member can never
 * subscribe to the staff room and watch the shop's order stream.
 */
import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer, type Socket } from 'socket.io';

import { touchDisplayDevice, verifyDisplayToken } from './display-devices';
import { REALTIME_EVENTS } from './realtime-events';
import type { Role } from './roles';
import { SESSION_COOKIE_NAME, verifySessionToken } from './session-token';

// Event names live in a dependency-free module so the browser can import them
// without pulling `socket.io` into its bundle. Re-exported here for the server.
export { REALTIME_EVENTS };

export interface OrderEventPayload {
  orderId: string;
  orderNumber: string;
  status: string;
  orderType: string;
  customerName?: string | null;
  finalAmountThb?: number;
  pickupPin?: string | null;
}

export interface StockEventPayload {
  productId: string;
  name: string;
  stockQty: number;
  reservedQty: number;
  availableQty: number;
}

/** Room every member of staff subscribes to. */
const STAFF_ROOM = 'staff';
/** Room only admins subscribe to. */
const ADMIN_ROOM = 'admin';
/**
 * Room every signed-in user subscribes to. Stock availability is visible to
 * customers by design (SRS §2), so it is broadcast here rather than to staff.
 */
const EVERYONE_ROOM = 'everyone';

/**
 * Every paired customer screen.
 *
 * Its own room rather than a slice of `everyone`, because a display holds no
 * session: what may reach it is a whitelist, not "anything a signed-in user is
 * allowed to see". Keeping it separate is what makes that auditable — the only
 * writes to this room are `emitToDisplays` calls.
 */
const DISPLAY_ROOM = 'display';

/**
 * The one socket server, reachable from every module graph in the process.
 *
 * `globalThis` rather than a module-scoped `let`, and that is not a stylistic
 * choice — it is the difference between the feature working and silently not.
 * Next bundles the route handlers into their own module graph, so this file is
 * loaded *twice* in one process: once by `server.ts`, which attaches Socket.io
 * to the HTTP listener, and once inside the bundle that runs `emitToDisplays`.
 * A module-level variable meant the second copy saw `server === null`, so every
 * emit from a route handler was a no-op: the till's cart post answered 200 and
 * the customer screen never changed, with nothing in any log to say why.
 *
 * Kept on `globalThis` for the same reason `db.ts` caches the Prisma client
 * there, and with the same caveat: in dev, module reloading must not open a
 * second server on a listener that is already listening.
 */
const globalForRealtime = globalThis as unknown as {
  __posSocketServer?: SocketServer | null;
};

function currentServer(): SocketServer | null {
  return globalForRealtime.__posSocketServer ?? null;
}

function setServer(server: SocketServer | null): void {
  globalForRealtime.__posSocketServer = server;
}

/** Parses the `Cookie` header into a lookup table. */
function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) {
    return {};
  }
  const jar: Record<string, string> = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    if (key) {
      jar[key] = decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return jar;
}

/** Attaches the realtime server to an existing HTTP server. */
export function attachRealtime(httpServer: HttpServer): SocketServer {
  const io = new SocketServer(httpServer, {
    path: '/realtime',
    // Same origin only: the browser already has the cookie, and nothing else
    // has any business opening a socket to the shop's till.
    cors: { origin: false },
    serveClient: false,
  });

  io.use(async (socket, next) => {
    /*
     * A customer display authenticates with a device token instead of a cookie,
     * because it has no account to hold a session for — see
     * `display-devices.ts`. This is tried first and is the only path that does
     * not end in a user: a screen is a granted reader, not somebody signed in.
     */
    const handshakeToken = (socket.handshake.auth as { displayToken?: unknown } | undefined)
      ?.displayToken;
    if (typeof handshakeToken === 'string' && handshakeToken.length > 0) {
      const device = await verifyDisplayToken(handshakeToken);
      if (!device) {
        next(new Error('UNAUTHENTICATED'));
        return;
      }
      socket.data.display = device;
      next();
      return;
    }

    try {
      const cookies = parseCookies(socket.handshake.headers.cookie);
      const token = cookies[SESSION_COOKIE_NAME];
      if (!token) {
        next(new Error('UNAUTHENTICATED'));
        return;
      }

      const user = await verifySessionToken(token);
      socket.data.user = user;
      next();
    } catch {
      next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const device = socket.data.display as { id: string; label: string } | undefined;
    if (device) {
      void socket.join(DISPLAY_ROOM);
      // The timestamp is what the settings list shows, so it is written on
      // connect rather than on every event: "is this screen alive" is a question
      // about whether it is connected at all.
      void touchDisplayDevice(device.id);
      return;
    }

    const user = socket.data.user as { id: string; role: Role };

    // Every signed-in user gets their own room, so member-specific events such
    // as "your order is ready" need no extra lookup.
    void socket.join(`user:${user.id}`);
    void socket.join(EVERYONE_ROOM);

    if (user.role === 'employee' || user.role === 'admin') {
      void socket.join(STAFF_ROOM);
    }
    if (user.role === 'admin') {
      void socket.join(ADMIN_ROOM);
    }
  });

  setServer(io);
  return io;
}

/** Closes the realtime server, releasing the HTTP listener. */
export async function detachRealtime(): Promise<void> {
  const server = currentServer();
  if (server) {
    await server.close();
    setServer(null);
  }
}

/** True once the realtime layer is live. */
export function isRealtimeReady(): boolean {
  return currentServer() !== null;
}

/**
 * Sends to a room, or does nothing when the realtime layer is not attached yet.
 *
 * Silent on purpose: this is called from request handlers that have already
 * committed their work, and a shop that cannot push a notification must still be
 * able to take the money. The consequence is that a genuinely missing server is
 * invisible here — which is exactly why `isRealtimeReady()` exists, and why the
 * integration suite asserts on the channel rather than on this call.
 */
function emit(room: string, event: string, payload: unknown): void {
  currentServer()?.to(room).emit(event, payload);
}

/** Alerts every signed-in staff member — the Phase 1 pre-order chime. */
export function emitToStaff(event: string, payload: unknown): void {
  emit(STAFF_ROOM, event, payload);
}

/** Alerts admins only. */
export function emitToAdmins(event: string, payload: unknown): void {
  emit(ADMIN_ROOM, event, payload);
}

/**
 * Alerts every signed-in user, staff and customers alike.
 *
 * Live stock availability is a customer-facing feature (SRS §2), so in-store
 * shoppers need the same push the till does.
 */
export function emitToEveryone(event: string, payload: unknown): void {
  emit(EVERYONE_ROOM, event, payload);
}

/** Alerts one specific user, used for "your order is ready" notifications. */
export function emitToUser(userId: string, event: string, payload: unknown): void {
  emit(`user:${userId}`, event, payload);
}

/**
 * To every paired customer screen.
 *
 * A display is unauthenticated by design, so what may travel on this channel is
 * a contract rather than a convention — see `display-view.ts`, which declares the
 * payload shapes and is deliberately the smallest set of facts a screen needs.
 */
export function emitToDisplays(event: string, payload: unknown): void {
  emit(DISPLAY_ROOM, event, payload);
}
