import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { requireGuest, requireStaff } from './auth/middleware.js';
import { signStaffToken, type StaffRole } from './auth/tokens.js';
import { query, queryOne } from './db/pool.js';
import { parse, unauthorized } from './http.js';
import { getKpis } from './modules/admin.service.js';
import { payAndClose, previewBill } from './modules/billing.service.js';
import { getCart } from './modules/cart.service.js';
import { joinTable, listGuests } from './modules/guests.service.js';
import { listInventory, restock } from './modules/inventory.service.js';
import * as menu from './modules/menu.service.js';
import * as orders from './modules/orders.service.js';
import { getPublicRestaurant, getRestaurant, publicRestaurant } from './modules/restaurant.js';
import * as tables from './modules/tables.service.js';

/**
 * Mapa de la API y su RBAC
 *
 *   /api/public/*   Cliente sin sesión    carta y puerta de entrada del QR
 *   /api/guest/*    Cliente con token     solo con la mesa abierta (requireGuest)
 *   /api/auth/*     Personal              login
 *   /api/tables/*   ADMIN, WAITER         mapa, apertura, llamados, cobro
 *   /api/orders/*   ADMIN, WAITER         confirmar, rechazar, entregar comandas
 *   /api/kitchen/*  ADMIN, KITCHEN        cola de cocina, estado de platos, agotados
 *   /api/admin/*    ADMIN                 KPIs, inventario, carta, banners
 */
export const api = Router();

const id = z.string().uuid();
const SALA: StaffRole[] = ['ADMIN', 'WAITER'];
const COCINA: StaffRole[] = ['ADMIN', 'KITCHEN'];

api.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'frictionless-order', time: new Date().toISOString() });
});

// ----------------------------------------------------------------------------
// Público (cliente sin autenticación)
// ----------------------------------------------------------------------------
api.get('/public/menu', async (_req, res) => {
  const restaurant = await getPublicRestaurant();
  res.json({ restaurant: publicRestaurant(restaurant), ...(await menu.getPublicMenu(restaurant.id)) });
});

// Puerta de entrada del QR estático: /mesa/12 llama aquí.
api.post('/public/tables/:number/join', async (req, res) => {
  const number = parse(z.coerce.number().int().positive(), req.params.number);
  const body = parse(z.object({ token: z.string().max(2000).optional() }), req.body ?? {});
  res.json(await joinTable(number, body.token));
});

// ----------------------------------------------------------------------------
// Cliente con token de sesión de mesa
// ----------------------------------------------------------------------------
api.get('/guest/state', requireGuest, async (req, res) => {
  const guest = req.guest!;
  const [cart, sessionOrders, guests, calls] = await Promise.all([
    getCart(guest.sid),
    orders.listSessionOrders(guest.sid),
    listGuests(guest.sid),
    query<{ type: 'WAITER' | 'BILL' }>('SELECT type FROM waiter_calls WHERE session_id = $1 AND attended_at IS NULL', [guest.sid]),
  ]);
  res.json({
    me: { id: guest.sub, number: guest.number, alias: guest.alias, color: guest.color },
    cart,
    orders: sessionOrders,
    guests,
    openCalls: calls.map((c) => c.type),
  });
});

api.post('/guest/orders', requireGuest, async (req, res) => {
  res.status(201).json(await orders.submitOrder(req.guest!));
});

api.post('/guest/calls', requireGuest, async (req, res) => {
  const { type } = parse(z.object({ type: z.enum(['WAITER', 'BILL']) }), req.body);
  await tables.createCall(req.guest!, type);
  res.status(201).json({ ok: true });
});

