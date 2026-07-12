// Polyfill WebSocket para Node < 22 (Railway usa Node 18): debe ejecutarse
// ANTES de cualquier require que cargue supabase-js (realtime-js exige un
// WebSocket global nativo y crashea si no existe).
if (!globalThis.WebSocket) {
  globalThis.WebSocket = require('ws');
}

// Bot de Telegram del agente de retail — puente Telegram ↔ agent/core.js.
//
// Dos modos, según TELEGRAM_TOKEN_RETAIL en .env:
//  - Con token : bot real en modo POLLING (sin webhook — ideal para demo local,
//                no necesita dominio público). Cada chat de Telegram es una
//                conversación independiente del agente (misma memoria que WhatsApp).
//  - Sin token : modo MOCK. No toca Telegram NI la API de Anthropic (inyecta el
//                mismo doble de pruebas del SDK que usa la suite de tests) y
//                simula 3 conversaciones de demostración por consola.
//
// Forzar el mock aunque haya token: `npm run telegram:mock`
// (equivale a `node telegram/bot.js --mock`, también acepta MOCK=true).
//
// Formato: el agente ya responde con *negrita* de un asterisco (estilo
// WhatsApp), que es el mismo Markdown "legacy" de Telegram — compatible tal cual.

require('dotenv').config();

const MODO_MOCK =
  process.env.MOCK === 'true' ||
  process.argv.includes('--mock') ||
  !process.env.TELEGRAM_TOKEN_RETAIL;

const MAX_CHARS_TELEGRAM = 4096;

const SALUDO =
  '¡Hola! Soy el asistente de *Frutos Secos La Cosecha* 😊 Puedo mostrarte *productos y precios*, revisar *stock*, y tomar, consultar o cancelar tu *pedido*. ¿Qué necesitas?';

const AYUDA =
  'Comandos disponibles:\n' +
  '/start — Ver el mensaje de bienvenida\n' +
  '/help — Ver esta ayuda\n\n' +
  'También puedes escribirme directamente, por ejemplo:\n' +
  '- "¿Qué frutos secos tienen?"\n' +
  '- "¿Tienen almendras? ¿A cuánto el kilo?"\n' +
  '- "Quiero 2 kilos de almendras, soy Pedro"\n' +
  '- "¿Cómo va mi pedido?"';

const SOLO_TEXTO = 'Solo puedo responder mensajes de texto 😊';

// ─── Envío con límite de largo y fallback de formato ─────────────────────────

function dividirMensaje(texto) {
  if (!texto) return [''];
  if (texto.length <= MAX_CHARS_TELEGRAM) return [texto];
  const partes = [];
  let resto = texto;
  while (resto.length > MAX_CHARS_TELEGRAM) {
    let corte = resto.lastIndexOf('\n', MAX_CHARS_TELEGRAM);
    if (corte < MAX_CHARS_TELEGRAM * 0.5) corte = MAX_CHARS_TELEGRAM;
    partes.push(resto.slice(0, corte));
    resto = resto.slice(corte);
  }
  partes.push(resto);
  return partes;
}

// Telegram rechaza el mensaje completo si el Markdown viene mal balanceado
// (ej: un solo "*"). Si el parseo falla, se reenvía como texto plano.
async function enviarTelegram(bot, chatId, texto) {
  for (const parte of dividirMensaje(texto)) {
    try {
      await bot.sendMessage(chatId, parte, { parse_mode: 'Markdown' });
    } catch {
      await bot.sendMessage(chatId, parte);
    }
  }
}

// Identidad de la conversación: en WhatsApp es el teléfono; aquí el chat de
// Telegram, con prefijo para no chocar con números reales en la misma DB.
const idConversacion = (chatId) => `tg${chatId}`;

// ─── Modo real: polling contra la API de Telegram ────────────────────────────

