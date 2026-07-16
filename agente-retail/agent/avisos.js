// Aviso al dueño del negocio por Telegram cuando pasa algo que le importa
// (pedido nuevo, cancelación, pendiente anotado). Fire-and-forget: nunca
// lanza ni bloquea la respuesta al cliente.
//
// Config: TELEGRAM_CHAT_DUENO (chat id del dueño — se obtiene escribiéndole a
// @userinfobot en Telegram) + el token del bot (TELEGRAM_TOKEN_RETAIL). Si
// falta cualquiera de los dos, el aviso queda solo en los logs y la demo
// funciona exactamente igual.

const axios = require('axios');

async function avisarDueno(texto) {
  console.log(`[Aviso dueño] ${texto}`);
  const token  = process.env.TELEGRAM_TOKEN_RETAIL;
  const chatId = process.env.TELEGRAM_CHAT_DUENO;
  if (!token || !chatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: texto,
    }, { timeout: 8000 });
  } catch (error) {
    console.warn('[Aviso dueño] No se pudo enviar por Telegram:', error.message);
  }
}

module.exports = { avisarDueno };
