import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { errorMessage } from '../../lib/api';
import { useAuth, useTheme } from '../../lib/session';
import type { StaffRole } from '../../lib/types';
import { STATUS_ORDER, TABLE_STATUS } from '../floor/tableStatus';

export const HOME_BY_ROLE: Record<StaffRole, string> = { ADMIN: '/admin', WAITER: '/sala', KITCHEN: '/cocina', COURIER: '/repartidor' };

// Cuentas del restaurante de demostración (db/migrations/V2 y V5). Quita este bloque al salir a producción.
const DEMO_ACCOUNTS = [
  { label: 'Gerencia', email: 'admin@demo.test' },
  { label: 'Sala', email: 'sala@demo.test' },
  { label: 'Cocina', email: 'cocina@demo.test' },
  { label: 'Repartidor', email: 'repartidor@demo.test' },
];
const DEMO_PASSWORD = 'demo1234';

export function LoginPage() {
  useTheme(); // aplica el tema guardado también en el login
  const { session, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to={HOME_BY_ROLE[session.user.role]} replace />;

  const submit = async (credentials: { email: string; password: string }) => {
    setBusy(true);
    setError(null);
    try {
      const next = await login(credentials.email, credentials.password);
      navigate(HOME_BY_ROLE[next.user.role], { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-dvh bg-canvas text-ink lg:grid-cols-[1.1fr_1fr]">
      {/* El producto contado con su propia pieza central: las mesas y sus cinco estados */}
      <section className="floor-dots hidden flex-col justify-between border-r border-line bg-surface p-12 lg:flex">
        <p className="font-display text-xl font-bold tracking-tight">FrictionlessOrder</p>
        <div>
          <ul className="mb-10 flex gap-4" aria-label="Los cinco estados de una mesa">
            {STATUS_ORDER.map((status, i) => {
              const style = TABLE_STATUS[status];
              return (
                <li key={status} className="flex w-24 flex-col items-center gap-2 text-center">
                  <span
                    className={`grid h-20 w-20 place-items-center font-display text-2xl font-bold shadow-sm ${i % 2 === 0 ? 'rounded-full' : 'rounded-[18px]'} ${style.top} ${style.ink} ${
                      style.blink ? 'animate-blink' : ''
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span className="text-xs font-medium text-ink-soft">{style.label}</span>
                </li>
              );
            })}
          </ul>
          <h1 className="max-w-lg font-display text-5xl font-extrabold leading-[1.02] tracking-tight">La sala entera, de un vistazo y al instante.</h1>
          <p className="mt-4 max-w-md text-lg text-ink-soft">Pedidos por QR con sala, cocina y caja sincronizadas en tiempo real.</p>
        </div>
        <p className="text-sm text-ink-faint">Los clientes entran escaneando el QR de su mesa. No necesitan cuenta.</p>
      </section>

      <section className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <p className="mb-8 font-display text-xl font-bold tracking-tight lg:hidden">FrictionlessOrder</p>
          <h2 className="font-display text-3xl font-bold tracking-tight">Entrar</h2>
          <p className="mt-1 text-ink-soft">Acceso para el personal del restaurante.</p>

          <form
            className="mt-6 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit({ email, password });
            }}
          >
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-ink-soft">Correo</span>
              <input
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-full rounded-xl border border-line bg-surface px-3 py-3 outline-none focus:border-ink"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-ink-soft">Contraseña</span>
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full rounded-xl border border-line bg-surface px-3 py-3 outline-none focus:border-ink"
              />
            </label>
            {error && (
              <p className="rounded-xl bg-state-calling/10 px-3 py-2 text-sm font-medium text-state-calling" role="alert">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy} className="w-full rounded-xl bg-ink py-3 font-semibold text-surface transition hover:opacity-90 disabled:opacity-50">
              {busy ? 'Entrando…' : 'Entrar'}
            </button>
          </form>

          <div className="mt-8 rounded-2xl border border-dashed border-line p-4">
            <p className="text-sm font-medium">Cuentas de demostración</p>
            <p className="mt-0.5 text-sm text-ink-faint">Entra con un toque para probar cada rol.</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {DEMO_ACCOUNTS.map((account) => (
                <button
                  key={account.email}
                  type="button"
                  disabled={busy}
                  onClick={() => void submit({ email: account.email, password: DEMO_PASSWORD })}
                  className="rounded-xl border border-line bg-surface py-2.5 text-sm font-semibold hover:bg-sunken disabled:opacity-50"
                >
                  {account.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
