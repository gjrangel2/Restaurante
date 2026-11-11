import { BookOpen, Clock, HandPlatter, Receipt, Utensils, type LucideIcon } from 'lucide-react';
import type { RestaurantTable, TableStatus } from '../../lib/types';

/**
 * Lógica de colores del mapa: los 5 estados exactos y cómo se pinta cada uno.
 * Es el único lugar donde se decide un color de mesa; el mapa, la leyenda y el
 * panel lateral leen de aquí.
 *
 * Las clases van escritas completas (no se construyen con plantillas) para
 * que Tailwind las encuentre al compilar.
 */
export interface StatusStyle {
  label: string; // nombre corto en la leyenda
  description: string; // qué está pasando en la mesa
  top: string; // tablero de la mesa
  chair: string; // sillas
  ink: string; // texto sobre el tablero
  dot: string; // punto de la leyenda
  pill: string; // etiqueta en el panel lateral
  blink: boolean; // rojo parpadeante
  icon: LucideIcon | null; // refuerzo no cromático del estado
}

export const TABLE_STATUS: Record<TableStatus, StatusStyle> = {
  FREE: {
    label: 'Libre',
    description: 'Sin clientes',
    top: 'bg-state-free',
    chair: 'bg-state-free',
    ink: 'text-state-free-ink',
    dot: 'bg-state-free',
    pill: 'bg-state-free text-state-free-ink',
    blink: false,
    icon: null,
  },
  OCCUPIED: {
    label: 'Ocupada',
    description: 'Leyendo la carta',
    top: 'bg-state-occupied',
    chair: 'bg-state-occupied/60',
    ink: 'text-white',
    dot: 'bg-state-occupied',
    pill: 'bg-state-occupied text-white',
    blink: false,
    icon: BookOpen,
  },
  WAITING_ORDER: {
    label: 'Esperando pedido',
    description: 'Pedido en curso',
    top: 'bg-state-waiting',
    chair: 'bg-state-waiting/60',
    ink: 'text-white',
    dot: 'bg-state-waiting',
    pill: 'bg-state-waiting text-white',
    blink: false,
    icon: Clock,
  },
  SERVED: {
    label: 'Servida',
    description: 'Comiendo',
    top: 'bg-state-served',
    chair: 'bg-state-served/60',
    ink: 'text-white',
    dot: 'bg-state-served',
    pill: 'bg-state-served text-white',
    blink: false,
    icon: Utensils,
  },
  CALLING: {
    label: 'Llamando',
    description: 'Llama al camarero o pide la cuenta',
    top: 'bg-state-calling',
    chair: 'bg-state-calling/60',
    ink: 'text-white',
    dot: 'bg-state-calling',
    pill: 'bg-state-calling text-white',
    blink: true,
    icon: HandPlatter,
  },
};

export const STATUS_ORDER: TableStatus[] = ['FREE', 'OCCUPIED', 'WAITING_ORDER', 'SERVED', 'CALLING'];

/** Icono del centro de la mesa. En rojo distingue "pide la cuenta" de "llama al camarero". */
export function statusIcon(table: RestaurantTable): LucideIcon | null {
  if (table.status === 'CALLING' && table.session?.call?.type === 'BILL') return Receipt;
  return TABLE_STATUS[table.status].icon;
}

/** Frase completa del estado, para el panel lateral y para lectores de pantalla. */
export function statusSentence(table: RestaurantTable): string {
  const call = table.session?.call;
  if (table.status === 'CALLING' && call) {
    const who = call.guestAlias ?? 'La mesa';
    return call.type === 'BILL' ? `${who} pide la cuenta` : `${who} llama al camarero`;
  }
  if (table.status === 'WAITING_ORDER' && table.session) {
    if (table.session.pendingOrders > 0) return 'Comanda nueva por confirmar';
    if (table.session.readyOrders > 0) return 'Pedido listo en cocina';
    return 'Pedido en cocina';
  }
  return TABLE_STATUS[table.status].description;
}
