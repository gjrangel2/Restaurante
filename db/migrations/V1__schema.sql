-- =====================================================================
-- FrictionlessOrder · V1 · Esquema base
-- PostgreSQL 16. El nombre del archivo sigue la convención de Flyway
-- (V<versión>__<descripción>.sql), así que sirve igual con Flyway/Spring
-- Boot o con el migrador incluido en el backend Node.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), crypt(), digest()

-- ---------------------------------------------------------------------
-- Tipos enumerados
-- ---------------------------------------------------------------------
-- RBAC mínimo. El cuarto rol (Cliente) es anónimo: no vive en "users",
-- se identifica con un token ligado a table_sessions.
CREATE TYPE user_role         AS ENUM ('ADMIN', 'WAITER', 'KITCHEN');

-- Los 5 estados exactos del mapa del restaurante.
--   FREE          Libre                              (gris)
--   OCCUPIED      Ocupada / leyendo menú             (azul)
--   WAITING_ORDER Esperando pedido                   (naranja)
--   SERVED        Servida / comiendo                 (verde)
--   CALLING       Llamado a camarero / pide cuenta   (rojo parpadeante)
CREATE TYPE table_status      AS ENUM ('FREE', 'OCCUPIED', 'WAITING_ORDER', 'SERVED', 'CALLING');
CREATE TYPE table_shape       AS ENUM ('ROUND', 'SQUARE', 'RECT');

CREATE TYPE order_status      AS ENUM ('PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'SERVED', 'CANCELLED');
CREATE TYPE order_item_status AS ENUM ('PENDING', 'PREPARING', 'READY', 'SERVED', 'CANCELLED');
CREATE TYPE call_type         AS ENUM ('WAITER', 'BILL');
CREATE TYPE movement_type     AS ENUM ('SALE', 'PURCHASE', 'ADJUSTMENT', 'WASTE');
CREATE TYPE invoice_status    AS ENUM ('DRAFT', 'ISSUED', 'VOIDED');
CREATE TYPE payment_method    AS ENUM ('CASH', 'CARD', 'TRANSFER');
CREATE TYPE payment_status    AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- ---------------------------------------------------------------------
-- Tenant: cada restaurante es un inquilino del SaaS
-- ---------------------------------------------------------------------
CREATE TABLE restaurants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text NOT NULL UNIQUE,
  name               text NOT NULL,
  legal_name         text,
  tax_id             text,                                   -- NIT
  timezone           text NOT NULL DEFAULT 'America/Bogota',
  currency           char(3) NOT NULL DEFAULT 'COP',
  tax_name           text NOT NULL DEFAULT 'INC',            -- impuesto nacional al consumo
  tax_rate           numeric(5,2) NOT NULL DEFAULT 8.00 CHECK (tax_rate >= 0 AND tax_rate < 100),
  prices_include_tax boolean NOT NULL DEFAULT true,          -- la carta muestra precio final
  suggested_tip_rate numeric(5,2) NOT NULL DEFAULT 10.00 CHECK (suggested_tip_rate >= 0 AND suggested_tip_rate <= 30),
  invoice_prefix     text NOT NULL DEFAULT 'FE',
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Users (personal del restaurante)
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  full_name     text NOT NULL,
  email         text NOT NULL,
  password_hash text NOT NULL,                               -- bcrypt
  role          user_role NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE INDEX users_restaurant_idx ON users (restaurant_id, role);

-- ---------------------------------------------------------------------
-- Tables (mesas). "tables" a secas se presta a confusión en SQL,
-- por eso la tabla se llama restaurant_tables.
-- ---------------------------------------------------------------------
CREATE TABLE restaurant_tables (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  number            int  NOT NULL CHECK (number > 0),        -- el número impreso en el QR: /mesa/12
  seats             int  NOT NULL DEFAULT 4 CHECK (seats BETWEEN 1 AND 30),
  zone              text NOT NULL DEFAULT 'Salón',
  shape             table_shape NOT NULL DEFAULT 'SQUARE',
  pos_x             int  NOT NULL DEFAULT 0 CHECK (pos_x >= 0),  -- columna en la grilla del mapa
  pos_y             int  NOT NULL DEFAULT 0 CHECK (pos_y >= 0),  -- fila en la grilla del mapa
  status            table_status NOT NULL DEFAULT 'FREE',    -- caché del estado derivado (ver backend: refreshTableStatus)
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  is_active         boolean NOT NULL DEFAULT true,
  UNIQUE (restaurant_id, number)
);

-- ---------------------------------------------------------------------
-- Sesiones de mesa: el corazón del anti-fraude del QR.
-- El QR es estático, pero solo se puede pedir mientras exista una sesión
-- abierta por un camarero. El id (UUID aleatorio) es el identificador de
-- sesión que viaja firmado dentro del token del cliente; al cerrarse la
-- sesión, todos los tokens emitidos para ella dejan de servir.
-- ---------------------------------------------------------------------
CREATE TABLE table_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id      uuid NOT NULL REFERENCES restaurant_tables(id),
  opened_by     uuid NOT NULL REFERENCES users(id),
  opened_at     timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  closed_by     uuid REFERENCES users(id),
  close_reason  text CHECK (close_reason IN ('PAID', 'CANCELLED')),
  CHECK ((closed_at IS NULL) = (close_reason IS NULL))
);
-- Una sola sesión abierta por mesa, garantizado por la base de datos.
CREATE UNIQUE INDEX table_sessions_one_open_uq ON table_sessions (table_id) WHERE closed_at IS NULL;
CREATE INDEX table_sessions_restaurant_idx ON table_sessions (restaurant_id, opened_at DESC);

