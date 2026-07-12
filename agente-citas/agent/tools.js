// Herramientas del agente de citas: definiciones (para Claude) + ejecución.
// Alcance LIMITADO por diseño: catálogo, disponibilidad, agendar y cancelar.

const { db } = require('../database/supabase');

const SLOT_MINUTOS = Number(process.env.SLOT_MINUTOS) || 60;

const TOOL_DEFINITIONS = [
  {
    name: 'ver_catalogo',
    description: 'Lista los servicios/productos del catálogo del negocio, con precio y duración. Úsala cuando el cliente pregunte qué servicios hay, precios o "qué ofrecen".',
    input_schema: {
      type: 'object',
      properties: {
        categoria: { type: 'string', description: 'Filtro opcional por categoría (ej: "consulta", "higiene", "estética", "ortodoncia")' },
      },
    },
  },
  {
    name: 'consultar_disponibilidad',
    description: 'Devuelve las horas disponibles para agendar en una fecha dada. Úsala SIEMPRE antes de agendar, para ofrecer solo horas realmente libres.',
    input_schema: {
      type: 'object',
      properties: {
        fecha: { type: 'string', description: 'Fecha en formato YYYY-MM-DD' },
      },
      required: ['fecha'],
    },
  },
  {
    name: 'agendar_cita',
    description: 'Agenda una hora para el cliente. Llamar solo cuando el cliente ya confirmó nombre, servicio, fecha y hora.',
    input_schema: {
      type: 'object',
      properties: {
        nombre:   { type: 'string', description: 'Nombre del cliente' },
        servicio: { type: 'string', description: 'Servicio del catálogo que quiere reservar' },
        fecha:    { type: 'string', description: 'Fecha en formato YYYY-MM-DD' },
        hora:     { type: 'string', description: 'Hora en formato HH:MM (24h)' },
        personas: { type: 'integer', description: 'Cantidad de personas (si aplica). Default 1.' },
        notas:    { type: 'string', description: 'Comentario opcional del cliente' },
      },
      required: ['nombre', 'servicio', 'fecha', 'hora'],
    },
  },
  {
    name: 'mis_citas',
    description: 'Lista las citas vigentes del cliente (se identifica por su teléfono). Úsala cuando pregunte por sus horas agendadas y ANTES de cancelar o cambiar una.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'cancelar_cita',
    description: 'Cancela una cita vigente del cliente. Sin cita_id cancela su única cita; si tiene varias, la herramienta pide seleccionar y debes volver a llamarla con el cita_id correcto (lo entrega mis_citas). Para cambiar una hora: cancelar y luego agendar de nuevo.',
    input_schema: {
      type: 'object',
      properties: {
        cita_id: { type: 'integer', description: 'ID de la cita a cancelar cuando el cliente tiene más de una (viene de mis_citas)' },
      },
    },
  },
  {
    name: 'ver_horarios',
    description: 'Muestra los horarios de atención del negocio por día de la semana. Úsala cuando pregunten a qué hora abren/cierran o qué días atienden.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * Ejecuta una herramienta y retorna un objeto serializable para el tool_result.
 * @param {string} nombre
 * @param {Object} input
 * @param {string} telefono - Teléfono del cliente (identidad de la sesión)
 */
async function ejecutarHerramienta(nombre, input, telefono) {
  switch (nombre) {
    case 'ver_catalogo':             return verCatalogo(input);
    case 'consultar_disponibilidad': return consultarDisponibilidad(input);
    case 'agendar_cita':             return agendarCita(input, telefono);
    case 'mis_citas':                return misCitas(telefono);
    case 'cancelar_cita':            return cancelarCita(input, telefono);
    case 'ver_horarios':             return verHorarios();
    default: return { error: `Herramienta desconocida: ${nombre}` };
  }
}

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const hoyChile = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });

const horaChile = () => new Date().toLocaleTimeString('en-GB', {
  timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit',
});

async function verCatalogo({ categoria } = {}) {
  const items = await db.catalogo.listar(categoria);
  if (!items.length) return { resultados: 0, mensaje: 'No hay servicios cargados para ese filtro.' };
  return {
    resultados: items.length,
    servicios: items.map((s) => ({
      nombre: s.nombre,
      descripcion: s.descripcion,
      categoria: s.categoria,
      precio: s.precio,
      duracion_minutos: s.duracion_minutos,
    })),
  };
}

async function consultarDisponibilidad({ fecha }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) {
    return { error: 'Fecha inválida: usar formato YYYY-MM-DD' };
  }
  const hoy = hoyChile();
  if (fecha < hoy) {
    return { fecha, disponible: false, error: `La fecha ${fecha} ya pasó (hoy es ${hoy}): solo se agenda de hoy en adelante.` };
  }
  const diaSemana = new Date(`${fecha}T12:00:00`).getDay();
  const horario = await db.horarios.get(diaSemana);
  if (!horario) return { fecha, disponible: false, mensaje: 'Ese día el negocio está cerrado.' };

  const ocupadas = new Set(
    (await db.citas.listarPorFecha(fecha)).map((c) => normalizarHora(c.hora))
  );

  // Si consultan por HOY, las horas que ya pasaron no se ofrecen
  const horaMinima = fecha === hoy ? horaChile() : null;

  const libres = [];
  let [h, m] = horario.abre.split(':').map(Number);
  const [hc, mc] = horario.cierra.split(':').map(Number);
  while (h * 60 + m + SLOT_MINUTOS <= hc * 60 + mc) {
    const slot = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    if (!ocupadas.has(slot) && (!horaMinima || slot > horaMinima)) libres.push(slot);
    m += SLOT_MINUTOS;
    h += Math.floor(m / 60);
    m %= 60;
  }
  return { fecha, horario_atencion: `${horario.abre} a ${horario.cierra}`, horas_disponibles: libres };
}