// ----------------------------------------------------------------------------
// Autenticación del personal
// ----------------------------------------------------------------------------
api.post('/auth/login', async (req, res) => {
  const { email, password } = parse(z.object({ email: z.string().trim().min(3).max(200), password: z.string().min(1).max(200) }), req.body);
  const user = await queryOne<{ id: string; restaurant_id: string; full_name: string; role: StaffRole; password_hash: string }>(
    'SELECT id, restaurant_id, full_name, role, password_hash FROM users WHERE lower(email) = lower($1) AND is_active',
    [email],
  );
  // Mismo mensaje exista o no el usuario: no se revela qué correos están registrados.
  if (!user || !(await bcrypt.compare(password, user.password_hash))) throw unauthorized('Correo o contraseña incorrectos');

  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  const restaurant = await getRestaurant(user.restaurant_id);
  res.json({
    token: signStaffToken({ sub: user.id, rid: user.restaurant_id, role: user.role, name: user.full_name }),
    user: { id: user.id, name: user.full_name, role: user.role },
    restaurant: { name: restaurant.name, currency: restaurant.currency, suggestedTipRate: restaurant.suggestedTipRate },
  });
});

api.get('/auth/me', requireStaff(), async (req, res) => {
  const staff = req.staff!;
  const restaurant = await getRestaurant(staff.rid);
  res.json({
    user: { id: staff.sub, name: staff.name, role: staff.role },
    restaurant: { name: restaurant.name, currency: restaurant.currency, suggestedTipRate: restaurant.suggestedTipRate },
  });
});

// ----------------------------------------------------------------------------
// Sala: mapa de mesas, sesiones, llamados y cobro
// ----------------------------------------------------------------------------
api.get('/tables', requireStaff(...SALA), async (req, res) => {
  res.json(await tables.listTables(req.staff!.rid));
});

api.get('/tables/:id', requireStaff(...SALA), async (req, res) => {
  const staff = req.staff!;
  const tableId = parse(id, req.params.id);
  const table = await tables.getTable(staff.rid, tableId);
  const [tableOrders, guests, bill] = await Promise.all([
    table.session ? orders.listSessionOrders(table.session.id) : [],
    table.session ? listGuests(table.session.id) : [],
    previewBill(staff.rid, tableId),
  ]);
  res.json({ table, orders: tableOrders, guests, bill });
});

api.post('/tables/:id/open', requireStaff(...SALA), async (req, res) => {
  res.status(201).json(await tables.openTable(req.staff!, parse(id, req.params.id)));
});

api.post('/tables/:id/cancel', requireStaff(...SALA), async (req, res) => {
  res.json(await tables.cancelOpenTable(req.staff!, parse(id, req.params.id)));
});

api.post('/tables/:id/attend', requireStaff(...SALA), async (req, res) => {
  res.json(await tables.attendCalls(req.staff!, parse(id, req.params.id)));
});

api.get('/tables/:id/bill', requireStaff(...SALA), async (req, res) => {
  const tipRate = req.query.tipRate === undefined ? undefined : parse(z.coerce.number().min(0).max(30), req.query.tipRate);
  res.json(await previewBill(req.staff!.rid, parse(id, req.params.id), tipRate));
});

api.post('/tables/:id/pay', requireStaff(...SALA), async (req, res) => {
  const input = parse(
    z.object({
      method: z.enum(['CASH', 'CARD', 'TRANSFER']),
      amountReceived: z.number().min(0).max(1_000_000_000),
      tipRate: z.number().min(0).max(30),
      customerName: z.string().trim().max(120).optional(),
      customerDoc: z.string().trim().max(30).optional(),
      customerEmail: z.string().trim().email().max(200).optional().or(z.literal('')),
    }),
    req.body,
  );
  res.status(201).json(await payAndClose(req.staff!, parse(id, req.params.id), input));
});

api.post('/orders/:id/confirm', requireStaff(...SALA), async (req, res) => {
  res.json(await orders.confirmOrder(req.staff!, parse(id, req.params.id)));
});

api.post('/orders/:id/reject', requireStaff(...SALA), async (req, res) => {
  res.json(await orders.rejectOrder(req.staff!, parse(id, req.params.id)));
});

api.post('/orders/:id/serve', requireStaff(...SALA), async (req, res) => {
  res.json(await orders.serveOrder(req.staff!, parse(id, req.params.id)));
});

