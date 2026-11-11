import { lazy, Suspense, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { HOME_BY_ROLE, LoginPage } from './features/auth/LoginPage';
import { useDocumentTitle } from './lib/restaurant';
import { useAuth } from './lib/session';
import type { StaffRole } from './lib/types';

// Cada pantalla se descarga solo cuando se abre: quien escanea el QR de su
// mesa no baja el panel de gerencia ni la librería de mapas.
const page = <K extends string>(load: () => Promise<Record<K, () => ReactNode>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
const AdminPage = page(() => import('./features/admin/AdminPage'), 'AdminPage');
const CourierPage = page(() => import('./features/courier/CourierPage'), 'CourierPage');
const CustomerApp = page(() => import('./features/customer/CustomerApp'), 'CustomerApp');
const DeliveryApp = page(() => import('./features/delivery/DeliveryApp'), 'DeliveryApp');
const DispatchPage = page(() => import('./features/delivery/DispatchPage'), 'DispatchPage');
const TrackingPage = page(() => import('./features/delivery/TrackingPage'), 'TrackingPage');
const FloorPage = page(() => import('./features/floor/FloorPage'), 'FloorPage');
const KitchenPage = page(() => import('./features/kitchen/KitchenPage'), 'KitchenPage');
const PaymentResultPage = page(() => import('./features/payments/PaymentPages'), 'PaymentResultPage');
const TestGatewayPage = page(() => import('./features/payments/PaymentPages'), 'TestGatewayPage');

/**
 * Rutas y RBAC en el cliente.
 *
 *   /mesa/:number              Cliente (anónimo, entra con el QR)
 *   /domicilios                Cliente de domicilio / para recoger (público)
 *   /pedido/:code              Seguimiento del pedido con mapa (público, por código)
 *   /pago/resultado/:reference Regreso desde la pasarela de pago
 *   /pago/prueba/:reference    Pasarela de prueba (solo sin credenciales reales)
 *   /sala                      Admin y Camarero
 *   /despacho                  Admin y Camarero (domicilios)
 *   /cocina                    Admin y Cocina
 *   /repartidor                Repartidor
 *   /admin                     Admin
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

function Loading() {
  return (
    <div className="grid min-h-dvh place-items-center bg-canvas" role="status" aria-label="Cargando">
      <span className="h-8 w-8 animate-spin rounded-full border-[3px] border-line border-t-ink" />
    </div>
  );
}

export function App() {
  useDocumentTitle();
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/mesa/:number" element={<CustomerApp />} />
        <Route path="/domicilios" element={<DeliveryApp />} />
        <Route path="/pedido/:code" element={<TrackingPage />} />
        <Route path="/pago/resultado/:reference" element={<PaymentResultPage />} />
        <Route path="/pago/prueba/:reference" element={<TestGatewayPage />} />
        <Route
          path="/despacho"
          element={
            <RequireRole roles={['ADMIN', 'WAITER']}>
              <DispatchPage />
            </RequireRole>
          }
        />
        <Route
          path="/repartidor"
          element={
            <RequireRole roles={['COURIER']}>
              <CourierPage />
            </RequireRole>
          }
        />
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
                <p className="mt-2 text-ink-soft">Si eres cliente, escanea el QR de tu mesa o pide a domicilio.</p>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  <Link to="/domicilios" className="inline-block rounded-xl bg-ink px-5 py-2.5 font-semibold text-surface">
                    Pedir a domicilio
                  </Link>
                  <Link to="/login" className="inline-block rounded-xl border border-line px-5 py-2.5 font-semibold">
                    Acceso del personal
                  </Link>
                </div>
              </div>
            </main>
          }
        />
      </Routes>
    </Suspense>
  );
}
