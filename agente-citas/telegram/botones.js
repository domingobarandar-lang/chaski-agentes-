// Botones inline de Telegram del agente de citas.
// Módulo PURO (sin Telegram ni red) para poder verificarlo en los tests:
// - TECLADO_INICIO: accesos rápidos del saludo (/start y botón Menú).
// - FRASES_BOTONES: cada botón se traduce a la frase natural equivalente y
//   entra por processMessage — el mismo loop del agente, sin lógica duplicada.
// - botonesParaRespuesta: botones contextuales según lo que respondió el bot.

const TECLADO_INICIO = {
  inline_keyboard: [
    [{ text: '🦷 Servicios y precios', callback_data: 'citas:servicios' }],
    [{ text: '📅 Agendar una hora', callback_data: 'citas:agendar' }],
    [
      { text: '🔎 Mis citas', callback_data: 'citas:mis' },
      { text: '❌ Cancelar mi hora', callback_data: 'citas:cancelar' },
    ],
  ],
};

const FRASES_BOTONES = {
  'citas:servicios': '¿Qué servicios tienen y cuánto cuestan?',
  'citas:agendar':   'Quiero agendar una hora',
  'citas:mis':       '¿Tengo alguna hora agendada?',
  'citas:cancelar':  'Quiero cancelar mi hora',
};

const BOTON_MENU = { text: '🏠 Menú', callback_data: 'menu' };

/**
 * Botones contextuales para acompañar una respuesta del agente. Heurística
 * sobre el texto (sin llamar al modelo): tras agendar → ver mis citas; tras
 * listar servicios con precios → agendar. Siempre incluye Menú.
 * @param {string} texto - Respuesta del agente
 * @returns {{inline_keyboard: Array}} reply_markup para Telegram
 */
function botonesParaRespuesta(texto) {
  const t = String(texto || '');
  const fila = [];
  const esAgendada = /qued(ó|o) agendada|✅/i.test(t);
  const esListaConPrecios = /\$\s?\d/.test(t) && /(^|\n)\s*[-•]/m.test(t);
  if (esAgendada) {
    fila.push({ text: '🔎 Mis citas', callback_data: 'citas:mis' });
  } else if (esListaConPrecios) {
    fila.push({ text: '📅 Agendar una hora', callback_data: 'citas:agendar' });
  }
  fila.push(BOTON_MENU);
  return { inline_keyboard: [fila] };
}

module.exports = { TECLADO_INICIO, FRASES_BOTONES, BOTON_MENU, botonesParaRespuesta };
