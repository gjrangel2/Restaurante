-- =====================================================================
-- FrictionlessOrder · V5 · Datos demo de domicilios
-- Opcional, como V3. Configura el restaurante demo para domicilios en Cali,
-- crea dos repartidores y deja pedidos en distintos estados para que el
-- tablero de despacho y el mapa no arranquen vacíos.
--
-- Usuarios demo nuevos (contraseña: demo1234)
--   repartidor@demo.test   → Repartidor (moto)
--   repartidor2@demo.test  → Repartidor (bicicleta)
--
-- Las direcciones y coordenadas son de ejemplo: cámbialas por las reales.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Restaurante: ubicación y reglas de domicilio
-- ---------------------------------------------------------------------
UPDATE restaurants
   SET address               = 'Av. 9N #10-50, Granada, Cali',
       phone                 = '+57 300 000 0000',
       lat                   = 3.459200,
       lng                   = -76.532300,
       delivery_enabled      = true,
       pickup_enabled        = true,
       delivery_min_order    = 20000,
       delivery_prep_minutes = 25
 WHERE slug = 'fogon';

INSERT INTO delivery_zones (restaurant_id, name, max_km, fee, travel_minutes)
SELECT r.id, z.name, z.max_km, z.fee, z.travel_minutes
  FROM restaurants r,
       (VALUES ('Cerca',     3.0, 4000, 12),
               ('Media',     6.0, 6500, 20),
               ('Extendida', 8.0, 9000, 30)) AS z(name, max_km, fee, travel_minutes)
 WHERE r.slug = 'fogon';

-- ---------------------------------------------------------------------
-- Repartidores
-- ---------------------------------------------------------------------
INSERT INTO users (restaurant_id, full_name, email, password_hash, role)
SELECT r.id, u.full_name, u.email, crypt('demo1234', gen_salt('bf', 10)), 'COURIER'
  FROM restaurants r,
       (VALUES ('Carlos Mejía', 'repartidor@demo.test'),
               ('Andrea Rivas', 'repartidor2@demo.test')) AS u(full_name, email)
 WHERE r.slug = 'fogon';

INSERT INTO courier_profiles (user_id, phone, vehicle, plate, is_available, last_lat, last_lng, last_seen_at)
SELECT u.id, p.phone, p.vehicle::vehicle_type, p.plate, true, p.lat, p.lng, now() - interval '1 minute'
  FROM users u
  JOIN (VALUES ('repartidor@demo.test',  '+57 300 000 0001', 'MOTO', 'ABC12D', 3.459350, -76.532100),
               ('repartidor2@demo.test', '+57 300 000 0002', 'BICI', NULL,     3.459200, -76.532300))
       AS p(email, phone, vehicle, plate, lat, lng) ON p.email = u.email;