-- Comensales anónimos de una sesión. Se numeran por orden de llegada a la mesa
-- ("Cliente #1", "Cliente #2"…) para saber quién pidió qué en el carrito compartido.
CREATE TABLE session_guests (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES table_sessions(id) ON DELETE CASCADE,
  number     int  NOT NULL CHECK (number > 0),             -- 1, 2, 3… dentro de la sesión
  alias      text NOT NULL,                                -- nombre visible: "Cliente #1"
  color      text NOT NULL,                                -- color del distintivo en pantalla
  joined_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, number)
);

-- ---------------------------------------------------------------------
-- Menú: categorías y Products
-- ---------------------------------------------------------------------
CREATE TABLE categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  sort_order    int  NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (restaurant_id, name)
);

CREATE TABLE products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id   uuid NOT NULL REFERENCES categories(id),
  name          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  price         numeric(12,2) NOT NULL CHECK (price >= 0),
  image_url     text,
  is_available  boolean NOT NULL DEFAULT true,               -- "86": cocina o admin lo agotan al instante
  is_featured   boolean NOT NULL DEFAULT false,
  prep_minutes  int  NOT NULL DEFAULT 15 CHECK (prep_minutes >= 0),
  tags          text[] NOT NULL DEFAULT '{}',
  sort_order    int  NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz                                  -- borrado lógico: las comandas históricas lo referencian
);
CREATE INDEX products_menu_idx ON products (restaurant_id, category_id, sort_order) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------
-- Inventory: insumos, recetas (escandallo) y kardex
-- ---------------------------------------------------------------------
CREATE TABLE inventory_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  unit          text NOT NULL CHECK (unit IN ('g', 'ml', 'und')),
  stock         numeric(14,3) NOT NULL DEFAULT 0,            -- puede quedar negativo: es una señal, no un error
  reorder_level numeric(14,3) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, name)
);

-- Receta: cuánto de cada insumo consume una unidad vendida del plato.
CREATE TABLE product_ingredients (
  product_id        uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  quantity          numeric(12,3) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (product_id, inventory_item_id)
);

-- ---------------------------------------------------------------------
-- Promotions (banners de la app del cliente)
-- ---------------------------------------------------------------------
CREATE TABLE promotions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  title         text NOT NULL,
  subtitle      text NOT NULL DEFAULT '',
  image_url     text,
  product_id    uuid REFERENCES products(id) ON DELETE SET NULL,  -- opcional: el banner lleva a un plato
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX promotions_window_idx ON promotions (restaurant_id, starts_at, ends_at) WHERE is_active;

-- ---------------------------------------------------------------------
-- Carrito colaborativo: pertenece a la sesión de mesa, no a una persona.
-- Cada línea recuerda quién la agregó.
-- ---------------------------------------------------------------------
CREATE TABLE cart_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES table_sessions(id) ON DELETE CASCADE,
  guest_id   uuid NOT NULL REFERENCES session_guests(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  quantity   int  NOT NULL CHECK (quantity BETWEEN 1 AND 50),
  notes      text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, guest_id, product_id, notes)
);

-- ---------------------------------------------------------------------
-- Orders y OrderItems (comandas)
-- ---------------------------------------------------------------------
CREATE TABLE orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number  bigint GENERATED ALWAYS AS IDENTITY (START WITH 1001) UNIQUE,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id      uuid NOT NULL REFERENCES restaurant_tables(id),
  session_id    uuid NOT NULL REFERENCES table_sessions(id),
  status        order_status NOT NULL DEFAULT 'PENDING',     -- PENDING = espera confirmación del camarero
  created_at    timestamptz NOT NULL DEFAULT now(),
  confirmed_at  timestamptz,
  confirmed_by  uuid REFERENCES users(id),
  ready_at      timestamptz,
  served_at     timestamptz,
  cancelled_at  timestamptz
);
CREATE INDEX orders_session_idx ON orders (session_id);
CREATE INDEX orders_active_idx  ON orders (restaurant_id, status) WHERE status IN ('PENDING', 'CONFIRMED', 'PREPARING', 'READY');
CREATE INDEX orders_created_idx ON orders (restaurant_id, created_at DESC);

