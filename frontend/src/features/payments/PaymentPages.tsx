import { CircleAlert, CircleCheck, Clock, FlaskConical, LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../../lib/api';
import { money } from '../../lib/format';
import type { PaymentChannel, PaymentIntentView } from '../../lib/types';

const CHANNEL_NAME: Record<PaymentChannel, string> = { WOMPI: 'Wompi', MERCADOPAGO: 'Mercado Pago', PSE: 'PSE' };

function Screen({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col bg-hoja px-6 pb-10 pt-8 text-white">
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center">{children}</div>
    </main>
  );
}

/**
 * Regreso desde la pasarela: /pago/resultado/<referencia>.
 *
 * La redirección trae una pista (Wompi: ?id=…, Mercado Pago: ?payment_id=…),
 * pero el resultado NO se toma de la URL: se le pide al backend que lo
 * verifique contra la API del proveedor. Mientras siga pendiente (PSE puede
 * tardar), se vuelve a consultar cada pocos segundos.
 */
export function PaymentResultPage() {
  const { reference = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const hint = params.get('id') ?? params.get('payment_id') ?? params.get('collection_id') ?? undefined;
  const [intent, setIntent] = useState<PaymentIntentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const attempts = useRef(0);

  const verify = useCallback(async () => {
    try {
      const view = await api.post<PaymentIntentView>(`/public/payments/${reference}/verify`, hint ? { hint } : {});
      setIntent(view);
      setError(null);
      return view;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    }
  }, [reference, hint]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      const view = await verify();
      attempts.current += 1;
      if (view?.status === 'PENDING') {
        if (attempts.current >= 60) setGaveUp(true);
        else timer = setTimeout(loop, 3000);
      }
    };
    void loop();
    return () => clearTimeout(timer);
  }, [verify]);

  // Domicilio aprobado: directo al seguimiento.
  useEffect(() => {
    if (intent?.status === 'APPROVED' && intent.purpose === 'DELIVERY' && intent.trackingCode) {
      const id = setTimeout(() => navigate(`/pedido/${intent.trackingCode}`, { replace: true }), 1600);
      return () => clearTimeout(id);
    }
  }, [intent, navigate]);

  if (error && !intent) {
    return (
      <Screen>
        <CircleAlert className="h-12 w-12 text-maiz" aria-hidden />
        <h1 className="mt-6 font-display text-3xl font-bold">No pudimos consultar tu pago</h1>
        <p className="mt-3 text-white/75">{error}</p>
        <button type="button" onClick={() => void verify()} className="mt-6 rounded-full bg-maiz px-6 py-3 font-semibold text-tinta">
          Volver a consultar
        </button>
      </Screen>
    );
  }

  if (!intent || intent.status === 'PENDING') {
    return (
      <Screen>
        {gaveUp ? <Clock className="h-12 w-12 text-maiz" aria-hidden /> : <LoaderCircle className="h-12 w-12 animate-spin text-maiz" aria-hidden />}
        <h1 className="mt-6 font-display text-3xl font-bold leading-tight">{gaveUp ? 'Tu pago sigue en proceso' : 'Confirmando tu pago…'}</h1>
        <p className="mt-3 text-white/75" role="status">
          {gaveUp
            ? 'El banco aún no confirma. Si ya pagaste, no vuelvas a pagar: en cuanto llegue la confirmación lo verás en tu pedido.'
            : 'Estamos consultando con la pasarela. Esto toma unos segundos; con PSE puede tardar un poco más.'}
        </p>
        {intent && <p className="mt-6 text-sm text-white/60">{intent.description} · {money(intent.amount, intent.currency)}</p>}
        {gaveUp && (
          <button
            type="button"
            onClick={() => {
              attempts.current = 0;
              setGaveUp(false);
              void verify();
            }}
            className="mt-6 rounded-full bg-maiz px-6 py-3 font-semibold text-tinta"
          >
            Volver a consultar
          </button>
        )}
        <BackLink intent={intent} />
      </Screen>
    );
  }

  if (intent.status === 'APPROVED') {
    return (
      <Screen>
        <CircleCheck className="h-14 w-14 text-maiz" aria-hidden />
        <h1 className="mt-6 font-display text-4xl font-bold leading-tight">Pago aprobado</h1>
        <p className="mt-3 text-lg text-white/85">
          {money(intent.amount, intent.currency)} · {intent.description}
        </p>
        {intent.needsReview ? (
          <p className="mt-4 rounded-2xl bg-white/10 p-4 text-sm">
            Recibimos tu pago, pero tu pedido cambió mientras pagabas. El restaurante lo revisará y te contactará.
          </p>
        ) : intent.purpose === 'TABLE_BILL' ? (
          <p className="mt-4 text-white/75">La cuenta de la mesa {intent.tableNumber} quedó pagada{intent.invoiceNumber ? ` (factura ${intent.invoiceNumber})` : ''}. ¡Gracias por venir!</p>
        ) : (
          <p className="mt-4 text-white/75">Te llevamos al seguimiento de tu pedido…</p>
        )}
        {!intent.live && <TestNotice />}
      </Screen>
    );
  }

  const expired = intent.status === 'EXPIRED';
  return (
    <Screen>
      <CircleAlert className="h-12 w-12 text-maiz" aria-hidden />
      <h1 className="mt-6 font-display text-3xl font-bold leading-tight">{expired ? 'El pago venció' : 'El pago no se aprobó'}</h1>
      <p className="mt-3 text-white/75">
        {expired ? 'Pasó el tiempo para completarlo. ' : 'La pasarela lo rechazó. '}
        No se te cobró. Puedes intentarlo de nuevo, con el mismo medio o con otro.
      </p>
      <BackLink intent={intent} primary />
    </Screen>
  );
}

