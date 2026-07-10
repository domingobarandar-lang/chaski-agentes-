// Cliente de Google AI Studio (Gemini) — https://aistudio.google.com
//
// Expone la MISMA interfaz que el SDK de Anthropic que usaba el agente
// (`cliente.messages.create({ model, max_tokens, system, tools, messages })`
// con bloques tool_use / tool_result y respuesta { stop_reason, content }),
// traduciendo ida y vuelta al formato generateContent() de Gemini. Así el loop
// de core.js, los tests y los mocks no cambian de formato.

const { GoogleGenerativeAI } = require('@google/generative-ai');

function crearClienteGemini() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('[LLM] Falta GEMINI_API_KEY en .env (o corre en modo mock)');
  }
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  const create = async ({ model, max_tokens, system, tools, messages }) => {
    const generativeModel = genAI.getGenerativeModel({ model });
    const respuesta = await generativeModel.generateContent({
      systemInstruction: system || undefined,
      tools: traducirTools(tools),
      generationConfig: { maxOutputTokens: max_tokens },
      contents: traducirMensajes(messages),
    });
    return traducirRespuesta(respuesta.response);
  };

  // `beta.messages` se mantiene por compatibilidad con los mocks existentes
  return { messages: { create }, beta: { messages: { create } } };
}

// ─── Anthropic → Gemini ───────────────────────────────────────────────────────

function traducirTools(tools) {
  if (!tools?.length) return undefined;
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    })),
  }];
}

function traducirMensajes(messages) {
  // id de tool_use → nombre de la herramienta: Anthropic solo guarda el id en
  // el tool_result, pero el functionResponse de Gemini exige el nombre.
  const nombrePorId = new Map();
  const contents = [];

  for (const mensaje of messages) {
    if (typeof mensaje.content === 'string') {
      contents.push({ role: mensaje.role === 'assistant' ? 'model' : 'user', parts: [{ text: mensaje.content }] });
      continue;
    }

    if (mensaje.role === 'assistant') {
      const parts = [];
      for (const bloque of mensaje.content) {
        if (bloque.type === 'text' && bloque.text) {
          parts.push({ text: bloque.text });
        } else if (bloque.type === 'tool_use') {
          nombrePorId.set(bloque.id, bloque.name);
          parts.push({ functionCall: { name: bloque.name, args: bloque.input ?? {} } });
        }
      }
      if (parts.length) contents.push({ role: 'model', parts });
      continue;
    }

    // user con bloques: cada tool_result se vuelve un functionResponse
    const parts = [];
    for (const bloque of mensaje.content) {
      if (bloque.type === 'tool_result') {
        let resultado;
        try { resultado = JSON.parse(bloque.content); }
        catch { resultado = bloque.content; }
        parts.push({
          functionResponse: {
            name: nombrePorId.get(bloque.tool_use_id) || 'desconocida',
            // Gemini exige un objeto (Struct): se envuelve por si el resultado
            // original era un array, string o número.
            response: { resultado },
          },
        });
      } else if (bloque.type === 'text') {
        parts.push({ text: bloque.text });
      }
    }
    if (parts.length) contents.push({ role: 'user', parts });
  }

  return contents;
}

// ─── Gemini → Anthropic ───────────────────────────────────────────────────────

// Razones de corte que en Anthropic equivalen a un rechazo de seguridad.
const RAZONES_BLOQUEO = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);

function traducirRespuesta(respuesta) {
  const candidato = respuesta?.candidates?.[0];
  const partes = candidato?.content?.parts ?? [];

  const content = [];
  let contadorId = 0;
  for (const parte of partes) {
    if (parte.text) {
      content.push({ type: 'text', text: parte.text });
    } else if (parte.functionCall) {
      content.push({
        type: 'tool_use',
        id: `fc_${Date.now()}_${contadorId++}`,
        name: parte.functionCall.name,
        input: parte.functionCall.args ?? {},
      });
    }
  }

  const huboFunctionCall = content.some((b) => b.type === 'tool_use');
  const bloqueado = RAZONES_BLOQUEO.has(candidato?.finishReason) || Boolean(respuesta?.promptFeedback?.blockReason);
  const stop_reason = huboFunctionCall ? 'tool_use' : bloqueado ? 'refusal' : 'end_turn';

  return { stop_reason, content };
}

module.exports = { crearClienteGemini };
