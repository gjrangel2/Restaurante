-- =====================================================================
-- FrictionlessOrder · V3 · Actividad de demostración
-- Opcional. Sirve para que el primer arranque no se vea vacío:
--   1) ventas cerradas de los últimos 7 días (KPIs, platos estrella, rotación)
--   2) siete mesas "en vivo", una por cada situación del mapa
-- Para arrancar en limpio, borra este archivo ANTES del primer
-- `docker compose up` (o recrea el volumen con `docker compose down -v`).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Historial de ventas
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_rid       uuid;
  v_tz        text;
  v_tax       numeric;
  v_prefix    text;
  v_waiter    uuid;
  v_day       int;
  v_tickets   int;
  v_i         int;
  v_ts        timestamptz;
  v_table     uuid;
  v_session   uuid;
  v_order     uuid;
  v_invoice   uuid;
  v_gross     numeric;
  v_tax_total numeric;
  v_tip       numeric;
BEGIN
  SELECT id, timezone, tax_rate, invoice_prefix INTO v_rid, v_tz, v_tax, v_prefix
    FROM restaurants WHERE slug = 'fogon';
  SELECT id INTO v_waiter FROM users WHERE restaurant_id = v_rid AND role = 'WAITER' LIMIT 1;

  FOR v_day IN REVERSE 7..0 LOOP                        -- 0 = hoy
    v_tickets := CASE WHEN v_day = 0 THEN 7 ELSE 11 + floor(random() * 8)::int END;

    FOR v_i IN 1..v_tickets LOOP
      IF v_day = 0 THEN
        v_ts := now() - interval '70 minutes' - random() * interval '4 hours';
      ELSE
        v_ts := (date_trunc('day', now() AT TIME ZONE v_tz) - make_interval(days => v_day)
                 + interval '7 hours' + random() * interval '14 hours') AT TIME ZONE v_tz;
      END IF;

      SELECT id INTO v_table FROM restaurant_tables WHERE restaurant_id = v_rid ORDER BY random() LIMIT 1;

      INSERT INTO table_sessions (restaurant_id, table_id, opened_by, opened_at, closed_at, closed_by, close_reason)
      VALUES (v_rid, v_table, v_waiter, v_ts, v_ts + interval '55 minutes', v_waiter, 'PAID')
      RETURNING id INTO v_session;

      INSERT INTO orders (restaurant_id, table_id, session_id, status, created_at, confirmed_at, confirmed_by, ready_at, served_at)
      VALUES (v_rid, v_table, v_session, 'SERVED', v_ts + interval '5 minutes', v_ts + interval '6 minutes', v_waiter,
              v_ts + interval '22 minutes', v_ts + interval '25 minutes')
      RETURNING id INTO v_order;

      -- Muestreo ponderado: unos platos se venden mucho y otros casi nada,
      -- para que "platos estrella" y "menos vendidos" tengan algo que contar.
      INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, guest_alias, status)
      SELECT v_order, p.id, p.name, p.price, 1 + floor(random() * 2)::int, 'Cliente #1', 'SERVED'
        FROM products p
       WHERE p.restaurant_id = v_rid
       ORDER BY power(random(), 1.0 / (CASE
                  WHEN p.name IN ('Hamburguesa Fogón', 'Costillas ahumadas', 'Limonada de la casa', 'Cerveza artesanal') THEN 6.0
                  WHEN p.is_featured THEN 3.5
                  WHEN p.name IN ('Crema de ahuyama', 'Helado artesanal', 'Tostada de la casa') THEN 0.25
                  ELSE 1.5
                END)) DESC
       LIMIT 2 + floor(random() * 3)::int;

      SELECT SUM(unit_price * quantity) INTO v_gross FROM order_items WHERE order_id = v_order;
      v_tax_total := round(v_gross - v_gross / (1 + v_tax / 100));          -- la carta ya incluye el impuesto
      v_tip := CASE WHEN random() < 0.7 THEN round((v_gross - v_tax_total) * 0.10) ELSE 0 END;

      INSERT INTO invoices (restaurant_id, session_id, table_id, invoice_number, status, subtotal, tax_name, tax_rate,
                            tax_total, tip_rate, tip_total, grand_total, cufe, provider, provider_response, created_at, issued_at)
      VALUES (v_rid, v_session, v_table, v_prefix || nextval('invoice_number_seq'), 'ISSUED', v_gross - v_tax_total, 'INC', v_tax,
              v_tax_total, CASE WHEN v_tip > 0 THEN 10 ELSE 0 END, v_tip, v_gross + v_tip,
              encode(digest(v_session::text, 'sha384'), 'hex'), 'MOCK', '{"simulated": true, "source": "demo-seed"}',
              v_ts + interval '50 minutes', v_ts + interval '52 minutes')
      RETURNING id INTO v_invoice;

      INSERT INTO payments (invoice_id, method, amount, amount_received, status, reference, validated_by, validated_at, created_at)
      VALUES (v_invoice, (ARRAY['CASH', 'CARD', 'CARD', 'TRANSFER'])[1 + floor(random() * 4)::int]::payment_method,
              v_gross + v_tip, v_gross + v_tip, 'APPROVED', 'SIM-' || upper(substr(md5(random()::text), 1, 8)),
              v_waiter, v_ts + interval '52 minutes', v_ts + interval '52 minutes');

      -- Kardex histórico (alimenta la rotación). No toca el stock actual, que ya viene fijado en V2.
      INSERT INTO inventory_movements (restaurant_id, inventory_item_id, type, quantity, order_item_id, created_by, created_at)
      SELECT v_rid, pi.inventory_item_id, 'SALE', -(oi.quantity * pi.quantity), oi.id, v_waiter, v_ts + interval '6 minutes'
        FROM order_items oi
        JOIN product_ingredients pi ON pi.product_id = oi.product_id
       WHERE oi.order_id = v_order;
    END LOOP;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 2) Mesas en vivo
