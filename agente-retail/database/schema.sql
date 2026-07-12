-- Schema del agente de retail — ejecutar en Supabase SQL Editor.
-- NOTA: el bot debe usar la clave service_role (la anon da "permission denied"
-- en tablas con RLS). Como alternativa para la demo, se deshabilita RLS abajo.

-- Historial de conversación por cliente (una fila por teléfono)
create table if not exists sesiones (
  telefono   text primary key,
  messages   jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- Catálogo de productos con stock
create table if not exists productos (
  id          bigint generated always as identity primary key,
  nombre      text not null,
  descripcion text,
  categoria   text,
  precio      integer not null default 0,   -- CLP
  unidad      text not null default 'un',   -- un | kg | lt ...
  stock       integer not null default 0,
  activo      boolean not null default true
);

-- Pedidos tomados por el bot
create table if not exists pedidos (
  id               bigint generated always as identity primary key,
  telefono_cliente text not null,
  nombre_cliente   text,
  direccion        text,
  notas            text,
  total            integer not null default 0,
  estado           text not null default 'recibido'
                   check (estado in ('recibido', 'preparando', 'despachado', 'entregado', 'cancelado')),
  created_at       timestamptz not null default now()
);

create table if not exists pedido_items (
  id              bigint generated always as identity primary key,
  pedido_id       bigint not null references pedidos (id) on delete cascade,
  producto_id     bigint references productos (id),
  nombre_producto text not null,
  cantidad        numeric(10,2) not null,  -- decimal: productos por kg admiten 0.5, 1.5...
  precio_unitario integer not null default 0
);

create index if not exists idx_pedidos_telefono on pedidos (telefono_cliente);
create index if not exists idx_items_pedido     on pedido_items (pedido_id);

-- Demo: sin RLS (el acceso es solo desde el backend con service_role).
alter table sesiones     disable row level security;
alter table productos    disable row level security;
alter table pedidos      disable row level security;
alter table pedido_items disable row level security;

-- ─── Datos de ejemplo (empresa FICTICIA: Frutos Secos La Cosecha) ────────────

insert into productos (nombre, descripcion, categoria, precio, unidad, stock) values
  ('Maní salado (kg)',                   'Maní tostado y salado, bien crocante',      'frutos secos',       4990,  'kg', 30),
  ('Maní sin sal (kg)',                  'Maní tostado natural, sin sal',             'frutos secos',       4790,  'kg', 25),
  ('Almendras (kg)',                     'Almendras naturales seleccionadas',         'frutos secos',       12990, 'kg', 15),
  ('Nueces mariposa (kg)',               'Nuez chilena partida, extra clara',         'frutos secos',       14990, 'kg', 10),
  ('Castañas de cajú (kg)',              'Cajú tostado, sin sal',                     'frutos secos',       11990, 'kg', 20),
  ('Mix frutos secos (bolsa 500 g)',     'Mezcla de maní, almendras, nueces y pasas', 'mix',                6990,  'un', 18),
  ('Pasas rubias (bolsa 500 g)',         'Pasas rubias jumbo, sin semilla',           'fruta deshidratada', 3490,  'un', 22),
  ('Higos secos (bolsa 250 g)',          'Higos deshidratados premium',               'fruta deshidratada', 4290,  'un', 16),
  ('Dátiles sin cuesco (caja 250 g)',    'Dátiles Medjool importados',                'fruta deshidratada', 5990,  'un', 14),
  ('Mantequilla de maní (frasco 500 g)', '100% maní, sin azúcar añadida',             'despensa',           4990,  'un', 12);

-- Si la base YA tenía el catálogo antiguo (abarrotes/mariscos/mascotas),
-- reemplazarlo por el de la tienda de frutos secos corriendo esto ANTES del
-- insert de arriba (el orden importa por las FK de pedido_items):
--   delete from pedido_items;
--   delete from pedidos;
--   delete from productos;
