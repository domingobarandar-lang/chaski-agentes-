// Memoria conversacional: historial por teléfono persistido en Supabase, con
// RESPALDO EN PROCESO. Si Supabase falla (tabla ausente, permisos, red), la
// conversación mantiene contexto mientras viva el proceso — nunca más un
// "confirmo" que el bot no entiende porque perdió el historial.
// Se guarda solo texto plano (user/assistant) — los bloques de tool use viven
// únicamente dentro del turno en agent/core.js.

const { db } = require('../database/supabase');

// Ventana deslizante: últimos N mensajes (user+assistant). Suficiente contexto
// para una conversación de agendamiento sin inflar el prompt.
const MAX_MENSAJES = 30;

// Respaldo en proceso: telefono → { messages, perfil }. Se actualiza SIEMPRE
// (también cuando Supabase funciona) para que una falla posterior de lectura
// tenga desde dónde continuar la conversación.
const respaldo = new Map();

/**
 * Carga la sesión completa del cliente: historial + perfil conocido
 * (nombre, etc., capturado de acciones exitosas anteriores).
 * @param {string} telefono
 * @returns {Promise<{historial: Array<{role: string, content: string}>, perfil: Object|null}>}
 */
async function cargarSesion(telefono) {
  try {
    const sesion = await db.sesiones.get(telefono);
    const messages = Array.isArray(sesion?.messages) ? sesion.messages : [];
    const perfil = sesion?.perfil && typeof sesion.perfil === 'object' ? sesion.perfil : null;
    const local = respaldo.get(telefono);
    // Si Supabase viene vacío pero el respaldo tiene turnos de ESTA conversación
    // (p.ej. las escrituras están fallando pero las lecturas no), gana el respaldo.
    if (!messages.length && local?.messages?.length) {
      return { historial: local.messages, perfil: perfil ?? local.perfil ?? null };
    }
    respaldo.set(telefono, { messages, perfil: perfil ?? local?.perfil ?? null });
    return { historial: messages, perfil: perfil ?? local?.perfil ?? null };
  } catch (error) {
    console.warn('[Memory] Supabase no disponible al leer — usando respaldo en proceso:', error.message);
    const local = respaldo.get(telefono);
    return { historial: local?.messages ?? [], perfil: local?.perfil ?? null };
  }
}

/**
 * Agrega el turno (mensaje del cliente + respuesta) al historial y persiste.
 * El respaldo en proceso se actualiza SIEMPRE, falle o no Supabase.
 */
async function persistirInteraccion(telefono, historialPrevio, mensajeUsuario, respuestaTexto) {
  const messages = [
    ...historialPrevio,
    { role: 'user', content: mensajeUsuario },
    { role: 'assistant', content: respuestaTexto },
  ].slice(-MAX_MENSAJES);
  const local = respaldo.get(telefono);
  respaldo.set(telefono, { messages, perfil: local?.perfil ?? null });
  try {
    await db.sesiones.upsert(telefono, messages);
  } catch (error) {
    // Perder un turno de historial en Supabase no debe romper la respuesta:
    // el respaldo en proceso ya lo tiene.
    console.warn('[Memory] No se pudo persistir historial en Supabase:', error.message);
  }
}

/**
 * Guarda datos del cliente capturados de forma DETERMINISTA (del input de una
 * herramienta que terminó con éxito — nunca extraídos por el modelo). En la
 * siguiente conversación se inyectan al prompt para reconocer al cliente.
 * @param {string} telefono
 * @param {Object} datos - ej: { nombre: 'Camila' }
 */
async function guardarPerfil(telefono, datos) {
  const limpios = Object.fromEntries(
    Object.entries(datos || {}).filter(([, v]) => typeof v === 'string' && v.trim())
  );
  if (!Object.keys(limpios).length) return;
  const local = respaldo.get(telefono);
  const perfil = { ...(local?.perfil || {}), ...limpios };
  respaldo.set(telefono, { messages: local?.messages ?? [], perfil });
  try {
    await db.sesiones.actualizarPerfil(telefono, perfil);
  } catch (error) {
    console.warn('[Memory] No se pudo persistir perfil en Supabase:', error.message);
  }
}

// Solo para tests: limpia el respaldo en proceso entre escenarios.
function _resetRespaldoParaTests() { respaldo.clear(); }

module.exports = { cargarSesion, persistirInteraccion, guardarPerfil, _resetRespaldoParaTests };
