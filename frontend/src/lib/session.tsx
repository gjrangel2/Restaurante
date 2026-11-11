import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import type { RestaurantInfo, StaffUser } from './types';

// ----------------------------------------------------------------------------
// Sesión del personal
// ----------------------------------------------------------------------------
interface StaffSession {
  token: string;
  user: StaffUser;
  restaurant: RestaurantInfo;
}

interface AuthApi {
  session: StaffSession | null;
  login: (email: string, password: string) => Promise<StaffSession>;
  logout: () => void;
}

const STORAGE_KEY = 'fo.staff';
const AuthContext = createContext<AuthApi | null>(null);

function readStored(): StaffSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StaffSession) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StaffSession | null>(readStored);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setSession(null);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const next = await api.post<StaffSession>('/auth/login', { email, password });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSession(next);
    return next;
  }, []);

  // Al abrir la app se comprueba que el token guardado siga siendo válido.
  useEffect(() => {
    if (!session) return;
    api.get('/auth/me', session.token).catch((err) => {
      if (err?.status === 401) logout();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo(() => ({ session, login, logout }), [session, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  return context;
}

/** Atajo para pantallas que solo existen con sesión iniciada (están detrás de <RequireRole>). */
export function useStaff(): StaffSession {
  const { session } = useAuth();
  if (!session) throw new Error('Esta pantalla requiere sesión de personal');
  return session;
}

// ----------------------------------------------------------------------------
// Tema claro / oscuro de la interfaz del personal
// ----------------------------------------------------------------------------
type Theme = 'light' | 'dark';
const THEME_KEY = 'fo.theme';

function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // sin acceso a localStorage: se usa la preferencia del sistema
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // el tema igual aplica durante esta visita
    }
    // La app del cliente siempre es clara: al salir de la interfaz del personal se limpia la clase.
    return () => document.documentElement.classList.remove('dark');
  }, [theme]);

  return { theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) };
}
