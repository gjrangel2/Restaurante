import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError, type ZodType } from 'zod';

/** Error de negocio con código estable: el frontend decide qué mostrar según `code`. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) => new HttpError(400, code, message, details);
export const unauthorized = (message = 'Inicia sesión para continuar') => new HttpError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Tu rol no tiene permiso para esta acción') => new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message = 'No encontrado') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (message: string, code = 'CONFLICT', details?: unknown) => new HttpError(409, code, message, details);

/** Valida y tipa un cuerpo/consulta con zod; lanza 400 con el detalle si no cumple. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest('Datos inválidos', 'VALIDATION_ERROR', result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return result.data;
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(notFound('Ruta no encontrada'));

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Datos inválidos', details: err.issues } });
    return;
  }
  // Reglas que hace cumplir PostgreSQL (CHECK, triggers de negocio, únicos).
  const pgCode = (err as { code?: string }).code;
  if (pgCode === '23514' || pgCode === '23505' || pgCode === '23503') {
    res.status(409).json({ error: { code: 'RULE_VIOLATION', message: (err as Error).message } });
    return;
  }
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'BAD_JSON', message: 'El cuerpo de la petición no es JSON válido' } });
    return;
  }
  console.error('[http] error no controlado:', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Algo falló en el servidor' } });
};
