import type { ReactNode } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { AdminPage } from './features/admin/AdminPage';
import { HOME_BY_ROLE, LoginPage } from './features/auth/LoginPage';
import { CustomerApp } from './features/customer/CustomerApp';
import { FloorPage } from './features/floor/FloorPage';
import { KitchenPage } from './features/kitchen/KitchenPage';
import { useAuth } from './lib/session';
import type { StaffRole } from './lib/types';

/**
 * Rutas y RBAC en el cliente.
 *
 *   /mesa/:number   Cliente (anónimo, entra con el QR)
 *   /sala           Admin y Camarero
 *   /cocina         Admin y Cocina
 *   /admin          Admin
 *
 * Esto solo decide qué pantalla se muestra: el permiso real lo hace cumplir
 * el backend en cada petición (requireStaff / requireGuest).
 */
function RequireRole({ roles, children }: { roles: StaffRole[]; children: ReactNode }) {
  const { session } = useAuth();
  if (!session) return <Navigate to="/login" replace />;
  if (!roles.includes(session.user.role)) return <Navigate to={HOME_BY_ROLE[session.user.role]} replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/mesa/:number" element={<CustomerApp />} />
      <Route
        path="/sala"
        element={
          <RequireRole roles={['ADMIN', 'WAITER']}>
            <FloorPage />
          </RequireRole>
        }
      />
      <Route
        path="/cocina"
        element={
          <RequireRole roles={['ADMIN', 'KITCHEN']}>
            <KitchenPage />
          </RequireRole>
        }
      />
      <Route
        path="/admin"
        element={
          <RequireRole roles={['ADMIN']}>
            <AdminPage />
          </RequireRole>
        }
      />
      <Route
        path="*"
        element={
          <main className="grid min-h-dvh place-items-center bg-canvas p-6 text-center text-ink">
            <div>
              <h1 className="font-display text-3xl font-bold">Esta página no existe</h1>
              <p className="mt-2 text-ink-soft">Si eres cliente, escanea el QR de tu mesa.</p>
              <Link to="/login" className="mt-5 inline-block rounded-xl bg-ink px-5 py-2.5 font-semibold text-surface">
                Ir al acceso del personal
              </Link>
            </div>
          </main>
        }
      />
    </Routes>
  );
}
