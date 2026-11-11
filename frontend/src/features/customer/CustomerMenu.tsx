import { BellRing, BookOpenText, ReceiptText, ShoppingBag, WifiOff, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../../components/Toasts';
import { api, ApiError, errorMessage } from '../../lib/api';
import { money, useNow } from '../../lib/format';
import { useReconnect, useSocket, useSocketEvent } from '../../lib/socket';
import type { CallType, CartChange, Guest, GuestState, Order, Product, Promotion, PublicMenu, RestaurantInfo } from '../../lib/types';
import { BillView, CartView } from './OrderViews';
import { BottomSheet, CategoryPills, FeaturedProduct, GuestAvatar, MenuSkeleton, ProductRow, ProductSheet, PromoCarousel } from './parts';
import { useSharedCart } from './useSharedCart';

/**
 * Menú del cliente (mobile-first).
 *
 * Se comporta como una app nativa: barra de navegación inferior, categorías
 * fijas que siguen al scroll, fotos con carga diferida, skeletons mientras
 * llega la carta y hojas inferiores para el detalle.
 *
 * Todo lo que cambia llega por WebSocket, sin recargar:
 *   · el carrito de la mesa (lo que agrega cualquier comensal)
 *   · el avance de cada pedido en cocina
 *   · la carta (platos agotados, precios, banners)
 *   · el cierre de la mesa cuando el camarero valida el pago
 */
interface CustomerMenuProps {
  token: string; // token de sesión de mesa
  me: Guest;
  tableNumber: number;
  restaurant: RestaurantInfo;
  joinedLate?: boolean; // llegó cuando la mesa ya había pedido
  onSessionClosed: (info: { reason: 'PAID' | 'CANCELLED'; invoiceNumber?: string; grandTotal?: number }) => void;
}

type Tab = 'menu' | 'order' | 'bill';

export function CustomerMenu({ token, me, tableNumber, restaurant, joinedLate = false, onSessionClosed }: CustomerMenuProps) {
  const toast = useToast();
  const now = useNow();
  const { socket, connected } = useSocket({ token });

  const [menu, setMenu] = useState<PublicMenu | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('menu');
  const [orders, setOrders] = useState<Order[]>([]);
  const [guests, setGuests] = useState<Guest[]>([me]);
  const [openCalls, setOpenCalls] = useState<CallType[]>([]);
  const [detail, setDetail] = useState<Product | null>(null);
  const [callSheet, setCallSheet] = useState(false);
  const [sending, setSending] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [billKey, setBillKey] = useState(0);
  const [lateNotice, setLateNotice] = useState(joinedLate);

  // --- Carrito compartido ---------------------------------------------------
  const cart = useSharedCart(socket, me, {
    onRemoteChange: (change) => toast.show(describeChange(change)),
    onError: (message, code) => {
      toast.show(message, { tone: 'error' });
      if (code === 'SESSION_CLOSED') onSessionClosed({ reason: 'CANCELLED' });
    },
  });

  // --- Carga inicial y resincronización -------------------------------------
  const loadMenu = useCallback(async () => {
    try {
      setMenu(await api.get<PublicMenu>('/public/menu'));
      setMenuError(null);
    } catch (err) {
      setMenuError(errorMessage(err));
    }
  }, []);

  const loadState = useCallback(async () => {
    try {
      const state = await api.get<GuestState>('/guest/state', token);
      setOrders(state.orders);
      setGuests(state.guests);
      setOpenCalls(state.openCalls);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'SESSION_CLOSED' || err.status === 401)) onSessionClosed({ reason: 'CANCELLED' });
    }
  }, [token, onSessionClosed]);

  useEffect(() => {
    void loadMenu();
    void loadState();
  }, [loadMenu, loadState]);

  useReconnect(socket, () => {
    void loadMenu();
    void loadState();
  });

  // --- Tiempo real ----------------------------------------------------------
  const upsertOrder = (order: Order) =>
    setOrders((current) => (current.some((o) => o.id === order.id) ? current.map((o) => (o.id === order.id ? order : o)) : [...current, order]));

  useSocketEvent(socket, 'menu:updated', () => void loadMenu()); // un plato se agotó, cambió un precio, hay banner nuevo…
  useSocketEvent<Order>(socket, 'order:created', upsertOrder);
  useSocketEvent<Order>(socket, 'order:updated', (order) => {
    const previous = orders.find((o) => o.id === order.id);
    upsertOrder(order);
    if (previous?.status === order.status) return;
    if (order.status === 'CONFIRMED') toast.show('Pedido confirmado: ya está en cocina', { emoji: '👨‍🍳' });
    if (order.status === 'READY') toast.show('Tu pedido está listo y va para la mesa', { emoji: '🛎️' });
    if (order.status === 'CANCELLED') toast.show('No se pudo tomar un pedido. Habla con tu camarero.', { tone: 'error' });
  });
  useSocketEvent<Guest[]>(socket, 'guests:updated', setGuests);
  useSocketEvent<{ type: CallType }>(socket, 'call:created', ({ type }) => setOpenCalls((current) => [...new Set([...current, type])]));
  useSocketEvent(socket, 'call:attended', () => {
    setOpenCalls([]);
    toast.show('Tu camarero va en camino', { emoji: '🙌' });
  });
  useSocketEvent<{ reason: 'PAID' | 'CANCELLED'; invoiceNumber?: string; grandTotal?: number }>(socket, 'session:closed', onSessionClosed);
  useSocketEvent<{ alias: string }>(socket, 'bill:paying', ({ alias }) => {
    setBillKey((k) => k + 1);
    if (alias !== me.alias) toast.show(`${alias} está pagando la cuenta`, { emoji: '💳' });
  });
  useSocketEvent(socket, 'bill:payment-failed', () => {
    setBillKey((k) => k + 1);
    toast.show('El pago en línea no se completó. Pueden intentarlo de nuevo.', { tone: 'error' });
  });

  // --- Banners vigentes según el reloj del cliente ---------------------------
  const promotions = useMemo(
    () => (menu?.promotions ?? []).filter((p) => new Date(p.startsAt).getTime() <= now && now < new Date(p.endsAt).getTime()),
    [menu, now],
  );

  // --- Categoría activa según el scroll --------------------------------------
  const sections = useRef(new Map<string, HTMLElement>());
  const jumping = useRef(false); // durante un salto por toque, el scroll no cambia la categoría activa

  useEffect(() => {
    if (!menu || tab !== 'menu') return;
    setActiveCategory((current) => current ?? menu.categories[0]?.id ?? null);
    const observer = new IntersectionObserver(
      (entries) => {
        if (jumping.current) return;
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActiveCategory((visible.target as HTMLElement).dataset.category ?? null);
      },
      { rootMargin: '-72px 0px -65% 0px' }, // franja justo debajo de la barra de categorías
    );
    sections.current.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [menu, tab]);

  const jumpToCategory = (id: string) => {
    setActiveCategory(id);
    jumping.current = true;
    sections.current.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => (jumping.current = false), 700);
  };

  /** Un banner lleva al plato que anuncia y lo resalta un momento. */
  const openPromotion = (promotion: Promotion) => {
    if (!promotion.productId) return;
    document.getElementById(`product-${promotion.productId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlighted(promotion.productId);
    setTimeout(() => setHighlighted(null), 2200);
  };

  // --- Acciones ---------------------------------------------------------------
  const sendOrder = async () => {
    setSending(true);
    try {
      upsertOrder(await api.post<Order>('/guest/orders', {}, token));
      toast.show('Pedido enviado', { tone: 'success' });
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    } finally {
      setSending(false);
    }
  };

  const call = async (type: CallType) => {
    setCallSheet(false);
    try {
      await api.post('/guest/calls', { type }, token);
      setOpenCalls((current) => [...new Set([...current, type])]);
      toast.show(type === 'BILL' ? 'Cuenta pedida' : 'Camarero avisado', { tone: 'success' });
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    }
  };

  const switchTab = (next: Tab) => {
    setTab(next);
    window.scrollTo({ top: 0 });
  };

  const currency = restaurant.currency;
  const waiterCalled = openCalls.includes('WAITER');
  const activeOrders = orders.filter((o) => o.status !== 'SERVED' && o.status !== 'CANCELLED').length;

  return (
    <div className="min-h-dvh bg-niebla">
      <div className="relative mx-auto min-h-dvh max-w-md bg-white pb-36 text-tinta shadow-lift">
        {!connected && cart.ready && (
          <p className="sticky top-0 z-30 flex items-center justify-center gap-2 bg-tinta py-1.5 text-xs font-medium text-white" role="status">
            <WifiOff className="h-3.5 w-3.5" aria-hidden /> Sin conexión. Reintentando…
          </p>
        )}

        {tab === 'menu' && lateNotice && (
          <div className="flex items-start gap-3 bg-maiz px-5 py-3 text-sm text-tinta" role="status">
            <p className="flex-1">
              <strong className="font-semibold">Tu mesa ya pidió.</strong> Lo que agregues se envía como un pedido nuevo; tu camarero ya sabe que llegaste.
            </p>
            <button type="button" onClick={() => setLateNotice(false)} className="font-semibold underline underline-offset-2">
              Entendido
            </button>
          </div>
        )}

        {tab === 'menu' && (
          <>
            {/* Cabecera: restaurante, mesa y quién está sentado */}
            <header className={`rounded-b-[32px] bg-hoja px-5 pt-7 text-white ${promotions.length > 0 ? 'pb-24' : 'pb-7'}`}>
              <div className="flex items-start justify-between gap-4">
                <h1 className="font-display text-[2.75rem] font-extrabold leading-[0.95] tracking-tight">{restaurant.name}</h1>
                <div className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-maiz text-tinta" aria-label={`Mesa ${tableNumber}`}>
                  <div className="text-center leading-none">
                    <span className="block text-[11px] font-semibold">Mesa</span>
                    <span className="font-display text-3xl font-extrabold">{tableNumber}</span>
                  </div>
                </div>
              </div>
              <div className="mt-5 flex items-center gap-3">
                <ul className="flex -space-x-2" aria-label="Personas en la mesa">
                  {guests.slice(0, 6).map((guest) => (
                    <li key={guest.id} className={guest.online === false ? 'opacity-50' : ''}>
                      <GuestAvatar guest={guest} ring={guest.id === me.id} />
                      <span className="sr-only">
                        {guest.alias}
                        {guest.id === me.id ? ' (tú)' : ''}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-sm leading-snug text-white/85">
                  Eres <strong className="font-semibold text-white">{me.alias}</strong>.{' '}
                  {guests.length > 1 ? 'Todos piden en un mismo pedido.' : 'Quien escanee el QR pide contigo.'}
                </p>
              </div>
            </header>

            {menu === null ? (
              menuError ? (
                <div className="p-8 text-center">
                  <p className="text-tinta-soft">{menuError}</p>
                  <button type="button" onClick={() => void loadMenu()} className="mt-4 rounded-full bg-hoja px-5 py-2.5 text-sm font-semibold text-white">
                    Reintentar
                  </button>
                </div>
              ) : (
                <div className="-mt-16">
                  <MenuSkeleton />
                </div>
              )
            ) : (
              <>
                {promotions.length > 0 && (
                  <div className="-mt-16">
                    <PromoCarousel promotions={promotions} onOpen={openPromotion} />
                  </div>
                )}

                <div className="mt-3">
                  <CategoryPills categories={menu.categories} activeId={activeCategory} onSelect={jumpToCategory} />
                </div>

                <div className="space-y-8 px-5 pt-5">
                  {menu.categories.map((category) => (
                    <section
                      key={category.id}
                      data-category={category.id}
                      ref={(element) => {
                        if (element) sections.current.set(category.id, element);
                        else sections.current.delete(category.id);
                      }}
                      className="scroll-mt-[68px]"
                      aria-labelledby={`category-${category.id}`}
                    >
                      <h2 id={`category-${category.id}`} className="font-display text-2xl font-bold text-tinta">
                        {category.name}
                      </h2>
                      <div className="mt-3 space-y-4">
                        {category.products
                          .filter((product) => product.isFeatured)
                          .map((product) => (
                            <FeaturedProduct key={product.id} product={product} cart={cart} currency={currency} highlighted={highlighted === product.id} onOpen={setDetail} />
                          ))}
                      </div>
                      <div className="mt-2 divide-y divide-hoja/10">
                        {category.products
                          .filter((product) => !product.isFeatured)
                          .map((product) => (
                            <ProductRow key={product.id} product={product} cart={cart} currency={currency} highlighted={highlighted === product.id} onOpen={setDetail} />
                          ))}
                      </div>
                    </section>
                  ))}
                  <p className="pb-2 text-center text-xs text-tinta-soft">
                    Precios en {currency}
                    {restaurant.pricesIncludeTax !== false && restaurant.taxName ? `, ${restaurant.taxName} incluido` : ''}.
                  </p>
                </div>
              </>
            )}
          </>
        )}

        {tab === 'order' && (
          <CartView cart={cart} me={me} orders={orders} currency={currency} sending={sending} onSend={sendOrder} onBrowse={() => switchTab('menu')} />
        )}

        {tab === 'bill' && (
          <BillView
            token={token}
            refreshKey={billKey}
            orders={orders}
            restaurant={{ ...restaurant, ...(menu?.restaurant ?? {}) }}
            billRequested={openCalls.includes('BILL')}
            onRequestBill={() => void call('BILL')}
            onBrowse={() => switchTab('menu')}
          />
        )}

        {/* Zona fija inferior: resumen del pedido de la mesa + navegación */}
        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-md">
          {tab === 'menu' && cart.totalQuantity > 0 && (
            <div className="px-4 pb-2">
              <button
                type="button"
                onClick={() => switchTab('order')}
                className="flex h-14 w-full animate-toast-in items-center gap-3 rounded-full bg-maiz pl-3 pr-5 text-tinta shadow-lift active:scale-[0.98]"
                aria-label={`Ver pedido de la mesa: ${cart.totalQuantity} productos, ${money(cart.cart.subtotal, currency)}`}
              >
                <span className="flex -space-x-2">
                  {cart.contributors.slice(0, 3).map((guest) => (
                    <GuestAvatar key={guest.id} guest={guest} size="sm" />
                  ))}
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-2 text-left font-bold">
                  <span className="truncate">Ver pedido</span>
                  <span key={cart.totalQuantity} className="grid h-6 min-w-6 shrink-0 animate-pop place-items-center rounded-full bg-tinta px-1.5 text-xs text-white">
                    {cart.totalQuantity}
                  </span>
                </span>
                <span className="shrink-0 font-bold tabular-nums">{money(cart.cart.subtotal, currency)}</span>
              </button>
            </div>
          )}

          <nav className="pb-safe flex justify-around rounded-t-3xl border-t border-hoja/10 bg-white px-2 pt-2 shadow-dock" aria-label="Navegación">
            <NavButton icon={BookOpenText} label="Carta" active={tab === 'menu'} onClick={() => switchTab('menu')} />
            <NavButton icon={ShoppingBag} label="Pedido" active={tab === 'order'} badge={cart.totalQuantity || undefined} dot={activeOrders > 0} onClick={() => switchTab('order')} />
            <NavButton icon={ReceiptText} label="Cuenta" active={tab === 'bill'} onClick={() => switchTab('bill')} />
            <NavButton icon={BellRing} label={waiterCalled ? 'Avisado' : 'Llamar'} active={false} highlight={waiterCalled} onClick={() => setCallSheet(true)} />
          </nav>
        </div>
      </div>

      {detail && (
        <ProductSheet
          product={detail}
          currency={currency}
          onClose={() => setDetail(null)}
          onAdd={(quantity, notes) => {
            cart.add(detail, quantity, notes);
            setDetail(null);
          }}
        />
      )}

      {callSheet && (
        <BottomSheet title="Llamar al camarero" onClose={() => setCallSheet(false)}>
          <div className="p-5 pt-6">
            <h2 className="font-display text-2xl font-bold text-tinta">{waiterCalled ? 'Tu camarero ya fue avisado' : '¿Llamamos a tu camarero?'}</h2>
            <p className="mt-1.5 text-tinta-soft">
              {waiterCalled ? 'Viene en camino a la mesa.' : `Le avisamos que la mesa ${tableNumber} lo necesita.`}
            </p>
            {!waiterCalled && (
              <button type="button" onClick={() => void call('WAITER')} className="mt-5 h-14 w-full rounded-full bg-maiz text-lg font-bold text-tinta active:scale-[0.98]">
                Llamar al camarero
              </button>
            )}
            <button type="button" onClick={() => setCallSheet(false)} className="mt-2 h-12 w-full rounded-full font-semibold text-tinta-soft">
              {waiterCalled ? 'Entendido' : 'Ahora no'}
            </button>
          </div>
        </BottomSheet>
      )}
    </div>
  );
}

function describeChange(change: CartChange): string {
  const who = change.by.alias;
  switch (change.action) {
    case 'added':
      return `${who} agregó ${change.productName}`;
    case 'removed':
      return `${who} quitó ${change.productName}`;
    case 'updated':
      return `${who} cambió ${change.productName}`;
    case 'ordered':
      return `${who} envió el pedido de la mesa`;
  }
}

interface NavButtonProps {
  icon: LucideIcon;
  label: string;
  active: boolean;
  badge?: number;
  dot?: boolean; // hay pedidos en curso
  highlight?: boolean;
  onClick: () => void;
}

function NavButton({ icon: Icon, label, active, badge, dot, highlight, onClick }: NavButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`relative flex w-20 flex-col items-center gap-0.5 rounded-2xl py-1.5 text-[11px] font-semibold transition-colors ${
        active ? 'text-hoja' : highlight ? 'text-rose-600' : 'text-tinta-soft'
      }`}
    >
      <span className={`relative grid h-8 w-14 place-items-center rounded-full transition-colors ${active ? 'bg-hoja-100' : ''}`}>
        <Icon className="h-[22px] w-[22px]" strokeWidth={active ? 2.4 : 2} aria-hidden />
        {badge !== undefined && (
          <span key={badge} className="absolute -top-1 right-1 grid h-5 min-w-5 animate-pop place-items-center rounded-full bg-guayaba px-1 text-[11px] font-bold text-white">
            {badge}
          </span>
        )}
        {badge === undefined && dot && <span className="absolute right-3 top-0.5 h-2.5 w-2.5 rounded-full bg-maiz ring-2 ring-white" aria-hidden />}
      </span>
      {label}
    </button>
  );
}
