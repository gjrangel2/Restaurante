import { ChefHat, LayoutDashboard, LogOut, Map as MapIcon, Moon, Sun, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth, useStaff, useTheme } from '../lib/session';
import type { StaffRole } from '../lib/types';

const NAV: Array<{ to: string; label: string; icon: LucideIcon; roles: StaffRole[] }> = [
  { to: '/admin', label: 'Gerencia', icon: LayoutDashboard, roles: ['ADMIN'] },
  { to: '/sala', label: 'Sala', icon: MapIcon, roles: ['ADMIN', 'WAITER'] },
  { to: '/cocina', label: 'Cocina', icon: ChefHat, roles: ['ADMIN', 'KITCHEN'] },
];

const ROLE_LABEL: Record<StaffRole, string> = { ADMIN: 'Gerencia', WAITER: 'Sala', KITCHEN: 'Cocina' };

/**
 * Marco común de las pantallas del personal: navegación según el rol,
 * indicador de conexión en vivo y cambio de tema claro/oscuro.
 */
export function StaffShell({ live, children }: { live?: boolean; children: ReactNode }) {
  const { user, restaurant } = useStaff();
  const { logout } = useAuth();
  const { theme, toggle } = useTheme();
  const links = NAV.filter((item) => item.roles.includes(user.role));

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="font-display text-lg font-bold tracking-tight">FrictionlessOrder</span>
            <span className="hidden truncate text-sm text-ink-faint md:inline">{restaurant.name}</span>
          </div>

          {links.length > 1 && (
            <nav className="ml-2 flex items-center gap-1" aria-label="Secciones">
              {links.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    `flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                      isActive ? 'bg-ink text-surface' : 'text-ink-soft hover:bg-sunken'
                    }`
                  }
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  <span className="hidden sm:inline">{label}</span>
                </NavLink>
              ))}
            </nav>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            {live !== undefined && (
              <span className="mr-1 flex items-center gap-1.5 text-xs font-medium text-ink-soft" role="status">
                <span className={`h-2 w-2 rounded-full ${live ? 'bg-state-served' : 'animate-blink bg-state-calling'}`} aria-hidden />
                <span className="hidden sm:inline">{live ? 'En vivo' : 'Reconectando…'}</span>
              </span>
            )}
            <button
              type="button"
              onClick={toggle}
              className="grid h-9 w-9 place-items-center rounded-full text-ink-soft hover:bg-sunken"
              aria-label={theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
            >
              {theme === 'dark' ? <Sun className="h-[18px] w-[18px]" aria-hidden /> : <Moon className="h-[18px] w-[18px]" aria-hidden />}
            </button>
            <div className="hidden text-right leading-tight sm:block">
              <p className="text-sm font-medium">{user.name}</p>
              <p className="text-xs text-ink-faint">{ROLE_LABEL[user.role]}</p>
            </div>
            <button
              type="button"
              onClick={logout}
              className="grid h-9 w-9 place-items-center rounded-full text-ink-soft hover:bg-sunken"
              aria-label="Cerrar sesión"
            >
              <LogOut className="h-[18px] w-[18px]" aria-hidden />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}

// Piezas de interfaz que comparten sala, cocina y admin ----------------------

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' }) {
  const variants = {
    primary: 'bg-ink text-surface hover:opacity-90',
    secondary: 'border border-line bg-surface text-ink hover:bg-sunken',
    danger: 'bg-state-calling text-white hover:opacity-90',
    ghost: 'text-ink-soft hover:bg-sunken',
  };
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${className}`}
    />
  );
}

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return <section className={`rounded-2xl border border-line bg-surface ${className}`}>{children}</section>;
}