function BackLink({ intent, primary = false }: { intent: PaymentIntentView | null; primary?: boolean }) {
  if (!intent) return null;
  const to = intent.purpose === 'DELIVERY' ? `/pedido/${intent.trackingCode}` : `/mesa/${intent.tableNumber}`;
  const label = intent.purpose === 'DELIVERY' ? 'Volver a mi pedido' : 'Volver a la mesa';
  return (
    <Link to={to} className={primary ? 'mt-6 rounded-full bg-maiz px-6 py-3 text-center font-semibold text-tinta' : 'mt-6 text-sm font-semibold text-white underline underline-offset-4'}>
      {label}
    </Link>
  );
}

const TestNotice = () => (
  <p className="mt-6 flex items-start gap-2 rounded-2xl bg-white/10 p-3 text-sm text-white/80">
    <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> Pago de prueba: no se movió dinero real.
  </p>
);

/**
 * Pasarela de pruebas: /pago/prueba/<referencia>.
 *
 * Existe para desarrollar y demostrar el flujo completo sin credenciales.
 * Es deliberadamente distinta de cualquier pasarela real y dice en todo
 * momento que es una simulación. Con credenciales configuradas, el cliente
 * va a Wompi o a Mercado Pago y nunca ve esta página.
 */
export function TestGatewayPage() {
  const { reference = '' } = useParams();
  const navigate = useNavigate();
  const [intent, setIntent] = useState<PaymentIntentView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<PaymentIntentView>(`/public/payments/${reference}`)
      .then(setIntent)
      .catch((err) => setError(errorMessage(err)));
  }, [reference]);

  const finish = async (outcome: 'APPROVED' | 'DECLINED') => {
    setBusy(true);
    try {
      await api.post(`/public/payments/${reference}/test-result`, { outcome });
      navigate(`/pago/resultado/${reference}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <main className="min-h-dvh bg-[repeating-linear-gradient(135deg,#FEF3C7_0_14px,#FDE68A_14px_28px)] p-4">
      <div className="mx-auto mt-6 max-w-sm overflow-hidden rounded-3xl bg-white shadow-lift">
        <div className="flex items-center gap-2 bg-tinta px-5 py-3 text-sm font-semibold text-maiz">
          <FlaskConical className="h-4 w-4" aria-hidden /> Pasarela de pruebas de FrictionlessOrder
        </div>
        <div className="p-6 text-tinta">
          {error && <p className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
          {!intent ? (
            !error && <div className="h-40 animate-pulse rounded-2xl bg-niebla" />
          ) : intent.status !== 'PENDING' ? (
            <>
              <p className="font-semibold">Este pago ya terminó ({intent.status === 'APPROVED' ? 'aprobado' : 'no aprobado'}).</p>
              <Link to={`/pago/resultado/${reference}`} className="mt-4 inline-block font-semibold underline">
                Ver resultado
              </Link>
            </>
          ) : (
            <>
              <p className="text-sm text-tinta-soft">{intent.restaurantName}</p>
              <h1 className="mt-1 font-display text-2xl font-bold">{intent.description}</h1>
              <p className="mt-4 font-display text-4xl font-extrabold tabular-nums">{money(intent.amount, intent.currency)}</p>
              <p className="mt-1 text-sm text-tinta-soft">Medio elegido: {CHANNEL_NAME[intent.channel]}</p>

              <p className="mt-5 rounded-2xl bg-amber-50 p-3 text-sm text-amber-900">
                Simulación: aquí no se piden datos de tarjeta ni de banco y no se cobra dinero. Con credenciales reales en el
                archivo .env, este paso lo hace {intent.channel === 'PSE' ? 'la pasarela configurada para PSE' : CHANNEL_NAME[intent.channel]}.
              </p>

              <div className="mt-6 grid gap-2">
                <button type="button" disabled={busy} onClick={() => void finish('APPROVED')} className="h-12 rounded-full bg-hoja font-semibold text-white disabled:opacity-50">
                  Simular pago aprobado
                </button>
                <button type="button" disabled={busy} onClick={() => void finish('DECLINED')} className="h-12 rounded-full border-2 border-tinta/15 font-semibold disabled:opacity-50">
                  Simular pago rechazado
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
