import { Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { LazyImage } from '../../components/LazyImage';
import { Button, Card } from '../../components/StaffShell';
import { useToast } from '../../components/Toasts';
import { api, errorMessage } from '../../lib/api';
import { money } from '../../lib/format';
import type { Category, Product } from '../../lib/types';
import { Field, inputClass, Modal, Switch } from './ui';

type ProductDraft = Omit<Product, 'id' | 'categoryName'> & { id?: string };

const emptyProduct = (categoryId: string): ProductDraft => ({
  categoryId,
  name: '',
  description: '',
  price: 0,
  imageUrl: null,
  isAvailable: true,
  isFeatured: false,
  prepMinutes: 15,
  tags: [],
  sortOrder: 0,
});

/**
 * Gestión de la carta: CRUD de platos y categorías. Cada guardado dispara
 * menu:updated en el backend, así que los móviles de los clientes ven el
 * cambio sin recargar.
 */
export function MenuAdmin({ token, currency }: { token: string; currency: string }) {
  const toast = useToast();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [editing, setEditing] = useState<ProductDraft | null>(null);
  const [newCategory, setNewCategory] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([api.get<Product[]>('/admin/products', token), api.get<Category[]>('/admin/categories', token)]);
      setProducts(p);
      setCategories(c);
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    }
  }, [token, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const guard = async (action: () => Promise<unknown>, success?: string) => {
    try {
      await action();
      if (success) toast.show(success, { tone: 'success' });
      await load();
      return true;
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
      return false;
    }
  };

  const saveProduct = async (draft: ProductDraft) => {
    const { id, ...body } = draft;
    const saved = await guard(() => (id ? api.put(`/admin/products/${id}`, body, token) : api.post('/admin/products', body, token)), 'Plato guardado');
    if (saved) setEditing(null);
  };

  const activeCategories = categories.filter((category) => category.isActive);

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[1fr_320px]">
      <Card>
        <div className="flex items-center justify-between gap-3 border-b border-line p-4">
          <h2 className="font-semibold">Platos</h2>
          <Button disabled={activeCategories.length === 0} onClick={() => setEditing(emptyProduct(activeCategories[0].id))}>
            <Plus className="h-4 w-4" aria-hidden /> Nuevo plato
          </Button>
        </div>

        {products === null ? (
          <div className="m-4 h-64 animate-pulse rounded-2xl bg-sunken" />
        ) : products.length === 0 ? (
          <p className="p-8 text-center text-ink-soft">La carta está vacía. Crea una categoría y agrega tu primer plato.</p>
        ) : (
          <ul className="divide-y divide-line">
            {products.map((product) => (
              <li key={product.id} className="flex items-center gap-3 p-3 sm:px-4">
                <LazyImage variant="neutral" src={product.imageUrl} alt="" className="h-12 w-12 shrink-0 rounded-xl" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate font-medium">
                    {product.name}
                    {product.isFeatured && <Star className="h-3.5 w-3.5 shrink-0 fill-[#fab219] text-[#fab219]" aria-label="Destacado" />}
                  </p>
                  <p className="truncate text-sm text-ink-faint">
                    {product.categoryName}, {money(product.price, currency)}
                  </p>
                </div>
                <span className="hidden text-sm text-ink-faint sm:inline">{product.isAvailable ? 'Disponible' : 'Agotado'}</span>
                <Switch
                  checked={product.isAvailable}
                  label={`${product.name} disponible`}
                  onChange={(next) => void guard(() => api.patch(`/kitchen/products/${product.id}/availability`, { isAvailable: next }, token))}
                />
                <button type="button" onClick={() => setEditing(product)} className="grid h-9 w-9 place-items-center rounded-full text-ink-soft hover:bg-sunken" aria-label={`Editar ${product.name}`}>
                  <Pencil className="h-4 w-4" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => window.confirm(`¿Eliminar "${product.name}" de la carta?`) && void guard(() => api.delete(`/admin/products/${product.id}`, token), 'Plato eliminado')}
                  className="grid h-9 w-9 place-items-center rounded-full text-ink-soft hover:bg-sunken"
                  aria-label={`Eliminar ${product.name}`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 font-semibold">Categorías</h2>
        <ul className="space-y-1">
          {categories.map((category) =>
            renaming?.id === category.id ? (
              <li key={category.id}>
                <form
                  className="flex gap-2"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    const name = renaming.name.trim();
                    if (!name) return;
                    const saved = await guard(() => api.put(`/admin/categories/${category.id}`, { name, sortOrder: category.sortOrder, isActive: true }, token));
                    if (saved) setRenaming(null);
                  }}
                >
                  <input
                    autoFocus
                    value={renaming.name}
                    onChange={(event) => setRenaming({ id: category.id, name: event.target.value })}
                    onKeyDown={(event) => event.key === 'Escape' && setRenaming(null)}
                    aria-label={`Nuevo nombre para ${category.name}`}
                    className={inputClass}
                  />
                  <Button type="submit" variant="secondary">
                    Guardar
                  </Button>
                </form>
              </li>
            ) : (
              <li key={category.id} className="flex items-center gap-2 text-sm">
                <span className={`min-w-0 flex-1 truncate ${category.isActive ? '' : 'text-ink-faint line-through'}`}>{category.name}</span>
                <span className="tabular-nums text-ink-faint">{category.productCount}</span>
                <button
                  type="button"
                  onClick={() => setRenaming({ id: category.id, name: category.name })}
                  className="grid h-8 w-8 place-items-center rounded-full text-ink-soft hover:bg-sunken"
                  aria-label={`Renombrar ${category.name}`}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => void guard(() => api.delete(`/admin/categories/${category.id}`, token), 'Categoría eliminada')}
                  className="grid h-8 w-8 place-items-center rounded-full text-ink-soft hover:bg-sunken"
                  aria-label={`Eliminar ${category.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </li>
            ),
          )}
        </ul>
        <form
          className="mt-3 flex gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!newCategory.trim()) return;
            const created = await guard(() => api.post('/admin/categories', { name: newCategory.trim(), sortOrder: categories.length + 1 }, token));
            if (created) setNewCategory('');
          }}
        >
          <input value={newCategory} onChange={(event) => setNewCategory(event.target.value)} placeholder="Nueva categoría" aria-label="Nueva categoría" className={inputClass} />
          <Button type="submit" variant="secondary" aria-label="Agregar categoría">
            <Plus className="h-4 w-4" aria-hidden />
          </Button>
        </form>
      </Card>

      {editing && <ProductForm draft={editing} categories={activeCategories} onClose={() => setEditing(null)} onSave={saveProduct} />}
    </div>
  );
}

function ProductForm({ draft, categories, onClose, onSave }: { draft: ProductDraft; categories: Category[]; onClose: () => void; onSave: (draft: ProductDraft) => Promise<void> }) {
  const [form, setForm] = useState(draft);
  const [tags, setTags] = useState(draft.tags.join(', '));
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) => setForm((current) => ({ ...current, [key]: value }));

  return (
    <Modal title={draft.id ? 'Editar plato' : 'Nuevo plato'} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          await onSave({
            ...form,
            imageUrl: form.imageUrl?.trim() || null,
            tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
          });
          setSaving(false);
        }}
      >
        <Field label="Nombre">
          <input required maxLength={80} value={form.name} onChange={(event) => set('name', event.target.value)} className={inputClass} />
        </Field>
        <Field label="Descripción">
          <textarea rows={2} maxLength={300} value={form.description} onChange={(event) => set('description', event.target.value)} className={inputClass} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Precio">
            <input required type="number" min={0} step="any" value={form.price} onChange={(event) => set('price', Number(event.target.value))} className={inputClass} />
          </Field>
          <Field label="Categoría">
            <select value={form.categoryId} onChange={(event) => set('categoryId', event.target.value)} className={inputClass}>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Minutos de preparación">
            <input type="number" min={0} max={240} value={form.prepMinutes} onChange={(event) => set('prepMinutes', Number(event.target.value))} className={inputClass} />
          </Field>
          <Field label="Orden en la categoría">
            <input type="number" min={0} max={999} value={form.sortOrder} onChange={(event) => set('sortOrder', Number(event.target.value))} className={inputClass} />
          </Field>
        </div>
        <Field label="Foto (URL)" hint="Horizontal, de al menos 900 px de ancho.">
          <input type="url" value={form.imageUrl ?? ''} onChange={(event) => set('imageUrl', event.target.value)} placeholder="https://…" className={inputClass} />
        </Field>
        <Field label="Etiquetas" hint="Separadas por coma: vegetariano, para compartir…">
          <input value={tags} onChange={(event) => setTags(event.target.value)} className={inputClass} />
        </Field>
        <div className="flex flex-wrap gap-x-6 gap-y-3 text-sm">
          <span className="flex items-center gap-2">
            <Switch checked={form.isFeatured} onChange={(next) => set('isFeatured', next)} label="Destacado" /> Destacado, con foto grande
          </span>
          <span className="flex items-center gap-2">
            <Switch checked={form.isAvailable} onChange={(next) => set('isAvailable', next)} label="Disponible" /> Disponible
          </span>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar plato'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
