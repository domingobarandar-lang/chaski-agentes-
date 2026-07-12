// Capa de acceso a datos del agente de retail.
// Con SUPABASE_URL + SUPABASE_ANON_KEY usa Supabase; sin ellas cae a una base
// EN MEMORIA con productos demo (suficiente para probar con `npm run chat`).
//
// Supabase es COMPARTIDO con agente-citas (mismo proyecto/URL/key — ver
// schema-compartido.sql). La tabla `sesiones` está prefijada como
// `retail_sesiones` para no chocar con la de agente-citas.

// Polyfill WebSocket para Node < 22 (Railway usa Node 18): realtime-js exige
// un WebSocket global nativo. Debe parchearse ANTES de cargar supabase-js.
// (Los entry points también lo hacen, pero se repite aquí por si este módulo
// se carga desde otro punto de entrada — es idempotente.)
const ws = require('ws');
if (!globalThis.WebSocket) {
  globalThis.WebSocket = ws;
}

const { createClient } = require('@supabase/supabase-js');

const usandoMemoria = !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY;

// ─── Implementación en memoria (modo demo) ───────────────────────────────────

// Catálogo demo de la empresa FICTICIA "Frutos Secos La Cosecha", como
// factory: el stock se muta con cada pedido, y el simulador
// (scripts/test-chat.js) necesita restaurar el estado inicial.
// OJO: la suite de tests depende de estos nombres, precios y stocks.
const productosDemo = () => [
  { id: 1,  nombre: 'Maní salado (kg)',                   descripcion: 'Maní tostado y salado, bien crocante',        categoria: 'frutos secos',       precio: 4990,  unidad: 'kg', stock: 30, activo: true },
  { id: 2,  nombre: 'Maní sin sal (kg)',                  descripcion: 'Maní tostado natural, sin sal',               categoria: 'frutos secos',       precio: 4790,  unidad: 'kg', stock: 25, activo: true },
  { id: 3,  nombre: 'Almendras (kg)',                     descripcion: 'Almendras naturales seleccionadas',           categoria: 'frutos secos',       precio: 12990, unidad: 'kg', stock: 15, activo: true },
  { id: 4,  nombre: 'Nueces mariposa (kg)',               descripcion: 'Nuez chilena partida, extra clara',           categoria: 'frutos secos',       precio: 14990, unidad: 'kg', stock: 10, activo: true },
  { id: 5,  nombre: 'Castañas de cajú (kg)',              descripcion: 'Cajú tostado, sin sal',                       categoria: 'frutos secos',       precio: 11990, unidad: 'kg', stock: 20, activo: true },
  { id: 6,  nombre: 'Mix frutos secos (bolsa 500 g)',     descripcion: 'Mezcla de maní, almendras, nueces y pasas',   categoria: 'mix',                precio: 6990,  unidad: 'un', stock: 18, activo: true },
  { id: 7,  nombre: 'Pasas rubias (bolsa 500 g)',         descripcion: 'Pasas rubias jumbo, sin semilla',             categoria: 'fruta deshidratada', precio: 3490,  unidad: 'un', stock: 22, activo: true },
  { id: 8,  nombre: 'Higos secos (bolsa 250 g)',          descripcion: 'Higos deshidratados premium',                 categoria: 'fruta deshidratada', precio: 4290,  unidad: 'un', stock: 16, activo: true },
  { id: 9,  nombre: 'Dátiles sin cuesco (caja 250 g)',    descripcion: 'Dátiles Medjool importados',                  categoria: 'fruta deshidratada', precio: 5990,  unidad: 'un', stock: 14, activo: true },
  { id: 10, nombre: 'Mantequilla de maní (frasco 500 g)', descripcion: '100% maní, sin azúcar añadida',               categoria: 'despensa',           precio: 4990,  unidad: 'un', stock: 12, activo: true },
];

const memoria = {
  sesiones: new Map(), // telefono → messages[]
  productos: productosDemo(),
  pedidos: [],       // { id, telefono_cliente, ..., items: [...] }
  proximoIdPedido: 1,
};

// Minúsculas y sin tildes, para que "mani" encuentre "Maní"
const normalizar = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '');

// ─── Búsqueda por tokens ──────────────────────────────────────────────────────
// "mix de frutos secos de 500g" → ["mix", "frutos", "secos", "500", "g"] y se exige
// que TODOS los tokens aparezcan en nombre+descripción+categoría. Así las
// frases naturales de WhatsApp encuentran productos aunque no calcen literal.

const STOPWORDS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'para', 'pa', 'un', 'una', 'unos',
  'unas', 'y', 'o', 'u', 'con', 'sin', 'por', 'al', 'en', 'que', 'me', 'mi',
  'su', 'tu', 'le', 'lo', 'se', 'a', 'e',
]);