// Minúsculas y sin tildes, para comparar nombres de servicio con tolerancia
const normalizarTexto = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/**
 * Resuelve el nombre que dio el cliente a UN servicio del catálogo.
 * @returns {{servicio: Object} | {noExiste: true} | {ambiguo: Object[]}}
 */
async function resolverServicio(nombre) {
  const items = await db.catalogo.listar();
  const q = normalizarTexto(nombre);
  const exacto = items.find((s) => normalizarTexto(s.nombre) === q);
  if (exacto) return { servicio: exacto };
  const parciales = items.filter((s) => {
    const n = normalizarTexto(s.nombre);
    return n.includes(q) || q.includes(n);
  });
  if (parciales.length === 1) return { servicio: parciales[0] };
  if (parciales.length > 1) return { ambiguo: parciales };
  return { noExiste: true };
}

async function agendarCita({ nombre, servicio, fecha, hora, personas, notas }, telefono) {
  // El servicio debe existir en el catálogo (no se agendan servicios inventados)
  const resolucion = await resolverServicio(servicio);
  if (resolucion.noExiste) {
    const items = await db.catalogo.listar();
    return {
      agendada: false,
      motivo: `"${servicio}" no está en el catálogo.`,
      servicios_disponibles: items.map((s) => s.nombre),
    };
  }
  if (resolucion.ambiguo) {
    return {
      agendada: false,
      motivo: `"${servicio}" coincide con varios servicios: pregunta al cliente cuál necesita.`,
      servicios_disponibles: resolucion.ambiguo.map((s) => s.nombre),
    };
  }
  const servicioCatalogo = resolucion.servicio;

  const disponibilidad = await consultarDisponibilidad({ fecha });
  if (disponibilidad.error) return disponibilidad;
  if (disponibilidad.disponible === false) return disponibilidad;
  const horaNorm = normalizarHora(hora);
  if (!disponibilidad.horas_disponibles.includes(horaNorm)) {
    return {
      agendada: false,
      motivo: `La hora ${horaNorm} no está disponible el ${fecha}.`,
      horas_disponibles: disponibilidad.horas_disponibles,
    };
  }
  const cita = await db.citas.crear({
    telefono_cliente: telefono,
    nombre_cliente: nombre,
    servicio: servicioCatalogo.nombre, // nombre canónico del catálogo
    fecha,
    hora: horaNorm,
    personas: personas ?? 1,
    notas: notas ?? null,
  });
  return { agendada: true, cita: { id: cita.id, nombre, servicio: servicioCatalogo.nombre, fecha, hora: horaNorm, personas: personas ?? 1 } };
}

const resumenCita = (c) => ({
  id: c.id,
  servicio: c.servicio,
  fecha: c.fecha,
  hora: normalizarHora(c.hora),
  personas: c.personas,
});

async function misCitas(telefono) {
  const citas = await db.citas.proximasPorTelefono(telefono, hoyChile());
  if (!citas.length) return { citas: [], mensaje: 'El cliente no tiene citas vigentes.' };
  return { citas: citas.map(resumenCita) };
}

async function cancelarCita({ cita_id } = {}, telefono) {
  const proximas = await db.citas.proximasPorTelefono(telefono, hoyChile());
  if (!proximas.length) return { cancelada: false, motivo: 'El cliente no tiene citas vigentes.' };

  let cita;
  if (cita_id != null) {
    cita = proximas.find((c) => c.id === Number(cita_id));
    if (!cita) {
      return {
        cancelada: false,
        motivo: `No hay una cita vigente con id ${cita_id}.`,
        citas: proximas.map(resumenCita),
      };
    }
  } else if (proximas.length > 1) {
    // Con varias citas NO se cancela a ciegas: hay que preguntar cuál
    return {
      cancelada: false,
      requiere_seleccion: true,
      citas: proximas.map(resumenCita),
      mensaje: 'El cliente tiene varias citas vigentes: pregúntale cuál quiere cancelar y vuelve a llamar con su cita_id.',
    };
  } else {
    cita = proximas[0];
  }

  await db.citas.cancelar(cita.id);
  return { cancelada: true, cita: { servicio: cita.servicio, fecha: cita.fecha, hora: normalizarHora(cita.hora) } };
}

async function verHorarios() {
  const filas = await db.horarios.listar();
  const porDia = new Map(filas.map((h) => [h.dia_semana, h]));
  return {
    horarios: DIAS_SEMANA.map((dia, i) => (porDia.has(i)
      ? { dia, abre: porDia.get(i).abre, cierra: porDia.get(i).cierra }
      : { dia, cerrado: true })),
  };
}

/** '9:00' | '09:00:00' → '09:00' */
function normalizarHora(hora) {
  const [h = '0', m = '00'] = String(hora || '').split(':');
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
}

module.exports = { TOOL_DEFINITIONS, ejecutarHerramienta };
