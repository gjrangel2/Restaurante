-- =====================================================================
-- FrictionlessOrder · V4 · Comensales tardíos, domicilios y pagos en línea
--
--   1. Aviso al mesero cuando alguien se une a una mesa que ya pidió
--   2. Rol Repartidor con su perfil (vehículo, disponibilidad, ubicación)
--   3. Domicilios y pedidos para recoger, con zonas de cobertura y tarifa
--   4. Seguimiento en vivo (recorrido del repartidor)
--   5. Pagos en línea (Wompi, Mercado Pago, PSE o pasarela de pruebas),
--      también para pagar la cuenta de la mesa desde el celular
--
-- Las migraciones aplicadas no se editan: esta versión solo agrega.
-- =====================================================================

-- PostgreSQL permite agregar un valor a un enum dentro de una transacción,
-- pero no usarlo hasta que la transacción termine: los repartidores demo
-- se crean en V5.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'COURIER';

-- ---------------------------------------------------------------------
-- 1) Comensal que llega tarde
-- ---------------------------------------------------------------------
-- joined_late: se unió cuando la mesa ya tenía comandas.
-- late_ack_*:  el camarero vio el aviso ("Entendido").
ALTER TABLE session_guests
  ADD COLUMN joined_late boolean NOT NULL DEFAULT false,
  ADD COLUMN late_ack_at timestamptz,
  ADD COLUMN late_ack_by uuid REFERENCES users(id);

-- ---------------------------------------------------------------------
-- 2) Restaurante: ubicación y reglas de domicilio
-- ---------------------------------------------------------------------
ALTER TABLE restaurants
  ADD COLUMN address               text,
  ADD COLUMN phone                 text,
  ADD COLUMN lat                   numeric(9,6) CHECK (lat BETWEEN -90 AND 90),
  ADD COLUMN lng                   numeric(9,6) CHECK (lng BETWEEN -180 AND 180),
  ADD COLUMN delivery_enabled      boolean NOT NULL DEFAULT false,
  ADD COLUMN pickup_enabled        boolean NOT NULL DEFAULT false,
  ADD COLUMN delivery_min_order    numeric(12,2) NOT NULL DEFAULT 0 CHECK (delivery_min_order >= 0),
  ADD COLUMN delivery_prep_minutes int NOT NULL DEFAULT 25 CHECK (delivery_prep_minutes BETWEEN 0 AND 240);

-- Cobertura por anillos de distancia en línea recta desde el restaurante.
-- Ej.: hasta 3 km $4.000, hasta 6 km $7.000. Más allá del último anillo no se entrega.
CREATE TABLE delivery_zones (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name           text NOT NULL,
  max_km         numeric(5,2) NOT NULL CHECK (max_km > 0 AND max_km <= 50),
  fee            numeric(12,2) NOT NULL CHECK (fee >= 0),
  travel_minutes int NOT NULL DEFAULT 15 CHECK (travel_minutes BETWEEN 0 AND 180),
  UNIQUE (restaurant_id, max_km)
);

-- ---------------------------------------------------------------------
-- 3) Repartidores: el usuario tiene rol COURIER y este perfil
-- ---------------------------------------------------------------------
CREATE TYPE vehicle_type AS ENUM ('MOTO', 'BICI', 'CARRO');

CREATE TABLE courier_profiles (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phone        text NOT NULL,
  vehicle      vehicle_type NOT NULL DEFAULT 'MOTO',
  plate        text,
  is_available boolean NOT NULL DEFAULT false,         -- "En turno": recibe pedidos
  last_lat     numeric(9,6),
  last_lng     numeric(9,6),
  last_heading int CHECK (last_heading BETWEEN 0 AND 359),
  last_seen_at timestamptz                              -- última ubicación recibida
);

-- ---------------------------------------------------------------------
-- 4) Comandas por canal. Un domicilio usa la MISMA cola de cocina, el
--    mismo descuento de inventario y los mismos estados de plato que una
--    mesa; solo cambia que no tiene mesa ni sesión.
-- ---------------------------------------------------------------------
CREATE TYPE order_channel AS ENUM ('DINE_IN', 'DELIVERY', 'PICKUP');

