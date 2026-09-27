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

let server: SocketServer | null = null;

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

  server = io;
  return io;
}

/** Closes the realtime server, releasing the HTTP listener. */
export async function detachRealtime(): Promise<void> {
  if (server) {
    await server.close();
    server = null;
  }
}

/** True once the realtime layer is live. */
export function isRealtimeReady(): boolean {
  return server !== null;
}

function emit(room: string, event: string, payload: unknown): void {
  server?.to(room).emit(event, payload);
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
