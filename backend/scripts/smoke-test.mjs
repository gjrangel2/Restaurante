// =====================================================================
// Prueba de humo de punta a punta (más de 140 comprobaciones).
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
// Para probar los webhooks firmados, arranca el backend con
// WOMPI_EVENTS_SECRET=test_events_secret y MP_WEBHOOK_SECRET=test_mp_secret;
// si no, esa parte se omite.
// =====================================================================
import { io } from 'socket.io-client';
import pg from 'pg';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

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


// =====================================================================
// Comensal tardío
// =====================================================================
console.log('Comensal tardío');
tables = (await call('GET', '/api/tables', { token: sala })).data;
const t5 = byNum(5).id;
await call('POST', `/api/tables/${t5}/open`, { token: sala });
const g1 = (await call('POST', '/api/public/tables/5/join', { body: {} })).data;
assert.equal(g1.joinedLate, false); ok('el primero en llegar no es tardío');
const sg1 = await connect({ token: g1.token });
await emitAck(sg1, 'cart:add', { productId: prod('Pizza margarita').id });
const o5 = (await call('POST', '/api/guest/orders', { token: g1.token })).data;
staffSock.events.length = 0;
const g2 = (await call('POST', '/api/public/tables/5/join', { body: {} })).data;
assert.equal(g2.joinedLate, true); assert.equal(g2.guest.alias, 'Cliente #2'); ok('quien se une después del pedido llega tarde');
const late = await waitFor(staffSock, 'guest:late', (e) => e.tableNumber === 5);
assert.equal(late.alias, 'Cliente #2'); ok('sala recibe guest:late al instante');
let t5dto = await waitFor(staffSock, 'table:updated', (t) => t.id === t5 && t.session?.lateGuests.length === 1);
assert.equal(t5dto.session.lateGuests[0].alias, 'Cliente #2'); ok('el mapa marca la mesa con el comensal nuevo');
r = await call('POST', `/api/tables/${t5}/late-guests/ack`, { token: sala });
assert.equal(r.data.session.lateGuests.length, 0); ok('"Entendido" quita el aviso');
const g5c = (await call('POST', '/api/public/tables/5/join', { body: {} })).data;
assert.equal(g5c.joinedLate, true);
await call('POST', `/api/orders/${o5.id}/confirm`, { token: sala });
t5dto = (await call('GET', `/api/tables/${t5}`, { token: sala })).data.table;
assert.equal(t5dto.session.lateGuests.length, 0); ok('confirmar la comanda de la mesa también atiende el aviso');

