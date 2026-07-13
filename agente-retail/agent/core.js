// Loop principal del agente conversacional con tool use.
// Modelo: Claude (claude-haiku-4-5-20251001 por defecto) vía la API de
// Anthropic, usando el cliente de agent/llm.js — el formato interno ya es
// el nativo de Anthropic Messages (tool_use / tool_result).

const { crearClienteAnthropic } = require('./llm');
const { buildSystemPrompt } = require('./prompts');
const { TOOL_DEFINITIONS, ejecutarHerramienta } = require('./tools');
const { cargarSesion, persistirInteraccion } = require('./memory');

// Cliente perezoso: sin ANTHROPIC_API_KEY el constructor lanza error, y este
// módulo también se carga desde los simuladores locales (chat / tests /
// telegram mock) que inyectan un cliente doble de pruebas.
let cliente = null;
let clienteOverride = null; // inyectado por tests y modo mock

function _setClienteParaTests(c) { clienteOverride = c; }

function obtenerCliente() {
  if (clienteOverride) return clienteOverride;
  if (!cliente) cliente = crearClienteAnthropic();
  return cliente;
}

// Configurable por entorno: si hay que cambiar de modelo, se cambia la
// variable sin tocar código. Nombres de modelo según la API de Anthropic.
const MODELO          = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const MAX_TOKENS      = 600;  // respuestas cortas: es WhatsApp
const MAX_RONDAS_TOOL = 6;    // límite de rondas de tool use (evita bucles)

const REINTENTOS_API       = 2;
const ESPERAS_REINTENTO_MS = [2000, 4000];

// Neutro a propósito: NO debe afirmar ninguna acción ("queda anotado" era
// mentira cuando el modelo venía de solo consultar algo).
const FALLBACK_VACIO = 'Perfecto 👍 ¿En qué más te ayudo?';
const MENSAJE_ERROR  =
  'Estoy teniendo problemas técnicos momentáneos. Escríbeme de nuevo en unos segundos, por favor. 🔄';

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Llama al modelo con reintentos ante errores transitorios (red, 429, 5xx).
 */
async function crearMensajeClaude(params) {
  const c = obtenerCliente();
  for (let intento = 0; intento <= REINTENTOS_API; intento++) {
    try {
      return await c.messages.create(params);
    } catch (error) {
      const status = error?.status;
      const esTransitorio = !status || status >= 500 || status === 429 ||
        /econnreset|etimedout|socket hang up|terminated|network|aborted|premature/i
          .test(error?.message || '');
      if (!esTransitorio || intento === REINTENTOS_API) throw error;
      const espera = ESPERAS_REINTENTO_MS[intento] ?? 4000;
      console.warn(`[Core] Error de API (intento ${intento + 1}): ${error.message} — reintento en ${espera}ms`);
      await esperar(espera);
    }
  }
}

// Cola serial por teléfono: si un cliente manda dos mensajes seguidos, se
// procesan en orden (dos en paralelo se pisarían el historial). Clientes
// distintos sí corren en paralelo.
const colasPorTelefono = new Map();

/**
 * Punto de entrada público: encola el mensaje en la cola de su teléfono.
 * @param {string} telefono - E.164 sin "+" (o id de chat de Telegram con prefijo tg)
 * @param {string} mensaje
 * @returns {Promise<string>} Respuesta para enviar al cliente
 */
function processMessage(telefono, mensaje) {
  const anterior = colasPorTelefono.get(telefono) ?? Promise.resolve();
  const actual = anterior
    .catch(() => {})
    .then(() => procesarMensajeInterno(telefono, mensaje));
  colasPorTelefono.set(telefono, actual);
  const limpiar = () => {
    if (colasPorTelefono.get(telefono) === actual) colasPorTelefono.delete(telefono);
  };
  actual.then(limpiar, limpiar);
  return actual;
}

// Guarda anti-alucinación: el modelo a veces responde "tu pedido quedó
// registrado" / "cambio hecho" SIN haber llamado ninguna herramienta (pedido
// fantasma — llegó a inventar un cambio con el precio del producto anterior).
// Si la respuesta afirma una acción y en el turno no se ejecutó ninguna
// herramienta, se le devuelve un recordatorio para que la llame de verdad o
// rectifique. Puede dar un falso positivo con frases como "aún NO está
// registrado" — inofensivo: el modelo simplemente repite su respuesta.
// Solo formas de acción COMPLETADA ("registré", "quedó registrado",
// "cancelé", "confirmado", "cambio hecho") — NO infinitivos de oferta
// ("puedes cancelar cuando quieras"), que aparecen en turnos legítimos sin
// herramientas. Un falso positivo residual solo cuesta una pasada extra.
const PATRON_ACCION = /\b(registr|cancel|actualiz|anot|confirm|cambi)(é|amos|ad[oa]s?)\b|\bcambio (hecho|listo)\b/i;

