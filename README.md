# FrictionlessOrder

Sistema SaaS de pedidos por QR para restaurantes, con sala, cocina, caja y domicilios sincronizados en tiempo real.
Este repositorio es el **código fundacional**: un flujo completo y ejecutable de punta a punta, listo para crecer.

- **En mesa:** pedido por QR con carrito compartido, cocina en vivo, cobro con factura y aviso al camarero
  cuando alguien llega tarde a una mesa que ya pidió.
- **Domicilios propios:** página pública de pedidos, cobertura por zonas, tablero de despacho con mapa en vivo,
  perfil de repartidor con GPS y seguimiento del pedido para el cliente.
- **Pagos en línea:** Wompi, Mercado Pago y PSE, para domicilios y para la cuenta de la mesa (la mesa se cierra sola
  cuando la pasarela aprueba el pago).

- **Frontend:** React 18, TypeScript, Tailwind CSS, Vite, Socket.IO client, Leaflet (mapas)
- **Backend:** Node.js 22, TypeScript, Express 5, Socket.IO, zod
- **Base de datos:** PostgreSQL 16 (migraciones SQL con nombres Flyway)
- **Infraestructura local:** Docker Compose (frontend en nginx, backend, base de datos)

## Arranque rápido

Con Docker Desktop abierto, desde esta carpeta:

```bash
docker compose up --build
```

La primera vez tarda unos minutos (descarga imágenes y compila). Cuando el log muestre
`FrictionlessOrder escuchando`, abre **http://localhost:8080**.

| Rol            | Correo                  | Contraseña | Entra a       |
|----------------|-------------------------|------------|---------------|
| Admin/Gerente  | `admin@demo.test`       | `demo1234` | `/admin`      |
| Camarero/Sala  | `sala@demo.test`        | `demo1234` | `/sala` y `/despacho` |
| Cocina         | `cocina@demo.test`      | `demo1234` | `/cocina`     |
| Repartidor     | `repartidor@demo.test`  | `demo1234` | `/repartidor` (Carlos, moto) |
| Repartidor     | `repartidor2@demo.test` | `demo1234` | `/repartidor` (Andrea, bicicleta) |
| Cliente en mesa | sin cuenta             |            | `/mesa/12` (el QR de la mesa) |
| Cliente a domicilio | sin cuenta         |            | `/domicilios` |

En la pantalla de acceso hay botones para entrar con cada cuenta demo de un toque.

Para detenerlo: `docker compose down`. Para empezar con la base de datos de cero: `docker compose down -v`.
Si un puerto está ocupado, copia `.env.example` como `.env` y cambia `WEB_PORT`, `API_PORT` o `DB_PORT`.

## Pruébalo en dos minutos