// =====================================================================
// Cuenta de la mesa pagada desde el celular
// =====================================================================
console.log('Pago de la cuenta desde el celular');
await call('PATCH', `/api/kitchen/orders/${o5.id}`, { token: cocina, body: { status: 'READY' } });
let gb = (await call('GET', '/api/guest/bill', { token: g1.token })).data;
assert.equal(gb.bill.canCharge, false); ok('con platos en camino no se puede pagar');
await call('POST', `/api/orders/${o5.id}/serve`, { token: sala });
gb = (await call('GET', '/api/guest/bill', { token: g1.token })).data;
assert.equal(gb.bill.canCharge, true); assert.equal(gb.payments.length, 3); ok('cuenta lista y 3 medios en línea (Wompi, Mercado Pago, PSE)');
assert.equal((await call('POST', '/api/guest/bill/checkout', { token: g1.token, body: { channel: 'BITCOIN', tipRate: 10 } })).status, 400); ok('medio de pago desconocido rechazado');
r = await call('POST', '/api/guest/bill/checkout', { token: g1.token, body: { channel: 'WOMPI', tipRate: 10 } });
assert.equal(r.status, 201); assert.equal(r.data.live, false); assert.match(r.data.checkoutUrl, /\/pago\/prueba\/FO-/); ok('sin credenciales, va a la pasarela de pruebas');
const ref5 = r.data.reference;
assert.equal(r.data.checkoutUrl.startsWith(BASE), true); ok('la URL de regreso usa la dirección con la que se abrió la app');
await waitFor(sg1, 'bill:paying'); ok('la mesa ve que alguien está pagando');
assert.equal((await call('POST', '/api/guest/bill/checkout', { token: g2.token, body: { channel: 'PSE', tipRate: 0 } })).status, 409); ok('un solo pago en línea por mesa');
await emitAck(sg1, 'cart:add', { productId: prod('Café latte').id });
r = await call('POST', '/api/guest/orders', { token: g1.token });
assert.equal(r.status, 409); assert.equal(r.data.error.code, 'ONLINE_PAYMENT_IN_PROGRESS'); ok('mientras se paga, no entran comandas nuevas');
const cartLine = (await call('GET', '/api/guest/state', { token: g1.token })).data.cart.items[0];
await emitAck(sg1, 'cart:setQuantity', { itemId: cartLine.id, quantity: 0 });
assert.equal((await call('POST', `/api/tables/${t5}/pay`, { token: sala, body: { method: 'CASH', amountReceived: 999999, tipRate: 10 } })).data.error.code, 'ONLINE_PAYMENT_IN_PROGRESS'); ok('caja no cobra encima de un pago en línea');
let pv = (await call('GET', `/api/public/payments/${ref5}`)).data;
assert.equal(pv.status, 'PENDING'); assert.equal(pv.purpose, 'TABLE_BILL'); assert.equal(pv.tableNumber, 5);
assert.equal(pv.amount, 36000 + Math.round((36000 - Math.round(36000 - 36000 / 1.08)) * 0.10)); ok('monto = consumo + propina sobre la base');
pv = (await call('POST', `/api/public/payments/${ref5}/test-result`, { body: { outcome: 'APPROVED' } })).data;
assert.equal(pv.status, 'APPROVED'); assert.match(pv.invoiceNumber, /^FG\d+$/); ok(`pago aprobado → factura ${pv.invoiceNumber}`);
await waitFor(sg1, 'session:closed', (e) => e.reason === 'PAID'); ok('los comensales ven la mesa cerrada');
tables = (await call('GET', '/api/tables', { token: sala })).data; assert.equal(byNum(5).status, 'FREE'); ok('la mesa queda libre sola');
assert.equal((await call('POST', `/api/public/payments/${ref5}/test-result`, { body: { outcome: 'APPROVED' } })).data.status, 'APPROVED');
assert.equal((await db.query(`select count(*)::int n from invoices i join payments p on p.invoice_id = i.id where p.payment_intent_id = (select id from payment_intents where reference = $1)`, [ref5])).rows[0].n, 1); ok('aplicar el mismo aprobado dos veces no duplica la factura');

console.log('Pago rechazado y webhooks');
tables = (await call('GET', '/api/tables', { token: sala })).data;
const t8 = byNum(8).id;
await call('POST', `/api/tables/${t8}/open`, { token: sala });
const g8 = (await call('POST', '/api/public/tables/8/join', { body: {} })).data;
const sg8 = await connect({ token: g8.token });
await emitAck(sg8, 'cart:add', { productId: prod('Bowl de la huerta').id });
const o8 = (await call('POST', '/api/guest/orders', { token: g8.token })).data;
await call('POST', `/api/orders/${o8.id}/confirm`, { token: sala });
await call('POST', `/api/orders/${o8.id}/serve`, { token: sala });
r = await call('POST', '/api/guest/bill/checkout', { token: g8.token, body: { channel: 'MERCADOPAGO', tipRate: 0 } });
pv = (await call('POST', `/api/public/payments/${r.data.reference}/test-result`, { body: { outcome: 'DECLINED' } })).data;
assert.equal(pv.status, 'DECLINED'); await waitFor(sg8, 'bill:payment-failed');
gb = (await call('GET', '/api/guest/bill', { token: g8.token })).data; assert.equal(gb.bill.canCharge, true); ok('pago rechazado → la mesa sigue abierta y puede reintentar');