-- ---------------------------------------------------------------------
-- p_guests: cuántos comensales hay en la mesa
-- p_items:  'Producto|cantidad|n.º de cliente|nota|estado del ítem'
CREATE FUNCTION pg_temp.demo_live_table(
  p_number       int,
  p_opened_ago   interval,
  p_guests       int,
  p_order_status order_status,
  p_items        text[],
  p_call         call_type
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_rid     uuid;
  v_waiter  uuid;
  v_table   uuid;
  v_session uuid;
  v_order   uuid;
  v_n       int;
  v_item    text;
  v_opened  timestamptz := now() - p_opened_ago;
  -- Los mismos colores, en el mismo orden, que reparte el backend (guests.service.ts).
  v_colors  text[] := ARRAY['#1D4ED8', '#BE123C', '#15803D', '#B45309', '#6D28D9', '#0F766E'];
BEGIN
  SELECT id INTO v_rid    FROM restaurants WHERE slug = 'fogon';
  SELECT id INTO v_waiter FROM users WHERE restaurant_id = v_rid AND role = 'WAITER' LIMIT 1;
  SELECT id INTO v_table  FROM restaurant_tables WHERE restaurant_id = v_rid AND number = p_number;

  INSERT INTO table_sessions (restaurant_id, table_id, opened_by, opened_at)
  VALUES (v_rid, v_table, v_waiter, v_opened)
  RETURNING id INTO v_session;

  FOR v_n IN 1..p_guests LOOP
    INSERT INTO session_guests (session_id, number, alias, color, joined_at)
    VALUES (v_session, v_n, 'Cliente #' || v_n, v_colors[1 + (v_n - 1) % array_length(v_colors, 1)],
            v_opened + interval '1 minute');
  END LOOP;

  IF p_order_status IS NOT NULL THEN
    INSERT INTO orders (restaurant_id, table_id, session_id, status, created_at, confirmed_at, confirmed_by, ready_at, served_at)
    VALUES (v_rid, v_table, v_session, p_order_status,
            v_opened + p_opened_ago * 0.30,
            CASE WHEN p_order_status <> 'PENDING' THEN v_opened + p_opened_ago * 0.35 END,
            CASE WHEN p_order_status <> 'PENDING' THEN v_waiter END,
            CASE WHEN p_order_status IN ('READY', 'SERVED') THEN v_opened + p_opened_ago * 0.60 END,
            CASE WHEN p_order_status = 'SERVED' THEN v_opened + p_opened_ago * 0.65 END)
    RETURNING id INTO v_order;

    FOREACH v_item IN ARRAY p_items LOOP
      INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, guest_alias, notes, status)
      SELECT v_order, p.id, p.name, p.price, split_part(v_item, '|', 2)::int, 'Cliente #' || split_part(v_item, '|', 3),
             split_part(v_item, '|', 4), split_part(v_item, '|', 5)::order_item_status
        FROM products p
       WHERE p.restaurant_id = v_rid AND p.name = split_part(v_item, '|', 1);
    END LOOP;

    IF p_order_status <> 'PENDING' THEN
      PERFORM fn_deduct_inventory(v_order, v_waiter);      -- igual que cuando el camarero confirma
    END IF;
  END IF;

  IF p_call IS NOT NULL THEN
    INSERT INTO waiter_calls (restaurant_id, table_id, session_id, guest_alias, type, created_at)
    VALUES (v_rid, v_table, v_session, 'Cliente #1', p_call, now() - interval '2 minutes');
  END IF;

  UPDATE restaurant_tables
     SET status = (CASE
                     WHEN p_call IS NOT NULL THEN 'CALLING'
                     WHEN p_order_status IN ('PENDING', 'CONFIRMED', 'PREPARING', 'READY') THEN 'WAITING_ORDER'
                     WHEN p_order_status = 'SERVED' THEN 'SERVED'
                     ELSE 'OCCUPIED'
                   END)::table_status,
         status_changed_at = CASE WHEN p_call IS NOT NULL THEN now() - interval '2 minutes'
                                  ELSE v_opened + p_opened_ago * 0.5 END
   WHERE id = v_table;
