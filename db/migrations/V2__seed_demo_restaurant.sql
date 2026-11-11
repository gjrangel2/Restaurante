-- =====================================================================
-- FrictionlessOrder · V2 · Restaurante de demostración
-- Crea un restaurante ficticio ("Fogón") con personal, mesas,
-- carta, recetas, inventario y banners. Bórralo o reemplázalo cuando
-- cargues un restaurante real.
--
-- Usuarios demo (contraseña para todos: demo1234)
--   admin@demo.test   → Admin/Gerente
--   sala@demo.test    → Camarero/Sala
--   cocina@demo.test  → Cocina
-- =====================================================================

INSERT INTO restaurants (slug, name, legal_name, tax_id, timezone, currency, tax_name, tax_rate, prices_include_tax, suggested_tip_rate, invoice_prefix)
VALUES ('fogon', 'Fogón', 'Fogón S.A.S. (demo)', '900000000-0', 'America/Bogota', 'COP', 'INC', 8.00, true, 10.00, 'FG');

-- ---------------------------------------------------------------------
-- Personal
-- ---------------------------------------------------------------------
INSERT INTO users (restaurant_id, full_name, email, password_hash, role)
SELECT r.id, u.full_name, u.email, crypt('demo1234', gen_salt('bf', 10)), u.role::user_role
  FROM restaurants r,
       (VALUES ('Gerencia Demo', 'admin@demo.test',  'ADMIN'),
               ('Sala Demo',     'sala@demo.test',   'WAITER'),
               ('Cocina Demo',   'cocina@demo.test', 'KITCHEN')) AS u(full_name, email, role)
 WHERE r.slug = 'fogon';

-- ---------------------------------------------------------------------
-- Mesas. pos_x / pos_y son la columna y la fila de la mesa en el plano.
-- Una mesa RECT ocupa dos columnas. Las columnas o filas que quedan sin
-- mesas se dibujan como pasillos (aquí, la columna 5 separa salón y terraza).
-- ---------------------------------------------------------------------
INSERT INTO restaurant_tables (restaurant_id, number, seats, zone, shape, pos_x, pos_y)
SELECT r.id, t.number, t.seats, t.zone, t.shape::table_shape, t.pos_x, t.pos_y
  FROM restaurants r,
       (VALUES ( 1, 2, 'Salón',   'ROUND',  0, 0),
               ( 2, 2, 'Salón',   'ROUND',  1, 0),
               ( 3, 4, 'Salón',   'SQUARE', 2, 0),
               ( 4, 4, 'Salón',   'SQUARE', 3, 0),
               ( 5, 6, 'Salón',   'RECT',   0, 1),
               ( 6, 4, 'Salón',   'SQUARE', 2, 1),
               ( 7, 6, 'Salón',   'RECT',   3, 1),
               ( 8, 4, 'Salón',   'ROUND',  0, 2),
               ( 9, 4, 'Salón',   'SQUARE', 1, 2),
               (10, 8, 'Salón',   'RECT',   2, 2),
               (11, 2, 'Terraza', 'ROUND',  6, 0),
               (12, 4, 'Terraza', 'ROUND',  7, 0),
               (13, 4, 'Terraza', 'SQUARE', 6, 1),
               (14, 4, 'Terraza', 'SQUARE', 7, 1),
               (15, 2, 'Barra',   'ROUND',  6, 2),
               (16, 2, 'Barra',   'ROUND',  7, 2)) AS t(number, seats, zone, shape, pos_x, pos_y)
 WHERE r.slug = 'fogon';

-- ---------------------------------------------------------------------
-- Carta
-- ---------------------------------------------------------------------
INSERT INTO categories (restaurant_id, name, sort_order)
SELECT r.id, c.name, c.sort_order
  FROM restaurants r,
       (VALUES ('Para empezar', 1),
               ('De la brasa',  2),
               ('Pastas y horno', 3),
               ('Bebidas',      4),
               ('Postres',      5)) AS c(name, sort_order)
 WHERE r.slug = 'fogon';