function arrancarBotReal() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[Telegram] Falta ANTHROPIC_API_KEY en .env — el agente no puede responder.');
    console.error('[Telegram] Para probar sin API keys: npm run telegram:mock');
    process.exit(1);
  }

  const { TelegramBot } = require('node-telegram-bot-api');
  const { processMessage, MENSAJE_ERROR } = require('../agent/core');
  const { usandoMemoria } = require('../database/supabase');

  const bot = new TelegramBot(process.env.TELEGRAM_TOKEN_RETAIL, { polling: true });

  bot.on('polling_error', (error) => {
    console.error('[Telegram] Error de polling:', error.message);
  });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const texto = (msg.text || '').trim();

    if (!texto) {
      await bot.sendMessage(chatId, SOLO_TEXTO);
      return;
    }
    if (texto === '/start') {
      await enviarTelegram(bot, chatId, SALUDO);
      return;
    }
    if (texto === '/help') {
      await enviarTelegram(bot, chatId, AYUDA);
      return;
    }

    console.log(`[Telegram ← ${chatId}] ${texto}`);
    try {
      await bot.sendChatAction(chatId, 'typing').catch(() => {});
      const respuesta = await processMessage(idConversacion(chatId), texto);
      await enviarTelegram(bot, chatId, respuesta);
      console.log(`[Telegram → ${chatId}] ${respuesta}`);
    } catch (error) {
      console.error('[Telegram] Error procesando mensaje:', error.message);
      await bot.sendMessage(chatId, MENSAJE_ERROR).catch(() => {});
    }
  });

  console.log('─'.repeat(60));
  console.log('[Telegram] Bot de retail escuchando (polling)…');
  console.log(`[Telegram] DB: ${usandoMemoria ? 'en memoria (demo)' : 'Supabase'}`);
  console.log('[Telegram] Escríbele a tu bot en Telegram para probar. Ctrl+C para salir.');
  console.log('─'.repeat(60));
}

// ─── Modo mock: sin Telegram y SIN API de Anthropic ───────────────────────────
// Inyecta un doble de pruebas del SDK vía core._setClienteParaTests (el mismo
// mecanismo de scripts/test-chat.js): ninguna llamada sale a la red.

function arrancarModoMock() {
  // El mock corre siempre contra la base EN MEMORIA (no ensuciar Supabase real)
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_KEY;

  const mockState = { pasos: [], log: [], contadorId: 0 };

  const lastResult = (nombre) => {
    for (let i = mockState.log.length - 1; i >= 0; i--) {
      const e = mockState.log[i];
      if (e.name === nombre && e.result != null) return e.result;
    }
    return null;
  };

  async function crearRespuestaMock(params) {
    // Registrar los tool_result que el loop del agente devuelve al "modelo"
    const ultimo = params.messages[params.messages.length - 1];
    if (Array.isArray(ultimo?.content)) {
      for (const bloque of ultimo.content) {
        if (bloque.type !== 'tool_result') continue;
        const pendiente = mockState.log.find((e) => e.id === bloque.tool_use_id);
        if (pendiente) {
          try { pendiente.result = JSON.parse(bloque.content); }
          catch { pendiente.result = bloque.content; }
        }
      }
    }

    const paso = mockState.pasos.shift();
    if (!paso) return { stop_reason: 'end_turn', content: [{ type: 'text', text: '¿Te ayudo con algo más? 😊' }] };

    if (paso.tools) {
      return {
        stop_reason: 'tool_use',
        content: paso.tools.map((t) => {
          const id = `tu_mock_${++mockState.contadorId}`;
          const input = typeof t.input === 'function' ? t.input() : (t.input || {});
          mockState.log.push({ id, name: t.name, input, result: null });
          return { type: 'tool_use', id, name: t.name, input };
        }),
      };
    }
    const texto = typeof paso.text === 'function' ? paso.text(lastResult) : paso.text;
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: texto }] };
  }

  const clienteMock = {
    messages: { create: crearRespuestaMock },
    beta: { messages: { create: crearRespuestaMock } },
  };

  const core = require('../agent/core');
  core._setClienteParaTests(clienteMock);
  const { processMessage } = core;

  // ── Conversaciones de demostración ──────────────────────────────────────────

  const clp = (n) => `$${Number(n).toLocaleString('es-CL')}`;

  const CONVERSACIONES = [
    {
      nombre: 'Ver los frutos secos a granel',
      chatId: 222001,
      turnos: [{
        user: 'Hola! ¿Qué frutos secos tienen?',
        modelo: [
          { tools: [{ name: 'buscar_productos', input: { categoria: 'frutos secos' } }] },
          { text: (last) => {
              const r = last('buscar_productos');
              if (!r?.productos?.length) return 'Por ahora no tengo productos en esa categoría 😅';
              return '¡Hola! 😊 A granel tenemos:\n' +
                r.productos.map((p) => `• *${p.nombre}* — ${clp(p.precio)} (stock: ${p.stock})`).join('\n') +
                '\n\n¿Te preparo un pedido?';
            } },
        ],
      }],
      verificar: (respuestas) => /almendras/i.test(respuestas[0]) && /nueces/i.test(respuestas[0]),
    },
    {
      nombre: 'Consultar precio y crear pedido',
      chatId: 222002,
      turnos: [
        {
          user: '¿Tienen almendras? ¿A cuánto el kilo?',
          modelo: [
            { tools: [{ name: 'consultar_stock', input: { producto: 'almendras' } }] },
            { text: (last) => {
                const r = last('consultar_stock');
                if (!r?.encontrado) return 'No encontré ese producto 😅';
                const p = r.producto;
                return `Sí 😊 *${p.nombre}* a ${clp(p.precio)}, quedan ${p.stock} kg disponibles. ¿Te anoto un pedido?`;
              } },
          ],
        },
        {
          user: 'Ya, dame 2 kilos de almendras y 1 mix de frutos secos. Soy Pedro',
          modelo: [
            { tools: [{ name: 'crear_pedido', input: {
                nombre_cliente: 'Pedro',
                items: [
                  { producto: 'Almendras', cantidad: 2 },
                  { producto: 'Mix frutos secos', cantidad: 1 },
                ],
              } }] },
            { text: (last) => {
                const r = last('crear_pedido');
                if (!r?.creado) return `No pude crear el pedido: ${(r?.problemas || [r?.motivo || 'error']).join(' ')} 😔`;
                const detalle = r.pedido.items.map((i) => `${i.cantidad} × ${i.producto}`).join(', ');
                return `¡Listo, Pedro! Pedido *#${r.pedido.id}* creado: ${detalle}. Total: *${clp(r.pedido.total)}* ✅`;
              } },
          ],
        },
      ],
      verificar: (respuestas) => /#\d+/.test(respuestas[1]) && /listo|creado|✅/i.test(respuestas[1]),
    },
    {
      nombre: 'Consultar estado del pedido (memoria: mismo chat que la conversación 2)',
      chatId: 222002,
      turnos: [{
        user: '¿Cómo va mi pedido?',
        modelo: [
          { tools: [{ name: 'consultar_pedido', input: {} }] },
          { text: (last) => {
              const r = last('consultar_pedido');
              if (!r?.encontrado) return 'No encuentro pedidos a tu nombre 😅 ¿Quieres hacer uno?';
              const p = r.pedido;
              const detalle = (p.items || []).map((i) => `${i.cantidad} × ${i.producto}`).join(', ');
              return `Tu pedido *#${p.id}* (${detalle}) está en estado *${p.estado}*. Total: ${clp(p.total)} 😊`;
            } },
        ],
      }],
      verificar: (respuestas) => /recibido/i.test(respuestas[0]),
    },
  ];

  return correrDemoMock(CONVERSACIONES, mockState, processMessage);
}

