// =====================================================================
// Prueba de humo de punta a punta (69 comprobaciones).
//
// Recorre el flujo real contra el sistema levantado: RBAC, anti-fraude del
// QR, carrito colaborativo por WebSocket, comanda → cocina → entrega,
// llamado, cobro con factura simulada, cierre de mesa y CRUD del admin.
//
// Necesita la base de datos RECIÉN creada (asume los datos demo de V2 y V3
// y los modifica):
//
//   docker compose down -v && docker compose up --build -d
//   cd backend && npm install && npm run smoke
//
// Variables opcionales: BASE (http://localhost:8080) y DATABASE_URL.
// =====================================================================
import { io } from 'socket.io-client';
import pg from 'pg';
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://localhost:8080';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://frictionless:frictionless@localhost:5433/frictionless' });
await db.connect();

let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };
async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
const login = async (email) => (await call('POST', '/api/auth/login', { body: { email, password: 'demo1234' } })).data.token;
const connect = (auth) => new Promise((resolve, reject) => { const s = io(BASE, { auth, transports: ['websocket'], forceNew: true }); s.events = []; s.onAny((ev, p) => s.events.push([ev, p])); s.on('connect', () => resolve(s)); s.on('connect_error', (e) => reject(e)); });
const waitFor = async (s, ev, pred = () => true, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const hit = s.events.find(([e, p]) => e === ev && pred(p)); if (hit) return hit[1]; await new Promise((r) => setTimeout(r, 25)); } throw new Error(`timeout esperando ${ev}`); };
const emitAck = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('Auth y RBAC');
const [sala, cocina, admin] = await Promise.all([login('sala@demo.test'), login('cocina@demo.test'), login('admin@demo.test')]);
assert.ok(sala && cocina && admin); ok('login de los 3 roles');
assert.equal((await call('POST', '/api/auth/login', { body: { email: 'sala@demo.test', password: 'mala' } })).status, 401); ok('contraseña incorrecta → 401');
assert.equal((await call('GET', '/api/tables')).status, 401); ok('sin token → 401');
assert.equal((await call('GET', '/api/tables', { token: cocina })).status, 403); ok('cocina no ve el mapa → 403');
assert.equal((await call('GET', '/api/admin/kpis', { token: sala })).status, 403); ok('camarero no ve admin → 403');
assert.equal((await call('GET', '/api/kitchen/orders', { token: sala })).status, 403); ok('camarero no ve cocina → 403');

console.log('Mapa');
let tables = (await call('GET', '/api/tables', { token: sala })).data;
assert.equal(tables.length, 16);
const byNum = (n) => tables.find((t) => t.number === n);
assert.equal(byNum(2).status, 'FREE'); assert.equal(byNum(3).status, 'OCCUPIED'); assert.equal(byNum(7).status, 'WAITING_ORDER'); assert.equal(byNum(9).status, 'SERVED'); assert.equal(byNum(12).status, 'CALLING');
assert.equal(byNum(7).session.pendingOrders, 1); assert.equal(byNum(12).session.call.type, 'BILL'); ok('16 mesas con los 5 estados sembrados');

console.log('Anti-fraude QR');
let j = await call('POST', '/api/public/tables/2/join', { body: {} });
assert.equal(j.data.state, 'CLOSED'); assert.equal(j.data.token, undefined); ok('mesa cerrada → sin token');
assert.equal((await call('POST', '/api/public/tables/99/join', { body: {} })).status, 404); ok('mesa inexistente → 404');
assert.equal((await call('POST', '/api/guest/orders', { token: sala })).status, 401); ok('token de personal no sirve como cliente');

const staffSock = await connect({ token: sala });
const kitchenSock = await connect({ token: cocina });
const lobby = await connect({ lobbyTable: 2 });
await assert.rejects(connect({}), /UNAUTHORIZED/); ok('socket sin credenciales rechazado');

const t2 = byNum(2).id;
let r = await call('POST', `/api/tables/${t2}/open`, { token: sala });
assert.equal(r.status, 201); assert.equal(r.data.status, 'OCCUPIED');
await waitFor(lobby, 'table:opened'); ok('lobby recibe table:opened');
await waitFor(staffSock, 'table:updated', (t) => t.id === t2 && t.status === 'OCCUPIED'); ok('sala recibe table:updated (azul)');
assert.equal((await call('POST', `/api/tables/${t2}/open`, { token: sala })).status, 409); ok('no se abre dos veces');

