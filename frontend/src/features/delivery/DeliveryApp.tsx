import { ArrowLeft, Bike, Clock, LocateFixed, MapPin, ShoppingBag, Store, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LazyImage } from '../../components/LazyImage';
import { MapView, type MapRing } from '../../components/MapView';
import { useToast } from '../../components/Toasts';
import { api, ApiError, errorMessage } from '../../lib/api';
import { money } from '../../lib/format';
import type { DeliveryConfig, DeliveryQuote, Product, PublicMenu } from '../../lib/types';
import { CategoryPills, FeaturedProduct, MenuSkeleton, ProductRow, ProductSheet, Stepper } from '../customer/parts';
import { PaymentPicker, type PaymentChoice } from '../payments/PaymentPicker';
import { useLocalCart } from './useLocalCart';

type Mode = 'DELIVERY' | 'PICKUP';

interface Contact {
  name: string;
  phone: string;
  email: string;
}

interface Address {
  line: string;
  details: string;
  notes: string;
  lat: number;
  lng: number;
}

const CONTACT_KEY = 'fo.delivery.contact';
const ADDRESS_KEY = 'fo.delivery.address';

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // sin almacenamiento disponible
  }
}

/**
 * Domicilios y pedidos para recoger: /domicilios
 *
 * Una sola página con dos vistas: la carta (la misma de la mesa) y el
 * checkout (ubicación en el mapa, datos de contacto y pago). La cobertura y
 * el valor del domicilio se cotizan en vivo al mover el pin.
 */