async function correrDemoMock(conversaciones, mockState, processMessage) {
  console.log('═'.repeat(64));
  console.log('Telegram — MODO MOCK (sin Telegram real, sin API de Anthropic)');
  console.log('Simulando conversaciones de demostración…');
  console.log('═'.repeat(64));

  let fallas = 0;
  for (const [i, conv] of conversaciones.entries()) {
    console.log(`\n[${i + 1}/${conversaciones.length}] ${conv.nombre}  (chat ${conv.chatId})`);
    const respuestas = [];
    try {
      for (const turno of conv.turnos) {
        mockState.pasos = [...(turno.modelo || [])];
        console.log(`  👤 ${turno.user}`);
        const respuesta = await processMessage(idConversacion(conv.chatId), turno.user);
        respuestas.push(respuesta);
        console.log(`  🤖 ${respuesta.replace(/\n/g, '\n     ')}`);
      }
      const ok = conv.verificar ? conv.verificar(respuestas) : respuestas.every(Boolean);
      console.log(ok ? '  ✅ Flujo OK' : '  ❌ FALLA: la respuesta no cumple lo esperado');
      if (!ok) fallas++;
    } catch (error) {
      console.log(`  ❌ FALLA: excepción — ${error.message}`);
      fallas++;
    }
  }

  console.log('\n' + '═'.repeat(64));
  console.log(fallas === 0
    ? `RESUMEN: ${conversaciones.length}/${conversaciones.length} conversaciones OK — el puente Telegram ↔ agente funciona.`
    : `RESUMEN: ${conversaciones.length - fallas}/${conversaciones.length} conversaciones OK (${fallas} con fallas).`);
  console.log('Para conectar Telegram real: pon TELEGRAM_TOKEN_RETAIL en .env y corre `npm run telegram` (ver README).');
  console.log('═'.repeat(64));
  process.exitCode = fallas ? 1 : 0;
}

if (MODO_MOCK) {
  arrancarModoMock().catch((e) => { console.error('Error fatal en modo mock:', e); process.exitCode = 1; });
} else {
  arrancarBotReal();
}