const a = (await call('POST', '/api/public/tables/2/join', { body: {} })).data;
const b = (await call('POST', '/api/public/tables/2/join', { body: {} })).data;
assert.equal(a.state, 'OPEN'); assert.equal(a.guest.alias, 'Cliente #1'); assert.equal(a.guest.number, 1); assert.equal(b.guest.alias, 'Cliente #2'); assert.notEqual(a.guest.color, b.guest.color); ok('comensales numerados: Cliente #1, Cliente #2');
const a2 = (await call('POST', '/api/public/tables/2/join', { body: { token: a.token } })).data;
assert.equal(a2.guest.id, a.guest.id); ok('recargar conserva la identidad');

console.log('Carrito colaborativo');
const sa = await connect({ token: a.token });
const sb = await connect({ token: b.token });
const menu = (await call('GET', '/api/public/menu')).data;
const prod = (name) => menu.categories.flatMap((c) => c.products).find((p) => p.name === name);
assert.equal(menu.categories.length, 5); assert.equal(menu.promotions.length, 2); ok('carta pública: 5 categorías, 2 banners vigentes');
assert.deepEqual(await emitAck(sa, 'cart:add', { productId: prod('Hamburguesa Fogón').id, quantity: 2 }), { ok: true });
let cu = await waitFor(sb, 'cart:updated', (p) => p.cart.totalQuantity === 2);
assert.equal(cu.change.by.alias, 'Cliente #1'); assert.equal(cu.change.productName, 'Hamburguesa Fogón'); ok('B ve lo que agrega A, con autor');
await emitAck(sb, 'cart:add', { productId: prod('Pizza pepperoni').id, notes: 'Sin orégano' });
cu = await waitFor(sa, 'cart:updated', (p) => p.cart.totalQuantity === 3); ok('A ve lo que agrega B');
const burgerLine = cu.cart.items.find((i) => i.name === 'Hamburguesa Fogón');
await emitAck(sb, 'cart:setQuantity', { itemId: burgerLine.id, quantity: 1 });
cu = await waitFor(sa, 'cart:updated', (p) => p.cart.totalQuantity === 2 && p.change?.action === 'updated'); ok('B edita la línea de A');
assert.equal(cu.cart.subtotal, 32000 + 38000);
r = await emitAck(sa, 'cart:add', { productId: prod('Torta de chocolate').id });
assert.equal(r.ok, false); assert.equal(r.error.code, 'PRODUCT_UNAVAILABLE'); ok('plato agotado no entra al carrito');
r = await emitAck(sa, 'cart:add', { productId: 'no-es-uuid' }); assert.equal(r.error.code, 'VALIDATION_ERROR'); ok('payload inválido rechazado');
const guests = await waitFor(sa, 'guests:updated', (g) => g.length === 2 && g.every((x) => x.online)); ok('presencia: 2 comensales en línea');

console.log('Comanda');
const stock0 = (await db.query(`select stock from inventory_items where name='Carne de res'`)).rows[0].stock;
r = await call('POST', '/api/guest/orders', { token: a.token });
assert.equal(r.status, 201); assert.equal(r.data.status, 'PENDING'); assert.equal(r.data.items.length, 2); const orderId = r.data.id;
await waitFor(staffSock, 'order:created', (o) => o.id === orderId); ok('sala recibe la comanda al instante');
await waitFor(sb, 'cart:updated', (p) => p.cart.totalQuantity === 0 && p.change?.action === 'ordered'); ok('carrito vacío para toda la mesa');
await waitFor(staffSock, 'table:updated', (t) => t.id === t2 && t.status === 'WAITING_ORDER' && t.session.pendingOrders === 1); ok('mesa naranja con comanda por confirmar');
assert.equal((await call('POST', '/api/guest/orders', { token: a.token })).status, 400); ok('carrito vacío no genera comanda');
assert.ok(!(await call('GET', '/api/kitchen/orders', { token: cocina })).data.some((o) => o.id === orderId)); ok('cocina no la ve hasta que sala confirma');
assert.equal((await call('POST', `/api/tables/${t2}/pay`, { token: sala, body: { method: 'CASH', amountReceived: 999999, tipRate: 10 } })).status, 409); ok('no se cobra con comandas en curso');
assert.equal((await call('POST', `/api/tables/${t2}/cancel`, { token: sala })).status, 409); ok('no se cierra sin consumo si hay comandas');