1. Entra como **Sala**. El mapa ya trae mesas en los cinco estados.
2. Abre en otra pestaña **http://localhost:8080/mesa/2**: verás la pantalla de espera, porque la mesa 2 está cerrada.
3. En el mapa, toca la **mesa 2** y pulsa **Abrir mesa**. La otra pestaña pasa sola a la carta.
4. Abre `/mesa/2` en una ventana de incógnito: es un segundo comensal (Cliente #2). Agrega platos en una y míralos aparecer en la otra.
5. Pulsa **Enviar pedido**. En el mapa, la mesa se pone naranja con el aviso de comanda por confirmar.
6. En el panel de la mesa, **Confirmar y enviar a cocina**. Entra como **Cocina** en otra pestaña y marca los platos.
7. De vuelta en Sala, **Marcar entregada** (verde). Desde el cliente, **Cuenta → Pagar con el camarero** (rojo parpadeante).
8. **Cobrar → Validar pago y cerrar mesa**. La mesa vuelve a gris y el cliente ve la despedida.

**Llegó tarde.** Con una mesa que ya pidió (la 7 de la demo), abre `/mesa/7` en otra ventana. El nuevo comensal ve
que su mesa ya pidió, y en Sala la mesa muestra un icono de persona con el aviso *Cliente #4 llegó después del pedido*.
**Entendido** lo marca como atendido; confirmar su comanda también.

**Pagar desde el celular.** En `/mesa/9` (servida), pestaña **Cuenta → Pagar desde mi celular**, elige Wompi,
Mercado Pago o PSE. Sin credenciales se abre la pasarela de pruebas: **Simular pago aprobado** y la mesa 9 queda libre
sola en el mapa, con su factura. Mientras se paga, la mesa muestra un icono de tarjeta y no admite pedidos nuevos.

**Domicilio de punta a punta** (cuatro ventanas):

1. **Sala → Domicilios** (`/despacho`): pedidos por etapa y el mapa con destinos y repartidores.
2. **Repartidor** en una ventana móvil (F12 → modo dispositivo) con `repartidor2@demo.test`.
3. **Cliente:** `/domicilios`, agrega platos, **Ver pedido**, mueve el pin en el mapa, llena los datos y paga con
   **Efectivo** o con una pasarela (de prueba). Termina en `/pedido/<código>`, la página de seguimiento.
4. En despacho, **Aceptar y enviar a cocina**. En **Cocina**: **Empezar todo → Todo listo**.
5. El repartidor: **Disponibles → Tomar pedido → Atender esta entrega → Recogí el pedido**. Para moverlo sin salir a la
   calle, **Simular recorrido (prueba)**: el cliente y despacho lo ven avanzar en el mapa.
6. **Entregar** con el código de 4 dígitos que ve el cliente en su seguimiento. Si era en efectivo, se emite la factura
   ahí mismo.

### Desde un móvil real

El móvil y el PC deben estar en la misma red Wi-Fi. Averigua la IP del PC (`ipconfig` en Windows) y entra desde
el PC a `http://<IP>:8080/sala`. El QR que muestra el panel de cada mesa apunta a la dirección con la que
abriste la página, así que con la IP ya se puede escanear desde el móvil. Si no carga, permite el puerto 8080
en el firewall de Windows para redes privadas.

## Cómo está organizado

```
Restaurante/
├── docker-compose.yml          frontend + backend + PostgreSQL
├── .env.example                puertos, credenciales y secreto JWT
├── db/migrations/
│   ├── V1__schema.sql          esquema, reglas de negocio en la BD, vista de inventario
│   ├── V2__seed_demo_restaurant.sql   restaurante demo: personal, mesas, carta, recetas, banners
│   ├── V3__demo_activity.sql   (opcional) ventas de 7 días y mesas en vivo para la demo
│   ├── V4__late_guests_delivery_payments.sql   llegadas tarde, domicilios, repartidores, pagos en línea
│   └── V5__demo_delivery.sql   (opcional) ubicación, zonas, repartidores y domicilios de la demo (Cali)
├── backend/src/
│   ├── index.ts                arranque: Express + Socket.IO + migraciones + barrido de pagos vencidos
│   ├── routes.ts               toda la API y su RBAC, en un solo lugar
│   ├── auth/                   tokens del personal y de sesión de mesa, middlewares
│   ├── realtime/               bus de eventos y gateway de Socket.IO (incluye la ubicación del repartidor)
│   ├── billing/providers.ts    pago en caja y facturación electrónica SIMULADOS
│   ├── payments/               Wompi, Mercado Pago, PSE y pasarela de pruebas; webhooks firmados
│   ├── geo.ts                  distancias, zonas y tiempo estimado por vehículo
│   ├── db/                     pool y migrador
│   └── modules/                tables, guests, cart, orders, billing, delivery, inventory, menu, admin
└── frontend/src/
    ├── components/MapView.tsx  mapa (Leaflet) con restaurante, destinos, repartidores y zonas
    ├── features/floor/         FloorMap.tsx (mapa visual), tableStatus.ts (colores), panel de mesa
    ├── features/customer/      CustomerMenu.tsx (menú móvil), useSharedCart.ts (carrito compartido)
    ├── features/delivery/      pedir a domicilio, seguimiento del cliente, tablero de despacho
    ├── features/courier/       app del repartidor (móvil)
    ├── features/payments/      selector de medio de pago, regreso de la pasarela, pasarela de pruebas
    ├── features/kitchen/       pantalla de cocina (mesas y domicilios)
    ├── features/admin/         dashboard, carta, banners, inventario
    └── lib/                    cliente HTTP, sockets, sesión, formato, tipos
```

```
 Móvil del cliente ─┐                     ┌─ /api/*  ────► Express (REST)  ─┐
 Sala / Cocina / ───┼─► nginx :8080 ──────┤                                 ├─► PostgreSQL
 Admin (navegador) ─┘   (sirve la SPA)    └─ /socket.io ─► Socket.IO (WS) ──┘
```

El navegador habla con un solo origen (nginx), que sirve la app y reenvía API y WebSockets al backend.
Por eso no hay CORS que configurar y el QR funciona igual desde cualquier dispositivo.

## Roles (RBAC)

| Rol | Puede |
|-----|-------|
| **Admin/Gerente** | Todo: dashboard, mapa, cocina, inventario, carta, banners, cobro, despacho, zonas y ajustes de domicilio |
| **Camarero/Sala** | Mapa, abrir mesas, confirmar o rechazar comandas, entregar, atender llamados, cobrar; despacho de domicilios |
| **Cocina** | Comandas confirmadas en tiempo real (mesas y domicilios), estado de cada plato, alertas de insumos, agotar platos |
| **Repartidor** | Su turno, tomar pedidos listos, recogerlos, compartir su ubicación y entregarlos con el código del cliente |
| **Cliente en mesa** | Anónimo. Ver la carta y pedir, solo con la mesa abierta y con un token ligado a esa sesión |
| **Cliente a domicilio** | Anónimo. Pedir y seguir *su* pedido con el código de seguimiento (10 caracteres, imposible de adivinar) |

El permiso real se hace cumplir en el backend (`requireStaff(...)` y `requireGuest` en `routes.ts`).
El frontend solo decide qué pantalla mostrar.

## Anti-fraude del QR

El QR es estático (`/mesa/12`) y por sí solo no da ningún permiso:

1. **Mesa cerrada:** `POST /api/public/tables/12/join` responde `CLOSED`, sin token. El cliente ve la espera.
2. **El camarero abre la mesa:** se crea una fila en `table_sessions`. Un índice único garantiza una sola sesión abierta por mesa.
3. **El cliente entra:** recibe un token firmado que lleva el id de esa sesión. Cada petición y cada evento de
   WebSocket comprueba que la sesión siga abierta.
4. **Segunda barrera:** el pedido nace `PENDING` y no entra a cocina hasta que el camarero lo confirma.
5. **Al validar el pago** la sesión se cierra y todos sus tokens dejan de servir al instante.

## Estados de mesa

| Estado en BD    | En el mapa                         | Color              |
|-----------------|------------------------------------|--------------------|
| `FREE`          | Libre                              | Gris               |
| `OCCUPIED`      | Ocupada, leyendo la carta          | Azul               |
| `WAITING_ORDER` | Esperando pedido                   | Naranja            |
| `SERVED`        | Servida, comiendo                  | Verde              |
| `CALLING`       | Llama al camarero o pide la cuenta | Rojo parpadeante   |

El estado no se asigna a mano en cada endpoint: se **deriva** de lo que hay en la base de datos
(`refreshTableStatus` en `tables.service.ts`) y se guarda como caché. Así nunca queda una mesa con un color
que no corresponde a sus comandas.

## Cliente que llega tarde

Si alguien escanea el QR cuando su mesa ya tiene comandas, entra marcado como *llegó tarde*. El camarero recibe
un aviso al instante, la mesa muestra un icono en el mapa y el panel lo resalta para que pase a tomarle el pedido.
El aviso se apaga con **Entendido** o al confirmar la siguiente comanda de esa mesa.

## Domicilios

Canal propio, sin comisiones de terceros. Un pedido a domicilio es una comanda normal (`orders.channel = DELIVERY`
o `PICKUP`), así que entra a la misma cocina y descuenta el mismo inventario; `delivery_orders` guarda el resto:
cliente, dirección con coordenadas, zona, tarifa, repartidor, código de seguimiento y PIN de entrega.

| Estado          | Quién lo mueve                                   | El cliente ve                 |
|-----------------|--------------------------------------------------|-------------------------------|
| `PENDING_PAYMENT` | pago en línea sin aprobar (se cancela a los 30 min) | Esperando tu pago        |
| `PLACED`        | pedido recibido                                  | Recibimos tu pedido           |
| `ACCEPTED`      | despacho lo acepta y lo manda a cocina           | El restaurante confirmó…      |
| `PREPARING`     | cocina empieza                                   | Estamos preparando…           |
| `READY`         | cocina termina                                   | Tu pedido está listo          |
| `ON_THE_WAY`    | el repartidor lo recoge                          | Va en camino, con mapa y tiempo estimado |
| `DELIVERED`     | entrega con el PIN del cliente                   | Pedido entregado              |

- **Cobertura y tarifa:** anillos de distancia desde el restaurante (Cerca 3 km, Media 6 km, Extendida 8 km en la demo),
  cada uno con su tarifa y minutos de viaje. Se editan en **Domicilios → Zonas y ajustes** (gerencia), donde también se
  fija la ubicación del restaurante tocando el mapa. El precio siempre lo calcula el servidor.
- **Tiempo estimado:** preparación + viaje de la zona al aceptar; en camino, distancia real × 1,35 a la velocidad del
  vehículo (moto 25 km/h, bici 13, carro 20).
- **Repartidor:** activa *En turno*, toma pedidos o se los asigna despacho, abre la ruta en Google Maps con un toque y
  comparte su GPS cada 4 s por WebSocket. El recorrido queda en `delivery_tracks`.
- **Entrega segura:** el cliente da un PIN de 4 dígitos que solo ve en su seguimiento; 5 intentos fallidos lo bloquean
  5 minutos. Para recoger en el local se usa el mismo PIN en el mostrador.
- **Cancelar:** el cliente puede hacerlo mientras el restaurante no lo acepte; despacho, con motivo, hasta que salga.
  Si ya estaba pagado en línea, queda marcado *Reembolso pendiente* para devolverlo desde el panel de la pasarela.

### Mapa

Leaflet con teselas de OpenStreetMap: funciona sin clave, pero sus términos solo admiten uso moderado. Para
producción usa un proveedor con clave (MapTiler, Stadia, Mapbox…) con `MAP_TILE_URL` y `MAP_ATTRIBUTION`.
El GPS del navegador solo funciona en **HTTPS** (o en `localhost`); desde la IP del PC en la red local el repartidor
verá un aviso y puede usar **Simular recorrido** para probar.

## Pagos en línea

| Medio en pantalla | Pasarela | Cómo se integra |
|-------------------|----------|-----------------|
| **Wompi** (tarjeta, Nequi, Bancolombia…) | Wompi | Web Checkout con firma de integridad (SHA-256) |
| **Mercado Pago** | Mercado Pago | Checkout Pro (preferencia) |
| **PSE** | la de `PSE_PROVIDER` (Wompi por defecto) | En Mercado Pago se excluyen los demás medios |

Sirven para pagar un domicilio y para pagar la cuenta de una mesa desde el celular.

**Cada pasarela se activa sola** al poner sus credenciales en `.env` (ver `.env.example`). Mientras no estén, el cliente
ve la etiqueta *Prueba* y pasa por la **pasarela de pruebas** de la app, que solo permite simular aprobado o rechazado
y nunca mueve dinero. `PAYMENTS_FORCE_TEST=true` la fuerza aunque haya credenciales.

Reglas que protegen el dinero:

- **El regreso del navegador no aprueba nada.** El estado se consulta a la API de la pasarela o llega por webhook
  firmado (Wompi: checksum de eventos; Mercado Pago: `x-signature` HMAC). Webhooks sin firma válida → 401.
- **El monto se verifica:** si la pasarela aprueba un valor distinto, el pago queda en revisión y no cierra nada.
- **Idempotente:** el mismo aviso dos veces no factura dos veces. Todos los avisos quedan en `payment_events`.
- **Una mesa, un pago a la vez:** mientras alguien paga en línea no se aceptan pedidos nuevos ni cobro en caja.
  Si nadie termina, el intento vence a los 15 minutos.
- **La mesa sigue cerrándose solo con pago validado:** el pago aprobado emite la factura y cierra la sesión dentro de la
  misma regla de base de datos (`trg_guard_session_close`).

Para usar pasarelas reales necesitas una dirección pública en HTTPS (`PUBLIC_BASE_URL`): Mercado Pago solo acepta
regresos HTTPS y las dos envían webhooks desde internet. Para probar desde tu PC, un túnel como
`cloudflared tunnel --url http://localhost:8080` o `ngrok http 8080` da esa dirección. Registra el webhook de Wompi en su
panel: `<PUBLIC_BASE_URL>/api/payments/webhooks/wompi` (el de Mercado Pago se envía solo en cada pago).
Empieza con las llaves de **pruebas** de cada pasarela antes de pasar a producción.

## Tiempo real

Socket.IO con salas por restaurante, por rol y por mesa. El carrito compartido vive en la base de datos;
tras cada cambio el servidor envía el carrito completo a toda la mesa, de modo que no hay conflictos que
resolver en el cliente. La lista de eventos está documentada en `backend/src/realtime/bus.ts`.

## Reglas que hace cumplir la base de datos

- Una sola sesión abierta por mesa (índice único parcial).
- **La mesa solo se cierra con el pago validado:** el trigger `trg_guard_session_close` rechaza cerrar una
  sesión sin factura emitida y pagos aprobados que cubran el total. Vale para este backend y para cualquier otro.
- Deducción de ingredientes por plato vendido: `fn_deduct_inventory`, dentro de la transacción que confirma la comanda.
- Alertas de inventario: vista `v_inventory_status` (punto de pedido + rotación de 7 días → rojo, amarillo u OK).

## Facturación

Cada cobro emite su factura: la cuenta de una mesa, un domicilio pagado en línea (al aprobarse) o uno en efectivo o
datáfono (al entregarlo). La emisión de factura electrónica y el pago en caja son **simulados** (`backend/src/billing/providers.ts`):
generan numeración, liquidan el impuesto y devuelven un código con forma de CUFE, pero no transmiten nada a la
DIAN ni tienen validez fiscal. Para producción se sustituyen los dos adaptadores (`EInvoiceProvider`,
`PaymentGateway`) por los de un proveedor real; el resto del sistema no cambia.

La tarifa (INC 8 %), si los precios incluyen el impuesto y la propina sugerida (10 %, voluntaria) son
configuración de cada restaurante en la tabla `restaurants`. Confírmalos con tu contador antes de facturar de verdad.

## Desarrollo sin reconstruir imágenes

```bash
docker compose up db                     # solo la base de datos (puerto 5433)

cd backend && npm install
DATABASE_URL=postgres://frictionless:frictionless@localhost:5433/frictionless npm run dev

cd frontend && npm install && npm run dev   # http://localhost:5173, con recarga en caliente
```

En PowerShell, define la variable antes: `$env:DATABASE_URL="postgres://frictionless:frictionless@localhost:5433/frictionless"`.

### Prueba de humo

`backend/scripts/smoke-test.mjs` recorre el flujo completo contra el sistema levantado (142 comprobaciones:
permisos, QR, carrito compartido, cocina, cobro, cierre de mesa, CRUD, llegadas tarde, pago de la mesa desde el
celular, webhooks de Wompi y Mercado Pago con firmas reales, y el ciclo completo de domicilios y repartidores).
Asume la base recién creada:

```bash
docker compose down -v && docker compose up --build -d
cd backend && npm install && npm run smoke
```

### Cambios de esquema

Las migraciones aplicadas no se editan: para cambiar el esquema, agrega `V6__lo_que_cambia.sql`.
Si ya tenías la base de una versión anterior, `docker compose up --build` aplica V4 y V5 solo, sin borrar nada.
Si un archivo ya aplicado cambia, el backend se detiene al arrancar y lo dice en el log (igual que Flyway);
en desarrollo se resuelve recreando la base con `docker compose down -v`.
Los nombres siguen la convención de Flyway, así que los mismos archivos sirven si el backend pasa a Spring Boot.

## Lo que falta para producción

- **Multi-restaurante real.** El esquema ya es multi-tenant (`restaurant_id` en las tablas raíz), pero las rutas públicas
  atienden un restaurante por despliegue (`DEFAULT_RESTAURANT_SLUG`). Falta resolver el tenant por subdominio:
  el único punto a cambiar es `getPublicRestaurant()`.
- **Facturación electrónica real** (ver arriba) y **reembolsos por API** (hoy se marcan como pendientes).
- **Domicilios a escala:** buscar la dirección escrita en el mapa (geocodificación), rutas reales (OSRM, Google Routes)
  en vez de distancia en línea recta, zonas dibujadas como polígonos, notificaciones push y una app nativa para el
  repartidor (en el navegador el GPS se pausa con la pantalla apagada).
- **Fotos propias.** La carta demo usa URLs públicas de Unsplash; si alguna no carga, la app muestra un marcador.
- **Gestión de mesas y usuarios desde el admin** (hoy se crean por SQL) y editor de recetas por plato.
- **HTTPS, secreto JWT propio, copias de seguridad** y límites de peticiones en el borde.
- **Endurecer el QR si hace falta:** PIN de mesa que entrega el camarero, o confirmar por geolocalización.
- **Pruebas unitarias** (hoy solo hay la prueba de humo) y varias réplicas del backend (adaptador Redis de Socket.IO).