CREATE TABLE order_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id),
  product_name text NOT NULL,                                -- copia: la comanda no cambia si luego editan la carta
  unit_price   numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  quantity     int  NOT NULL CHECK (quantity > 0),
  notes        text NOT NULL DEFAULT '',
  guest_alias  text,                                         -- quién lo pidió en la mesa
  status       order_item_status NOT NULL DEFAULT 'PENDING',
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_items_order_idx   ON order_items (order_id);
CREATE INDEX order_items_product_idx ON order_items (product_id);

-- Llamados a camarero / petición de cuenta
CREATE TABLE waiter_calls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id      uuid NOT NULL REFERENCES restaurant_tables(id),
  session_id    uuid NOT NULL REFERENCES table_sessions(id) ON DELETE CASCADE,
  guest_alias   text,
  type          call_type NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  attended_at   timestamptz,
  attended_by   uuid REFERENCES users(id)
);
CREATE INDEX waiter_calls_open_idx ON waiter_calls (table_id) WHERE attended_at IS NULL;

-- Kardex: todo cambio de stock deja rastro. Las ventas se registran en negativo.
CREATE TABLE inventory_movements (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  type              movement_type NOT NULL,
  quantity          numeric(14,3) NOT NULL CHECK (quantity <> 0),
  order_item_id     uuid REFERENCES order_items(id) ON DELETE SET NULL,
  note              text,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_movements_item_idx ON inventory_movements (inventory_item_id, created_at DESC);

-- ---------------------------------------------------------------------
-- Facturación (proveedor simulado) y pagos
-- ---------------------------------------------------------------------
CREATE SEQUENCE invoice_number_seq START WITH 1001;

CREATE TABLE invoices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  session_id        uuid NOT NULL UNIQUE REFERENCES table_sessions(id),
  table_id          uuid NOT NULL REFERENCES restaurant_tables(id),
  invoice_number    text UNIQUE,                             -- se asigna al emitir
  status            invoice_status NOT NULL DEFAULT 'DRAFT',
  subtotal          numeric(12,2) NOT NULL DEFAULT 0,        -- base gravable
  tax_name          text NOT NULL,
  tax_rate          numeric(5,2) NOT NULL,
  tax_total         numeric(12,2) NOT NULL DEFAULT 0,
  tip_rate          numeric(5,2) NOT NULL DEFAULT 0,
  tip_total         numeric(12,2) NOT NULL DEFAULT 0,        -- propina voluntaria: nunca entra en la base
  grand_total       numeric(12,2) NOT NULL DEFAULT 0,
  customer_name     text NOT NULL DEFAULT 'Consumidor final',
  customer_doc      text NOT NULL DEFAULT '222222222222',
  customer_email    text,
  cufe              text,                                    -- código único que devuelve el proveedor (aquí, simulado)
  provider          text NOT NULL DEFAULT 'MOCK',
  provider_response jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  issued_at         timestamptz
);
CREATE INDEX invoices_issued_idx ON invoices (restaurant_id, issued_at DESC) WHERE status = 'ISSUED';

CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  method          payment_method NOT NULL,
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),  -- lo que se aplica a la factura
  amount_received numeric(12,2) NOT NULL CHECK (amount_received >= 0),
  change_due      numeric(12,2) NOT NULL DEFAULT 0,
  status          payment_status NOT NULL DEFAULT 'PENDING',
  reference       text,                                      -- autorización de la pasarela (simulada)
  validated_by    uuid REFERENCES users(id),
  validated_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_invoice_idx ON payments (invoice_id);

-- ---------------------------------------------------------------------
-- Reglas de negocio que la base de datos hace cumplir
-- ---------------------------------------------------------------------

-- updated_at automático
CREATE FUNCTION fn_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER trg_products_touch        BEFORE UPDATE ON products        FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();
CREATE TRIGGER trg_inventory_items_touch BEFORE UPDATE ON inventory_items FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();
CREATE TRIGGER trg_cart_items_touch      BEFORE UPDATE ON cart_items      FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();
CREATE TRIGGER trg_order_items_touch     BEFORE UPDATE ON order_items     FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

