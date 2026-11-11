import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

/** Ventana modal para los formularios del admin. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-end sm:place-items-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 animate-fade-in bg-black/50" onClick={onClose} aria-hidden />
      <div className="relative max-h-[92dvh] w-full animate-sheet-up overflow-y-auto rounded-t-3xl border border-line bg-surface p-6 text-ink sm:max-w-lg sm:animate-fade-in sm:rounded-3xl">
        <div className="mb-5 flex items-center justify-between gap-3">
          <h2 className="font-display text-2xl font-bold">{title}</h2>
          <button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full text-ink-soft hover:bg-sunken" aria-label="Cerrar">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const inputClass =
  'w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-ink outline-none placeholder:text-ink-faint focus:border-ink disabled:opacity-60';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-ink-soft">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-ink-faint">{hint}</span>}
    </label>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-state-served' : 'bg-state-free'}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

/** <input type="datetime-local"> trabaja en hora local sin zona; estas dos funciones convierten desde y hacia ISO. */
export const toLocalInput = (iso: string): string => {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
export const fromLocalInput = (value: string): string => new Date(value).toISOString();
