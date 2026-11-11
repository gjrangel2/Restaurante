# FrictionlessOrder

Sistema SaaS de pedidos por QR para restaurantes, con sala, cocina y caja sincronizadas en tiempo real.
Este repositorio es el **código fundacional**: un flujo completo y ejecutable de punta a punta, listo para crecer.

- **Frontend:** React 18, TypeScript, Tailwind CSS, Vite, Socket.IO client
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

| Rol            | Correo             | Contraseña | Entra a   |
|----------------|--------------------|------------|-----------|
| Admin/Gerente  | `admin@demo.test`  | `demo1234` | `/admin`  |
| Camarero/Sala  | `sala@demo.test`   | `demo1234` | `/sala`   |
| Cocina         | `cocina@demo.test` | `demo1234` | `/cocina` |
| Cliente        | sin cuenta         |            | `/mesa/12` (el QR de la mesa) |

En la pantalla de acceso hay tres botones para entrar con cada cuenta demo de un toque.

Para detenerlo: `docker compose down`. Para empezar con la base de datos de cero: `docker compose down -v`.
Si un puerto está ocupado, copia `.env.example` como `.env` y cambia `WEB_PORT`, `API_PORT` o `DB_PORT`.

## Pruébalo en dos minutos

1. Entra como **Sala**. El mapa ya trae mesas en los cinco estados.
2. Abre en otra pestaña **http://localhost:8080/mesa/2**: verás la pantalla de espera, porque la mesa 2 está cerrada.
3. En el mapa, toca la **mesa 2** y pulsa **Abrir mesa**. La otra pestaña pasa sola a la carta.
4. Abre `/mesa/2` en una ventana de incógnito: es un segundo comensal (Cliente #2). Agrega platos en una y míralos aparecer en la otra.
5. Pulsa **Enviar pedido**. En el mapa, la mesa se pone naranja con el aviso de comanda por confirmar.
6. En el panel de la mesa, **Confirmar y enviar a cocina**. Entra como **Cocina** en otra pestaña y marca los platos.
7. De vuelta en Sala, **Marcar entregada** (verde). Desde el cliente, **Pedir la cuenta** (rojo parpadeante).
8. **Cobrar → Validar pago y cerrar mesa**. La mesa vuelve a gris y el cliente ve la despedida.

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
│   └── V3__demo_activity.sql   (opcional) ventas de 7 días y mesas en vivo para la demo
├── backend/src/
│   ├── index.ts                arranque: Express + Socket.IO + migraciones
│   ├── routes.ts               toda la API y su RBAC, en un solo lugar
│   ├── auth/                   tokens del personal y de sesión de mesa, middlewares
│   ├── realtime/               bus de eventos y gateway de Socket.IO
│   ├── billing/providers.ts    pasarela de pago y facturación electrónica SIMULADAS
│   ├── db/                     pool y migrador
│   └── modules/                tables, guests, cart, orders, billing, inventory, menu, admin
└── frontend/src/
    ├── features/floor/         FloorMap.tsx (mapa visual), tableStatus.ts (colores), panel de mesa
    ├── features/customer/      CustomerMenu.tsx (menú móvil), useSharedCart.ts (carrito compartido)
    ├── features/kitchen/       pantalla de cocina
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
| **Admin/Gerente** | Todo: dashboard, mapa, cocina, inventario, carta, banners, cobro |
| **Camarero/Sala** | Mapa, abrir mesas, confirmar o rechazar comandas, entregar, atender llamados, cobrar |
| **Cocina** | Comandas confirmadas en tiempo real, estado de cada plato, alertas de insumos, agotar platos |
| **Cliente** | Anónimo. Ver la carta y pedir, solo con la mesa abierta y con un token ligado a esa sesión |

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

La emisión de factura electrónica y la validación del pago son **simuladas** (`backend/src/billing/providers.ts`):
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

`backend/scripts/smoke-test.mjs` recorre el flujo completo contra el sistema levantado (69 comprobaciones:
permisos, QR, carrito compartido, cocina, cobro, cierre de mesa y CRUD). Asume la base recién creada:

```bash
docker compose down -v && docker compose up --build -d
cd backend && npm install && npm run smoke
```

### Cambios de esquema

Las migraciones aplicadas no se editan: para cambiar el esquema, agrega `V4__lo_que_cambia.sql`.
Si un archivo ya aplicado cambia, el backend se detiene al arrancar y lo dice en el log (igual que Flyway);
en desarrollo se resuelve recreando la base con `docker compose down -v`.
Los nombres siguen la convención de Flyway, así que los mismos archivos sirven si el backend pasa a Spring Boot.

## Lo que falta para producción

- **Multi-restaurante real.** El esquema ya es multi-tenant (`restaurant_id` en las tablas raíz), pero las rutas públicas
  atienden un restaurante por despliegue (`DEFAULT_RESTAURANT_SLUG`). Falta resolver el tenant por subdominio:
  el único punto a cambiar es `getPublicRestaurant()`.
- **Facturación y pagos reales** (ver arriba).
- **Fotos propias.** La carta demo usa URLs públicas de Unsplash; si alguna no carga, la app muestra un marcador.
- **Gestión de mesas y usuarios desde el admin** (hoy se crean por SQL) y editor de recetas por plato.
- **HTTPS, secreto JWT propio, copias de seguridad** y límites de peticiones en el borde.
- **Endurecer el QR si hace falta:** PIN de mesa que entrega el camarero, o confirmar por geolocalización.
- **Pruebas unitarias** (hoy solo hay la prueba de humo) y varias réplicas del backend (adaptador Redis de Socket.IO).
