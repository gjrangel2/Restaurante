import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { LazyImage } from '../../components/LazyImage';
import { Button, Card } from '../../components/StaffShell';
import { useToast } from '../../components/Toasts';
import { api, errorMessage } from '../../lib/api';
import { useNow } from '../../lib/format';
import type { Product, Promotion } from '../../lib/types';
import { Field, fromLocalInput, inputClass, Modal, Switch, toLocalInput } from './ui';

type Draft = Omit<Promotion, 'id'> & { id?: string };

const newDraft = (): Draft => {
  const start = new Date();
  const end = new Date(start.getTime() + 7 * 24 * 3600_000);
  return { title: '', subtitle: '', imageUrl: null, productId: null, startsAt: start.toISOString(), endsAt: end.toISOString(), isActive: true };
};

const when = (iso: string) => new Date(iso).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** En qué momento de su vida está un banner respecto al reloj. */
function phase(promotion: Promotion, now: number): { text: string; className: string } {
  if (!promotion.isActive) return { text: 'Pausado', className: 'bg-sunken text-ink-faint' };
  if (now < new Date(promotion.startsAt).getTime()) return { text: 'Programado', className: 'bg-state-occupied text-white' };
  if (now >= new Date(promotion.endsAt).getTime()) return { text: 'Finalizado', className: 'bg-sunken text-ink-faint' };
  return { text: 'En pantalla', className: 'bg-state-served text-white' };
}

/** CRUD de banners de la app del cliente: título, imagen y ventana de fechas. */
export function PromotionsAdmin({ token }: { token: string }) {
  const toast = useToast();
  const now = useNow();
  const [promotions, setPromotions] = useState<Promotion[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);

  const load = useCallback(async () => {
    try {
      const [promos, menu] = await Promise.all([api.get<Promotion[]>('/admin/promotions', token), api.get<Product[]>('/admin/products', token)]);
      setPromotions(promos);
      setProducts(menu);
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    }
  }, [token, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (draft: Draft) => {
    const { id, ...body } = draft;
    try {
      await (id ? api.put(`/admin/promotions/${id}`, body, token) : api.post('/admin/promotions', body, token));
      toast.show('Banner guardado', { tone: 'success' });
      setEditing(null);
      await load();
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    }
  };

  const remove = async (promotion: Promotion) => {
    if (!window.confirm(`¿Eliminar el banner "${promotion.title}"?`)) return;
    try {
      await api.delete(`/admin/promotions/${promotion.id}`, token);
      toast.show('Banner eliminado', { tone: 'success' });
      await load();
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between gap-3 border-b border-line p-4">
        <div>
          <h2 className="font-semibold">Banners promocionales</h2>
          <p className="text-sm text-ink-faint">Aparecen arriba de la carta del cliente entre su fecha de inicio y de fin.</p>
        </div>
        <Button onClick={() => setEditing(newDraft())}>
          <Plus className="h-4 w-4" aria-hidden /> Nuevo banner
        </Button>
      </div>

      {promotions === null ? (
        <div className="m-4 h-40 animate-pulse rounded-2xl bg-sunken" />
      ) : promotions.length === 0 ? (
        <p className="p-8 text-center text-ink-soft">Aún no hay banners. Crea el primero para anunciar un plato o una promoción.</p>
      ) : (
        <ul className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
          {promotions.map((promotion) => {
            const state = phase(promotion, now);
            return (
              <li key={promotion.id} className="overflow-hidden rounded-2xl border border-line">
                <div className="relative">
                  <LazyImage variant="neutral" src={promotion.imageUrl} alt="" className="aspect-[2/1] w-full" />
                  <span className={`absolute left-3 top-3 rounded-full px-2.5 py-0.5 text-xs font-semibold ${state.className}`}>{state.text}</span>
                </div>
                <div className="flex items-start gap-2 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{promotion.title}</p>
                    <p className="truncate text-sm text-ink-soft">{promotion.subtitle}</p>
                    <p className="mt-1 text-xs text-ink-faint">
                      Del {when(promotion.startsAt)} al {when(promotion.endsAt)}
                    </p>
                  </div>
                  <button type="button" onClick={() => setEditing(promotion)} className="grid h-9 w-9 place-items-center rounded-full text-ink-soft hover:bg-sunken" aria-label={`Editar ${promotion.title}`}>
                    <Pencil className="h-4 w-4" aria-hidden />
                  </button>
                  <button type="button" onClick={() => void remove(promotion)} className="grid h-9 w-9 place-items-center rounded-full text-ink-soft hover:bg-sunken" aria-label={`Eliminar ${promotion.title}`}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editing && <PromotionForm draft={editing} products={products} onClose={() => setEditing(null)} onSave={save} />}
    </Card>
  );
}

function PromotionForm({ draft, products, onClose, onSave }: { draft: Draft; products: Product[]; onClose: () => void; onSave: (draft: Draft) => Promise<void> }) {
  const [form, setForm] = useState(draft);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setForm((current) => ({ ...current, [key]: value }));
  const invalidWindow = new Date(form.endsAt) <= new Date(form.startsAt);

  return (
    <Modal title={draft.id ? 'Editar banner' : 'Nuevo banner'} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          await onSave({ ...form, imageUrl: form.imageUrl?.trim() || null });
          setSaving(false);
        }}
      >
        <Field label="Título">
          <input required maxLength={80} value={form.title} onChange={(event) => set('title', event.target.value)} className={inputClass} />
        </Field>
        <Field label="Texto de apoyo">
          <input maxLength={140} value={form.subtitle} onChange={(event) => set('subtitle', event.target.value)} className={inputClass} />
        </Field>
        <Field label="Imagen (URL)" hint="Horizontal, proporción 2:1.">
          <input type="url" value={form.imageUrl ?? ''} onChange={(event) => set('imageUrl', event.target.value)} placeholder="https://…" className={inputClass} />
        </Field>
        <Field label="Plato que anuncia" hint="Al tocar el banner, la carta salta a ese plato.">
          <select value={form.productId ?? ''} onChange={(event) => set('productId', event.target.value || null)} className={inputClass}>
            <option value="">Ninguno</option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Empieza">
            <input required type="datetime-local" value={toLocalInput(form.startsAt)} onChange={(event) => event.target.value && set('startsAt', fromLocalInput(event.target.value))} className={inputClass} />
          </Field>
          <Field label="Termina">
            <input required type="datetime-local" value={toLocalInput(form.endsAt)} onChange={(event) => event.target.value && set('endsAt', fromLocalInput(event.target.value))} className={inputClass} />
          </Field>
        </div>
        {invalidWindow && <p className="text-sm font-medium text-state-calling">La fecha de fin debe ser posterior a la de inicio.</p>}
        <span className="flex items-center gap-2 text-sm">
          <Switch checked={form.isActive} onChange={(next) => set('isActive', next)} label="Activo" /> Activo
        </span>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={saving || invalidWindow}>
            {saving ? 'Guardando…' : 'Guardar banner'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