-- ---------------------------------------------------------------------
-- Pedidos de ejemplo
-- ---------------------------------------------------------------------
-- p_items: 'Producto|cantidad|nota'
CREATE FUNCTION pg_temp.demo_delivery(
  p_type          order_channel,
  p_target        delivery_status,
  p_customer      text,
  p_phone         text,
  p_address       text,
  p_lat           numeric,
  p_lng           numeric,
  p_payment       delivery_payment,
  p_items         text[],
  p_courier_email text,
  p_minutes_ago   int
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r          restaurants%ROWTYPE;
  v_waiter   uuid;
  v_courier  uuid;
  v_order    uuid;
  v_delivery uuid;
  v_item     text;
  v_gross    numeric;
  v_fee      numeric := 0;
  v_zone     uuid;
  v_km       numeric;
  v_travel   int := 0;
  v_tax      numeric;
  v_invoice  uuid;
  v_t0       timestamptz := now() - make_interval(mins => p_minutes_ago);
  v_rank     int := array_position(enum_range(NULL::delivery_status), p_target);
  v_paid     boolean;
  v_i        int;
  v_frac     numeric;
BEGIN
  SELECT * INTO r FROM restaurants WHERE slug = 'fogon';
  SELECT id INTO v_waiter FROM users WHERE restaurant_id = r.id AND role = 'WAITER' LIMIT 1;
  SELECT id INTO v_courier FROM users WHERE email = p_courier_email;

  -- Distancia en línea recta (haversine) y anillo de cobertura
  IF p_type = 'DELIVERY' THEN
    v_km := round((6371 * 2 * asin(sqrt(
              power(sin(radians(p_lat - r.lat) / 2), 2)
              + cos(radians(r.lat)) * cos(radians(p_lat)) * power(sin(radians(p_lng - r.lng) / 2), 2))))::numeric, 2);
    SELECT id, fee, travel_minutes INTO v_zone, v_fee, v_travel
      FROM delivery_zones WHERE restaurant_id = r.id AND max_km >= v_km ORDER BY max_km LIMIT 1;
  END IF;

  -- Comanda de cocina, con el estado que corresponde al punto del recorrido
  INSERT INTO orders (restaurant_id, channel, status, created_at, confirmed_at, confirmed_by, ready_at, served_at)
  VALUES (r.id, p_type,
          (CASE
             WHEN v_rank <= 2 THEN 'PENDING'
             WHEN p_target = 'ACCEPTED' THEN 'CONFIRMED'
             WHEN p_target = 'PREPARING' THEN 'PREPARING'
             WHEN p_target = 'READY' THEN 'READY'
             ELSE 'SERVED'
           END)::order_status,
          v_t0,
          CASE WHEN v_rank >= 3 THEN v_t0 + interval '2 minutes' END,
          CASE WHEN v_rank >= 3 THEN v_waiter END,
          CASE WHEN v_rank >= 5 THEN v_t0 + interval '20 minutes' END,
          CASE WHEN v_rank >= 6 THEN v_t0 + interval '22 minutes' END)
  RETURNING id INTO v_order;

  FOREACH v_item IN ARRAY p_items LOOP
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, notes, guest_alias, status)
    SELECT v_order, p.id, p.name, p.price, split_part(v_item, '|', 2)::int, split_part(v_item, '|', 3), p_customer,
           (CASE
              WHEN v_rank <= 3 THEN 'PENDING'
              WHEN p_target = 'PREPARING' THEN 'PREPARING'
              WHEN p_target = 'READY' THEN 'READY'
              ELSE 'SERVED'
            END)::order_item_status
      FROM products p
     WHERE p.restaurant_id = r.id AND p.name = split_part(v_item, '|', 1);
  END LOOP;

  IF v_rank >= 3 THEN
    PERFORM fn_deduct_inventory(v_order, v_waiter);
  END IF;

  SELECT SUM(unit_price * quantity) INTO v_gross FROM order_items WHERE order_id = v_order;
  v_paid := p_payment = 'ONLINE' OR p_target = 'DELIVERED';

  INSERT INTO delivery_orders (
    restaurant_id, order_id, type, status, tracking_code, delivery_pin,
    customer_name, customer_phone, address_line, address_details, address_notes, lat, lng, distance_km, zone_id,
    subtotal, delivery_fee, total, payment_method, paid_at, courier_id, estimated_at,
    created_at, placed_at, accepted_at, assigned_at, picked_up_at, delivered_at)
  VALUES (
    r.id, v_order, p_type, p_target,
    upper(substr(md5(random()::text || clock_timestamp()::text), 1, 10)),
    lpad(floor(random() * 10000)::int::text, 4, '0'),
    p_customer, p_phone,
    CASE WHEN p_type = 'DELIVERY' THEN p_address END,
    CASE WHEN p_type = 'DELIVERY' THEN 'Apto 302' END,
    CASE WHEN p_type = 'DELIVERY' THEN 'Portería con citófono' END,
    CASE WHEN p_type = 'DELIVERY' THEN p_lat END,
    CASE WHEN p_type = 'DELIVERY' THEN p_lng END,
    v_km, v_zone,
    v_gross, v_fee, v_gross + v_fee, p_payment,
    CASE WHEN v_paid THEN v_t0 + CASE WHEN p_target = 'DELIVERED' THEN interval '40 minutes' ELSE interval '1 minute' END END,
    CASE WHEN v_rank >= 3 THEN v_courier END,
    CASE WHEN v_rank >= 3 THEN v_t0 + make_interval(mins => r.delivery_prep_minutes + v_travel + 2) END,
    v_t0,
    v_t0,
    CASE WHEN v_rank >= 3 THEN v_t0 + interval '2 minutes' END,
    CASE WHEN v_rank >= 3 AND v_courier IS NOT NULL THEN v_t0 + interval '3 minutes' END,
    CASE WHEN v_rank >= 6 THEN v_t0 + interval '22 minutes' END,
    CASE WHEN v_rank >= 7 THEN v_t0 + interval '40 minutes' END)
  RETURNING id INTO v_delivery;

  -- Recorrido parcial del repartidor que va en camino
  IF p_target = 'ON_THE_WAY' THEN
    FOR v_i IN 0..7 LOOP
      v_frac := v_i * 0.08;
      INSERT INTO delivery_tracks (delivery_order_id, lat, lng, recorded_at)
      VALUES (v_delivery, r.lat + (p_lat - r.lat) * v_frac, r.lng + (p_lng - r.lng) * v_frac,
              now() - make_interval(secs => (7 - v_i) * 40));
    END LOOP;
    UPDATE courier_profiles
       SET last_lat = r.lat + (p_lat - r.lat) * 0.56, last_lng = r.lng + (p_lng - r.lng) * 0.56, last_seen_at = now()
     WHERE user_id = v_courier;
  END IF;

  -- Factura: al pagar en línea o al entregar con pago contra entrega
  IF v_paid THEN
    v_tax := round(v_gross - v_gross / (1 + r.tax_rate / 100));
    INSERT INTO invoices (restaurant_id, delivery_order_id, invoice_number, status, subtotal, tax_name, tax_rate, tax_total,
                          delivery_fee, grand_total, customer_name, cufe, provider, provider_response, created_at, issued_at)
    VALUES (r.id, v_delivery, r.invoice_prefix || nextval('invoice_number_seq'), 'ISSUED', v_gross - v_tax, r.tax_name, r.tax_rate,
            v_tax, v_fee, v_gross + v_fee, p_customer, encode(digest(v_delivery::text, 'sha384'), 'hex'), 'MOCK',
            '{"simulated": true, "source": "demo-seed"}', v_t0, v_t0 + interval '1 minute')
    RETURNING id INTO v_invoice;

    INSERT INTO payments (invoice_id, method, amount, amount_received, status, reference, provider, validated_at, created_at)
    VALUES (v_invoice, CASE WHEN p_payment = 'ONLINE' THEN 'CARD' ELSE 'CASH' END::payment_method,
            v_gross + v_fee, v_gross + v_fee, 'APPROVED', 'SIM-' || upper(substr(md5(random()::text), 1, 8)),
            CASE WHEN p_payment = 'ONLINE' THEN 'MOCK' ELSE 'POS' END, v_t0 + interval '1 minute', v_t0);
  END IF;
