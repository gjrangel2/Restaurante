import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

type Tone = 'info' | 'success' | 'error';

interface Toast {
  id: number;
  message: string;
  tone: Tone;
  emoji?: string;
}

interface ToastApi {
  show: (message: string, options?: { tone?: Tone; emoji?: string }) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => undefined });

export const useToast = () => useContext(ToastContext);

const TONES: Record<Tone, string> = {
  info: 'bg-gray-900 text-white',
  success: 'bg-emerald-700 text-white',
  error: 'bg-red-700 text-white',
};

/** Avisos breves arriba de la pantalla ("Cliente #2 agregó Pizza pepperoni"). Se anuncian a lectores de pantalla. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const show = useCallback<ToastApi['show']>((message, options = {}) => {
    const id = nextId.current++;
    setToasts((current) => [...current.slice(-2), { id, message, tone: options.tone ?? 'info', emoji: options.emoji }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 3200);
  }, []);

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`flex max-w-sm animate-toast-in items-center gap-2 rounded-full px-4 py-2 text-sm font-medium shadow-lift ${TONES[toast.tone]}`}
          >
            {toast.emoji && <span aria-hidden>{toast.emoji}</span>}
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
