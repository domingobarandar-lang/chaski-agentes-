-- Schema del agente de retail — ejecutar en Supabase SQL Editor.
-- ⚠️ Si el proyecto Supabase es COMPARTIDO con agente-citas, usar mejor
-- schema-compartido.sql (raíz del repo), que crea las tablas de ambos.
-- Las tablas quedan con RLS ACTIVADO y sin políticas: la clave anon (pública
-- por diseño) no puede leer ni escribir datos de clientes. El bot usa la
-- service_role (SUPABASE_SERVICE_ROLE_KEY, solo en el servidor), que salta RLS.

-- Historial de conversación por cliente (una fila por teléfono).
-- OJO: el código lee `retail_sesiones` (prefijada para no chocar con la tabla
-- de agente-citas en un proyecto compartido).
-- `perfil`: datos conocidos del cliente (nombre, dirección) capturados de
-- pedidos creados con éxito — el bot lo reconoce en su siguiente conversación.
create table if not exists retail_sesiones (
  telefono   text primary key,
  messages   jsonb not null default '[]'::jsonb,
  perfil     jsonb,
  updated_at timestamptz not null default now()
);

-- Migración para bases creadas con el schema anterior (sin la columna perfil):
alter table retail_sesiones add column if not exists perfil jsonb;

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

-- RLS activado y SIN políticas: la clave anon no entra; solo la service_role
-- del backend, que salta RLS. Sobre una base en uso: primero
-- SUPABASE_SERVICE_ROLE_KEY en el servidor y redeploy; recién después esto
-- (con la anon, el bot quedaría sin base).
alter table retail_sesiones enable row level security;
alter table productos       enable row level security;
alter table pedidos         enable row level security;
alter table pedido_items    enable row level security;

-- Si la base venía del schema ANTIGUO que creaba la tabla `sesiones` sin
-- prefijo (el código no la lee), migrar el historial y eliminarla:
--   insert into retail_sesiones (telefono, messages, updated_at)
--     select telefono, messages, updated_at from sesiones
--     on conflict (telefono) do nothing;
--   drop table sesiones;

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
