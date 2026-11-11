import type { DeliveryPayment, DeliveryStatus, Vehicle } from '../../lib/types';

/**
 * Cómo se nombra y se pinta cada estado de un domicilio. Lo comparten el
 * seguimiento del cliente, el tablero de despacho y la app del repartidor.
 */
export const DELIVERY_STATUS: Record<DeliveryStatus, { label: string; customer: string; color: string; pill: string }> = {
  PENDING_PAYMENT: { label: 'Esperando pago', customer: 'Esperando tu pago', color: '#64748B', pill: 'bg-slate-500 text-white' },
  PLACED: { label: 'Nuevo', customer: 'Recibimos tu pedido', color: '#7C3AED', pill: 'bg-violet-600 text-white' },
  ACCEPTED: { label: 'Aceptado', customer: 'El restaurante confirmó tu pedido', color: '#2563EB', pill: 'bg-blue-600 text-white' },
  PREPARING: { label: 'En cocina', customer: 'Estamos preparando tu pedido', color: '#EA580C', pill: 'bg-orange-600 text-white' },
  READY: { label: 'Listo', customer: 'Tu pedido está listo', color: '#CA8A04', pill: 'bg-yellow-600 text-white' },
  ON_THE_WAY: { label: 'En camino', customer: 'Tu pedido va en camino', color: '#16A34A', pill: 'bg-green-600 text-white' },
  DELIVERED: { label: 'Entregado', customer: 'Pedido entregado', color: '#0F766E', pill: 'bg-teal-700 text-white' },
  CANCELLED: { label: 'Cancelado', customer: 'Pedido cancelado', color: '#B91C1C', pill: 'bg-red-700 text-white' },
};

/** Los pasos que ve el cliente; es una secuencia real, por eso va numerada en pantalla. */
export function trackingSteps(type: 'DELIVERY' | 'PICKUP'): Array<{ status: DeliveryStatus; label: string }> {
  return [
    { status: 'PLACED', label: 'Recibido' },
    { status: 'ACCEPTED', label: 'Aceptado' },
    { status: 'PREPARING', label: 'Cocina' },
    { status: 'READY', label: type === 'PICKUP' ? 'Para recoger' : 'Listo' },
    ...(type === 'DELIVERY' ? [{ status: 'ON_THE_WAY' as DeliveryStatus, label: 'En camino' }] : []),
    { status: 'DELIVERED', label: 'Entregado' },
  ];
}

const ORDER: DeliveryStatus[] = ['PENDING_PAYMENT', 'PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'ON_THE_WAY', 'DELIVERED'];
export const statusRank = (status: DeliveryStatus) => ORDER.indexOf(status);

export const PAYMENT_LABEL: Record<DeliveryPayment, string> = {
  CASH: 'Efectivo al recibir',
  CARD_ON_DELIVERY: 'Datáfono al recibir',
  ONLINE: 'Pagado en línea',
};

export const VEHICLE_LABEL: Record<Vehicle, string> = { MOTO: 'Moto', BICI: 'Bicicleta', CARRO: 'Carro' };

/** Ubicación vieja: el repartidor no ha enviado posición en los últimos 2 minutos. */
export const isStale = (lastSeenAt: string | null, now = Date.now()) => !lastSeenAt || now - new Date(lastSeenAt).getTime() > 120_000;

export const firstName = (name: string) => name.split(' ')[0];
