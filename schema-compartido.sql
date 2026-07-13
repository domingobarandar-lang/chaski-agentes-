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

-- Historial de conversación por cliente (una fila por identificador de chat).
-- `perfil`: datos conocidos del cliente (nombre) capturados de citas agendadas
-- con éxito — el bot lo reconoce en su siguiente conversación.
create table if not exists citas_sesiones (
  telefono   text primary key,
  messages   jsonb not null default '[]'::jsonb,
  perfil     jsonb,
  updated_at timestamptz not null default now()
);

-- Migración para bases creadas con el schema anterior (sin la columna perfil):
alter table citas_sesiones add column if not exists perfil jsonb;

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

-- ─── Datos de ejemplo (empresa FICTICIA: Clínica Dental Sonrisa del Valle) ───

insert into horarios (dia_semana, abre, cierra) values
  (1, '09:00', '19:00'),
  (2, '09:00', '19:00'),
  (3, '09:00', '19:00'),
  (4, '09:00', '19:00'),
  (5, '09:00', '19:00'),
  (6, '10:00', '14:00')
on conflict (dia_semana) do nothing;

insert into catalogo (nombre, descripcion, categoria, precio, duracion_minutos) values
  ('Consulta general',         'Evaluación inicial con odontólogo general',             'consulta',     25000,  30),
  ('Limpieza dental',          'Destartraje ultrasónico y profilaxis completa',         'higiene',      45000,  60),
  ('Blanqueamiento',           'Blanqueamiento dental LED en 1 sesión',                 'estética',     120000, 90),
  ('Urgencia dental',          'Atención de dolor agudo, fractura o trauma',            'urgencia',     35000,  45),
  ('Extracción simple',        'Extracción de pieza dental con anestesia local',        'cirugía',      40000,  45),
  ('Endodoncia',               'Tratamiento de conducto por pieza',                     'tratamiento',  180000, 90),
  ('Evaluación de ortodoncia', 'Diagnóstico y plan de tratamiento con la ortodoncista', 'ortodoncia',   20000,  45),
  ('Radiografía panorámica',   'Imagen panorámica digital, entrega inmediata',          'imagenología', 18000,  20);

-- Si la base YA tenía el catálogo antiguo (mesas de restaurante, etc.),
-- correr esto ANTES del insert de arriba:
--   delete from catalogo;

-- ═══════════════════════════════════════════════════════════════════════════
-- agente-retail
-- ═══════════════════════════════════════════════════════════════════════════

-- Historial de conversación por cliente (una fila por identificador de chat).
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

-- Demo: sin RLS (el acceso es solo desde el backend con la clave anon).
alter table retail_sesiones disable row level security;
alter table productos       disable row level security;
alter table pedidos         disable row level security;
alter table pedido_items    disable row level security;

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
-- correr esto ANTES del insert de arriba (el orden importa por las FK):
--   delete from pedido_items;
--   delete from pedidos;
--   delete from productos;
