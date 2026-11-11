import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { useSocketEvent } from '../../lib/socket';
import type { Cart, CartChange, CartLine, Guest, Product } from '../../lib/types';

type Ack = { ok: true } | { ok: false; error: { code: string; message: string } };

const EMPTY_CART: Cart = { items: [], totalQuantity: 0, subtotal: 0 };

interface Options {
  /** Otro comensal cambió el carrito ("Cliente #2 agregó Pizza pepperoni"). */
  onRemoteChange?: (change: CartChange) => void;
  onError?: (message: string, code: string) => void;
}

/**
 * Lógica del carrito compartido de la mesa.
 *
 * Fuente de verdad: el servidor. Cada cambio viaja por WebSocket
 * (cart:add / cart:setQuantity) y el servidor responde a TODA la mesa con el
 * carrito completo (cart:updated). Por eso no hay conflictos que resolver en
 * el cliente: gana el orden en que el servidor recibió los cambios, y todos
 * terminan viendo lo mismo.
 *
 * Para que la app se sienta inmediata aunque la red vaya lenta, los cambios
 * propios se pintan al instante (optimistas) y se reemplazan por el estado
 * real cuando llega el siguiente cart:updated.
 */
export function useSharedCart(socket: Socket | null, me: Guest, options: Options = {}) {
  const [cart, setCart] = useState<Cart>(EMPTY_CART);
  const [ready, setReady] = useState(false);
  // Unidades que acabo de agregar y el servidor aún no ha confirmado, por plato.
  const [pendingAdds, setPendingAdds] = useState<Record<string, number>>({});
  const callbacks = useRef(options);
  callbacks.current = options;

  useSocketEvent<{ cart: Cart; change?: CartChange }>(socket, 'cart:updated', ({ cart: next, change }) => {
    setCart(next);
    setPendingAdds({});
    setReady(true);
    if (change && change.by.id !== me.id) callbacks.current.onRemoteChange?.(change);
  });

  // Al conectar (y al reconectar) se pide el carrito actual.
  useEffect(() => {
    if (!socket) return;
    const sync = () => socket.emit('cart:sync');
    if (socket.connected) sync();
    socket.on('connect', sync);
    return () => {
      socket.off('connect', sync);
    };
  }, [socket]);

  const handleAck = useCallback((ack: Ack) => {
    if (ack.ok) return;
    setPendingAdds({});
    socket?.emit('cart:sync'); // deshace el cambio optimista con el estado real
    callbacks.current.onError?.(ack.error.message, ack.error.code);
  }, [socket]);

  const add = useCallback(
    (product: Product, quantity = 1, notes = '') => {
      if (!socket) return;
      setPendingAdds((current) => ({ ...current, [product.id]: (current[product.id] ?? 0) + quantity }));
      socket.emit('cart:add', { productId: product.id, quantity, notes }, handleAck);
    },
    [socket, handleAck],
  );

  const setQuantity = useCallback(
    (line: CartLine, quantity: number) => {
      if (!socket) return;
      setCart((current) => {
        const items = quantity <= 0 ? current.items.filter((i) => i.id !== line.id) : current.items.map((i) => (i.id === line.id ? { ...i, quantity } : i));
        return {
          items,
          totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
          subtotal: items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0),
        };
      });
      socket.emit('cart:setQuantity', { itemId: line.id, quantity }, handleAck);
    },
    [socket, handleAck],
  );

  // Vistas derivadas que usa la interfaz
  const view = useMemo(() => {
    const pendingTotal = Object.values(pendingAdds).reduce((sum, n) => sum + n, 0);

    // Líneas agrupadas por comensal, con las mías primero.
    const groups = new Map<string, { guest: Guest; lines: CartLine[] }>();
    for (const line of cart.items) {
      const group = groups.get(line.guest.id) ?? { guest: line.guest, lines: [] };
      group.lines.push(line);
      groups.set(line.guest.id, group);
    }
    const byGuest = [...groups.values()].sort((a, b) => Number(b.guest.id === me.id) - Number(a.guest.id === me.id));

    return {
      totalQuantity: cart.totalQuantity + pendingTotal,
      byGuest,
      contributors: byGuest.map((group) => group.guest),
      hasUnavailable: cart.items.some((line) => !line.isAvailable),
    };
  }, [cart, pendingAdds, me.id]);

  /** Mi línea "simple" (sin nota) de un plato: la que controla el − / + de la carta. */
  const myLine = useCallback(
    (productId: string) => cart.items.find((line) => line.productId === productId && line.guest.id === me.id && line.notes === '') ?? null,
    [cart, me.id],
  );

  /** Cuántas unidades de un plato llevo yo (incluye lo que aún no confirma el servidor). */
  const myQuantity = useCallback(
    (productId: string) =>
      cart.items.filter((line) => line.productId === productId && line.guest.id === me.id).reduce((sum, line) => sum + line.quantity, 0) +
      (pendingAdds[productId] ?? 0),
    [cart, pendingAdds, me.id],
  );

  /** Quiénes más en la mesa llevan ese plato, para mostrarlo en la carta. */
  const othersWith = useCallback(
    (productId: string) => cart.items.filter((line) => line.productId === productId && line.guest.id !== me.id),
    [cart, me.id],
  );

  return { cart, ready, add, setQuantity, myLine, myQuantity, othersWith, ...view };
}

export type SharedCart = ReturnType<typeof useSharedCart>;
