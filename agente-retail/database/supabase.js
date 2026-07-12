// Capa de acceso a datos del agente de retail.
// Con SUPABASE_URL + SUPABASE_ANON_KEY usa Supabase; sin ellas cae a una base
// EN MEMORIA con productos demo (suficiente para probar con `npm run chat`).
//
// Supabase es COMPARTIDO con agente-citas (mismo proyecto/URL/key — ver
// schema-compartido.sql). La tabla `sesiones` está prefijada como
// `retail_sesiones` para no chocar con la de agente-citas.

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const usandoMemoria = !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY;

// ─── Implementación en memoria (modo demo) ───────────────────────────────────

// Catálogo demo como factory: el stock se muta con cada pedido, y el
// simulador (scripts/test-chat.js) necesita restaurar el estado inicial.
const productosDemo = () => [
  { id: 1,  nombre: 'Arroz grado 1 (1 kg)',            descripcion: 'Bolsa de arroz grano largo',          categoria: 'abarrotes', precio: 1890,  unidad: 'un',  stock: 40, activo: true },
  { id: 2,  nombre: 'Lentejas (1 kg)',                 descripcion: 'Lentejas seleccionadas',              categoria: 'abarrotes', precio: 2490,  unidad: 'un',  stock: 25, activo: true },
  { id: 3,  nombre: 'Aceite vegetal (900 ml)',         descripcion: 'Aceite de maravilla',                 categoria: 'abarrotes', precio: 2990,  unidad: 'un',  stock: 30, activo: true },
  { id: 4,  nombre: 'Salmón fresco (kg)',              descripcion: 'Filete de salmón del día',            categoria: 'mariscos',  precio: 12990, unidad: 'kg',  stock: 15, activo: true },
  { id: 5,  nombre: 'Camarones ecuatorianos (kg)',     descripcion: 'Camarón 36/40 congelado',             categoria: 'mariscos',  precio: 10990, unidad: 'kg',  stock: 20, activo: true },
  { id: 6,  nombre: 'Choritos (malla 1 kg)',           descripcion: 'Choritos frescos de Chiloé',          categoria: 'mariscos',  precio: 3490,  unidad: 'un',  stock: 18, activo: true },
  { id: 7,  nombre: 'Comida perro adulto (15 kg)',     descripcion: 'Saco de alimento premium para perro', categoria: 'mascotas',  precio: 34990, unidad: 'un',  stock: 12, activo: true },
  { id: 8,  nombre: 'Comida gato (3 kg)',              descripcion: 'Alimento para gato adulto',           categoria: 'mascotas',  precio: 12990, unidad: 'un',  stock: 22, activo: true },
  { id: 9,  nombre: 'Arena sanitaria (10 L)',          descripcion: 'Arena aglomerante para gato',         categoria: 'mascotas',  precio: 8990,  unidad: 'un',  stock: 16, activo: true },
  { id: 10, nombre: 'Snacks para perro (paquete)',     descripcion: 'Galletas de entrenamiento',           categoria: 'mascotas',  precio: 3990,  unidad: 'un',  stock: 35, activo: true },
];

const memoria = {
  sesiones: new Map(), // telefono → messages[]
  productos: productosDemo(),
  pedidos: [],       // { id, telefono_cliente, ..., items: [...] }
  proximoIdPedido: 1,
};

// Minúsculas y sin tildes, para que "salmon" encuentre "Salmón"
const normalizar = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '');

// ─── Búsqueda por tokens ──────────────────────────────────────────────────────
// "alimento para perros de 15kg" → ["alimento", "perro", "15", "kg"] y se exige
// que TODOS los tokens aparezcan en nombre+descripción+categoría. Así las
// frases naturales de WhatsApp encuentran productos aunque no calcen literal.

const STOPWORDS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'para', 'pa', 'un', 'una', 'unos',
  'unas', 'y', 'o', 'u', 'con', 'sin', 'por', 'al', 'en', 'que', 'me', 'mi',
  'su', 'tu', 'le', 'lo', 'se', 'a', 'e',
]);

// "perros" → "perro", "camarones" → "camaron" (heurística simple)
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
    // Node < 22 no trae WebSocket nativo; realtime-js espera la opción
    // `transport` (websocketImpl no existe y se ignora silenciosamente).
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