r = await call('POST', `/api/orders/${orderId}/confirm`, { token: sala });
assert.equal(r.data.status, 'CONFIRMED');
await waitFor(kitchenSock, 'order:updated', (o) => o.id === orderId && o.status === 'CONFIRMED'); ok('cocina recibe la comanda confirmada');
await waitFor(kitchenSock, 'inventory:alert', (al) => al.some((i) => i.name === 'Carne de res' && i.alertLevel === 'RED')); ok('cocina recibe alerta de inventario');
const stock1 = (await db.query(`select stock from inventory_items where name='Carne de res'`)).rows[0].stock;
assert.equal(Number(stock0) - Number(stock1), 180); ok('se descontaron 180 g de carne (1 hamburguesa)');
assert.equal((await call('POST', `/api/orders/${orderId}/confirm`, { token: sala })).status, 409); ok('no se confirma dos veces');

const items = r.data.items;
r = await call('PATCH', `/api/kitchen/items/${items[0].id}`, { token: cocina, body: { status: 'PREPARING' } });
assert.equal(r.data.status, 'PREPARING'); ok('un plato en preparación → comanda PREPARING');
await call('PATCH', `/api/kitchen/items/${items[0].id}`, { token: cocina, body: { status: 'READY' } });
r = await call('PATCH', `/api/kitchen/items/${items[1].id}`, { token: cocina, body: { status: 'READY' } });
assert.equal(r.data.status, 'READY'); assert.ok(r.data.readyAt); ok('todos listos → comanda READY');
await waitFor(sa, 'order:updated', (o) => o.id === orderId && o.status === 'READY'); ok('el cliente ve su pedido listo');
await waitFor(staffSock, 'table:updated', (t) => t.id === t2 && t.session?.readyOrders === 1); ok('el mapa marca comanda lista');
assert.equal((await call('PATCH', `/api/kitchen/items/${items[0].id}`, { token: sala, body: { status: 'READY' } })).status, 403); ok('sala no cambia estados de cocina');
r = await call('POST', `/api/orders/${orderId}/serve`, { token: sala });
assert.equal(r.data.status, 'SERVED');
await waitFor(staffSock, 'table:updated', (t) => t.id === t2 && t.status === 'SERVED'); ok('mesa verde al entregar');

console.log('Llamado y cobro');
assert.equal((await call('POST', '/api/guest/calls', { token: b.token, body: { type: 'BILL' } })).status, 201);
await waitFor(staffSock, 'call:created', (c) => c.tableNumber === 2 && c.type === 'BILL');
await waitFor(staffSock, 'table:updated', (t) => t.id === t2 && t.status === 'CALLING'); ok('pedir la cuenta → mesa roja');
await call('POST', '/api/guest/calls', { token: a.token, body: { type: 'BILL' } });
assert.equal((await db.query(`select count(*)::int n from waiter_calls where table_id=$1 and attended_at is null`, [t2])).rows[0].n, 1); ok('llamado duplicado no se repite');
r = await call('POST', `/api/tables/${t2}/attend`, { token: sala }); assert.equal(r.data.status, 'SERVED'); ok('atender → vuelve a verde');
await waitFor(sb, 'call:attended');