END $$;

-- Azul: acaban de sentarse y leen la carta.
SELECT pg_temp.demo_live_table(3, interval '6 minutes', 2, NULL, NULL, NULL);

-- Naranja: comanda nueva que el camarero todavía debe confirmar.
SELECT pg_temp.demo_live_table(7, interval '12 minutes', 3, 'PENDING',
  ARRAY['Costillas ahumadas|1|1||PENDING', 'Pinchos mixtos|1|2|Sin cebolla|PENDING', 'Cerveza artesanal|3|3||PENDING'], NULL);

-- Naranja: comanda confirmada, en cola de cocina.
SELECT pg_temp.demo_live_table(6, interval '18 minutes', 2, 'CONFIRMED',
  ARRAY['Hamburguesa Fogón|2|1|Una sin tomate|PENDING', 'Pizza pepperoni|1|2||PENDING', 'Limonada de la casa|2|2||PENDING'], NULL);

-- Naranja: en preparación, con platos a medio salir.
SELECT pg_temp.demo_live_table(14, interval '25 minutes', 4, 'PREPARING',
  ARRAY['Pizza margarita|1|1||READY', 'Ensalada de aguacate y huevo|1|4||PREPARING', 'Pasta al pomodoro|2|3||PREPARING', 'Jugo de naranja|2|2||READY'], NULL);

-- Verde: servidos y comiendo.
SELECT pg_temp.demo_live_table(9, interval '40 minutes', 2, 'SERVED',
  ARRAY['Salmón a la parrilla|1|1||SERVED', 'Pasta al pomodoro|1|2||SERVED', 'Jugo de naranja|2|1||SERVED'], NULL);

-- Rojo: piden la cuenta.
SELECT pg_temp.demo_live_table(12, interval '65 minutes', 3, 'SERVED',
  ARRAY['Churrasco 300 g|1|1|Término medio|SERVED', 'Hamburguesa Fogón|1|2||SERVED', 'Cóctel de maracuyá|2|3||SERVED', 'Cheesecake de frutos rojos|1|2||SERVED'], 'BILL');

-- Rojo: llaman al camarero.
SELECT pg_temp.demo_live_table(1, interval '30 minutes', 1, 'SERVED',
  ARRAY['Café latte|2|1||SERVED', 'Pancakes con frutos rojos|1|1||SERVED'], 'WAITER');