-- Las fotos son URLs públicas de Unsplash: cámbialas por las del restaurante.
-- Si alguna no carga, la app muestra un marcador de color en su lugar.
INSERT INTO products (restaurant_id, category_id, name, description, price, image_url, is_featured, prep_minutes, tags, sort_order)
SELECT r.id, c.id, p.name, p.description, p.price,
       'https://images.unsplash.com/' || p.photo || '?auto=format&fit=crop&w=900&q=70',
       p.is_featured, p.prep_minutes, p.tags::text[], p.sort_order
  FROM restaurants r
  JOIN (VALUES
    ('Para empezar', 'Crema de ahuyama',            'Ahuyama asada, crema de coco y semillas tostadas.',                 16000, 'photo-1547592180-85f173990554',    false, 10, '{vegetariano}', 1),
    ('Para empezar', 'Bowl de la huerta',           'Vegetales de temporada, aguacate, granos y vinagreta de limón.',    24000, 'photo-1512621776951-a57141f2eefd', false, 10, '{vegetariano}', 2),
    ('Para empezar', 'Ensalada de aguacate y huevo','Hojas frescas, aguacate, huevo y tomates cherry.',                  22000, 'photo-1546069901-ba9599a7e63c',    false, 10, '{vegetariano}', 3),
    ('Para empezar', 'Tostada de la casa',          'Pan artesanal, huevo, queso y hierbas.',                            18000, 'photo-1482049016688-2d3e1b311543', false, 12, '{}',            4),

    ('De la brasa',  'Hamburguesa Fogón',           '180 g de res a la brasa, queso, vegetales frescos y pan brioche.',  32000, 'photo-1568901346375-23c9450c58cd', true,  18, '{favorito}',    1),
    ('De la brasa',  'Costillas ahumadas',          'Costilla de cerdo ahumada seis horas, glaseada a la brasa.',        46000, 'photo-1544025162-d76694265947',    true,  25, '{para compartir}', 2),
    ('De la brasa',  'Pinchos mixtos',              'Res y pollo marinados, vegetales asados y chimichurri.',            34000, 'photo-1555939594-58d7cb561ad1',    false, 20, '{}',            3),
    ('De la brasa',  'Churrasco 300 g',             'Corte de res a la parrilla en el término que prefieras.',           52000, 'photo-1600891964092-4316c288032e', false, 22, '{}',            4),
    ('De la brasa',  'Salmón a la parrilla',        'Filete de salmón con vegetales salteados.',                         49000, 'photo-1467003909585-2f8a72700288', false, 20, '{}',            5),

    ('Pastas y horno', 'Pasta al pomodoro',         'Pasta al dente, salsa de tomate de la casa y albahaca.',            29000, 'photo-1473093295043-cdd812d0e601', false, 15, '{vegetariano}', 1),
    ('Pastas y horno', 'Pizza margarita',           'Masa madre, tomate, queso y albahaca fresca.',                      36000, 'photo-1513104890138-7c749659a591', false, 18, '{vegetariano,para compartir}', 2),
    ('Pastas y horno', 'Pizza pepperoni',           'Masa madre, tomate, queso y pepperoni.',                            38000, 'photo-1565299624946-b28f40a0ae38', true,  18, '{para compartir}', 3),

    ('Bebidas',      'Limonada de la casa',         'Limón recién exprimido, hierbabuena y mucho hielo.',                 9000, 'photo-1556679343-c7306c1976bc',    false,  5, '{}',            1),
    ('Bebidas',      'Jugo de naranja',             'Naranjas exprimidas al momento.',                                    9000, 'photo-1600271886742-f049cd451bba', false,  5, '{}',            2),
    ('Bebidas',      'Cóctel de maracuyá',          'Ron, maracuyá y un toque cítrico.',                                 24000, 'photo-1544145945-f90425340c7e',    false,  6, '{con alcohol}', 3),
    ('Bebidas',      'Cerveza artesanal',           'Rubia de la casa, bien fría.',                                      14000, 'photo-1608270586620-248524c67de9', false,  2, '{con alcohol}', 4),
    ('Bebidas',      'Café latte',                  'Espresso doble con leche vaporizada.',                               7000, 'photo-1509042239860-f550ce710b93', false,  5, '{}',            5),

    ('Postres',      'Torta de chocolate',          'Bizcocho húmedo con ganache de chocolate.',                         15000, 'photo-1578985545062-69928b1d9587', false,  5, '{}',            1),
    ('Postres',      'Cheesecake de frutos rojos',  'Base crocante, queso crema y salsa de frutos rojos.',               16000, 'photo-1565958011703-44f9829ba187', true,   5, '{favorito}',    2),
    ('Postres',      'Helado artesanal',            'Dos bolas del sabor del día.',                                      11000, 'photo-1497034825429-c343d7c6a68f', false,  3, '{}',            3),
    ('Postres',      'Pancakes con frutos rojos',   'Torre de pancakes, frutos rojos y miel.',                           17000, 'photo-1567620905732-2d1ec7ab7445', false, 12, '{}',            4)
  ) AS p(category, name, description, price, photo, is_featured, prep_minutes, tags, sort_order) ON true
  JOIN categories c ON c.restaurant_id = r.id AND c.name = p.category
 WHERE r.slug = 'fogon';

