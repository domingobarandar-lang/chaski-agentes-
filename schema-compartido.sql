-- Schema Supabase COMPARTIDO entre agente-citas y agente-retail (demo).
-- Ejecutar una sola vez en el SQL Editor del proyecto Supabase compartido
-- (mismo SUPABASE_URL / SUPABASE_ANON_KEY en el .env de ambos agentes).
--
-- Prefijos: solo se prefija la tabla que se llama IGUAL en los dos schemas
-- originales (`sesiones`, historial de conversación) -> `citas_sesiones` /
-- `retail_sesiones`. El resto de las tablas (catalogo, horarios, citas,
-- productos, pedidos, pedido_items) no chocan entre sí y mantienen su nombre.
--
-- Por qué el prefijo es obligatorio en `sesiones`: en Telegram, `chat.id` de
-- un usuario es el mismo sin importar a qué bot le escribe. Como los dos bots
-- arman la clave de sesión como `tg${chatId}` (ver telegram/bot.js de cada
-- agente), un mismo usuario que le escribe a los dos bots tendría la MISMA
-- clave `telefono` en una tabla `sesiones` compartida, y un agente pisaría el
-- historial de conversación del otro.
--
-- NOTA: el bot usa la clave anon. Todas las tablas de abajo tienen RLS
-- deshabilitado (demo), así que la anon key funciona igual que la service_role.

-- ═══════════════════════════════════════════════════════════════════════════
-- agente-citas
-- ═══════════════════════════════════════════════════════════════════════════

-- Historial de conversación por cliente (una fila por identificador de chat)
create table if not exists citas_sesiones (
  telefono   text primary key,
  messages   jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- Catálogo de servicios/productos que el bot puede mostrar
create table if not exists catalogo (
  id               bigint generated always as identity primary key,
  nombre           text not null,
  descripcion      text,
  categoria        text,
  precio           integer,          -- CLP; 0 o null si no aplica
  duracion_minutos integer not null default 60,
  activo           boolean not null default true
);

-- Horario de atención por día de la semana (0=domingo ... 6=sábado).
-- Un día sin fila = cerrado.
create table if not exists horarios (
  dia_semana smallint primary key check (dia_semana between 0 and 6),
  abre       time not null,
  cierra     time not null
);

-- Citas agendadas por el bot
create table if not exists citas (
  id               bigint generated always as identity primary key,
  telefono_cliente text not null,
  nombre_cliente   text,
  servicio         text,
  fecha            date not null,
  hora             time not null,
  personas         smallint not null default 1,
  notas            text,
  estado           text not null default 'confirmada' check (estado in ('confirmada', 'cancelada')),
  created_at       timestamptz not null default now()
);

create index if not exists idx_citas_fecha    on citas (fecha) where estado = 'confirmada';
create index if not exists idx_citas_telefono on citas (telefono_cliente);

-- Demo: sin RLS (el acceso es solo desde el backend con la clave anon).
alter table citas_sesiones disable row level security;
alter table catalogo       disable row level security;
alter table horarios       disable row level security;
alter table citas          disable row level security;

-- ─── Datos de ejemplo ────────────────────────────────────────────────────────

insert into horarios (dia_semana, abre, cierra) values
  (1, '09:00', '19:00'),
  (2, '09:00', '19:00'),
  (3, '09:00', '19:00'),
  (4, '09:00', '19:00'),
  (5, '09:00', '19:00'),
  (6, '10:00', '14:00')
on conflict (dia_semana) do nothing;

insert into catalogo (nombre, descripcion, categoria, precio, duracion_minutos) values
  ('Consulta general',       'Evaluación inicial con el profesional', 'consulta',    25000,  30),
  ('Limpieza dental',        'Destartraje y profilaxis completa',     'dental',      45000,  60),
  ('Blanqueamiento',         'Blanqueamiento dental en 1 sesión',     'dental',      120000, 90),
  ('Mesa para 2 personas',   'Reserva de mesa estándar',              'restaurante', 0,      90),
  ('Mesa para 4-6 personas', 'Reserva de mesa grande',                'restaurante', 0,      120);

-- ═══════════════════════════════════════════════════════════════════════════
-- agente-retail
-- ═══════════════════════════════════════════════════════════════════════════

-- Historial de conversación por cliente (una fila por identificador de chat)
create table if not exists retail_sesiones (
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

-- Demo: sin RLS (el acceso es solo desde el backend con la clave anon).
alter table retail_sesiones disable row level security;
alter table productos       disable row level security;
alter table pedidos         disable row level security;
alter table pedido_items    disable row level security;

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
