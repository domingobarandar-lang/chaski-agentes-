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

-- ─── Datos de ejemplo ────────────────────────────────────────────────────────

insert into productos (nombre, descripcion, categoria, precio, unidad, stock) values
  ('Arroz grado 1 (1 kg)',        'Bolsa de arroz grano largo',          'abarrotes', 1890,  'un', 40),
  ('Lentejas (1 kg)',             'Lentejas seleccionadas',              'abarrotes', 2490,  'un', 25),
  ('Aceite vegetal (900 ml)',     'Aceite de maravilla',                 'abarrotes', 2990,  'un', 30),
  ('Salmón fresco (kg)',          'Filete de salmón del día',            'mariscos',  12990, 'kg', 15),
  ('Camarones ecuatorianos (kg)', 'Camarón 36/40 congelado',             'mariscos',  10990, 'kg', 20),
  ('Choritos (malla 1 kg)',       'Choritos frescos de Chiloé',          'mariscos',  3490,  'un', 18),
  ('Comida perro adulto (15 kg)', 'Saco de alimento premium para perro', 'mascotas',  34990, 'un', 12),
  ('Comida gato (3 kg)',          'Alimento para gato adulto',           'mascotas',  12990, 'un', 22),
  ('Arena sanitaria (10 L)',      'Arena aglomerante para gato',         'mascotas',  8990,  'un', 16),
  ('Snacks para perro (paquete)', 'Galletas de entrenamiento',           'mascotas',  3990,  'un', 35);
