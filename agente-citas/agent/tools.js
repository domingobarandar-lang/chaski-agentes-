// Herramientas del agente de citas: definiciones (para Claude) + ejecución.
// Alcance LIMITADO por diseño: catálogo, disponibilidad, agendar y cancelar.

const { db } = require('../database/supabase');
const { guardarPerfil } = require('./memory');
const { avisarDueno } = require('./avisos');

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
    description: 'Devuelve las horas disponibles para agendar en una fecha dada. Úsala SIEMPRE antes de agendar, para ofrecer solo horas realmente libres. Si ya sabes qué servicio quiere el cliente, pásalo también: así se considera su duración real.',
    input_schema: {
      type: 'object',
      properties: {
        fecha:    { type: 'string', description: 'Fecha en formato YYYY-MM-DD' },
        servicio: { type: 'string', description: 'Opcional: servicio del catálogo, para reservar el bloque completo según su duración' },
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
  {
    name: 'anotar_pendiente',
    description: 'Deja registrado un pendiente para que recepción lo resuelva y le responda al cliente por este chat. Úsala cuando el cliente pida algo real que no puedes resolver con tus herramientas, o cuando una herramienta siga fallando técnicamente.',
    input_schema: {
      type: 'object',
      properties: {
        resumen: { type: 'string', description: 'Resumen claro del pendiente: qué pidió el cliente, para cuándo y a nombre de quién' },
      },
      required: ['resumen'],
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
    case 'anotar_pendiente':         return anotarPendiente(input, telefono);
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

// '09:30' → 570 (minutos desde medianoche)
const aMinutos = (hhmm) => {
  const [h = 0, m = 0] = String(hhmm || '').split(':').map(Number);
  return h * 60 + (m || 0);
};

/**
 * Intervalos [inicio, fin) en minutos ocupados por las citas de una fecha,
 * con la duración REAL del servicio según el catálogo: una cita de 90 min a
 * las 10:00 ocupa 10:00–11:30 — antes solo bloqueaba el slot de las 10:00 y
 * las 11:00 seguían ofertándose (doble reserva real).
 */
async function intervalosOcupados(fecha) {
  const [citas, items] = await Promise.all([
    db.citas.listarPorFecha(fecha),
    db.catalogo.listar(),
  ]);
  const duracionPorServicio = new Map(
    items.map((s) => [normalizarTexto(s.nombre), s.duracion_minutos || SLOT_MINUTOS])
  );
  return citas.map((c) => {
    const inicio = aMinutos(normalizarHora(c.hora));
    const duracion = duracionPorServicio.get(normalizarTexto(c.servicio)) || SLOT_MINUTOS;
    return { inicio, fin: inicio + duracion };
  });
}

const seSolapa = (intervalos, inicio, fin) =>
  intervalos.some((i) => inicio < i.fin && fin > i.inicio);

async function consultarDisponibilidad({ fecha, servicio } = {}) {
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

  // Duración a reservar: la del servicio si se conoce; si no, un slot base.
  let duracion = SLOT_MINUTOS;
  if (servicio) {
    const resolucion = await resolverServicio(servicio);
    if (resolucion.servicio?.duracion_minutos) duracion = resolucion.servicio.duracion_minutos;
  }

  const ocupados = await intervalosOcupados(fecha);

  // Si consultan por HOY, las horas que ya pasaron no se ofrecen
  const horaMinima = fecha === hoy ? horaChile() : null;

  const libres = [];
  const abreMin   = aMinutos(horario.abre);
  const cierraMin = aMinutos(horario.cierra);
  for (let t = abreMin; t + duracion <= cierraMin; t += SLOT_MINUTOS) {
    const slot = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    if (!seSolapa(ocupados, t, t + duracion) && (!horaMinima || slot > horaMinima)) libres.push(slot);
  }
  return {
    fecha,
    horario_atencion: `${horario.abre} a ${horario.cierra}`,
    duracion_considerada_minutos: duracion,
    horas_disponibles: libres,
  };
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

  // Con el nombre canónico: la disponibilidad reserva el bloque completo
  // según la duración real del servicio, no solo la hora de inicio.
  const disponibilidad = await consultarDisponibilidad({ fecha, servicio: servicioCatalogo.nombre });
  if (disponibilidad.error) return disponibilidad;
  if (disponibilidad.disponible === false) return disponibilidad;
  const horaNorm = normalizarHora(hora);
  if (!disponibilidad.horas_disponibles.includes(horaNorm)) {
    // ¿La hora la ocupa una cita de ESTE MISMO cliente? Entonces el modelo
    // volvió a llamar tras una confirmación repetida ("sí", "confirmo"):
    // respuesta idempotente, no un rechazo (evita el falso "ya no está
    // disponible" y también la cita duplicada).
    const propias = await db.citas.proximasPorTelefono(telefono, fecha);
    const yaExiste = propias.find((c) => c.fecha === fecha && normalizarHora(c.hora) === horaNorm);
    if (yaExiste) {
      return {
        agendada: true,
        ya_existia: true,
        cita: { id: yaExiste.id, nombre: yaExiste.nombre_cliente ?? nombre, servicio: yaExiste.servicio, fecha, hora: horaNorm },
        mensaje: 'Esta cita YA estaba agendada para este mismo cliente (no se creó una nueva). Dile que su hora está lista.',
      };
    }
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
  // Perfil: el nombre viene del input de una cita agendada con ÉXITO
  // (determinista, no extraído por el modelo). Sirve para reconocer al
  // cliente en su próxima conversación. Nunca bloquea la respuesta.
  guardarPerfil(telefono, { nombre }).catch(() => {});
  // Sin await: el aviso al dueño jamás retrasa la respuesta al cliente.
  avisarDueno(`🆕 Cita nueva: ${nombre} — ${servicioCatalogo.nombre} el ${fecha} a las ${horaNorm} (cliente ${telefono})`);
  return { agendada: true, cita: { id: cita.id, nombre, servicio: servicioCatalogo.nombre, fecha, hora: horaNorm, personas: personas ?? 1 } };
}

async function anotarPendiente({ resumen } = {}, telefono) {
  if (!resumen || !String(resumen).trim()) {
    return { anotado: false, motivo: 'Falta el resumen del pendiente.' };
  }
  // Registro visible en los logs del servicio (Railway): suficiente para la
  // demo. Una tabla de pendientes real queda como paso de producción.
  console.log(`[Pendiente] ${telefono}: ${String(resumen).trim()}`);
  avisarDueno(`📝 Pendiente del cliente ${telefono}: ${String(resumen).trim()}`);
  return { anotado: true, mensaje: 'Pendiente registrado: recepción lo verá y le responderá al cliente por este mismo chat.' };
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
  avisarDueno(`❌ Cita cancelada: ${cita.servicio} del ${cita.fecha} a las ${normalizarHora(cita.hora)} (cliente ${telefono})`);
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