// "almendras" → "almendra", "nueces" → "nuec" (heurística simple)
function singularizar(token) {
  if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function tokenizar(texto) {
  return normalizar(texto)
    .replace(/(\d)([a-z])/g, '$1 $2')   // "15kg" → "15 kg"
    .replace(/([a-z])(\d)/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOPWORDS.has(t));
}

function textoProducto(p) {
  return normalizar(`${p.nombre} ${p.descripcion ?? ''} ${p.categoria ?? ''}`);
}

const tokenCoincide = (objetivo, token) =>
  objetivo.includes(token) || objetivo.includes(singularizar(token));

// Elige el mejor candidato para un nombre dado: coincidencia exacta del nombre
// gana; si no, el único cuyo nombre contiene la consulta; si no, el primero.
function elegirMejor(candidatos, consulta) {
  if (!candidatos.length) return null;
  const q = normalizar(consulta).trim();
  const exacto = candidatos.find((p) => normalizar(p.nombre) === q);
  if (exacto) return exacto;
  const porNombre = candidatos.filter((p) => normalizar(p.nombre).includes(q));
  if (porNombre.length === 1) return porNombre[0];
  return candidatos[0];
}

const dbMemoria = {
  async testConexion() { return true; },
  // Solo modo memoria: restaura catálogo, pedidos y sesiones al estado inicial
  // (lo usa scripts/test-chat.js entre escenarios).
  async _resetDemo() {
    memoria.sesiones = new Map();
    memoria.productos = productosDemo();
    memoria.pedidos = [];
    memoria.proximoIdPedido = 1;
  },
  sesiones: {
    async get(telefono) {
      const messages = memoria.sesiones.get(telefono);
      return messages ? { messages } : null;
    },
    async upsert(telefono, messages) { memoria.sesiones.set(telefono, messages); },
  },
  productos: {
    // Búsqueda estricta: TODOS los tokens de la consulta deben aparecer.
    async buscar(consulta, categoria) {
      const tokens = tokenizar(consulta ?? '');
      const c = normalizar(categoria);
      return memoria.productos.filter((p) => p.activo
        && (!tokens.length || tokens.every((t) => tokenCoincide(textoProducto(p), t)))
        && (!c || normalizar(p.categoria).includes(c)));
    },
    // Búsqueda amplia (similares): basta con que UN token coincida. Se usa
    // para ofrecer alternativas cuando la estricta no encuentra nada.
    async buscarAmplio(consulta, categoria) {
      const tokens = tokenizar(consulta ?? '');
      if (!tokens.length) return [];
      const c = normalizar(categoria);
      return memoria.productos.filter((p) => p.activo
        && tokens.some((t) => tokenCoincide(textoProducto(p), t))
        && (!c || normalizar(p.categoria).includes(c)));
    },
    async buscarUno(nombre) {
      const candidatos = await dbMemoria.productos.buscar(nombre);
      return elegirMejor(candidatos, nombre);
    },
    async descontarStock(id, cantidad) {
      const producto = memoria.productos.find((p) => p.id === id);
      if (producto) producto.stock = Math.max(0, producto.stock - cantidad);
    },
    async reponerStock(id, cantidad) {
      const producto = memoria.productos.find((p) => p.id === id);
      if (producto) producto.stock += cantidad;
    },
  },
  pedidos: {
    async crear(datos, items) {
      const pedido = {
        id: memoria.proximoIdPedido++,
        estado: 'recibido',
        created_at: new Date().toISOString(),
        ...datos,
        items,
      };
      memoria.pedidos.push(pedido);
      return pedido;
    },
    async ultimoPorTelefono(telefono) {
      const propios = memoria.pedidos.filter((p) => p.telefono_cliente === telefono);
      return propios.length ? propios[propios.length - 1] : null;
    },
    async actualizarEstado(id, estado) {
      const pedido = memoria.pedidos.find((p) => p.id === id);
      if (pedido) pedido.estado = estado;
    },
  },
};

// ─── Implementación Supabase ─────────────────────────────────────────────────

function crearDbSupabase() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    // Redundante con el polyfill global de arriba (que es el fix real en
    // Node < 22); se mantiene como respaldo por si el global se pierde.
    realtime: { transport: ws },
  });

  return {
    supabase,
    async testConexion() {
      const { error } = await supabase.from('productos').select('count', { count: 'exact', head: true });
      return !error;
    },
    sesiones: {
      async get(telefono) {
        const { data, error } = await supabase
          .from('retail_sesiones')
          .select('messages')
          .eq('telefono', telefono)
          .single();
        if (error) {
          if (error.code === 'PGRST116') return null; // sin filas
          throw new Error(`[DB] sesiones.get: ${error.message}`);
        }
        return data;
      },
      async upsert(telefono, messages) {
        const { error } = await supabase
          .from('retail_sesiones')
          .upsert({ telefono, messages, updated_at: new Date().toISOString() }, { onConflict: 'telefono' });
        if (error) throw new Error(`[DB] sesiones.upsert: ${error.message}`);
      },
    },
    productos: {
      // Los tokens son alfanuméricos (tokenizar limpia todo lo demás), así que
      // es seguro interpolarlos en los filtros .or() de PostgREST.
      _condicionesToken(token) {
        const variantes = [...new Set([token, singularizar(token)])];
        return variantes
          .flatMap((v) => [`nombre.ilike.%${v}%`, `descripcion.ilike.%${v}%`, `categoria.ilike.%${v}%`])
          .join(',');
      },
      // Búsqueda estricta: cada token debe aparecer (un .or por token = AND).
      async buscar(consulta, categoria) {
        let query = supabase.from('productos').select('*').eq('activo', true).order('id');
        for (const token of tokenizar(consulta ?? '')) {
          query = query.or(this._condicionesToken(token));
        }
        if (categoria) query = query.ilike('categoria', `%${categoria}%`);
        const { data, error } = await query;
        if (error) throw new Error(`[DB] productos.buscar: ${error.message}`);
        return data ?? [];
      },
      // Búsqueda amplia: basta un token (todas las condiciones en un solo .or).
      async buscarAmplio(consulta, categoria) {
        const tokens = tokenizar(consulta ?? '');
        if (!tokens.length) return [];
        let query = supabase.from('productos').select('*').eq('activo', true).order('id')
          .or(tokens.map((t) => this._condicionesToken(t)).join(','));
        if (categoria) query = query.ilike('categoria', `%${categoria}%`);
        const { data, error } = await query;
        if (error) throw new Error(`[DB] productos.buscarAmplio: ${error.message}`);
        return data ?? [];
      },
      async buscarUno(nombre) {
        const candidatos = await this.buscar(nombre);
        return elegirMejor(candidatos, nombre);
      },
      async descontarStock(id, cantidad) {
        // Lectura + update simple (suficiente para la demo; en producción real
        // esto sería una función RPC atómica en Postgres).
        const { data, error } = await supabase.from('productos').select('stock').eq('id', id).single();
        if (error) throw new Error(`[DB] productos.descontarStock (select): ${error.message}`);
        const nuevo = Math.max(0, (data?.stock ?? 0) - cantidad);
        const { error: errorUpdate } = await supabase.from('productos').update({ stock: nuevo }).eq('id', id);
        if (errorUpdate) throw new Error(`[DB] productos.descontarStock (update): ${errorUpdate.message}`);
      },
      async reponerStock(id, cantidad) {
        const { data, error } = await supabase.from('productos').select('stock').eq('id', id).single();
        if (error) throw new Error(`[DB] productos.reponerStock (select): ${error.message}`);
        const nuevo = (data?.stock ?? 0) + cantidad;
        const { error: errorUpdate } = await supabase.from('productos').update({ stock: nuevo }).eq('id', id);
        if (errorUpdate) throw new Error(`[DB] productos.reponerStock (update): ${errorUpdate.message}`);
      },
    },
    pedidos: {
      async crear(datos, items) {
        const { data: pedido, error } = await supabase
          .from('pedidos')
          .insert({ ...datos, estado: 'recibido' })
          .select()
          .single();
        if (error) throw new Error(`[DB] pedidos.crear: ${error.message}`);

        const { error: errorItems } = await supabase
          .from('pedido_items')
          .insert(items.map((i) => ({ ...i, pedido_id: pedido.id })));
        if (errorItems) throw new Error(`[DB] pedidos.crear (items): ${errorItems.message}`);

        return { ...pedido, items };
      },
      async ultimoPorTelefono(telefono) {
        const { data, error } = await supabase
          .from('pedidos')
          .select('*, items:pedido_items(*)')
          .eq('telefono_cliente', telefono)
          .order('created_at', { ascending: false })
          .limit(1);
        if (error) throw new Error(`[DB] pedidos.ultimoPorTelefono: ${error.message}`);
        return data?.[0] ?? null;
      },
      async actualizarEstado(id, estado) {
        const { error } = await supabase.from('pedidos').update({ estado }).eq('id', id);
        if (error) throw new Error(`[DB] pedidos.actualizarEstado: ${error.message}`);
      },
    },
  };
}

const db = usandoMemoria ? dbMemoria : crearDbSupabase();

module.exports = { db, usandoMemoria, normalizar };
