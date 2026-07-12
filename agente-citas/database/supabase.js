// Capa de acceso a datos del agente de citas.
// Con SUPABASE_URL + SUPABASE_ANON_KEY usa Supabase; sin ellas cae a una base
// EN MEMORIA con datos demo (suficiente para probar con `npm run chat`).
//
// Supabase es COMPARTIDO con agente-retail (mismo proyecto/URL/key — ver
// schema-compartido.sql). La tabla `sesiones` está prefijada como
// `citas_sesiones` para no chocar con la de agente-retail.

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

// Catálogo demo de la empresa FICTICIA "Clínica Dental Sonrisa del Valle"
// (los nombres y precios de los 3 primeros servicios los usa la suite de tests).
const memoria = {
  sesiones: new Map(), // telefono → messages[]
  catalogo: [
    { id: 1, nombre: 'Consulta general',         descripcion: 'Evaluación inicial con odontólogo general',            categoria: 'consulta',     precio: 25000,  duracion_minutos: 30, activo: true },
    { id: 2, nombre: 'Limpieza dental',          descripcion: 'Destartraje ultrasónico y profilaxis completa',        categoria: 'higiene',      precio: 45000,  duracion_minutos: 60, activo: true },
    { id: 3, nombre: 'Blanqueamiento',           descripcion: 'Blanqueamiento dental LED en 1 sesión',                categoria: 'estética',     precio: 120000, duracion_minutos: 90, activo: true },
    { id: 4, nombre: 'Urgencia dental',          descripcion: 'Atención de dolor agudo, fractura o trauma',           categoria: 'urgencia',     precio: 35000,  duracion_minutos: 45, activo: true },
    { id: 5, nombre: 'Extracción simple',        descripcion: 'Extracción de pieza dental con anestesia local',       categoria: 'cirugía',      precio: 40000,  duracion_minutos: 45, activo: true },
    { id: 6, nombre: 'Endodoncia',               descripcion: 'Tratamiento de conducto por pieza',                    categoria: 'tratamiento',  precio: 180000, duracion_minutos: 90, activo: true },
    { id: 7, nombre: 'Evaluación de ortodoncia', descripcion: 'Diagnóstico y plan de tratamiento con la ortodoncista', categoria: 'ortodoncia',  precio: 20000,  duracion_minutos: 45, activo: true },
    { id: 8, nombre: 'Radiografía panorámica',   descripcion: 'Imagen panorámica digital, entrega inmediata',         categoria: 'imagenología', precio: 18000,  duracion_minutos: 20, activo: true },
  ],
  // 0=domingo ... 6=sábado (domingo cerrado)
  horarios: new Map([
    [1, { abre: '09:00', cierra: '19:00' }],
    [2, { abre: '09:00', cierra: '19:00' }],
    [3, { abre: '09:00', cierra: '19:00' }],
    [4, { abre: '09:00', cierra: '19:00' }],
    [5, { abre: '09:00', cierra: '19:00' }],
    [6, { abre: '10:00', cierra: '14:00' }],
  ]),
  citas: [],
  proximoIdCita: 1,
};

