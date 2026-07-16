// Punto de entrada único para deploy en Railway (Opción A: un solo servicio
// corriendo los dos bots de Telegram en el mismo proceso).
//
// Cada bot arranca en modo real o mock según su propia variable de token
// (TELEGRAM_TOKEN_CITAS / TELEGRAM_TOKEN_RETAIL) — ver agente-*/telegram/bot.js.

// Señal para los bots: en el deploy unificado, un token faltante en
// producción apaga SOLO ese bot (con alerta en logs) en vez de abortar el
// proceso completo — abortar mataría también al bot que sí tiene token.
process.env.CHASKI_DEPLOY_UNIFICADO = 'true';

require('./agente-citas/telegram/bot.js');
require('./agente-retail/telegram/bot.js');
