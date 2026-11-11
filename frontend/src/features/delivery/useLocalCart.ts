import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CartLine, Guest, Product } from '../../lib/types';
import type { MenuCart } from '../customer/parts';

const ME: Guest = { id: 'me', number: 1, alias: 'Tú', color: '#0C3B2E' };
const STORAGE_KEY = 'fo.delivery.cart';

interface StoredLine {
  productId: string;
  name: string;
  unitPrice: number;
  imageUrl: string | null;
  quantity: number;
  notes: string;
}

function load(): StoredLine[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredLine[]) : [];
  } catch {
    return [];
  }
}

/**
 * Carrito personal para domicilios. Misma forma que el carrito compartido de
 * la mesa (así la carta se reutiliza tal cual), pero vive en el navegador y
 * sobrevive a una recarga. Los precios que muestra son orientativos: el
 * backend vuelve a calcular todo con los precios de la base de datos.
 */
export function useLocalCart(available: (productId: string) => boolean) {
  const [lines, setLines] = useState<StoredLine[]>(load);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
    } catch {
      // sin almacenamiento: el carrito dura lo que dure la pestaña
    }
  }, [lines]);

  const items: CartLine[] = useMemo(
    () =>
      lines.map((line) => ({
        id: `${line.productId}|${line.notes}`,
        ...line,
        isAvailable: available(line.productId),
        guest: ME,
      })),
    [lines, available],
  );

  const add = useCallback((product: Product, quantity = 1, notes = '') => {
    setLines((current) => {
      const index = current.findIndex((l) => l.productId === product.id && l.notes === notes);
      if (index >= 0) return current.map((l, i) => (i === index ? { ...l, quantity: Math.min(50, l.quantity + quantity) } : l));
      return [...current, { productId: product.id, name: product.name, unitPrice: product.price, imageUrl: product.imageUrl, quantity, notes }];
    });
  }, []);

  const setQuantity = useCallback((line: CartLine, quantity: number) => {
    setLines((current) =>
      quantity <= 0
        ? current.filter((l) => `${l.productId}|${l.notes}` !== line.id)
        : current.map((l) => (`${l.productId}|${l.notes}` === line.id ? { ...l, quantity: Math.min(50, quantity) } : l)),
    );
  }, []);

  const clear = useCallback(() => setLines([]), []);

  const menuCart: MenuCart = useMemo(
    () => ({
      add,
      setQuantity,
      myLine: (productId: string) => items.find((l) => l.productId === productId && l.notes === '') ?? null,
      myQuantity: (productId: string) => items.filter((l) => l.productId === productId).reduce((sum, l) => sum + l.quantity, 0),
      othersWith: () => [],
    }),
    [add, setQuantity, items],
  );

  return {
    items,
    menuCart,
    setQuantity,
    clear,
    totalQuantity: items.reduce((sum, l) => sum + l.quantity, 0),
    subtotal: items.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0),
    hasUnavailable: items.some((l) => !l.isAvailable),
  };
}
