import type { Request, RequestHandler } from 'express';
import { queryOne } from '../db/pool.js';
import { forbidden, HttpError, unauthorized } from '../http.js';
import { verifyToken, type GuestClaims, type StaffClaims, type StaffRole } from './tokens.js';

declare module 'express-serve-static-core' {
  interface Request {
    staff?: StaffClaims;
    guest?: GuestClaims;
  }
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

/** RBAC del personal: requireStaff('ADMIN', 'WAITER') deja pasar solo esos roles. */
export function requireStaff(...roles: StaffRole[]): RequestHandler {
  return (req, _res, next) => {
    const token = bearer(req);
    const claims = token ? verifyToken(token) : null;
    if (!claims || claims.kind !== 'staff') return next(unauthorized());
    if (roles.length > 0 && !roles.includes(claims.role)) return next(forbidden());
    req.staff = claims;
    next();
  };
}

/** ¿Sigue abierta la sesión de mesa de este token? */
export async function isSessionOpen(sessionId: string): Promise<boolean> {
  const row = await queryOne('SELECT 1 FROM table_sessions WHERE id = $1 AND closed_at IS NULL', [sessionId]);
  return row !== null;
}

/**
 * Control anti-fraude del QR: un cliente solo actúa con un token de sesión
 * de mesa y solo mientras un camarero mantenga esa sesión abierta.
 */
export const requireGuest: RequestHandler = async (req, _res, next) => {
  const token = bearer(req);
  const claims = token ? verifyToken(token) : null;
  if (!claims || claims.kind !== 'guest') return next(unauthorized('Escanea el QR de tu mesa para continuar'));
  if (!(await isSessionOpen(claims.sid))) {
    return next(new HttpError(410, 'SESSION_CLOSED', 'La mesa está cerrada. Pide a tu camarero que la abra.'));
  }
  req.guest = claims;
  next();
};