ALTER TABLE orders
  ADD COLUMN channel order_channel NOT NULL DEFAULT 'DINE_IN',
  ALTER COLUMN table_id   DROP NOT NULL,
  ALTER COLUMN session_id DROP NOT NULL,
  ADD CONSTRAINT orders_channel_chk CHECK (
    (channel = 'DINE_IN' AND table_id IS NOT NULL AND session_id IS NOT NULL)
    OR (channel <> 'DINE_IN' AND table_id IS NULL AND session_id IS NULL)
  );

-- ---------------------------------------------------------------------
-- 5) Domicilios y pedidos para recoger
-- ---------------------------------------------------------------------
-- Estado visible para el cliente. Igual que en las mesas, no se asigna a
-- mano: el backend lo deriva de las marcas de tiempo y de la comanda
-- (refreshDeliveryStatus en delivery.service.ts).
CREATE TYPE delivery_status AS ENUM (
  'PENDING_PAYMENT', -- pago en línea sin aprobar: el restaurante aún no lo ve
  'PLACED',          -- recibido, espera que el restaurante lo acepte
  'ACCEPTED',        -- aceptado: en la cola de cocina
  'PREPARING',       -- cocina empezó
  'READY',           -- listo para salir (o para recoger)
  'ON_THE_WAY',      -- el repartidor lo recogió
  'DELIVERED',       -- entregado con el PIN del cliente
  'CANCELLED'
);
CREATE TYPE delivery_payment AS ENUM ('CASH', 'CARD_ON_DELIVERY', 'ONLINE');

CREATE TABLE delivery_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            bigint GENERATED ALWAYS AS IDENTITY (START WITH 2001) UNIQUE,  -- se muestra como D-2001
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id        uuid NOT NULL UNIQUE REFERENCES orders(id),                     -- la comanda de cocina
  type            order_channel NOT NULL CHECK (type IN ('DELIVERY', 'PICKUP')),
  status          delivery_status NOT NULL DEFAULT 'PLACED',
  tracking_code   text NOT NULL UNIQUE,                                          -- secreto: /pedido/<código>
  delivery_pin    char(4) NOT NULL,                                              -- el cliente lo dicta al recibir
  customer_name   text NOT NULL,
  customer_phone  text NOT NULL,
  customer_email  text,
  address_line    text,
  address_details text,                                                          -- apto, torre, conjunto
  address_notes   text,                                                          -- indicaciones para el repartidor
  lat             numeric(9,6),
  lng             numeric(9,6),
  distance_km     numeric(6,2),
  zone_id         uuid REFERENCES delivery_zones(id) ON DELETE SET NULL,
  subtotal        numeric(12,2) NOT NULL CHECK (subtotal >= 0),                   -- platos, impuesto incluido
  delivery_fee    numeric(12,2) NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0),
  total           numeric(12,2) NOT NULL CHECK (total >= 0),
  payment_method  delivery_payment NOT NULL,
  paid_at         timestamptz,
  refund_pending  boolean NOT NULL DEFAULT false,                                -- pagó en línea y se canceló
  courier_id      uuid REFERENCES users(id),
  estimated_at    timestamptz,                                                   -- hora estimada de entrega
  created_at      timestamptz NOT NULL DEFAULT now(),
  placed_at       timestamptz,
  accepted_at     timestamptz,
  assigned_at     timestamptz,
  picked_up_at    timestamptz,
  delivered_at    timestamptz,
  cancelled_at    timestamptz,
  cancel_reason   text,
  CHECK (type <> 'DELIVERY' OR (address_line IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL)),
  CHECK (total = subtotal + delivery_fee)
);
CREATE INDEX delivery_orders_board_idx   ON delivery_orders (restaurant_id, status, created_at DESC);
CREATE INDEX delivery_orders_courier_idx ON delivery_orders (courier_id) WHERE status IN ('ACCEPTED', 'PREPARING', 'READY', 'ON_THE_WAY');