const wompiSecret = 'test_events_secret';
r = await call('POST', '/api/guest/bill/checkout', { token: g8.token, body: { channel: 'PSE', tipRate: 0 } });
const ref8 = r.data.reference; const amount8 = (await call('GET', `/api/public/payments/${ref8}`)).data.amount;
const tx8 = { id: '1234-1700000000-00001', reference: ref8, status: 'APPROVED', amount_in_cents: amount8 * 100, currency: 'COP', payment_method_type: 'PSE' };
const ts = Date.now();
const event = (checksum) => ({ event: 'transaction.updated', data: { transaction: tx8 }, signature: { properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'], checksum }, timestamp: ts, sent_at: new Date().toISOString() });
const goodChecksum = crypto.createHash('sha256').update(`${tx8.id}${tx8.status}${tx8.amount_in_cents}${ts}${wompiSecret}`).digest('hex');
const badHook = await call('POST', '/api/payments/webhooks/wompi', { body: event('0'.repeat(64)) });
if (badHook.status === 401) {
  ok('webhook de Wompi con firma inválida → 401');
  assert.equal((await call('GET', `/api/public/payments/${ref8}`)).data.status, 'PENDING'); ok('y no cambia nada');
  assert.equal((await call('POST', '/api/payments/webhooks/wompi', { body: event(goodChecksum) })).status, 200);
  assert.equal((await call('GET', `/api/public/payments/${ref8}`)).data.status, 'APPROVED');
  await waitFor(sg8, 'session:closed'); ok('webhook firmado de Wompi aprueba el pago y cierra la mesa');
  const logged = (await db.query(`select count(*) filter (where valid_signature)::int ok, count(*) filter (where not valid_signature)::int bad from payment_events where reference = $1`, [ref8])).rows[0];
  assert.deepEqual(logged, { ok: 1, bad: 1 }); ok('ambos webhooks quedan en la bitácora');

  const mpSecret = 'test_mp_secret'; const reqId = 'req-123'; const mpTs = String(Date.now());
  const v1 = crypto.createHmac('sha256', mpSecret).update(`id:987654;request-id:${reqId};ts:${mpTs};`).digest('hex');
  const mpHook = async (sig) => (await fetch(`${BASE}/api/payments/webhooks/mercadopago?data.id=987654&type=payment`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': sig, 'x-request-id': reqId }, body: JSON.stringify({ type: 'payment', data: { id: '987654' } }) })).status;
  assert.equal(await mpHook(`ts=${mpTs},v1=${'a'.repeat(64)}`), 401); ok('webhook de Mercado Pago con firma inválida → 401');
  assert.equal(await mpHook(`ts=${mpTs},v1=${v1}`), 200); ok('firma válida de Mercado Pago aceptada (HMAC id;request-id;ts)');
} else {
  console.log('  · webhooks firmados omitidos: el backend no tiene WOMPI_EVENTS_SECRET de prueba');
  await call('POST', `/api/public/payments/${ref8}/test-result`, { body: { outcome: 'APPROVED' } });
}

// =====================================================================
// Domicilios
// =====================================================================
console.log('Domicilios: pedido y cotización');
const [repartidor, repartidor2] = await Promise.all([login('repartidor@demo.test'), login('repartidor2@demo.test')]);
assert.ok(repartidor && repartidor2); ok('login de repartidores');
assert.equal((await call('GET', '/api/tables', { token: repartidor })).status, 403); ok('repartidor no ve el mapa de mesas');
assert.equal((await call('GET', '/api/courier/me', { token: sala })).status, 403); ok('camarero no entra a la app del repartidor');
const cfg = (await call('GET', '/api/public/delivery')).data;
assert.equal(cfg.restaurant.deliveryEnabled, true); assert.equal(cfg.zones.length, 3); assert.ok(cfg.map.tileUrl.includes('{z}')); ok('configuración pública: zonas, medios de pago y mapa');
const home = { lat: 3.4489, lng: -76.5363 };
const q = (await call('POST', '/api/public/delivery/quote', { body: home })).data;
assert.equal(q.inCoverage, true); assert.equal(q.fee, 4000); ok(`cotización: ${q.distanceKm} km → domicilio $4.000`);
const order = (extra) => ({ type: 'DELIVERY', items: [{ productId: prod('Hamburguesa Fogón').id, quantity: 2, notes: 'Sin cebolla' }], customer: { name: 'Prueba Uno', phone: '+57 300 123 4567' }, address: { line: 'Calle de prueba #1-23', details: 'Casa', notes: '', ...home }, payment: 'CASH', ...extra });
assert.equal((await call('POST', '/api/public/delivery/orders', { body: order({ items: [{ productId: prod('Café latte').id, quantity: 1 }] }) })).data.error.code, 'BELOW_MINIMUM'); ok('pedido mínimo');
assert.equal((await call('POST', '/api/public/delivery/orders', { body: order({ address: { line: 'Muy lejos #1-1', lat: 3.30, lng: -76.53 } }) })).data.error.code, 'OUT_OF_COVERAGE'); ok('fuera de cobertura');
assert.equal((await call('POST', '/api/public/delivery/orders', { body: order({ items: [{ productId: prod('Torta de chocolate').id, quantity: 9 }] }) })).status, 409); ok('plato agotado');
assert.equal((await call('POST', '/api/public/delivery/orders', { body: order({ customer: { name: 'X', phone: 'abc' } }) })).status, 400); ok('datos del cliente validados');

staffSock.events.length = 0;
r = await call('POST', '/api/public/delivery/orders', { body: order() });
assert.equal(r.status, 201); assert.equal(r.data.checkoutUrl, null); assert.match(r.data.trackingCode, /^[A-Z2-9]{10}$/);
const code1 = r.data.trackingCode;
let tr = (await call('GET', `/api/public/delivery/track/${code1}`)).data;
assert.equal(tr.status, 'PLACED'); assert.equal(tr.total, 32000 * 2 + 4000); assert.match(tr.pin, /^\d{4}$/); ok(`domicilio ${tr.code} creado (pago en efectivo, total ${tr.total})`);
await waitFor(staffSock, 'delivery:new', (e) => e.code === tr.code); ok('despacho recibe el pedido nuevo al instante');
const board = (await call('GET', '/api/delivery/board', { token: sala })).data;
const d1 = board.deliveries.find((d) => d.code === tr.code);
assert.ok(d1); assert.equal(d1.pin, undefined); assert.ok(board.couriers.length >= 2); ok('el tablero no expone el PIN del cliente');
assert.equal((await call('GET', '/api/public/delivery/track/abc')).status, 400); assert.equal((await call('GET', '/api/public/delivery/track/ZZZZZZZZZZ')).status, 404); ok('códigos de seguimiento inválidos o desconocidos');

console.log('Domicilios: cocina, repartidor y entrega');
const trackSock = await connect({ trackingCode: code1 });
const courierSock = await connect({ token: repartidor });
r = await call('POST', `/api/delivery/${d1.id}/accept`, { token: sala });
assert.equal(r.data.status, 'ACCEPTED'); assert.ok(r.data.estimatedAt); ok('aceptado: entra a cocina con hora estimada');
const kOrder = await waitFor(kitchenSock, 'order:updated', (o) => o.id === d1.orderId && o.status === 'CONFIRMED');
assert.equal(kOrder.channel, 'DELIVERY'); assert.equal(kOrder.deliveryCode, tr.code); assert.equal(kOrder.tableNumber, null); ok('cocina lo ve como domicilio en su misma cola');
await waitFor(trackSock, 'delivery:updated', (t) => t.status === 'ACCEPTED' && t.etaMinutes > 0); ok('el cliente ve "confirmado" con tiempo estimado');
let me = (await call('GET', '/api/courier/me', { token: repartidor })).data;
assert.ok(me.deliveries.some((d) => d.id === d1.id && d.courier === null)); ok('aparece en "Disponibles" del repartidor');
r = await call('POST', `/api/courier/deliveries/${d1.id}/take`, { token: repartidor });
assert.equal(r.data.courier.name, 'Carlos Mejía'); ok('el repartidor toma el pedido');
assert.equal((await call('POST', `/api/courier/deliveries/${d1.id}/take`, { token: repartidor2 })).data.error.code, 'ALREADY_TAKEN'); ok('otro repartidor ya no puede tomarlo');
assert.equal((await call('POST', `/api/courier/deliveries/${d1.id}/pickup`, { token: repartidor })).data.error.code, 'NOT_READY'); ok('no se recoge antes de que cocina lo termine');
await call('PATCH', `/api/kitchen/orders/${d1.orderId}`, { token: cocina, body: { status: 'PREPARING' } });
await waitFor(trackSock, 'delivery:updated', (t) => t.status === 'PREPARING');
await call('PATCH', `/api/kitchen/orders/${d1.orderId}`, { token: cocina, body: { status: 'READY' } });
await waitFor(trackSock, 'delivery:updated', (t) => t.status === 'READY'); ok('el cliente sigue los estados de cocina en vivo');
assert.equal((await call('POST', `/api/orders/${d1.orderId}/serve`, { token: sala })).data.error.code, 'USE_DISPATCH'); ok('un domicilio no se "entrega en mesa"');
r = await call('POST', `/api/courier/deliveries/${d1.id}/pickup`, { token: repartidor });
assert.equal(r.data.status, 'ON_THE_WAY');
await waitFor(trackSock, 'delivery:updated', (t) => t.status === 'ON_THE_WAY' && t.courier?.name === 'Carlos'); ok('recogido: en camino, con el repartidor a la vista');
assert.ok(!(await call('GET', '/api/kitchen/orders', { token: cocina })).data.some((o) => o.id === d1.orderId)); ok('y sale de la pantalla de cocina');
staffSock.events.length = 0;
assert.deepEqual(await emitAck(courierSock, 'courier:location', { lat: 3.4540, lng: -76.5345, heading: 200 }), { ok: true });
const loc = await waitFor(trackSock, 'courier:location');
assert.ok(loc.etaMinutes >= 1); ok(`el cliente ve la ubicación del repartidor (llega en ~${loc.etaMinutes} min)`);
await waitFor(staffSock, 'courier:location', (e) => e.lat === 3.454); ok('despacho la ve en su mapa');
assert.equal((await emitAck(courierSock, 'courier:location', { lat: 3.4520, lng: -76.5350 })).error.code, 'TOO_FAST'); ok('ubicaciones demasiado seguidas se ignoran');
assert.equal((await emitAck(courierSock, 'courier:location', { lat: 999, lng: 0 })).ok, false); ok('coordenadas inválidas rechazadas');
tr = (await call('GET', `/api/public/delivery/track/${code1}`)).data;
assert.ok(tr.track.length >= 2); ok(`recorrido guardado (${tr.track.length} puntos)`);
assert.equal((await call('POST', `/api/courier/deliveries/${d1.id}/deliver`, { token: repartidor, body: { pin: tr.pin === '0000' ? '1111' : '0000' } })).data.error.code, 'WRONG_PIN'); ok('PIN equivocado no entrega');
r = await call('POST', `/api/courier/deliveries/${d1.id}/deliver`, { token: repartidor, body: { pin: tr.pin, amountReceived: 70000 } });
assert.equal(r.data.status, 'DELIVERED'); assert.equal(r.data.paid, true);
await waitFor(trackSock, 'delivery:updated', (t) => t.status === 'DELIVERED'); ok('entregado con el PIN del cliente');
const inv1 = (await db.query(`select i.grand_total, i.delivery_fee, p.method, p.change_due from invoices i join payments p on p.invoice_id = i.id where i.delivery_order_id = $1`, [d1.id])).rows[0];
assert.equal(Number(inv1.grand_total), 68000); assert.equal(Number(inv1.delivery_fee), 4000); assert.equal(inv1.method, 'CASH'); assert.equal(Number(inv1.change_due), 2000); ok('factura del domicilio: incluye el envío, efectivo con cambio de $2.000');

console.log('Domicilios: pago en línea, para recoger y cancelaciones');
r = await call('POST', '/api/public/delivery/orders', { body: order({ payment: 'WOMPI' }) });
assert.match(r.data.checkoutUrl, /\/pago\/prueba\/FO-/);
const code2 = r.data.trackingCode; const ref2 = r.data.checkoutUrl.split('/').pop();
tr = (await call('GET', `/api/public/delivery/track/${code2}`)).data;
assert.equal(tr.status, 'PENDING_PAYMENT'); ok('pago en línea: el pedido espera el pago');
assert.equal((await call('POST', `/api/delivery/${(await call('GET', '/api/delivery/board', { token: sala })).data.deliveries.find((d) => d.code === tr.code).id}/accept`, { token: sala })).data.error.code, 'NOT_PLACED'); ok('el restaurante no puede aceptar lo que no se ha pagado');
pv = (await call('POST', `/api/public/payments/${ref2}/test-result`, { body: { outcome: 'DECLINED' } })).data;
assert.equal(pv.status, 'DECLINED'); assert.equal(pv.trackingCode, code2);
r = await call('POST', `/api/public/delivery/track/${code2}/pay`, { body: { channel: 'PSE' } });
assert.match(r.data.checkoutUrl, /\/pago\/prueba\/FO-/); ok('rechazado → se puede reintentar con otro medio');
pv = (await call('POST', `/api/public/payments/${r.data.checkoutUrl.split('/').pop()}/test-result`, { body: { outcome: 'APPROVED' } })).data;
tr = (await call('GET', `/api/public/delivery/track/${code2}`)).data;
assert.equal(tr.status, 'PLACED'); assert.equal(tr.paid, true); ok('pago aprobado → llega al restaurante ya pagado');
assert.equal((await call('POST', `/api/public/delivery/track/${code2}/cancel`)).status, 200);
tr = (await call('GET', `/api/public/delivery/track/${code2}`)).data;
assert.equal(tr.status, 'CANCELLED'); assert.equal(tr.refundPending, true); ok('cancelado por el cliente antes de aceptarse → queda marcado para reembolso');

r = await call('POST', '/api/public/delivery/orders', { body: { type: 'PICKUP', items: [{ productId: prod('Pizza pepperoni').id, quantity: 1 }], customer: { name: 'Prueba Recoge', phone: '3001112233' }, payment: 'CASH' } });
const code3 = r.data.trackingCode; tr = (await call('GET', `/api/public/delivery/track/${code3}`)).data;
assert.equal(tr.deliveryFee, 0); ok('para recoger: sin dirección ni domicilio');
const d3 = (await call('GET', '/api/delivery/board', { token: sala })).data.deliveries.find((d) => d.code === tr.code);
assert.equal((await call('POST', `/api/delivery/${d3.id}/assign`, { token: sala, body: { courierId: board.couriers[0].id } })).data.error.code, 'PICKUP_ORDER'); ok('no se asigna repartidor a un pedido para recoger');
await call('POST', `/api/delivery/${d3.id}/accept`, { token: sala });
await call('PATCH', `/api/kitchen/orders/${d3.orderId}`, { token: cocina, body: { status: 'READY' } });
assert.equal((await call('POST', `/api/delivery/${d3.id}/handover`, { token: sala, body: { pin: '12' } })).status, 400);
r = await call('POST', `/api/delivery/${d3.id}/handover`, { token: sala, body: { pin: tr.pin } });
assert.equal(r.data.status, 'DELIVERED'); ok('entregado en mostrador con el PIN');

r = await call('POST', '/api/public/delivery/orders', { body: order({ payment: 'CARD_ON_DELIVERY' }) });
const code4 = r.data.trackingCode; tr = (await call('GET', `/api/public/delivery/track/${code4}`)).data;
const d4 = (await call('GET', '/api/delivery/board', { token: sala })).data.deliveries.find((d) => d.code === tr.code);
r = await call('POST', `/api/delivery/${d4.id}/assign`, { token: sala, body: { courierId: d1.courier?.id ?? (await call('GET', '/api/courier/me', { token: repartidor2 })).data.profile.id } });
assert.ok(r.data.courier); ok('despacho asigna repartidor');
await call('POST', `/api/delivery/${d4.id}/accept`, { token: sala });
r = await call('POST', `/api/delivery/${d4.id}/cancel`, { token: sala, body: { reason: 'Se agotó un ingrediente' } });
assert.equal(r.data.status, 'CANCELLED'); assert.equal(r.data.cancelReason, 'Se agotó un ingrediente');
assert.ok(!(await call('GET', '/api/kitchen/orders', { token: cocina })).data.some((o) => o.id === d4.orderId)); ok('cancelado desde despacho: sale de cocina');
assert.equal((await call('POST', `/api/delivery/${d4.id}/cancel`, { token: sala, body: { reason: 'otra vez' } })).status, 409); ok('no se cancela dos veces');

console.log('Domicilios: ajustes');
const settings = (await call('GET', '/api/delivery/settings', { token: admin })).data;
assert.equal(settings.zones.length, 3);
assert.equal((await call('PUT', '/api/delivery/settings', { token: sala, body: settings })).status, 403); ok('solo gerencia cambia los ajustes');
r = await call('PUT', '/api/delivery/settings', { token: admin, body: { ...settings, zones: [...settings.zones, { name: 'Lejana', maxKm: 10, fee: 12000, travelMinutes: 40 }] } });
assert.equal(r.data.zones.length, 4);
assert.equal((await call('POST', '/api/public/delivery/quote', { body: { lat: 3.38, lng: -76.53 } })).data.fee, 12000); ok('zona nueva aplica de inmediato a la cotización');
assert.equal((await call('PUT', '/api/delivery/settings', { token: admin, body: { ...settings, zones: [] } })).data.error.code, 'NO_ZONES'); ok('no se activan domicilios sin zonas');
await call('PUT', '/api/delivery/settings', { token: admin, body: settings });
for (const sock of [sg1, sg8, trackSock, courierSock]) sock.close();

for (const s of [staffSock, kitchenSock, lobby, sa, sb, sc, menuSock]) s.close();
await db.end();
console.log(`\n${passed} comprobaciones OK`);
process.exit(0);