END $$;

-- Nuevo: espera que el restaurante lo acepte
SELECT pg_temp.demo_delivery('DELIVERY', 'PLACED', 'Laura Gómez', '+57 300 000 0101',
  'Cra. 4 #10-20, San Antonio', 3.448900, -76.536300, 'CASH',
  ARRAY['Hamburguesa Fogón|2|Una sin cebolla', 'Limonada de la casa|2|'], NULL, 4);

-- Aceptado, sin repartidor: aparece en "Disponibles" de la app del repartidor
SELECT pg_temp.demo_delivery('DELIVERY', 'ACCEPTED', 'Julián Pardo', '+57 300 000 0102',
  'Av. 6N #35-10, Santa Mónica', 3.474000, -76.529000, 'CARD_ON_DELIVERY',
  ARRAY['Pizza margarita|1|', 'Cerveza artesanal|2|'], NULL, 7);

-- En cocina, ya asignado a Carlos y pagado en línea
SELECT pg_temp.demo_delivery('DELIVERY', 'PREPARING', 'Sofía Herrera', '+57 300 000 0103',
  'Calle 5 #38-40, San Fernando', 3.433500, -76.544000, 'ONLINE',
  ARRAY['Costillas ahumadas|1|', 'Cheesecake de frutos rojos|1|'], 'repartidor@demo.test', 12);

-- En camino con Andrea, pago en efectivo al recibir
SELECT pg_temp.demo_delivery('DELIVERY', 'ON_THE_WAY', 'Mateo Cárdenas', '+57 300 000 0104',
  'Cra. 66 #9-50, El Limonar', 3.395000, -76.542000, 'CASH',
  ARRAY['Churrasco 300 g|1|Término medio', 'Jugo de naranja|1|'], 'repartidor2@demo.test', 28);

-- Para recoger, listo en el mostrador
SELECT pg_temp.demo_delivery('PICKUP', 'READY', 'Valentina Ríos', '+57 300 000 0105',
  NULL, NULL, NULL, 'CASH',
  ARRAY['Pasta al pomodoro|1|', 'Café latte|1|'], NULL, 22);

-- Entregados más temprano (cuentan en las ventas del día)
SELECT pg_temp.demo_delivery('DELIVERY', 'DELIVERED', 'Camila Torres', '+57 300 000 0106',
  'Calle 25N #6-30, San Vicente', 3.465500, -76.525000, 'CASH',
  ARRAY['Pinchos mixtos|2|', 'Limonada de la casa|2|'], 'repartidor@demo.test', 150);

SELECT pg_temp.demo_delivery('DELIVERY', 'DELIVERED', 'Andrés Lozano', '+57 300 000 0107',
  'Cra. 34 #3-80, San Fernando Viejo', 3.430000, -76.540500, 'ONLINE',
  ARRAY['Pizza pepperoni|1|', 'Cerveza artesanal|3|'], 'repartidor2@demo.test', 95);

-- Andrea va en camino: su perfil queda "en turno" y con ubicación reciente
UPDATE courier_profiles SET is_available = true WHERE user_id IN (SELECT id FROM users WHERE role = 'COURIER');
