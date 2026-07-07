// Cliente de OpenRouter (https://openrouter.ai) — API compatible con OpenAI.
//
// Expone la MISMA interfaz que el SDK de Anthropic que usaba el agente
// (`cliente.messages.create({ model, max_tokens, system, tools, messages })`
// con bloques tool_use / tool_result y respuesta { stop_reason, content }),
// traduciendo ida y vuelta al formato chat.completions de OpenAI. Así el loop
// de core.js, los tests y los mocks no cambian de formato.

const OpenAI = require('openai');

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function crearClienteOpenRouter() {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('[LLM] Falta OPENROUTER_API_KEY en .env (o corre en modo mock)');
  }
  const openai = new OpenAI({
    baseURL: OPENROUTER_BASE_URL,
    apiKey: process.env.OPENROUTER_API_KEY,
    timeout: 60_000,
    maxRetries: 0, // los reintentos los maneja core.js
    defaultHeaders: {
      'HTTP-Referer': 'https://chaski.cl',
      'X-Title': 'Chaski',
    },
  });

  const create = async (params) =>
    traducirRespuesta(await openai.chat.completions.create(traducirPeticion(params)));

  // `beta.messages` se mantiene por compatibilidad con los mocks existentes
  return { messages: { create }, beta: { messages: { create } } };
}

// ─── Anthropic → OpenAI ───────────────────────────────────────────────────────

function traducirPeticion({ model, max_tokens, system, tools, messages }) {
  const salida = [];
  if (system) salida.push({ role: 'system', content: system });

  for (const mensaje of messages) {
    if (typeof mensaje.content === 'string') {
      salida.push({ role: mensaje.role, content: mensaje.content });
      continue;
    }
    if (mensaje.role === 'assistant') {
      const texto = mensaje.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const toolCalls = mensaje.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      const msg = { role: 'assistant', content: texto || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      salida.push(msg);
      continue;
    }
    // user con bloques: cada tool_result se vuelve un mensaje role "tool"
    for (const bloque of mensaje.content) {
      if (bloque.type === 'tool_result') {
        salida.push({
          role: 'tool',
          tool_call_id: bloque.tool_use_id,
          content: typeof bloque.content === 'string' ? bloque.content : JSON.stringify(bloque.content),
        });
      } else if (bloque.type === 'text') {
        salida.push({ role: 'user', content: bloque.text });
      }
    }
  }

  const peticion = { model, max_tokens, messages: salida };
  if (tools?.length) {
    peticion.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  return peticion;
}

// ─── OpenAI → Anthropic ───────────────────────────────────────────────────────

function traducirRespuesta(respuesta) {
  const eleccion = respuesta?.choices?.[0];
  const msg = eleccion?.message ?? {};

  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); }
    catch { /* argumentos malformados: la tool recibirá {} y lo reportará */ }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
  }

  const stop_reason =
    eleccion?.finish_reason === 'tool_calls' ? 'tool_use'
    : eleccion?.finish_reason === 'content_filter' ? 'refusal'
    : 'end_turn';

  return { stop_reason, content };
}

module.exports = { crearClienteOpenRouter };
