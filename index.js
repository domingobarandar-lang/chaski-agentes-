// Punto de entrada único para deploy en Railway (Opción A: un solo servicio
// corriendo los dos bots de Telegram en el mismo proceso).
//
// Cada bot arranca en modo real o mock según su propia variable de token
// (TELEGRAM_TOKEN_CITAS / TELEGRAM_TOKEN_RETAIL) — ver agente-*/telegram/bot.js.
require('./agente-citas/telegram/bot.js');
require('./agente-retail/telegram/bot.js');
