import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

type SocketAuth = { token: string } | { lobbyTable: number };

/**
 * Abre una conexión Socket.IO mientras el componente esté montado y haya
 * credenciales. Devuelve el socket y si está en línea (para el indicador
 * "En vivo"). Socket.IO reconecta solo; al volver, cada pantalla recarga su
 * estado para no depender de eventos perdidos.
 */
export function useSocket(auth: SocketAuth | null): { socket: Socket | null; connected: boolean } {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const key = auth ? JSON.stringify(auth) : null;

  useEffect(() => {
    if (!key) return;
    const instance = io({ auth: JSON.parse(key), transports: ['websocket', 'polling'] });
    instance.on('connect', () => setConnected(true));
    instance.on('disconnect', () => setConnected(false));
    setSocket(instance);
    return () => {
      instance.close();
      setSocket(null);
      setConnected(false);
    };
  }, [key]);

  return { socket, connected };
}

/** Suscribe un manejador a un evento; siempre ejecuta la versión más reciente del manejador. */
export function useSocketEvent<T = unknown>(socket: Socket | null, event: string, handler: (payload: T) => void): void {
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(() => {
    if (!socket) return;
    const listener = (payload: T) => latest.current(payload);
    socket.on(event, listener);
    return () => {
      socket.off(event, listener);
    };
  }, [socket, event]);
}

/** Ejecuta `onReconnect` cada vez que el socket vuelve a conectarse (no en la primera conexión). */
export function useReconnect(socket: Socket | null, onReconnect: () => void): void {
  const latest = useRef(onReconnect);
  latest.current = onReconnect;

  useEffect(() => {
    if (!socket) return;
    let first = !socket.connected;
    const listener = () => {
      if (first) {
        first = false;
        return;
      }
      latest.current();
    };
    socket.on('connect', listener);
    return () => {
      socket.off('connect', listener);
    };
  }, [socket]);
}