const dbMemoria = {
  async testConexion() { return true; },
  // Solo en modo memoria: reinicia sesiones y citas a cero (lo usa la suite
  // de tests para aislar escenarios). En modo Supabase no existe.
  async resetDemo() {
    memoria.sesiones.clear();
    memoria.citas.length = 0;
    memoria.proximoIdCita = 1;
  },
  sesiones: {
    async get(telefono) {
      const messages = memoria.sesiones.get(telefono);
      return messages ? { messages } : null;
    },
    async upsert(telefono, messages) { memoria.sesiones.set(telefono, messages); },
  },
  catalogo: {
    async listar(categoria) {
      return memoria.catalogo.filter((s) => s.activo &&
        (!categoria || (s.categoria || '').toLowerCase().includes(categoria.toLowerCase())));
    },
  },
  horarios: {
    async get(diaSemana) { return memoria.horarios.get(diaSemana) ?? null; },
    async listar() {
      return [...memoria.horarios.entries()].map(([dia_semana, h]) => ({ dia_semana, ...h }));
    },
  },
  citas: {
    async listarPorFecha(fecha) {
      return memoria.citas.filter((c) => c.fecha === fecha && c.estado === 'confirmada');
    },
    async crear(datos) {
      const cita = { id: memoria.proximoIdCita++, estado: 'confirmada', created_at: new Date().toISOString(), ...datos };
      memoria.citas.push(cita);
      return cita;
    },
    async proximasPorTelefono(telefono, desdeFecha) {
      return memoria.citas
        .filter((c) => c.telefono_cliente === telefono && c.estado === 'confirmada' && c.fecha >= desdeFecha)
        .sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora));
    },
    async cancelar(id) {
      const cita = memoria.citas.find((c) => c.id === id);
      if (cita) cita.estado = 'cancelada';
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
      const { error } = await supabase.from('citas').select('count', { count: 'exact', head: true });
      return !error;
    },
    sesiones: {
      async get(telefono) {
        const { data, error } = await supabase
          .from('citas_sesiones')
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
          .from('citas_sesiones')
          .upsert({ telefono, messages, updated_at: new Date().toISOString() }, { onConflict: 'telefono' });
        if (error) throw new Error(`[DB] sesiones.upsert: ${error.message}`);
      },
    },
    catalogo: {
      async listar(categoria) {
        let query = supabase.from('catalogo').select('*').eq('activo', true).order('id');
        if (categoria) query = query.ilike('categoria', `%${categoria}%`);
        const { data, error } = await query;
        if (error) throw new Error(`[DB] catalogo.listar: ${error.message}`);
        return data ?? [];
      },
    },
    horarios: {
      async get(diaSemana) {
        const { data, error } = await supabase
          .from('horarios')
          .select('abre, cierra')
          .eq('dia_semana', diaSemana)
          .single();
        if (error) {
          if (error.code === 'PGRST116') return null; // día cerrado
          throw new Error(`[DB] horarios.get: ${error.message}`);
        }
        // Postgres devuelve time como 'HH:MM:SS' — recortamos a 'HH:MM'
        return { abre: String(data.abre).slice(0, 5), cierra: String(data.cierra).slice(0, 5) };
      },
      async listar() {
        const { data, error } = await supabase
          .from('horarios')
          .select('dia_semana, abre, cierra')
          .order('dia_semana');
        if (error) throw new Error(`[DB] horarios.listar: ${error.message}`);
        return (data ?? []).map((h) => ({
          dia_semana: h.dia_semana,
          abre: String(h.abre).slice(0, 5),
          cierra: String(h.cierra).slice(0, 5),
        }));
      },
    },
    citas: {
      async listarPorFecha(fecha) {
        const { data, error } = await supabase
          .from('citas')
          .select('id, hora, servicio')
          .eq('fecha', fecha)
          .eq('estado', 'confirmada');
        if (error) throw new Error(`[DB] citas.listarPorFecha: ${error.message}`);
        return data ?? [];
      },
      async crear(datos) {
        const { data, error } = await supabase.from('citas').insert(datos).select().single();
        if (error) throw new Error(`[DB] citas.crear: ${error.message}`);
        return data;
      },
      async proximasPorTelefono(telefono, desdeFecha) {
        const { data, error } = await supabase
          .from('citas')
          .select('*')
          .eq('telefono_cliente', telefono)
          .eq('estado', 'confirmada')
          .gte('fecha', desdeFecha)
          .order('fecha')
          .order('hora');
        if (error) throw new Error(`[DB] citas.proximasPorTelefono: ${error.message}`);
        return data ?? [];
      },
      async cancelar(id) {
        const { error } = await supabase.from('citas').update({ estado: 'cancelada' }).eq('id', id);
        if (error) throw new Error(`[DB] citas.cancelar: ${error.message}`);
      },
    },
  };
}

const db = usandoMemoria ? dbMemoria : crearDbSupabase();

module.exports = { db, usandoMemoria };