-- ---------------------------------------------------------------------
-- Inventario. Algunos insumos arrancan bajos a propósito para que el
-- tablero muestre alertas amarillas y rojas desde el primer arranque.
-- ---------------------------------------------------------------------
INSERT INTO inventory_items (restaurant_id, name, unit, stock, reorder_level)
SELECT r.id, i.name, i.unit, i.stock, i.reorder_level
  FROM restaurants r,
       (VALUES ('Carne de res',        'g',    2600,  6000),   -- rojo: muy por debajo del punto de pedido
               ('Pan brioche',         'und',    14,    20),   -- amarillo
               ('Queso',               'g',    9000,  3000),
               ('Costilla de cerdo',   'g',    3200,  6000),   -- amarillo, casi rojo
               ('Pollo',               'g',    7000,  2500),
               ('Salmón',              'g',     900,  2000),   -- rojo
               ('Pasta seca',          'g',    8000,  2000),
               ('Salsa de tomate',     'ml',  12000,  3000),
               ('Masa de pizza',       'und',    40,    12),
               ('Pepperoni',           'g',    2500,   800),
               ('Aguacate',            'und',    18,    15),
               ('Huevo',               'und',    90,    30),
               ('Vegetales frescos',   'g',   14000,  4000),
               ('Ahuyama',             'g',    9000,  3000),
               ('Pan artesanal',       'und',    30,    12),
               ('Limón',               'und',   120,    40),
               ('Naranja',             'und',    36,    40),   -- amarillo
               ('Pulpa de maracuyá',   'ml',   3000,  1000),
               ('Ron',                 'ml',   4500,  1500),
               ('Cerveza artesanal',   'und',    96,    36),
               ('Café en grano',       'g',    3000,  1000),
               ('Leche',               'ml',  20000,  6000),
               ('Torta de chocolate',  'und',     0,     6),   -- rojo: agotado
               ('Cheesecake',          'und',    14,     6),
               ('Helado',              'ml',   9000,  3000),
               ('Harina',              'g',   10000,  3000),
               ('Frutos rojos',        'g',    2500,  1000)) AS i(name, unit, stock, reorder_level)
 WHERE r.slug = 'fogon';

