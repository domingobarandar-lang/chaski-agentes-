// Cliente de Anthropic (Claude) — https://console.anthropic.com
//
// agent/core.js ya arma sus mensajes en el formato nativo de la API de
// Anthropic Messages (system, tools con input_schema, bloques tool_use /
// tool_result y respuesta { stop_reason, content }), así que este adaptador
// es un wrapper delgado sobre el SDK oficial: no hay traducción de formato
// de por medio.

const Anthropic = require('@anthropic-ai/sdk');

function crearClienteAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('[LLM] Falta ANTHROPIC_API_KEY en .env (o corre en modo mock)');
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const create = (params) => client.messages.create(params);

  // `beta.messages` se mantiene por compatibilidad con los mocks existentes
  // (scripts/test-chat.js, telegram/bot.js --mock, core.js._setClienteParaTests)
  return { messages: { create }, beta: { messages: { create } } };
}

module.exports = { crearClienteAnthropic };
