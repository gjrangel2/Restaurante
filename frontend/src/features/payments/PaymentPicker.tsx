import { Banknote, Building2, CreditCard, FlaskConical, Wallet, type LucideIcon } from 'lucide-react';
import type { PaymentOption } from '../../lib/types';

export type PaymentChoice = 'CASH' | 'CARD_ON_DELIVERY' | PaymentOption['id'];

interface Option {
  id: PaymentChoice;
  label: string;
  detail: string;
  icon: LucideIcon;
  test?: boolean;
}

const ONLINE_ICON: Record<PaymentOption['id'], LucideIcon> = { WOMPI: CreditCard, MERCADOPAGO: Wallet, PSE: Building2 };

/**
 * Selector de medio de pago para el cliente (domicilio y cuenta de la mesa).
 * Los nombres de las pasarelas van en texto: el pago ocurre en su propia
 * página, no aquí. "Modo de prueba" avisa cuando no hay credenciales reales.
 */
export function PaymentPicker({
  online,
  offline = [],
  value,
  onChange,
}: {
  online: PaymentOption[];
  offline?: Array<'CASH' | 'CARD_ON_DELIVERY'>;
  value: PaymentChoice | null;
  onChange: (choice: PaymentChoice) => void;
}) {
  const options: Option[] = [
    ...online.map((o) => ({ id: o.id, label: o.id === 'PSE' ? 'PSE' : o.label, detail: o.detail, icon: ONLINE_ICON[o.id], test: !o.live })),
    ...offline.map((id) =>
      id === 'CASH'
        ? { id, label: 'Efectivo', detail: 'Pagas al recibir', icon: Banknote }
        : { id, label: 'Datáfono', detail: 'Tarjeta al recibir', icon: CreditCard },
    ),
  ];

  return (
    <div className="grid gap-2" role="radiogroup" aria-label="Medio de pago">
      {options.map((option) => {
        const selected = value === option.id;
        const Icon = option.icon;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.id)}
            className={`flex items-center gap-3 rounded-2xl border-2 px-4 py-3 text-left transition-colors ${
              selected ? 'border-hoja bg-hoja-100' : 'border-hoja/10 bg-white'
            }`}
          >
            <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${selected ? 'bg-hoja text-white' : 'bg-niebla text-hoja'}`}>
              <Icon className="h-5 w-5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold text-tinta">{option.label}</span>
              <span className="block text-sm text-tinta-soft">{option.detail}</span>
            </span>
            {option.test && (
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900" title="Sin credenciales: no se cobra dinero real">
                <FlaskConical className="h-3 w-3" aria-hidden /> Prueba
              </span>
            )}
            <span className={`h-5 w-5 shrink-0 rounded-full border-2 ${selected ? 'border-[6px] border-hoja' : 'border-hoja/25'}`} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
