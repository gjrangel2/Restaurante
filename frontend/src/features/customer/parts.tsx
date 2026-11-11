import { Clock, Minus, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LazyImage } from '../../components/LazyImage';
import { money } from '../../lib/format';
import type { CartLine, Guest, MenuCategory, Product, Promotion } from '../../lib/types';
import type { SharedCart } from './useSharedCart';

/**
 * Lo que la carta necesita de un carrito. Lo cumplen el carrito compartido de
 * la mesa (useSharedCart) y el carrito personal de domicilios (useLocalCart).
 */
export type MenuCart = Pick<SharedCart, 'add' | 'setQuantity' | 'myLine' | 'myQuantity' | 'othersWith'>;

// ----------------------------------------------------------------------------
// Comensales
// ----------------------------------------------------------------------------
/** Distintivo de un comensal: su número de cliente sobre su color. El borde amarillo marca "este soy yo". */
export function GuestAvatar({ guest, size = 'md', ring = false }: { guest: Pick<Guest, 'number' | 'alias' | 'color'>; size?: 'sm' | 'md'; ring?: boolean }) {
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full border-2 font-bold tabular-nums text-white ${
        size === 'sm' ? 'h-6 w-6 text-[11px]' : 'h-9 w-9 text-sm'
      } ${ring ? 'border-maiz' : 'border-white'}`}
      style={{ backgroundColor: guest.color }}
      title={guest.alias}
      aria-hidden
    >
      {guest.number}
    </span>
  );
}

// ----------------------------------------------------------------------------
// Selector de cantidad
// ----------------------------------------------------------------------------
export function Stepper({ quantity, onChange, label, size = 'md' }: { quantity: number; onChange: (next: number) => void; label: string; size?: 'md' | 'lg' }) {
  const button = size === 'lg' ? 'h-11 w-11' : 'h-9 w-9';
  return (
    <div className="flex items-center rounded-full bg-hoja text-white" role="group" aria-label={`Cantidad de ${label}`}>
      <button type="button" onClick={() => onChange(quantity - 1)} className={`grid ${button} place-items-center rounded-full active:scale-90`} aria-label={`Quitar uno de ${label}`}>
        <Minus className="h-4 w-4" aria-hidden />
      </button>
      <span key={quantity} className="min-w-5 animate-pop text-center text-sm font-bold tabular-nums" aria-live="polite">
        {quantity}
      </span>
      <button type="button" onClick={() => onChange(quantity + 1)} className={`grid ${button} place-items-center rounded-full active:scale-90`} aria-label={`Agregar uno de ${label}`}>
        <Plus className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

/** Botón de agregar de la carta: un "+" que se convierte en − n + cuando ya llevo ese plato. */
function QuickAdd({ product, cart }: { product: Product; cart: MenuCart }) {
  const mine = cart.myQuantity(product.id);
  const line = cart.myLine(product.id);

  if (mine > 0 && line) {
    return <Stepper quantity={mine} label={product.name} onChange={(next) => (next > mine ? cart.add(product) : cart.setQuantity(line, line.quantity - 1))} />;
  }
  return (
    <button
      type="button"
      onClick={() => cart.add(product)}
      className="relative grid h-9 w-9 place-items-center rounded-full bg-maiz text-tinta shadow-lift transition active:scale-90"
      aria-label={`Agregar ${product.name} al pedido`}
    >
      <Plus className="h-5 w-5" strokeWidth={2.5} aria-hidden />
      {mine > 0 && (
        <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-hoja px-1 text-[11px] font-bold text-white">{mine}</span>
      )}
    </button>
  );
}

/** Quién más en la mesa ya lleva este plato. */
function OthersChips({ lines }: { lines: CartLine[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {lines.map((line) => (
        <span key={line.id} className="flex items-center gap-1.5 rounded-full bg-niebla py-0.5 pl-2 pr-2.5 text-xs text-tinta-soft">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: line.guest.color }} aria-hidden />
          {line.guest.alias} lleva {line.quantity}
        </span>
      ))}
    </div>
  );
}

const SoldOut = () => <span className="rounded-full bg-tinta px-2.5 py-1 text-xs font-semibold text-white">Agotado</span>;

// ----------------------------------------------------------------------------
// Platos
// ----------------------------------------------------------------------------
interface ProductProps {
  product: Product;
  cart: MenuCart;
  currency: string;
  highlighted: boolean; // el banner que lo anuncia acaba de traer al cliente hasta aquí
  onOpen: (product: Product) => void;
}

/** Plato destacado: la foto manda. */
export function FeaturedProduct({ product, cart, currency, highlighted, onOpen }: ProductProps) {
  return (
    <article
      id={`product-${product.id}`}
      className={`relative scroll-mt-32 overflow-hidden rounded-3xl bg-white shadow-lift transition-shadow ${highlighted ? 'ring-4 ring-maiz' : ''}`}
    >
      <button type="button" onClick={() => onOpen(product)} className="block w-full text-left" aria-label={`Ver ${product.name}`}>
        <LazyImage src={product.imageUrl} alt={product.name} className={`aspect-[16/10] w-full ${product.isAvailable ? '' : 'opacity-60 grayscale'}`} />
        <div className="p-4 pr-16">
          <h3 className="font-display text-xl font-bold leading-tight text-tinta">{product.name}</h3>
          <p className="mt-1 line-clamp-2 text-sm text-tinta-soft">{product.description}</p>
          <p className="mt-2 font-semibold tabular-nums text-tinta">{money(product.price, currency)}</p>
        </div>
      </button>
      <div className="px-4 pb-3 empty:hidden">
        <OthersChips lines={cart.othersWith(product.id)} />
      </div>
      <div className="absolute bottom-4 right-4">{product.isAvailable ? <QuickAdd product={product} cart={cart} /> : <SoldOut />}</div>
    </article>
  );
}

/** Plato en fila compacta: texto a la izquierda, foto a la derecha. */
export function ProductRow({ product, cart, currency, highlighted, onOpen }: ProductProps) {
  return (
    <article
      id={`product-${product.id}`}
      className={`relative flex scroll-mt-32 gap-3 py-3 transition-shadow ${highlighted ? 'rounded-2xl ring-4 ring-maiz ring-offset-4' : ''}`}
    >
      <button type="button" onClick={() => onOpen(product)} className="min-w-0 flex-1 text-left" aria-label={`Ver ${product.name}`}>
        <h3 className={`font-semibold leading-snug ${product.isAvailable ? 'text-tinta' : 'text-tinta-soft'}`}>{product.name}</h3>
        <p className="mt-0.5 line-clamp-2 text-sm text-tinta-soft">{product.description}</p>
        <p className="mt-1.5 font-semibold tabular-nums text-tinta">{money(product.price, currency)}</p>
        <OthersChips lines={cart.othersWith(product.id)} />
      </button>
      <div className="relative h-24 w-24 shrink-0">
        <button type="button" onClick={() => onOpen(product)} tabIndex={-1} aria-hidden className="block h-full w-full">
          <LazyImage src={product.imageUrl} alt="" className={`h-full w-full rounded-2xl ${product.isAvailable ? '' : 'opacity-60 grayscale'}`} />
        </button>
        <div className="absolute -bottom-2 -right-1">{product.isAvailable ? <QuickAdd product={product} cart={cart} /> : <SoldOut />}</div>
      </div>
    </article>
  );
}

// ----------------------------------------------------------------------------
// Hoja inferior (detalle de plato, confirmaciones)
// ----------------------------------------------------------------------------
export function BottomSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden'; // el fondo no se desplaza mientras la hoja está abierta
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 animate-fade-in bg-tinta/50" onClick={onClose} aria-hidden />
      <div className="pb-safe relative max-h-[92dvh] w-full max-w-md animate-sheet-up overflow-y-auto rounded-t-[28px] bg-white">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 grid h-9 w-9 place-items-center rounded-full bg-white/90 text-tinta shadow-lift"
          aria-label="Cerrar"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
        {children}
      </div>
    </div>
  );
}

/** Detalle de un plato: foto grande, nota para cocina y cantidad. */
export function ProductSheet({ product, currency, onClose, onAdd }: { product: Product; currency: string; onClose: () => void; onAdd: (quantity: number, notes: string) => void }) {
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState('');

  return (
    <BottomSheet title={product.name} onClose={onClose}>
      <LazyImage src={product.imageUrl} alt={product.name} eager className="aspect-[4/3] w-full" />
      <div className="p-5">
        <h2 className="font-display text-2xl font-bold leading-tight text-tinta">{product.name}</h2>
        <p className="mt-1.5 text-tinta-soft">{product.description}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-tinta-soft">
          <span className="flex items-center gap-1">
            <Clock className="h-4 w-4" aria-hidden /> {product.prepMinutes} min aprox.
          </span>
          {product.tags.map((tag) => (
            <span key={tag} className="rounded-full bg-niebla px-2.5 py-0.5">
              {tag}
            </span>
          ))}
        </div>

        {product.isAvailable ? (
          <>
            <label className="mt-5 block">
              <span className="text-sm font-semibold text-tinta">¿Algo que deba saber la cocina?</span>
              <input
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                maxLength={200}
                placeholder="Sin cebolla, término medio…"
                className="mt-1.5 w-full rounded-2xl border border-hoja-100 bg-niebla px-4 py-3 text-tinta outline-none placeholder:text-tinta-soft/70 focus:border-hoja"
              />
            </label>
            <div className="mt-5 flex items-center gap-3">
              <Stepper size="lg" quantity={quantity} label={product.name} onChange={(next) => setQuantity(Math.max(1, Math.min(20, next)))} />
              <button
                type="button"
                onClick={() => onAdd(quantity, notes.trim())}
                className="flex h-12 flex-1 items-center justify-between gap-3 whitespace-nowrap rounded-full bg-maiz px-5 font-semibold text-tinta active:scale-[0.98]"
              >
                <span>Agregar</span>
                <span className="tabular-nums">{money(product.price * quantity, currency)}</span>
              </button>
            </div>
          </>
        ) : (
          <p className="mt-5 rounded-2xl bg-niebla p-4 text-sm text-tinta-soft">Este plato se agotó por hoy.</p>
        )}
      </div>
    </BottomSheet>
  );
}

// ----------------------------------------------------------------------------
// Banners promocionales
// ----------------------------------------------------------------------------
export function PromoCarousel({ promotions, onOpen }: { promotions: Promotion[]; onOpen: (promotion: Promotion) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);

  const onScroll = () => {
    const element = track.current;
    if (!element) return;
    setIndex(Math.round(element.scrollLeft / (element.scrollWidth / promotions.length)));
  };

  return (
    <div>
      <div ref={track} onScroll={onScroll} className="no-scrollbar flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth px-5">
        {promotions.map((promotion, i) => (
          <button
            key={promotion.id}
            type="button"
            onClick={() => onOpen(promotion)}
            className={`relative aspect-[2/1] shrink-0 snap-center overflow-hidden rounded-3xl bg-hoja-700 text-left shadow-lift ${promotions.length > 1 ? 'w-[88%]' : 'w-full'}`}
          >
            <LazyImage plain src={promotion.imageUrl} alt="" eager={i === 0} className="absolute inset-0 h-full w-full !bg-hoja-700" />
            <div className="absolute inset-0 bg-gradient-to-t from-tinta/85 via-tinta/30 to-transparent" aria-hidden />
            <div className="absolute inset-x-0 bottom-0 p-4 text-white">
              <p className="font-display text-2xl font-bold leading-none">{promotion.title}</p>
              {promotion.subtitle && <p className="mt-1 text-sm text-white/85">{promotion.subtitle}</p>}
            </div>
          </button>
        ))}
      </div>
      {promotions.length > 1 && (
        <div className="mt-3 flex justify-center gap-1.5" aria-hidden>
          {promotions.map((promotion, i) => (
            <span key={promotion.id} className={`h-1.5 rounded-full transition-all ${i === index ? 'w-5 bg-hoja' : 'w-1.5 bg-hoja/25'}`} />
          ))}
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Categorías: barra fija que sigue al scroll
// ----------------------------------------------------------------------------
export function CategoryPills({ categories, activeId, onSelect }: { categories: MenuCategory[]; activeId: string | null; onSelect: (id: string) => void }) {
  const refs = useRef(new Map<string, HTMLButtonElement>());

  // La categoría activa siempre queda a la vista dentro de la barra.
  useEffect(() => {
    if (activeId) refs.current.get(activeId)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [activeId]);

  return (
    <nav className="sticky top-0 z-20 border-b border-hoja/10 bg-white/95 backdrop-blur" aria-label="Categorías de la carta">
      <div className="no-scrollbar flex gap-2 overflow-x-auto px-5 py-3">
        {categories.map((category) => {
          const active = category.id === activeId;
          return (
            <button
              key={category.id}
              ref={(element) => {
                if (element) refs.current.set(category.id, element);
                else refs.current.delete(category.id);
              }}
              type="button"
              onClick={() => onSelect(category.id)}
              aria-current={active ? 'true' : undefined}
              className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${active ? 'bg-hoja text-white' : 'bg-niebla text-tinta-soft'}`}
            >
              {category.name}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

