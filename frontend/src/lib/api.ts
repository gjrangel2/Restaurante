/** Error de la API con el código estable que devuelve el backend (p. ej. SESSION_CLOSED). */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: any, // información extra del backend (p. ej. el código de seguimiento si la pasarela falló)
  ) {
    super(message);
  }
}

interface RequestOptions {
  token?: string | null;
  body?: unknown;
}

/**
 * Cliente HTTP mínimo. Las rutas son relativas (/api/…): en Docker las sirve
 * nginx y en desarrollo el proxy de Vite, siempre en el mismo origen.
 */
async function request<T>(method: string, path: string, { token, body }: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Sin conexión con el servidor. Revisa tu red e inténtalo de nuevo.');
  }

  if (response.status === 204) return undefined as T;

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(response.status, data?.error?.code ?? 'UNKNOWN', data?.error?.message ?? 'Algo salió mal. Inténtalo de nuevo.', data?.error?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, token?: string | null) => request<T>('GET', path, { token }),
  post: <T>(path: string, body?: unknown, token?: string | null) => request<T>('POST', path, { token, body: body ?? {} }),
  put: <T>(path: string, body: unknown, token?: string | null) => request<T>('PUT', path, { token, body }),
  patch: <T>(path: string, body: unknown, token?: string | null) => request<T>('PATCH', path, { token, body }),
  delete: <T = void>(path: string, token?: string | null) => request<T>('DELETE', path, { token }),
};

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : 'Algo salió mal. Inténtalo de nuevo.');