const detail = (await call('GET', `/api/tables/${t2}`, { token: sala })).data;
assert.equal(detail.bill.totals.gross, 70000); assert.equal(detail.bill.totals.taxTotal, 5185); assert.equal(detail.bill.totals.subtotal, 64815); assert.equal(detail.bill.totals.tipTotal, 6482); assert.equal(detail.bill.totals.grandTotal, 76482); assert.equal(detail.bill.canCharge, true); ok('liquidación: base 64.815 + INC 5.185 + propina 6.482 = 76.482');
r = await call('POST', `/api/tables/${t2}/pay`, { token: sala, body: { method: 'CASH', amountReceived: 50000, tipRate: 10 } });
assert.equal(r.status, 402); assert.equal(r.data.error.code, 'PAYMENT_REJECTED');
tables = (await call('GET', '/api/tables', { token: sala })).data; assert.equal(byNum(2).status, 'SERVED'); ok('pago rechazado → la mesa sigue abierta');
await assert.rejects(db.query(`update table_sessions set closed_at = now(), close_reason='PAID' where table_id=$1 and closed_at is null`, [t2]), /pago est. validado/); ok('la BD impide cerrar sin pago validado');
r = await call('POST', `/api/tables/${t2}/pay`, { token: sala, body: { method: 'CASH', amountReceived: 80000, tipRate: 10, customerName: '' } });
assert.equal(r.status, 201); assert.match(r.data.invoiceNumber, /^FG\d+$/); assert.equal(r.data.payment.changeDue, 3518); assert.equal(r.data.cufe.length, 96); assert.equal(r.data.simulated, true); ok(`pago validado → factura ${r.data.invoiceNumber}, cambio 3.518`);
await waitFor(sa, 'session:closed', (p) => p.reason === 'PAID'); ok('clientes reciben session:closed');
await waitFor(staffSock, 'table:updated', (t) => t.id === t2 && t.status === 'FREE'); ok('mesa gris (libre)');
assert.equal((await call('GET', '/api/guest/state', { token: a.token })).status, 410); ok('token de la sesión cerrada → 410');
r = await emitAck(sa, 'cart:add', { productId: prod('Café latte').id }); assert.equal(r.error.code, 'SESSION_CLOSED'); ok('socket abierto ya no puede pedir');
assert.equal((await call('POST', '/api/public/tables/2/join', { body: { token: a.token } })).data.state, 'CLOSED'); ok('el QR vuelve a pantalla de espera');
await assert.rejects(connect({ token: a.token }), /SESSION_CLOSED/); ok('reconexión con token viejo rechazada');

console.log('Cocina: comanda completa y pago con tarjeta');
const t4 = byNum(4).id;
await call('POST', `/api/tables/${t4}/open`, { token: sala });
const d = (await call('POST', '/api/public/tables/4/join', { body: {} })).data;
const sd = await connect({ token: d.token });
await emitAck(sd, 'cart:add', { productId: prod('Pasta al pomodoro').id });
await emitAck(sd, 'cart:add', { productId: prod('Café latte').id, quantity: 2 });
const o3 = (await call('POST', '/api/guest/orders', { token: d.token })).data;
await call('POST', `/api/orders/${o3.id}/confirm`, { token: sala });
r = await call('PATCH', `/api/kitchen/orders/${o3.id}`, { token: cocina, body: { status: 'PREPARING' } });
assert.equal(r.status, 200); assert.equal(r.data.status, 'PREPARING'); assert.ok(r.data.items.every((i) => i.status === 'PREPARING')); ok('"Empezar todo" pasa todos los platos a preparación');
await call('PATCH', `/api/kitchen/items/${r.data.items[0].id}`, { token: cocina, body: { status: 'READY' } });
r = await call('PATCH', `/api/kitchen/orders/${o3.id}`, { token: cocina, body: { status: 'PREPARING' } });
assert.equal(r.data.items.filter((i) => i.status === 'READY').length, 1); ok('"Empezar todo" no devuelve lo que ya estaba listo');
r = await call('PATCH', `/api/kitchen/orders/${o3.id}`, { token: cocina, body: { status: 'READY' } });
assert.equal(r.data.status, 'READY'); ok('"Todo listo" deja la comanda lista');
await call('POST', `/api/orders/${o3.id}/serve`, { token: sala });
r = await call('POST', `/api/tables/${t4}/pay`, { token: sala, body: { method: 'CARD', amountReceived: 43000, tipRate: 0, customerName: 'Cliente de prueba', customerDoc: '900123456' } });
assert.equal(r.status, 201); assert.equal(r.data.grandTotal, 43000); assert.equal(r.data.tipTotal, 0); assert.equal(r.data.payment.changeDue, 0); assert.equal(r.data.customerName, 'Cliente de prueba'); ok('pago con tarjeta, sin propina y con datos del cliente');
sd.close();

console.log('Cerrar sin consumo');
await call('POST', `/api/tables/${t4}/open`, { token: sala });
r = await call('POST', `/api/tables/${t4}/cancel`, { token: sala }); assert.equal(r.data.status, 'FREE'); ok('mesa sin comandas se puede cerrar');

console.log('Rechazo de comanda');
await call('POST', `/api/tables/${t4}/open`, { token: sala });
const c = (await call('POST', '/api/public/tables/4/join', { body: {} })).data;
const sc = await connect({ token: c.token });
await emitAck(sc, 'cart:add', { productId: prod('Café latte').id });
const o2 = (await call('POST', '/api/guest/orders', { token: c.token })).data;
r = await call('POST', `/api/orders/${o2.id}/reject`, { token: sala }); assert.equal(r.data.status, 'CANCELLED');
tables = (await call('GET', '/api/tables', { token: sala })).data; assert.equal(byNum(4).status, 'OCCUPIED'); ok('rechazar comanda → mesa vuelve a azul');
r = await call('POST', `/api/tables/${t4}/cancel`, { token: sala }); assert.equal(r.data.status, 'FREE'); ok('y se puede cerrar sin consumo');