// ----------------------------------------------------------------------------
// Skeleton de la carta mientras carga
// ----------------------------------------------------------------------------
function Bone({ className }: { className: string }) {
  return (
    <div className={`relative overflow-hidden bg-niebla ${className}`}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/70 to-transparent" />
    </div>
  );
}

export function MenuSkeleton() {
  return (
    <div aria-busy="true" aria-label="Cargando la carta">
      <div className="px-5">
        <Bone className="aspect-[2/1] w-full rounded-3xl" />
      </div>
      <div className="flex gap-2 px-5 py-4">
        {['w-24', 'w-28', 'w-32', 'w-20'].map((width) => (
          <Bone key={width} className={`h-9 rounded-full ${width}`} />
        ))}
      </div>
      <div className="space-y-5 px-5">
        <Bone className="h-7 w-40 rounded-lg" />
        <Bone className="aspect-[16/10] w-full rounded-3xl" />
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex gap-3">
            <div className="flex-1 space-y-2 py-1">
              <Bone className="h-5 w-3/5 rounded-md" />
              <Bone className="h-4 w-full rounded-md" />
              <Bone className="h-4 w-1/4 rounded-md" />
            </div>
            <Bone className="h-24 w-24 rounded-2xl" />
          </div>
        ))}
      </div>
    </div>
  );
}
