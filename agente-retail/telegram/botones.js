// Botones inline de Telegram del agente de retail.
// Módulo PURO (sin Telegram ni red) para poder verificarlo en los tests:
// - TECLADO_INICIO: accesos rápidos del saludo (/start y botón Menú).
// - FRASES_BOTONES: cada botón se traduce a la frase natural equivalente y
//   entra por processMessage — el mismo loop del agente, sin lógica duplicada.
// - botonesParaRespuesta: botones contextuales según lo que respondió el bot.

const TECLADO_INICIO = {
  inline_keyboard: [
    [{ text: '🥜 Ver catálogo', callback_data: 'retail:catalogo' }],
    [{ text: '🛒 Hacer un pedido', callback_data: 'retail:pedido' }],
    [
      { text: '🔎 Precio y stock', callback_data: 'retail:stock' },
      { text: '🚚 Estado de mi pedido', callback_data: 'retail:estado' },
    ],
  ],
};

const FRASES_BOTONES = {
  'retail:catalogo': '¿Qué productos tienen y a qué precio?',
  'retail:pedido':   'Quiero hacer un pedido',
  'retail:stock':    'Quiero consultar el precio y stock de un producto',
  'retail:estado':   '¿Cómo va mi pedido?',
};

const BOTON_MENU = { text: '🏠 Menú', callback_data: 'menu' };

/**
 * Botones contextuales para acompañar una respuesta del agente. Heurística
 * sobre el texto (sin llamar al modelo): tras crear un pedido → estado; tras
 * listar productos con precios → hacer pedido. Siempre incluye Menú.
 * @param {string} texto - Respuesta del agente
 * @returns {{inline_keyboard: Array}} reply_markup para Telegram
 */
function botonesParaRespuesta(texto) {
  const t = String(texto || '');
  const fila = [];
  const esPedidoCreado = /pedido.*(registrado|creado|qued(ó|o))|✅/i.test(t);
  const esListaConPrecios = /\$\s?\d/.test(t) && /(^|\n)\s*[-•]/m.test(t);
  if (esPedidoCreado) {
    fila.push({ text: '🚚 Estado de mi pedido', callback_data: 'retail:estado' });
  } else if (esListaConPrecios) {
    fila.push({ text: '🛒 Hacer un pedido', callback_data: 'retail:pedido' });
  }
  fila.push(BOTON_MENU);
  return { inline_keyboard: [fila] };
}

module.exports = { TECLADO_INICIO, FRASES_BOTONES, BOTON_MENU, botonesParaRespuesta };