-- Recorrido del repartidor durante la entrega (la línea que ve el cliente en el mapa).
CREATE TABLE delivery_tracks (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_order_id uuid NOT NULL REFERENCES delivery_orders(id) ON DELETE CASCADE,
  lat               numeric(9,6) NOT NULL,
  lng               numeric(9,6) NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_tracks_order_idx ON delivery_tracks (delivery_order_id, recorded_at);

-- ---------------------------------------------------------------------
-- 6) Pagos en línea
-- ---------------------------------------------------------------------
-- Un "intento" es cada vez que el cliente va a la pasarela. Su estado lo
-- confirman la consulta a la API del proveedor o su webhook firmado, nunca
-- solo la redirección del navegador.
CREATE TYPE payment_provider AS ENUM ('WOMPI', 'MERCADOPAGO', 'MOCK');
CREATE TYPE intent_status    AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'ERROR', 'EXPIRED');

CREATE TABLE payment_intents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference         text NOT NULL UNIQUE,                       -- la que viaja a la pasarela
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  purpose           text NOT NULL CHECK (purpose IN ('DELIVERY', 'TABLE_BILL')),
  delivery_order_id uuid REFERENCES delivery_orders(id) ON DELETE CASCADE,
  session_id        uuid REFERENCES table_sessions(id) ON DELETE CASCADE,
  provider          payment_provider NOT NULL,                  -- quién procesa
  channel           text NOT NULL CHECK (channel IN ('WOMPI', 'MERCADOPAGO', 'PSE')),  -- lo que eligió el cliente
  live              boolean NOT NULL,                           -- false = pasarela de pruebas, sin dinero real
  amount            numeric(12,2) NOT NULL CHECK (amount > 0),
  tip_rate          numeric(5,2) NOT NULL DEFAULT 0,
  currency          char(3) NOT NULL,
  status            intent_status NOT NULL DEFAULT 'PENDING',
  checkout_url      text,
  provider_tx_id    text,                                       -- id de la transacción en el proveedor
  provider_method   text,                                       -- CARD, PSE, NEQUI… según el proveedor
  provider_status   text,
  raw               jsonb,
  needs_review      boolean NOT NULL DEFAULT false,             -- aprobado pero no cuadró: revisar a mano
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  CHECK ((purpose = 'DELIVERY')   = (delivery_order_id IS NOT NULL)),
  CHECK ((purpose = 'TABLE_BILL') = (session_id IS NOT NULL))
);
-- Un solo pago en línea en curso por mesa: mientras exista, no se reciben comandas nuevas.
CREATE UNIQUE INDEX payment_intents_one_pending_table_uq ON payment_intents (session_id) WHERE status = 'PENDING' AND purpose = 'TABLE_BILL';
CREATE INDEX payment_intents_delivery_idx ON payment_intents (delivery_order_id);
CREATE TRIGGER trg_payment_intents_touch BEFORE UPDATE ON payment_intents FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

-- Bitácora de webhooks recibidos (también los de firma inválida), para auditar.
CREATE TABLE payment_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider        payment_provider NOT NULL,
  reference       text,
  valid_signature boolean NOT NULL,
  payload         jsonb NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 7) Facturas y pagos: ahora también de domicilios y en línea
-- ---------------------------------------------------------------------
ALTER TABLE invoices
  ALTER COLUMN session_id DROP NOT NULL,
  ALTER COLUMN table_id   DROP NOT NULL,
  ADD COLUMN delivery_order_id uuid UNIQUE REFERENCES delivery_orders(id),
  ADD COLUMN delivery_fee      numeric(12,2) NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0),
  ADD CONSTRAINT invoices_owner_chk CHECK ((session_id IS NULL) <> (delivery_order_id IS NULL));

ALTER TABLE payments
  ADD COLUMN provider          text NOT NULL DEFAULT 'POS',     -- POS (en caja o al entregar), WOMPI, MERCADOPAGO, MOCK
  ADD COLUMN payment_intent_id uuid REFERENCES payment_intents(id);
