// Agente de retail — servidor Express con webhook de WhatsApp Cloud API.
// Misma estructura que el contestador de Gesta, versión demo/genérica.

require('dotenv').config();
const express = require('express');

const webhookRouter = require('./whatsapp/webhook');
const { usandoMemoria, reportarSalud } = require('./database/supabase');

const app = express();

// Captura el rawBody antes del parseo JSON: necesario para validar la firma
// x-hub-signature-256 de Meta en whatsapp/webhook.js.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// Ruta de salud para el hosting / uptime checks
app.get('/', (_req, res) => {
  res.json({ status: 'ok', servicio: 'Agente de retail (demo)', db: usandoMemoria ? 'memoria' : 'supabase' });
});

app.use('/webhook', webhookRouter);

const PORT = process.env.PORT || 3400;
app.listen(PORT, () => {
  console.log(`[Servidor] Agente de retail escuchando en puerto ${PORT}`);
  // Salud de la base al arrancar: estado tabla por tabla, auto-siembra del
  // catálogo si está vacío, e instrucciones exactas si falta el schema.
  reportarSalud().catch((e) => console.warn('[DB] Chequeo de salud falló:', e.message));
  if (!process.env.WHATSAPP_TOKEN) {
    console.warn('[WhatsApp] WHATSAPP_TOKEN no configurado — modo demo: los mensajes salientes se imprimen por consola');
    console.warn('[WhatsApp] Para probar sin Meta: npm run chat');
  }
});
