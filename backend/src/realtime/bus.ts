import type { Server } from 'socket.io';

/**
 * Punto único para emitir eventos en tiempo real. Los servicios importan este
 * módulo (y no el gateway) para no crear dependencias circulares.
 *
 * Eventos servidor → cliente
 *   table:updated      sala      una mesa cambió (estado, comensales, total, llamado)
 *   table:opened       lobby     el camarero abrió la mesa: el cliente en espera entra solo
 *   call:created       sala      llamado a camarero o petición de cuenta
 *   call:attended      mesa      el camarero ya va
 *   order:created      sala      comanda nueva por confirmar
 *   order:updated      sala, cocina y mesa
 *   cart:updated       mesa      carrito compartido completo + quién hizo el último cambio
 *   guests:updated     mesa      quién está sentado (y conectado)
 *   menu:updated       carta     platos, categorías o banners cambiaron: recargar carta
 *   inventory:alert    cocina y sala   insumos en amarillo o rojo tras una venta
 *   invoice:issued     sala      se cobró una mesa (refresca KPIs)
 *   session:closed     mesa      pago validado, la mesa se cerró
 */
let io: Server | null = null;

export function setIo(server: Server): void {
  io = server;
}

export function getIo(): Server {
  if (!io) throw new Error('Socket.IO todavía no está inicializado');
  return io;
}

export const rooms = {
  staff: (restaurantId: string) => `staff:${restaurantId}`, // Admin + Sala
  kitchen: (restaurantId: string) => `kitchen:${restaurantId}`, // Cocina + Admin
  menu: (restaurantId: string) => `menu:${restaurantId}`, // cualquiera con la carta abierta
  session: (sessionId: string) => `session:${sessionId}`, // comensales de una mesa abierta
  lobby: (tableId: string) => `lobby:${tableId}`, // clientes esperando a que abran la mesa
};

export function emit(room: string | string[], event: string, payload?: unknown): void {
  io?.to(room).emit(event, payload);
}