// ----------------------------------------------------------------------------
// Cocina
// ----------------------------------------------------------------------------
api.get('/kitchen/orders', requireStaff(...COCINA), async (req, res) => {
  res.json(await orders.listKitchenOrders(req.staff!.rid));
});

api.patch('/kitchen/items/:id', requireStaff(...COCINA), async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['PENDING', 'PREPARING', 'READY']) }), req.body);
  res.json(await orders.setItemStatus(req.staff!, parse(id, req.params.id), status));
});

api.patch('/kitchen/orders/:id', requireStaff(...COCINA), async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['PREPARING', 'READY']) }), req.body);
  res.json(await orders.bumpOrder(req.staff!, parse(id, req.params.id), status));
});

api.get('/kitchen/inventory', requireStaff(...COCINA), async (req, res) => {
  res.json(await listInventory(req.staff!.rid));
});

api.get('/kitchen/products', requireStaff(...COCINA), async (req, res) => {
  res.json(await menu.listProducts(req.staff!.rid));
});

api.patch('/kitchen/products/:id/availability', requireStaff(...COCINA), async (req, res) => {
  const { isAvailable } = parse(z.object({ isAvailable: z.boolean() }), req.body);
  res.json(await menu.setProductAvailability(req.staff!.rid, parse(id, req.params.id), isAvailable));
});

// ----------------------------------------------------------------------------
// Administración
// ----------------------------------------------------------------------------
const admin = Router();
admin.use(requireStaff('ADMIN'));

admin.get('/kpis', async (req, res) => {
  const days = parse(z.coerce.number().int().min(1).max(90).default(7), req.query.days);
  res.json(await getKpis(req.staff!.rid, days));
});

admin.get('/inventory', async (req, res) => {
  res.json(await listInventory(req.staff!.rid));
});

admin.post('/inventory/:id/restock', async (req, res) => {
  const { quantity, note } = parse(
    z.object({ quantity: z.number().refine((n) => n !== 0, 'La cantidad no puede ser 0'), note: z.string().trim().max(200).optional() }),
    req.body,
  );
  await restock(req.staff!, parse(id, req.params.id), quantity, note);
  res.json(await listInventory(req.staff!.rid));
});

admin.get('/categories', async (req, res) => {
  res.json(await menu.listCategories(req.staff!.rid));
});
admin.post('/categories', async (req, res) => {
  res.status(201).json(await menu.createCategory(req.staff!.rid, parse(menu.categorySchema, req.body)));
});
admin.put('/categories/:id', async (req, res) => {
  res.json(await menu.updateCategory(req.staff!.rid, parse(id, req.params.id), parse(menu.categorySchema, req.body)));
});
admin.delete('/categories/:id', async (req, res) => {
  await menu.deleteCategory(req.staff!.rid, parse(id, req.params.id));
  res.status(204).end();
});

admin.get('/products', async (req, res) => {
  res.json(await menu.listProducts(req.staff!.rid));
});
admin.post('/products', async (req, res) => {
  res.status(201).json(await menu.createProduct(req.staff!.rid, parse(menu.productSchema, req.body)));
});
admin.put('/products/:id', async (req, res) => {
  res.json(await menu.updateProduct(req.staff!.rid, parse(id, req.params.id), parse(menu.productSchema, req.body)));
});
admin.delete('/products/:id', async (req, res) => {
  await menu.deleteProduct(req.staff!.rid, parse(id, req.params.id));
  res.status(204).end();
});

admin.get('/promotions', async (req, res) => {
  res.json(await menu.listPromotions(req.staff!.rid));
});
admin.post('/promotions', async (req, res) => {
  res.status(201).json(await menu.createPromotion(req.staff!.rid, parse(menu.promotionSchema, req.body)));
});
admin.put('/promotions/:id', async (req, res) => {
  res.json(await menu.updatePromotion(req.staff!.rid, parse(id, req.params.id), parse(menu.promotionSchema, req.body)));
});
admin.delete('/promotions/:id', async (req, res) => {
  await menu.deletePromotion(req.staff!.rid, parse(id, req.params.id));
  res.status(204).end();
});

api.use('/admin', admin);
