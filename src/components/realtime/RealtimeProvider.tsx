'use client';

/**
 * Client half of the realtime layer.
 *
 * One socket per browser tab, shared through context, so ten components can
 * subscribe without opening ten connections. Authentication rides on the
 * session cookie, which the browser sends to the same origin automatically.
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';

export type RealtimeStatus = 'connecting' | 'online' | 'offline';

interface RealtimeContextValue {
  status: RealtimeStatus;
  socket: Socket | null;
}

const RealtimeContext = createContext<RealtimeContextValue>({ status: 'connecting', socket: null });

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [status, setStatus] = useState<RealtimeStatus>('connecting');

  useEffect(() => {
    const connection = io({
      path: '/realtime',
      withCredentials: true,
      // Start on websocket; fall back automatically if a proxy blocks it.
      transports: ['websocket', 'polling'],
    });

    connection.on('connect', () => setStatus('online'));
    connection.on('disconnect', () => setStatus('offline'));
    connection.on('connect_error', () => setStatus('offline'));

    setSocket(connection);
    return () => {
      connection.close();
    };
  }, []);

  return (
    <RealtimeContext.Provider value={{ status, socket }}>{children}</RealtimeContext.Provider>
  );
}

export function useRealtime(): RealtimeContextValue {
  return useContext(RealtimeContext);
}

/**
 * Subscribes to one realtime event for the lifetime of a component.
 *
 * The handler is held in a ref, so a caller can pass an inline closure without
 * tearing down and rebuilding the socket subscription on every render.
 */
export function useRealtimeEvent<T>(event: string, handler: (payload: T) => void): void {
  const { socket } = useRealtime();
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!socket) {
      return;
    }
    const listener = (payload: T): void => handlerRef.current(payload);
    socket.on(event, listener);
    return () => {
      socket.off(event, listener);
    };
  }, [socket, event]);
}