const RECORDATORIO_VERIFICACION =
  '[Verificación automática del sistema — el cliente NO ve este mensaje] En este turno NO ejecutaste ninguna herramienta, pero tu respuesta afirma una acción (registrar/cancelar/cambiar/anotar un pedido). Si estás confirmando una acción NUEVA de este turno, DEBES llamar la herramienta correspondiente AHORA (para un CAMBIO: cancelar_pedido y luego crear_pedido; recuerda que crear_pedido detecta duplicados y responde duplicado:true sin duplicar). Si tu respuesta solo recuerda algo que ya quedó hecho en un turno anterior, o explica que algo NO está hecho, repítela tal cual.';

/**
 * Una pasada modelo→tools→modelo. Muta `mensajes` (agrega los turnos de tool
 * use) y devuelve la respuesta final de la pasada + cuántas herramientas corrió.
 */
async function correrTurno(paramsBase, mensajes, telefono) {
  let respuesta = await crearMensajeClaude({ ...paramsBase, messages: mensajes });
  let rondas = 0;
  let herramientas = 0;

  while (respuesta.stop_reason === 'tool_use' && rondas < MAX_RONDAS_TOOL) {
    // El contenido del assistant se pasa de vuelta TAL CUAL
    mensajes.push({ role: 'assistant', content: respuesta.content });

    const resultados = [];
    for (const bloque of respuesta.content) {
      if (bloque.type !== 'tool_use') continue;
      herramientas++;
      let resultado;
      let falloTecnico = false;
      try {
        console.log(`[Tools] ${telefono} → ${bloque.name}(${JSON.stringify(bloque.input)})`);
        resultado = await ejecutarHerramienta(bloque.name, bloque.input, telefono);
      } catch (error) {
        console.error(`[Tools] ${bloque.name} falló:`, error.message);
        falloTecnico = true;
        // Tipado para que el prompt lo distinga de un resultado vacío: una
        // falla técnica NUNCA debe convertirse en "no tenemos eso".
        resultado = {
          error_tecnico: true,
          detalle: error.message,
          instruccion: 'La consulta falló por un problema técnico momentáneo — NO significa que no haya datos. Dile al cliente que tuviste un problema técnico, no afirmes que un producto no existe o no hay stock, no confirmes pedidos que no se crearon, y ofrece reintentar o dejarlo anotado con anotar_pendiente.',
        };
      }
      resultados.push({
        type: 'tool_result',
        tool_use_id: bloque.id,
        content: JSON.stringify(resultado),
        ...(falloTecnico ? { is_error: true } : {}),
      });
    }
    // Todos los tool_result van en UN solo mensaje user
    mensajes.push({ role: 'user', content: resultados });

    respuesta = await crearMensajeClaude({ ...paramsBase, messages: mensajes });
    rondas++;
  }
  return { respuesta, herramientas };
}

const extraerTexto = (respuesta) => respuesta.content
  .filter((b) => b.type === 'text')
  .map((b) => b.text)
  .join('\n')
  .trim();

// WhatsApp/Telegram usan UN asterisco para negrita; el modelo a veces cae en
// Markdown (**negrita**) pese al prompt y el cliente vería los ** literales.
const normalizarFormato = (t) => t.replace(/\*\*(.+?)\*\*/g, '*$1*');

/**
 * Loop agéntico completo: historial → Claude → tools → Claude → respuesta.
 */
async function procesarMensajeInterno(telefono, mensaje) {
  const { historial, perfil } = await cargarSesion(telefono);
  const mensajes  = [...historial, { role: 'user', content: mensaje }];

  const paramsBase = {
    model: MODELO,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt(perfil),
    tools: TOOL_DEFINITIONS,
  };

  let { respuesta, herramientas } = await correrTurno(paramsBase, mensajes, telefono);

  // Rechazo de seguridad / filtro de contenido: content puede venir vacío y
  // leerlo directo rompería.
  if (respuesta.stop_reason === 'refusal') {
    return 'Sobre eso no te puedo ayudar. Puedo mostrarte productos, revisar stock o tomar tu pedido. 😊';
  }

  let texto = extraerTexto(respuesta);

  if (!herramientas && PATRON_ACCION.test(texto)) {
    console.warn('[Core] Respuesta afirma una acción sin herramientas ejecutadas: pasada de verificación');
    mensajes.push({ role: 'assistant', content: respuesta.content });
    mensajes.push({ role: 'user', content: RECORDATORIO_VERIFICACION });
    ({ respuesta } = await correrTurno(paramsBase, mensajes, telefono));
    if (respuesta.stop_reason !== 'refusal') texto = extraerTexto(respuesta);
  }

  texto = normalizarFormato(texto) || FALLBACK_VACIO;

  // El historial persistido guarda solo texto plano (user/assistant); los
  // bloques de tool use viven solo dentro del turno.
  await persistirInteraccion(telefono, historial, mensaje, texto);
  return texto;
}

module.exports = { processMessage, MENSAJE_ERROR, _setClienteParaTests };