-- Recetas: consumo de insumos por cada unidad vendida.
INSERT INTO product_ingredients (product_id, inventory_item_id, quantity)
SELECT p.id, i.id, x.quantity
  FROM restaurants r
  JOIN (VALUES
    ('Crema de ahuyama',             'Ahuyama',            300),
    ('Crema de ahuyama',             'Leche',              100),
    ('Bowl de la huerta',            'Vegetales frescos',  200),
    ('Bowl de la huerta',            'Aguacate',           0.5),
    ('Ensalada de aguacate y huevo', 'Vegetales frescos',  150),
    ('Ensalada de aguacate y huevo', 'Aguacate',           0.5),
    ('Ensalada de aguacate y huevo', 'Huevo',                1),
    ('Tostada de la casa',           'Pan artesanal',        2),
    ('Tostada de la casa',           'Huevo',                2),
    ('Tostada de la casa',           'Queso',               30),
    ('Hamburguesa Fogón',            'Carne de res',       180),
    ('Hamburguesa Fogón',            'Pan brioche',          1),
    ('Hamburguesa Fogón',            'Queso',               40),
    ('Hamburguesa Fogón',            'Vegetales frescos',   60),
    ('Costillas ahumadas',           'Costilla de cerdo',  450),
    ('Pinchos mixtos',               'Carne de res',       120),
    ('Pinchos mixtos',               'Pollo',              120),
    ('Pinchos mixtos',               'Vegetales frescos',   80),
    ('Churrasco 300 g',              'Carne de res',       300),
    ('Salmón a la parrilla',         'Salmón',             220),
    ('Salmón a la parrilla',         'Vegetales frescos',  120),
    ('Pasta al pomodoro',            'Pasta seca',         130),
    ('Pasta al pomodoro',            'Salsa de tomate',    150),
    ('Pizza margarita',              'Masa de pizza',        1),
    ('Pizza margarita',              'Salsa de tomate',    100),
    ('Pizza margarita',              'Queso',              150),
    ('Pizza pepperoni',              'Masa de pizza',        1),
    ('Pizza pepperoni',              'Salsa de tomate',    100),
    ('Pizza pepperoni',              'Queso',              150),
    ('Pizza pepperoni',              'Pepperoni',           60),
    ('Limonada de la casa',          'Limón',                2),
    ('Jugo de naranja',              'Naranja',              4),
    ('Cóctel de maracuyá',           'Pulpa de maracuyá',   60),
    ('Cóctel de maracuyá',           'Ron',                 45),
    ('Cerveza artesanal',            'Cerveza artesanal',    1),
    ('Café latte',                   'Café en grano',       18),
    ('Café latte',                   'Leche',              200),
    ('Torta de chocolate',           'Torta de chocolate',   1),
    ('Cheesecake de frutos rojos',   'Cheesecake',           1),
    ('Cheesecake de frutos rojos',   'Frutos rojos',        40),
    ('Helado artesanal',             'Helado',             150),
    ('Pancakes con frutos rojos',    'Harina',             120),
    ('Pancakes con frutos rojos',    'Leche',              100),
    ('Pancakes con frutos rojos',    'Huevo',                1),
    ('Pancakes con frutos rojos',    'Frutos rojos',        60)
  ) AS x(product, ingredient, quantity) ON true
  JOIN products p        ON p.restaurant_id = r.id AND p.name = x.product
  JOIN inventory_items i ON i.restaurant_id = r.id AND i.name = x.ingredient
 WHERE r.slug = 'fogon';

-- La torta de chocolate arranca agotada en inventario: también sale agotada en la carta.
UPDATE products SET is_available = false WHERE name = 'Torta de chocolate';

-- ---------------------------------------------------------------------
-- Banners promocionales (ventanas relativas al momento de la instalación)
-- ---------------------------------------------------------------------
INSERT INTO promotions (restaurant_id, title, subtitle, image_url, product_id, starts_at, ends_at)
SELECT r.id, b.title, b.subtitle,
       'https://images.unsplash.com/' || b.photo || '?auto=format&fit=crop&w=1200&q=70',
       (SELECT id FROM products p WHERE p.restaurant_id = r.id AND p.name = b.product),
       now() + b.starts_in, now() + b.ends_in
  FROM restaurants r,
       (VALUES ('Costillas para dos',   'Pídelas hoy con dos cervezas artesanales.',   'photo-1544025162-d76694265947', 'Costillas ahumadas',         interval '-1 day',  interval '30 days'),
               ('Tarde de postres',     'El cheesecake de frutos rojos, recién hecho.', 'photo-1565958011703-44f9829ba187', 'Cheesecake de frutos rojos', interval '-1 day',  interval '14 days'),
               ('Noches de pizza',      'Empieza el próximo fin de semana.',            'photo-1513104890138-7c749659a591', 'Pizza margarita',            interval '5 days',  interval '8 days')
       ) AS b(title, subtitle, photo, product, starts_in, ends_in)
 WHERE r.slug = 'fogon';

-- Verificación: ninguna línea de receta se perdió por un nombre mal escrito.
DO $$
DECLARE
  v_recipes  int;
  v_products int;
BEGIN
  SELECT count(*) INTO v_recipes  FROM product_ingredients;
  SELECT count(*) INTO v_products FROM products;
  IF v_recipes <> 45 OR v_products <> 21 THEN
    RAISE EXCEPTION 'Seed incompleto: % productos (esperados 21), % líneas de receta (esperadas 45)', v_products, v_recipes;
  END IF;
END $$;