export function DeliveryApp() {
  const navigate = useNavigate();
  const toast = useToast();
  const [config, setConfig] = useState<DeliveryConfig | null>(null);
  const [menu, setMenu] = useState<PublicMenu | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('DELIVERY');
  const [view, setView] = useState<'menu' | 'checkout'>('menu');
  const [detail, setDetail] = useState<Product | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, m] = await Promise.all([api.get<DeliveryConfig>('/public/delivery'), api.get<PublicMenu>('/public/menu')]);
      setConfig(c);
      setMenu(m);
      setError(null);
      if (!c.restaurant.deliveryEnabled && c.restaurant.pickupEnabled) setMode('PICKUP');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const availability = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const category of menu?.categories ?? []) for (const product of category.products) map.set(product.id, product.isAvailable);
    return map;
  }, [menu]);
  const isAvailable = useCallback((id: string) => availability.get(id) ?? false, [availability]);
  const cart = useLocalCart(isAvailable);

  // Categoría activa según el scroll (igual que en la mesa)
  const sections = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    if (!menu || view !== 'menu') return;
    setActiveCategory((current) => current ?? menu.categories[0]?.id ?? null);
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActiveCategory((visible.target as HTMLElement).dataset.category ?? null);
      },
      { rootMargin: '-72px 0px -65% 0px' },
    );
    sections.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [menu, view]);

  if (error && !config) {
    return (
      <main className="grid min-h-dvh place-items-center bg-hoja p-8 text-center text-white">
        <div>
          <h1 className="font-display text-3xl font-bold">No pudimos cargar la carta</h1>
          <p className="mt-2 text-white/75">{error}</p>
          <button type="button" onClick={() => void load()} className="mt-6 rounded-full bg-maiz px-6 py-3 font-semibold text-tinta">
            Reintentar
          </button>
        </div>
      </main>
    );
  }

  const r = config?.restaurant;
  const closed = r && !r.deliveryEnabled && !r.pickupEnabled;
  const cheapestFee = config?.zones.length ? Math.min(...config.zones.map((z) => z.fee)) : 0;
  const fastest = config?.zones.length ? Math.min(...config.zones.map((z) => z.travelMinutes)) : 0;

  return (
    <div className="min-h-dvh bg-niebla">
      <div className="relative mx-auto min-h-dvh max-w-md bg-white pb-32 text-tinta shadow-lift">
        {view === 'menu' ? (
          <>
            <header className="rounded-b-[32px] bg-hoja px-5 pb-6 pt-7 text-white">
              <p className="text-sm font-semibold text-maiz">Pide sin salir de casa</p>
              <h1 className="mt-1 font-display text-[2.75rem] font-extrabold leading-[0.95] tracking-tight">{r?.name ?? ' '}</h1>

              {r && !closed && (
                <>
                  <div className="mt-5 grid grid-cols-2 gap-1 rounded-full bg-white/10 p-1" role="radiogroup" aria-label="Cómo quieres recibirlo">
                    {(['DELIVERY', 'PICKUP'] as Mode[]).map((option) => {
                      const enabled = option === 'DELIVERY' ? r.deliveryEnabled : r.pickupEnabled;
                      const Icon = option === 'DELIVERY' ? Bike : Store;
                      return (
                        <button
                          key={option}
                          type="button"
                          role="radio"
                          aria-checked={mode === option}
                          disabled={!enabled}
                          onClick={() => setMode(option)}
                          className={`flex items-center justify-center gap-2 rounded-full py-2.5 text-sm font-semibold transition-colors disabled:opacity-40 ${
                            mode === option ? 'bg-maiz text-tinta' : 'text-white'
                          }`}
                        >
                          <Icon className="h-4 w-4" aria-hidden />
                          {option === 'DELIVERY' ? 'Domicilio' : 'Para recoger'}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm text-white/85">
                    <span className="flex items-center gap-1.5">
                      <Clock className="h-4 w-4" aria-hidden />
                      {mode === 'DELIVERY' ? `${r.prepMinutes + fastest}–${r.prepMinutes + fastest + 15} min` : `Listo en ~${r.prepMinutes} min`}
                    </span>
                    {mode === 'DELIVERY' ? (
                      <span>Domicilio desde {money(cheapestFee, r.currency)}</span>
                    ) : (
                      r.address && <span className="flex items-center gap-1.5"><MapPin className="h-4 w-4" aria-hidden /> {r.address}</span>
                    )}
                  </p>
                </>
              )}
              {closed && <p className="mt-4 rounded-2xl bg-white/10 p-4 text-sm">En este momento no estamos recibiendo pedidos para llevar. Vuelve más tarde.</p>}
            </header>

            {!menu ? (
              <div className="pt-5">
                <MenuSkeleton />
              </div>
            ) : (
              <>
                <div className="mt-3">
                  <CategoryPills
                    categories={menu.categories}
                    activeId={activeCategory}
                    onSelect={(id) => {
                      setActiveCategory(id);
                      sections.current.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                  />
                </div>
                <div className="space-y-8 px-5 pt-5">
                  {menu.categories.map((category) => (
                    <section
                      key={category.id}
                      data-category={category.id}
                      ref={(el) => {
                        if (el) sections.current.set(category.id, el);
                        else sections.current.delete(category.id);
                      }}
                      className="scroll-mt-[68px]"
                      aria-labelledby={`d-category-${category.id}`}
                    >
                      <h2 id={`d-category-${category.id}`} className="font-display text-2xl font-bold">
                        {category.name}
                      </h2>
                      <div className="mt-3 space-y-4">
                        {category.products
                          .filter((p) => p.isFeatured)
                          .map((p) => (
                            <FeaturedProduct key={p.id} product={p} cart={cart.menuCart} currency={menu.restaurant.currency} highlighted={false} onOpen={setDetail} />
                          ))}
                      </div>
                      <div className="mt-2 divide-y divide-hoja/10">
                        {category.products
                          .filter((p) => !p.isFeatured)
                          .map((p) => (
                            <ProductRow key={p.id} product={p} cart={cart.menuCart} currency={menu.restaurant.currency} highlighted={false} onOpen={setDetail} />
                          ))}
                      </div>
                    </section>
                  ))}
                </div>
              </>
            )}

            {cart.totalQuantity > 0 && !closed && (
              <div className="pb-safe fixed inset-x-0 bottom-0 z-30 mx-auto max-w-md px-4 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setView('checkout');
                    window.scrollTo({ top: 0 });
                  }}
                  className="flex h-14 w-full animate-toast-in items-center gap-3 rounded-full bg-maiz pl-5 pr-5 text-tinta shadow-lift active:scale-[0.98]"
                >
                  <ShoppingBag className="h-5 w-5" aria-hidden />
                  <span className="flex flex-1 items-center gap-2 font-bold">
                    Ver pedido
                    <span key={cart.totalQuantity} className="grid h-6 min-w-6 animate-pop place-items-center rounded-full bg-tinta px-1.5 text-xs text-white">
                      {cart.totalQuantity}
                    </span>
                  </span>
                  <span className="font-bold tabular-nums">{money(cart.subtotal, r?.currency)}</span>
                </button>
              </div>
            )}
          </>
        ) : (
          config && (
            <Checkout
              config={config}
              mode={mode}
              cart={cart}
              onBack={() => setView('menu')}
              onPlaced={(trackingCode, checkoutUrl) => {
                cart.clear();
                if (checkoutUrl) window.location.assign(checkoutUrl);
                else navigate(`/pedido/${trackingCode}`);
              }}
              onError={(message) => toast.show(message, { tone: 'error' })}
            />
          )
        )}
      </div>

      {detail && menu && (
        <ProductSheet
          product={detail}
          currency={menu.restaurant.currency}
          onClose={() => setDetail(null)}
          onAdd={(quantity, notes) => {
            cart.menuCart.add(detail, quantity, notes);
            setDetail(null);
          }}
        />
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Checkout
// ----------------------------------------------------------------------------
interface CheckoutProps {
  config: DeliveryConfig;
  mode: Mode;
  cart: ReturnType<typeof useLocalCart>;
  onBack: () => void;
  onPlaced: (trackingCode: string, checkoutUrl: string | null) => void;
  onError: (message: string) => void;
}

function Checkout({ config, mode, cart, onBack, onPlaced, onError }: CheckoutProps) {
  const r = config.restaurant;
  const origin: [number, number] | null = r.lat !== null && r.lng !== null ? [Number(r.lat), Number(r.lng)] : null;
  const saved = readJson<Address>(ADDRESS_KEY);
  const [address, setAddress] = useState<Address>(
    saved ?? { line: '', details: '', notes: '', lat: origin ? origin[0] - 0.006 : 0, lng: origin ? origin[1] - 0.004 : 0 },
  );
  const [contact, setContact] = useState<Contact>(readJson<Contact>(CONTACT_KEY) ?? { name: '', phone: '', email: '' });
  const [payment, setPayment] = useState<PaymentChoice | null>(null);
  const [quote, setQuote] = useState<DeliveryQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [locating, setLocating] = useState<string | null>(null);
  const [center, setCenter] = useState<[number, number] | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState(false);

  // Cotización en vivo al mover el pin (con una pequeña espera para no saturar).
  useEffect(() => {
    if (mode !== 'DELIVERY') return;
    setQuoting(true);
    const id = setTimeout(() => {
      api
        .post<DeliveryQuote>('/public/delivery/quote', { lat: address.lat, lng: address.lng })
        .then(setQuote)
        .catch(() => setQuote(null))
        .finally(() => setQuoting(false));
    }, 350);
    return () => clearTimeout(id);
  }, [mode, address.lat, address.lng]);

  const useMyLocation = () => {
    if (!('geolocation' in navigator) || !window.isSecureContext) {
      setLocating('Tu navegador solo comparte la ubicación en conexiones seguras (HTTPS). Mueve el pin en el mapa.');
      return;
    }
    setLocating('Buscando tu ubicación…');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        setAddress((a) => ({ ...a, lat, lng }));
        setCenter([lat, lng]);
        setLocating(null);
      },
      () => setLocating('No pudimos obtener tu ubicación. Mueve el pin en el mapa.'),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const rings: MapRing[] = useMemo(
    () => (origin ? config.zones.map((z) => ({ id: z.name, lat: origin[0], lng: origin[1], radiusKm: z.maxKm, color: '#0C3B2E', label: `${z.name}: hasta ${z.maxKm} km · ${money(z.fee, r.currency)}` })) : []),
    [config.zones, origin?.[0], origin?.[1]], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const fee = mode === 'DELIVERY' ? quote?.fee ?? 0 : 0;
  const total = cart.subtotal + fee;
  const belowMinimum = mode === 'DELIVERY' && cart.subtotal < r.minOrder;
  const phoneOk = /^[+\d][\d\s-]{6,19}$/.test(contact.phone.trim());
  const problems = [
    cart.items.length === 0 && 'Tu pedido está vacío',
    cart.hasUnavailable && 'Quita los platos agotados',
    belowMinimum && `El pedido mínimo para domicilio es de ${money(r.minOrder, r.currency)}`,
    mode === 'DELIVERY' && quote && !quote.inCoverage && `Esa ubicación está fuera de nuestra zona (hasta ${quote.maxKm} km)`,
    mode === 'DELIVERY' && address.line.trim().length < 5 && 'Escribe la dirección',
    contact.name.trim().length < 2 && 'Escribe tu nombre',
    !phoneOk && 'Escribe un teléfono válido',
    !payment && 'Elige cómo vas a pagar',
  ].filter(Boolean) as string[];
  const online = payment === 'WOMPI' || payment === 'MERCADOPAGO' || payment === 'PSE';

  const submit = async () => {
    setTouched(true);
    if (problems.length > 0 || quoting) return;
    setSubmitting(true);
    writeJson(CONTACT_KEY, contact);
    if (mode === 'DELIVERY') writeJson(ADDRESS_KEY, address);
    try {
      const result = await api.post<{ trackingCode: string; checkoutUrl: string | null }>('/public/delivery/orders', {
        type: mode,
        items: cart.items.map((l) => ({ productId: l.productId, quantity: l.quantity, notes: l.notes })),
        customer: { name: contact.name.trim(), phone: contact.phone.trim(), email: contact.email.trim() },
        address: mode === 'DELIVERY' ? { ...address, line: address.line.trim(), details: address.details.trim(), notes: address.notes.trim() } : undefined,
        payment,
      });
      onPlaced(result.trackingCode, result.checkoutUrl);
    } catch (err) {
      // La pasarela falló pero el pedido quedó creado: desde el seguimiento se reintenta el pago.
      if (err instanceof ApiError && err.code === 'GATEWAY_UNAVAILABLE' && err.details?.trackingCode) {
        onPlaced(err.details.trackingCode as string, null);
        return;
      }
      onError(errorMessage(err));
      setSubmitting(false);
    }
  };

  const input = 'w-full rounded-2xl border border-hoja/15 bg-niebla px-4 py-3 text-tinta outline-none placeholder:text-tinta-soft/70 focus:border-hoja';

  return (
    <div className="pb-6">
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-hoja/10 bg-white/95 px-3 py-3 backdrop-blur">
        <button type="button" onClick={onBack} className="grid h-10 w-10 place-items-center rounded-full hover:bg-niebla" aria-label="Volver a la carta">
          <ArrowLeft className="h-5 w-5" aria-hidden />
        </button>
        <h1 className="font-display text-xl font-bold">{mode === 'DELIVERY' ? 'Tu domicilio' : 'Tu pedido para recoger'}</h1>
      </header>

      <section className="px-5 pt-5" aria-labelledby="co-items">
        <h2 id="co-items" className="text-sm font-semibold text-tinta-soft">
          Pedido
        </h2>
        <ul className="mt-3 space-y-3">
          {cart.items.map((line) => (
            <li key={line.id} className="flex items-center gap-3">
              <LazyImage src={line.imageUrl} alt="" className="h-14 w-14 shrink-0 rounded-xl" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{line.name}</p>
                {line.notes && <p className="truncate text-sm text-tinta-soft">“{line.notes}”</p>}
                {line.isAvailable ? (
                  <p className="text-sm tabular-nums text-tinta-soft">{money(line.unitPrice * line.quantity, r.currency)}</p>
                ) : (
                  <p className="text-sm font-medium text-red-700">Se agotó: quítalo</p>
                )}
              </div>
              <Stepper quantity={line.quantity} label={line.name} onChange={(n) => cart.setQuantity(line, n)} />
            </li>
          ))}
        </ul>
        {cart.items.length === 0 && (
          <button type="button" onClick={onBack} className="mt-2 rounded-full bg-hoja px-5 py-2.5 text-sm font-semibold text-white">
            Ver la carta
          </button>
        )}
      </section>

      {mode === 'DELIVERY' ? (
        <section className="mt-8" aria-labelledby="co-address">
          <h2 id="co-address" className="px-5 text-sm font-semibold text-tinta-soft">
            ¿Dónde lo entregamos?
          </h2>
          <p className="mt-1 px-5 text-sm text-tinta-soft">Toca el mapa o arrastra el pin hasta tu puerta.</p>
          <div className="relative mt-3">
            {origin ? (
              <MapView
                config={config.map}
                className="h-72 w-full"
                ariaLabel="Mapa para elegir la ubicación de entrega"
                markers={[{ id: 'restaurant', lat: origin[0], lng: origin[1], kind: 'restaurant', title: r.name }]}
                rings={rings}
                fitKey="initial"
                center={center}
                draggable={{ lat: address.lat, lng: address.lng, onMove: (lat, lng) => setAddress((a) => ({ ...a, lat, lng })) }}
                onMapClick={(lat, lng) => setAddress((a) => ({ ...a, lat, lng }))}
              />
            ) : (
              <p className="mx-5 rounded-2xl bg-niebla p-4 text-sm">El restaurante aún no configuró su ubicación.</p>
            )}
            <button
              type="button"
              onClick={useMyLocation}
              className="absolute bottom-3 right-3 z-[500] flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold shadow-lift"
            >
              <LocateFixed className="h-4 w-4" aria-hidden /> Usar mi ubicación
            </button>
          </div>
          {locating && <p className="mx-5 mt-2 text-sm text-tinta-soft" role="status">{locating}</p>}

          <div className="mx-5 mt-3 rounded-2xl bg-niebla p-4 text-sm" role="status" aria-live="polite">
            {quoting || !quote ? (
              <span className="text-tinta-soft">Calculando el domicilio…</span>
            ) : quote.inCoverage ? (
              <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="font-semibold">Domicilio {money(quote.fee, r.currency)}</span>
                <span className="text-tinta-soft">{quote.distanceKm.toLocaleString('es-CO')} km</span>
                <span className="flex items-center gap-1 text-tinta-soft">
                  <Clock className="h-4 w-4" aria-hidden /> {quote.etaMinutes}–{quote.etaMinutes + 15} min
                </span>
              </span>
            ) : (
              <span className="flex items-center gap-2 font-semibold text-red-700">
                <TriangleAlert className="h-4 w-4" aria-hidden /> Fuera de nuestra zona de entrega (hasta {quote.maxKm} km)
              </span>
            )}
          </div>

          <div className="mt-4 space-y-3 px-5">
            <label className="block">
              <span className="text-sm font-semibold">Dirección</span>
              <input value={address.line} onChange={(e) => setAddress((a) => ({ ...a, line: e.target.value }))} placeholder="Calle 5 #38-40, San Fernando" autoComplete="street-address" maxLength={160} className={`mt-1.5 ${input}`} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm font-semibold">Apto, torre, casa</span>
                <input value={address.details} onChange={(e) => setAddress((a) => ({ ...a, details: e.target.value }))} placeholder="Apto 302" maxLength={120} className={`mt-1.5 ${input}`} />
              </label>
              <label className="block">
                <span className="text-sm font-semibold">Indicaciones</span>
                <input value={address.notes} onChange={(e) => setAddress((a) => ({ ...a, notes: e.target.value }))} placeholder="Portería" maxLength={200} className={`mt-1.5 ${input}`} />
              </label>
            </div>
          </div>
        </section>
      ) : (
        <section className="mx-5 mt-8 rounded-3xl bg-niebla p-5" aria-labelledby="co-pickup">
          <h2 id="co-pickup" className="flex items-center gap-2 font-semibold">
            <Store className="h-5 w-5" aria-hidden /> Recoges en {r.name}
          </h2>
          {r.address && <p className="mt-1 text-sm text-tinta-soft">{r.address}</p>}
          <p className="mt-1 text-sm text-tinta-soft">Listo en ~{r.prepMinutes} min. Te avisamos en el seguimiento.</p>
        </section>
      )}

      <section className="mt-8 space-y-3 px-5" aria-labelledby="co-contact">
        <h2 id="co-contact" className="text-sm font-semibold text-tinta-soft">
          Tus datos
        </h2>
        <label className="block">
          <span className="text-sm font-semibold">Nombre</span>
          <input value={contact.name} onChange={(e) => setContact((c) => ({ ...c, name: e.target.value }))} autoComplete="name" maxLength={80} className={`mt-1.5 ${input}`} />
        </label>
        <label className="block">
          <span className="text-sm font-semibold">Celular</span>
          <input value={contact.phone} onChange={(e) => setContact((c) => ({ ...c, phone: e.target.value }))} inputMode="tel" autoComplete="tel" placeholder="300 123 4567" maxLength={20} className={`mt-1.5 ${input}`} />
          <span className="mt-1 block text-xs text-tinta-soft">Para que el repartidor te llame si no encuentra la dirección.</span>
        </label>
        <label className="block">
          <span className="text-sm font-semibold">Correo (opcional)</span>
          <input value={contact.email} onChange={(e) => setContact((c) => ({ ...c, email: e.target.value }))} type="email" autoComplete="email" placeholder="Para enviarte la factura" maxLength={200} className={`mt-1.5 ${input}`} />
        </label>
      </section>

      <section className="mt-8 px-5" aria-labelledby="co-pay">
        <h2 id="co-pay" className="mb-3 text-sm font-semibold text-tinta-soft">
          ¿Cómo vas a pagar?
        </h2>
        <PaymentPicker online={config.payments} offline={['CASH', 'CARD_ON_DELIVERY']} value={payment} onChange={setPayment} />
      </section>

      <section className="mx-5 mt-8 space-y-2 rounded-3xl bg-niebla p-5" aria-label="Total">
        <div className="flex justify-between text-tinta-soft">
          <span>Productos</span>
          <span className="tabular-nums">{money(cart.subtotal, r.currency)}</span>
        </div>
        {mode === 'DELIVERY' && (
          <div className="flex justify-between text-tinta-soft">
            <span>Domicilio</span>
            <span className="tabular-nums">{quote?.inCoverage ? money(fee, r.currency) : '—'}</span>
          </div>
        )}
        <div className="flex items-baseline justify-between border-t border-hoja/10 pt-2">
          <span className="font-semibold">Total</span>
          <span className="font-display text-3xl font-bold tabular-nums">{money(total, r.currency)}</span>
        </div>
        <p className="text-xs text-tinta-soft">Precios con {r.taxName} incluido.</p>
      </section>

      <div className="px-5 pt-5">
        {touched && problems.length > 0 && (
          <ul className="mb-3 space-y-1 rounded-2xl bg-red-50 p-4 text-sm text-red-800" role="alert">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <button
          type="button"
          disabled={submitting}
          onClick={() => void submit()}
          className="flex h-14 w-full items-center justify-between rounded-full bg-maiz px-6 text-lg font-bold text-tinta transition active:scale-[0.98] disabled:opacity-60"
        >
          <span>{submitting ? 'Enviando…' : online ? 'Ir a pagar' : 'Hacer pedido'}</span>
          <span className="tabular-nums">{money(total, r.currency)}</span>
        </button>
        {online && <p className="mt-2 text-center text-sm text-tinta-soft">Te llevamos a la pasarela de pago y vuelves aquí al terminar.</p>}
      </div>
    </div>
  );
}