console.log('Admin');
const k = (await call('GET', '/api/admin/kpis', { token: admin })).data;
assert.ok(k.salesToday > 0 && k.ticketsToday >= 8 && k.daily.length === 7 && k.topProducts.length === 5 && k.bottomProducts.length === 5); assert.ok(k.topProducts[0].units >= k.topProducts[4].units); ok(`KPIs: ventas hoy ${k.salesToday}, ticket medio ${Math.round(k.avgTicketToday)}, estrella "${k.topProducts[0].name}"`);
const inv = (await call('GET', '/api/admin/inventory', { token: admin })).data;
assert.equal(inv.length, 27); assert.equal(inv[0].alertLevel, 'RED'); assert.ok(inv.find((i) => i.name === 'Carne de res').affectedProducts.includes('Hamburguesa Fogón')); ok('inventario con alertas y platos afectados');
const torta = inv.find((i) => i.name === 'Torta de chocolate');
r = await call('POST', `/api/admin/inventory/${torta.id}/restock`, { token: admin, body: { quantity: 24 } });
assert.equal(r.data.find((i) => i.name === 'Torta de chocolate').alertLevel, 'OK'); ok('reposición quita la alerta');

const cats = (await call('GET', '/api/admin/categories', { token: admin })).data;
const g3 = (await call('POST', '/api/public/tables/3/join', { body: {} })).data;
const menuSock = await connect({ token: g3.token });
r = await call('POST', '/api/admin/products', { token: admin, body: { categoryId: cats[0].id, name: 'Arepa de prueba', price: 8000 } });
assert.equal(r.status, 201); const pid = r.data.id;
await waitFor(menuSock, 'menu:updated'); ok('crear plato → menu:updated en el móvil del cliente');
r = await call('PUT', `/api/admin/products/${pid}`, { token: admin, body: { categoryId: cats[0].id, name: 'Arepa de prueba', price: 9000, isFeatured: true } }); assert.equal(r.data.price, 9000);
r = await call('PATCH', `/api/kitchen/products/${pid}/availability`, { token: cocina, body: { isAvailable: false } }); assert.equal(r.data.isAvailable, false); ok('cocina marca agotado');
assert.equal((await call('POST', '/api/admin/products', { token: admin, body: { categoryId: cats[0].id, name: '', price: -1 } })).status, 400); ok('validación de plato');
assert.equal((await call('DELETE', `/api/admin/products/${pid}`, { token: admin })).status, 204);
assert.ok(!(await call('GET', '/api/public/menu')).data.categories.flatMap((x) => x.products).some((p) => p.id === pid)); ok('plato eliminado sale de la carta');
r = await call('POST', '/api/admin/categories', { token: admin, body: { name: 'Temporal', sortOrder: 9 } }); assert.equal(r.status, 201);
assert.equal((await call('DELETE', `/api/admin/categories/${r.data.id}`, { token: admin })).status, 204);
assert.equal((await call('DELETE', `/api/admin/categories/${cats[0].id}`, { token: admin })).status, 409); ok('CRUD de categorías');
const now = Date.now();
r = await call('POST', '/api/admin/promotions', { token: admin, body: { title: 'Promo test', startsAt: new Date(now - 1000).toISOString(), endsAt: new Date(now + 3600e3).toISOString() } });
assert.equal(r.status, 201); const promoId = r.data.id;
assert.equal((await call('GET', '/api/public/menu')).data.promotions.length, 3);
assert.equal((await call('POST', '/api/admin/promotions', { token: admin, body: { title: 'Mala', startsAt: new Date(now).toISOString(), endsAt: new Date(now - 1).toISOString() } })).status, 400);
assert.equal((await call('DELETE', `/api/admin/promotions/${promoId}`, { token: admin })).status, 204); ok('CRUD de banners con ventana de fechas');

for (const s of [staffSock, kitchenSock, lobby, sa, sb, sc, menuSock]) s.close();
await db.end();
console.log(`\n${passed} comprobaciones OK`);
process.exit(0);
