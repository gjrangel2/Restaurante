import { UtensilsCrossed } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface LazyImageProps {
  src: string | null | undefined;
  alt: string;
  className?: string;
  /** Carga inmediata para lo que ya está en pantalla al abrir (primer banner, primer destacado). */
  eager?: boolean;
  /** 'brand' usa los tonos de la app del cliente; 'neutral' se adapta al tema claro/oscuro del personal. */
  variant?: 'brand' | 'neutral';
  /** Sin icono de respaldo: si la imagen falla queda el fondo liso del contenedor (banners con texto encima). */
  plain?: boolean;
}

/**
 * Imagen con carga diferida:
 *   1. Mientras no se acerca a la pantalla, no se descarga (IntersectionObserver
 *      con 200 px de margen, para que ya esté lista al llegar con el scroll).
 *   2. Mientras descarga, muestra un skeleton con brillo.
 *   3. Al terminar, aparece con un fundido corto.
 *   4. Si la URL falla o el plato no tiene foto, queda un marcador sobrio.
 */
export function LazyImage({ src, alt, className = '', eager = false, variant = 'brand', plain = false }: LazyImageProps) {
  const holder = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(eager);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>(src ? 'loading' : 'error');

  useEffect(() => {
    setStatus(src ? 'loading' : 'error');
  }, [src]);

  useEffect(() => {
    if (visible || !holder.current) return;
    if (!('IntersectionObserver' in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(holder.current);
    return () => observer.disconnect();
  }, [visible]);

  return (
    <div ref={holder} className={`relative overflow-hidden ${variant === 'brand' ? 'bg-niebla' : 'bg-sunken'} ${className}`}>
      {status === 'loading' && !plain && (
        <div className="absolute inset-0 overflow-hidden" aria-hidden>
          <div
            className={`absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent to-transparent ${variant === 'brand' ? 'via-white/70' : 'via-ink-faint/15'}`}
          />
        </div>
      )}

      {status === 'error' && !plain && (
        <div
          className={`absolute inset-0 grid place-items-center ${variant === 'brand' ? 'bg-hoja-100 text-hoja/40' : 'bg-sunken text-ink-faint/60'}`}
          role="img"
          aria-label={alt}
        >
          <UtensilsCrossed className="h-1/3 max-h-10 w-auto" strokeWidth={1.5} aria-hidden />
        </div>
      )}

      {src && visible && status !== 'error' && (
        <img
          src={src}
          alt={alt}
          decoding="async"
          loading={eager ? 'eager' : 'lazy'}
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('error')}
          className={`h-full w-full object-cover transition-opacity duration-500 ${status === 'loaded' ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
    </div>
  );
}
