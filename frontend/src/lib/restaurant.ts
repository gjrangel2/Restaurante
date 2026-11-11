import { useEffect, useState } from 'react';
import { api } from './api';

// El nombre del restaurante es la marca de todas las pantallas (login, personal,
// pestaña del navegador). Se pide una vez y se comparte.
let cached: string | null = null;
let pending: Promise<string | null> | null = null;

function loadName(): Promise<string | null> {
  pending ??= api
    .get<{ restaurant: { name: string } }>('/public/config')
    .then((c) => (cached = c.restaurant.name))
    .catch(() => {
      pending = null; // reintenta en el próximo uso
      return null;
    });
  return pending;
}

/** Nombre del restaurante; null mientras carga. */
export function useRestaurantName(): string | null {
  const [name, setName] = useState(cached);
  useEffect(() => {
    if (!cached) void loadName().then(setName);
  }, []);
  return name;
}

/** Pone el nombre del restaurante en la pestaña del navegador. */
export function useDocumentTitle() {
  const name = useRestaurantName();
  useEffect(() => {
    if (name) document.title = name;
  }, [name]);
}
