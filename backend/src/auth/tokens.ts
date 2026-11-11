import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export type StaffRole = 'ADMIN' | 'WAITER' | 'KITCHEN';

/** Token del personal: identidad + rol + restaurante (tenant). */
export interface StaffClaims {
  kind: 'staff';
  sub: string; // users.id
  rid: string; // restaurants.id
  role: StaffRole;
  name: string;
}

/**
 * Token de sesión de mesa (rol "Cliente", sin autenticación).
 * Va ligado a UNA sesión de mesa: cuando la sesión se cierra, deja de servir
 * aunque su firma y su fecha de expiración sigan siendo válidas.
 */
export interface GuestClaims {
  kind: 'guest';
  sub: string; // session_guests.id
  sid: string; // table_sessions.id
  tid: string; // restaurant_tables.id
  rid: string; // restaurants.id
  number: number; // Cliente #1, #2… dentro de la mesa
  alias: string;
  color: string;
}

export type Claims = StaffClaims | GuestClaims;

export function signStaffToken(claims: Omit<StaffClaims, 'kind'>): string {
  return jwt.sign({ ...claims, kind: 'staff' }, config.jwtSecret, { expiresIn: config.staffTokenTtl });
}

export function signGuestToken(claims: Omit<GuestClaims, 'kind'>): string {
  return jwt.sign({ ...claims, kind: 'guest' }, config.jwtSecret, { expiresIn: config.guestTokenTtl });
}

export function verifyToken(token: string): Claims | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as Claims;
    return payload.kind === 'staff' || payload.kind === 'guest' ? payload : null;
  } catch {
    return null;
  }
}