-- "La mesa se cierra únicamente cuando el pago es validado."
-- Ningún backend (Node hoy, Spring Boot mañana) puede saltarse esta regla:
--   · PAID      exige factura emitida y pagos aprobados que cubran el total.
--   · CANCELLED solo se permite si la mesa no tiene comandas vivas
--               (el camarero abrió por error o los clientes se fueron sin pedir).
CREATE FUNCTION fn_guard_session_close() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_total numeric;
  v_paid  numeric;
BEGIN
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'La sesión % ya está cerrada y no se puede modificar', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.closed_at IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.close_reason = 'CANCELLED' THEN
    IF EXISTS (SELECT 1 FROM orders WHERE session_id = NEW.id AND status <> 'CANCELLED') THEN
      RAISE EXCEPTION 'No se puede cancelar una mesa con comandas activas'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT i.grand_total,
         COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'APPROVED'), 0)
    INTO v_total, v_paid
    FROM invoices i
    LEFT JOIN payments p ON p.invoice_id = i.id
   WHERE i.session_id = NEW.id AND i.status = 'ISSUED'
   GROUP BY i.id;

  IF v_total IS NULL OR v_paid < v_total THEN
    RAISE EXCEPTION 'La mesa solo se cierra cuando el pago está validado'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_guard_session_close
  BEFORE UPDATE ON table_sessions
  FOR EACH ROW EXECUTE FUNCTION fn_guard_session_close();

-- Deducción de ingredientes por plato vendido. El backend la llama dentro de
-- la misma transacción en la que el camarero confirma la comanda.
CREATE FUNCTION fn_deduct_inventory(p_order_id uuid, p_user_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- 1) Kardex: un movimiento por cada (ítem de la comanda × insumo de su receta)
  INSERT INTO inventory_movements (restaurant_id, inventory_item_id, type, quantity, order_item_id, created_by)
  SELECT o.restaurant_id, pi.inventory_item_id, 'SALE', -(oi.quantity * pi.quantity), oi.id, p_user_id
    FROM order_items oi
    JOIN orders o               ON o.id = oi.order_id
    JOIN product_ingredients pi ON pi.product_id = oi.product_id
   WHERE oi.order_id = p_order_id AND oi.status <> 'CANCELLED';

  -- 2) Saldo de cada insumo
  UPDATE inventory_items ii
     SET stock = ii.stock - used.total
    FROM (
      SELECT pi.inventory_item_id, SUM(oi.quantity * pi.quantity) AS total
        FROM order_items oi
        JOIN product_ingredients pi ON pi.product_id = oi.product_id
       WHERE oi.order_id = p_order_id AND oi.status <> 'CANCELLED'
       GROUP BY pi.inventory_item_id
    ) used
   WHERE ii.id = used.inventory_item_id;
END $$;

-- Estado del inventario con rotación y alerta.
--   avg_daily_usage  consumo medio diario de los últimos 7 días (rotación)
--   days_of_cover    para cuántos días alcanza el stock a ese ritmo
--   alert_level      RED     agotado, por debajo de la mitad del punto de pedido, o menos de 1 día de cobertura
--                    YELLOW  por debajo del punto de pedido, o menos de 3 días de cobertura
--                    OK      el resto
CREATE VIEW v_inventory_status AS
SELECT ii.id,
       ii.restaurant_id,
       ii.name,
       ii.unit,
       ii.stock,
       ii.reorder_level,
       ii.updated_at,
       COALESCE(u.used_7d, 0)                    AS used_7d,
       ROUND(COALESCE(u.used_7d, 0) / 7.0, 3)    AS avg_daily_usage,
       CASE WHEN COALESCE(u.used_7d, 0) > 0
            THEN ROUND(GREATEST(ii.stock, 0) / (u.used_7d / 7.0), 1)
       END                                       AS days_of_cover,
       CASE
         WHEN ii.stock <= 0                                               THEN 'RED'
         WHEN ii.stock <= ii.reorder_level * 0.5                          THEN 'RED'
         WHEN COALESCE(u.used_7d, 0) > 0 AND ii.stock / (u.used_7d / 7.0) < 1 THEN 'RED'
         WHEN ii.stock <= ii.reorder_level                                THEN 'YELLOW'
         WHEN COALESCE(u.used_7d, 0) > 0 AND ii.stock / (u.used_7d / 7.0) < 3 THEN 'YELLOW'
         ELSE 'OK'
       END                                       AS alert_level
  FROM inventory_items ii
  LEFT JOIN (
    SELECT inventory_item_id, -SUM(quantity) AS used_7d
      FROM inventory_movements
     WHERE type = 'SALE' AND created_at >= now() - interval '7 days'
     GROUP BY inventory_item_id
  ) u ON u.inventory_item_id = ii.id;
