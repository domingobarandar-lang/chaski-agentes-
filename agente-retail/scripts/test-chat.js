// Simulador de conversaciones AUTOMATIZADO — evalúa el agente sin WhatsApp.
//
// Uso: npm test   (o: node scripts/test-chat.js)
// Forzar mock aunque haya API key: MOCK=true npm test
//
// Dos modos, según haya o no ANTHROPIC_API_KEY en el entorno / .env (y MOCK):
//  - Modo API : las conversaciones pasan por Claude de verdad (API de Anthropic).
//  - Modo MOCK: se inyecta un doble de pruebas del cliente que ejecuta los tool
//    calls que el modelo haría en cada escenario. Evalúa la capa de
//    herramientas, el loop de core.js y la memoria — sin llamar a la API.
//
// En ambos modos la base de datos es la EN MEMORIA (no configurar SUPABASE_*
// al correr los tests). Cada escenario parte con la base limpia.

require('dotenv').config();

const path = require('path');

const MODO = (process.env.MOCK === 'true' || !process.env.ANTHROPIC_API_KEY) ? 'mock' : 'api';

if (process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)) {
  console.error('Los tests usan la base EN MEMORIA: quita SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY del entorno antes de correrlos.');
  process.exit(1);
}

// ─── Doble de pruebas del SDK de Anthropic (modo mock) ───────────────────────

// Guion del turno actual: lista de pasos que el "modelo" ejecuta en orden.
// Cada paso es { tools: [{name, input}] } (ronda de tool use) o { texto }.
const estadoMock = { pasos: [] };
let contadorToolUse = 0;

function mockCreate(params) {
  // Última llamada al "modelo": los escenarios de resiliencia inspeccionan
  // system (perfil inyectado) y messages (historial que llegó al modelo).
  estadoMock.ultimoParams = params;
  const paso = estadoMock.pasos.shift();
  if (paso?.tools?.length) {
    return {
      stop_reason: 'tool_use',
      content: paso.tools.map((t) => ({
        type: 'tool_use',
        id: `tu_mock_${++contadorToolUse}`,
        name: t.name,
        input: t.input ?? {},
      })),
    };
  }
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: paso?.texto ?? '[mock] ok' }],
  };
}

// Cliente que se inyecta en core.js vía _setClienteParaTests (modo mock).
// NOTA: MODO se decide arriba por ANTHROPIC_API_KEY; este cliente doble se
// usa solo si MODO === 'mock' (ver cargarAgenteFresco).
const clienteMock = {
  messages: { create: async (p) => mockCreate(p) },
  beta: { messages: { create: async (p) => mockCreate(p) } },
};

// ─── Carga fresca del agente por escenario (resetea la DB en memoria) ────────

const MODULOS_AGENTE = [
  '../agent/core',
  '../agent/tools',
  '../agent/memory',
  '../agent/prompts',
  '../database/supabase',
].map((m) => require.resolve(m));

function cargarAgenteFresco() {
  for (const id of MODULOS_AGENTE) delete require.cache[id];

  // Envolver ejecutarHerramienta ANTES de cargar core (que la desestructura al
  // hacer require) para capturar cada tool call con su resultado.
  const capturas = [];
  const tools = require('../agent/tools');
  const original = tools.ejecutarHerramienta;
  tools.ejecutarHerramienta = async (nombre, input, telefono) => {
    try {
      const resultado = await original(nombre, input, telefono);
      capturas.push({ name: nombre, input, resultado });
      return resultado;
    } catch (error) {
      capturas.push({ name: nombre, input, error: error.message });
      throw error;
    }
  };

  const core = require('../agent/core');
  if (MODO === 'mock') core._setClienteParaTests(clienteMock);
  const { db } = require('../database/supabase');
  return { processMessage: core.processMessage, db, capturas, tools };
}

// ─── Utilidades de aserción ───────────────────────────────────────────────────

function capturaDe(capturas, nombre) {
  return capturas.filter((c) => c.name === nombre).map((c) => c.resultado);
}

function nombresProductos(resultadoBusqueda) {
  return (resultadoBusqueda?.productos ?? []).map((p) => p.nombre);
}

// ─── Escenarios ───────────────────────────────────────────────────────────────
//
// Cada escenario: { nombre, turnos: [{ user, mock, evaluar, soloApi }], alFinal }
//  - mock   : guion del doble de pruebas (ignorado en modo API)
//  - soloApi: el turno solo corre en modo API (ej: responder la confirmación
//             que el modelo real pide antes de crear/cancelar un pedido; el
//             guion mock no la necesita porque fuerza el tool call directo)
//  - evaluar: async ({ respuesta, capturas, db, modo }) => [problemas]
//             `capturas` trae solo los tool calls del turno.
//  - alFinal: async ({ db, telefono, modo }) => [problemas] — invariantes de
//             negocio sobre el estado final (válidos en ambos modos).
//
// IMPORTANTE (modo API): el modelo real decide sus llamadas — puede resolver
// sin herramientas o pedir confirmación en un turno extra. Las aserciones
// sobre UN tool call específico van gateadas con `modo === 'mock'`; lo que se
// exige en ambos modos son los INVARIANTES (no crear pedidos inválidos, no
// corromper stock, no inventar datos).

const ESCENARIOS = [
  {
    nombre: 'Búsqueda multi-palabra: "mix de frutos secos de 500g"',
    turnos: [{
      user: '¿Tienen mix de frutos secos de 500g?',
      mock: [
        { tools: [{ name: 'buscar_productos', input: { consulta: 'mix de frutos secos 500g' } }] },
        { texto: 'Sí, tenemos Mix frutos secos (bolsa 500 g) a $6.990. ¿Te lo anoto? 😊' },
      ],
      evaluar: async ({ capturas }) => {
        const problemas = [];
        const busquedas = capturaDe(capturas, 'buscar_productos');
        const nombres = busquedas.flatMap(nombresProductos);
        if (!nombres.some((n) => /mix frutos secos/i.test(n))) {
          problemas.push(`buscar_productos("mix de frutos secos 500g") NO encontró "Mix frutos secos (bolsa 500 g)". Resultados: ${JSON.stringify(nombres)}`);
        }
        return problemas;
      },
    }],
  },
  {
    nombre: 'Búsqueda con conector y singular: "bolsas de pasas"',
    turnos: [{
      user: '¿Tienen bolsas de pasas?',
      mock: [
        { tools: [{ name: 'buscar_productos', input: { consulta: 'bolsas de pasas' } }] },
        { texto: 'Sí: Pasas rubias (bolsa 500 g) a $3.490. 😊' },
      ],
      evaluar: async ({ capturas }) => {
        const nombres = capturaDe(capturas, 'buscar_productos').flatMap(nombresProductos);
        return nombres.some((n) => /pasas rubias/i.test(n))
          ? []
          : [`buscar_productos("bolsas de pasas") NO encontró "Pasas rubias (bolsa 500 g)". Resultados: ${JSON.stringify(nombres)}`];
      },
    }],
  },
  {
    nombre: 'Producto inexistente: "¿cuánto cuesta el kilo de pistachos?"',
    turnos: [{
      user: '¿Cuánto cuesta el kilo de pistachos?',
      mock: [
        { tools: [{ name: 'consultar_stock', input: { producto: 'pistachos' } }] },
        { texto: 'Pistachos no manejamos por ahora, pero tenemos maní, almendras, nueces y castañas de cajú. ¿Te sirve alguno? 😊' },
      ],
      evaluar: async ({ capturas, respuesta, modo }) => {
        const problemas = [];
        const [stock] = capturaDe(capturas, 'consultar_stock');
        if (stock?.encontrado !== false) problemas.push('consultar_stock("pistachos") debió responder encontrado:false.');
        const tieneAyuda = stock && (stock.categorias_disponibles?.length || stock.sugerencias?.length);
        if (!tieneAyuda) problemas.push('consultar_stock sin resultados no entrega alternativas (categorías/sugerencias) para que el agente ofrezca otra cosa.');
        if (modo === 'api' && /\$\s?\d/.test(respuesta) && /pistacho/i.test(respuesta)) {
          problemas.push(`Posible precio inventado para un producto inexistente: "${respuesta}"`);
        }
        return problemas;
      },
    }],
  },
  {
    nombre: 'Sin stock en catálogo: "¿tienen chocolates?"',
    turnos: [{
      user: '¿Tienen stock de chocolates?',
      mock: [
        { tools: [{ name: 'buscar_productos', input: { consulta: 'chocolates' } }] },
        { texto: 'Por ahora no tenemos chocolates. Manejamos frutos secos, mix y fruta deshidratada. 😊' },
      ],
      evaluar: async ({ capturas }) => {
        const problemas = [];
        const [busqueda] = capturaDe(capturas, 'buscar_productos');
        if (!busqueda || busqueda.resultados !== 0) {
          problemas.push(`buscar_productos("chocolates") debió dar 0 resultados (no hay falsos positivos). Obtuvo: ${JSON.stringify(nombresProductos(busqueda))}`);
        }
        if (busqueda && !busqueda.categorias_disponibles?.length) {
          problemas.push('Búsqueda sin resultados no informa las categorías disponibles.');
        }
        return problemas;
      },
    }],
  },
  {
    nombre: 'Pedido feliz: 2 kg de almendras (consulta → confirmación → creación)',
    turnos: [
      {
        user: 'Hola! Quiero pedir 2 kilos de almendras',
        mock: [
          { tools: [{ name: 'consultar_stock', input: { producto: 'almendras' } }] },
          { texto: 'Tenemos Almendras a $12.990 el kg (hay 15 kg). Serían $25.980. ¿A nombre de quién dejo el pedido? 😊' },
        ],
        evaluar: async ({ capturas }) => {
          const [stock] = capturaDe(capturas, 'consultar_stock');
          return stock?.encontrado && /almendra/i.test(stock.producto?.nombre ?? '')
            ? []
            : [`consultar_stock("almendras") no encontró las almendras: ${JSON.stringify(stock)}`];
        },
      },
      {
        user: 'A nombre de Carla Pérez. Confirmo!',
        mock: [
          { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Carla Pérez', items: [{ producto: 'almendras', cantidad: 2 }] } }] },
          { texto: 'Listo Carla, pedido #1 por 2 kg de almendras, total $25.980. Te avisamos cuando esté listo. 😊' },
        ],
        evaluar: async ({ capturas, db, telefono }) => {
          const problemas = [];
          const [pedido] = capturaDe(capturas, 'crear_pedido');
          if (!pedido?.creado) problemas.push(`crear_pedido falló: ${JSON.stringify(pedido)}`);
          if (pedido?.creado && pedido.pedido.total !== 25980) problemas.push(`Total incorrecto: esperaba 25980, obtuvo ${pedido.pedido.total}`);
          const almendras = await db.productos.buscarUno('Almendras');
          if (almendras && almendras.stock !== 13) problemas.push(`Stock no descontado correctamente: esperaba 13 kg, hay ${almendras.stock}`);
          const guardado = await db.pedidos.ultimoPorTelefono(telefono);
          if (!guardado) problemas.push('El pedido no quedó asociado al teléfono del cliente.');
          return problemas;
        },
      },
    ],
  },
  {
    nombre: 'Cantidad decimal: 1,5 kg de almendras (definición de la herramienta)',
    turnos: [
      {
        user: 'Quiero 1,5 kg de almendras, soy Ana. Confirmo.',
        mock: [
          { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Ana', items: [{ producto: 'Almendras (kg)', cantidad: 1.5 }] } }] },
          { texto: 'Listo Ana: 1,5 kg de almendras, total $19.485. 😊' },
        ],
        evaluar: async ({ capturas, tools, modo }) => {
          const problemas = [];
          // Definición: si el schema dice "integer", Claude redondearía el 1,5 kg.
          const def = tools.TOOL_DEFINITIONS.find((t) => t.name === 'crear_pedido');
          const tipoCantidad = def?.input_schema?.properties?.items?.items?.properties?.cantidad?.type;
          if (tipoCantidad !== 'number') {
            problemas.push(`cantidad en crear_pedido es "${tipoCantidad}": los productos por kg no aceptan decimales (1,5 kg es imposible).`);
          }
          if (modo === 'mock') {
            const [pedido] = capturaDe(capturas, 'crear_pedido');
            if (!pedido?.creado) problemas.push(`Pedido de 1,5 kg rechazado: ${JSON.stringify(pedido)}`);
          }
          return problemas;
        },
      },
      // El modelo real puede mostrar el total y pedir confirmación primero
      { soloApi: true, user: 'Sí, confirmo.', evaluar: async () => [] },
    ],
    alFinal: async ({ db, telefono }) => {
      const problemas = [];
      const pedido = await db.pedidos.ultimoPorTelefono(telefono);
      if (!pedido) problemas.push('El pedido de 1,5 kg nunca se creó (ni tras confirmar).');
      else if (pedido.total !== 19485) problemas.push(`Total incorrecto: esperaba 19485, obtuvo ${pedido.total}`);
      return problemas;
    },
  },
  {
    nombre: 'Decimal en producto por unidad debe rechazarse (2,5 bolsas)',
    turnos: [{
      user: 'Quiero 2,5 bolsas de mix de frutos secos, soy Raúl. Confirmo.',
      mock: [
        { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Raúl', items: [{ producto: 'Mix frutos secos (bolsa 500 g)', cantidad: 2.5 }] } }] },
        { texto: 'Las bolsas se venden por unidad: ¿te anoto 2 o 3? 😊' },
      ],
      evaluar: async ({ capturas, db, telefono, modo }) => {
        const problemas = [];
        const [pedido] = capturaDe(capturas, 'crear_pedido');
        if (modo === 'mock' && pedido?.creado !== false) {
          problemas.push(`Se aceptó cantidad 2,5 de un producto vendido por unidad: ${JSON.stringify(pedido)}`);
        }
        // API: también es válido que el modelo no llame la herramienta y
        // ofrezca 2 o 3 — el invariante es que NO exista un pedido con 2,5.
        if (pedido?.creado) problemas.push(`Se creó un pedido con cantidad decimal por unidad: ${JSON.stringify(pedido)}`);
        if (await db.pedidos.ultimoPorTelefono(telefono)) problemas.push('Quedó un pedido creado pese a la cantidad 2,5 por unidad.');
        return problemas;
      },
    }],
  },
  {
    nombre: 'Stock insuficiente: 50 kg de almendras (hay 15)',
    turnos: [{
      user: 'Necesito 50 kg de almendras para un evento, soy Pedro. Dale no más.',
      mock: [
        { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Pedro', items: [{ producto: 'almendras', cantidad: 50 }] } }] },
        { texto: 'Uy, solo nos quedan 15 kg de almendras. ¿Te sirven? 😊' },
      ],
      evaluar: async ({ capturas, db, telefono, respuesta, modo }) => {
        const problemas = [];
        const [pedido] = capturaDe(capturas, 'crear_pedido');
        if (modo === 'mock' && pedido?.creado !== false) problemas.push(`Pedido sobre stock debió rechazarse: ${JSON.stringify(pedido)}`);
        if (pedido?.creado || await db.pedidos.ultimoPorTelefono(telefono)) problemas.push('Se creó un pedido por sobre el stock disponible.');
        // El cliente debe enterarse de cuánto hay: en mock viene en
        // pedido.problemas; en API basta que la respuesta mencione los 15 kg.
        const informa = modo === 'mock'
          ? /15/.test(JSON.stringify(pedido?.problemas ?? ''))
          : /15/.test(respuesta ?? '');
        if (!informa) problemas.push(`El rechazo no informa el stock disponible (15).`);
        const almendras = await db.productos.buscarUno('Almendras');
        if (almendras && almendras.stock !== 15) problemas.push(`El rechazo alteró el stock: quedó en ${almendras.stock}`);
        return problemas;
      },
    }],
  },
  {
    nombre: 'BUG ítems duplicados: 10 + 10 kg de almendras (hay 15) debe rechazarse',
    turnos: [{
      user: 'Quiero 10 kg de almendras... ah y agrégame otros 10 kg más. Soy Diego, confirmo.',
      mock: [
        { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Diego', items: [
          { producto: 'almendras', cantidad: 10 },
          { producto: 'Almendras (kg)', cantidad: 10 },
        ] } }] },
        { texto: 'Solo tenemos 15 kg de almendras en total. ¿Los dejo así? 😊' },
      ],
      evaluar: async ({ capturas, db, telefono, modo }) => {
        const problemas = [];
        const [pedido] = capturaDe(capturas, 'crear_pedido');
        if (modo === 'mock' && pedido?.creado !== false) {
          problemas.push(`El mismo producto repetido en dos líneas (10+10 con stock 15) NO se validó en conjunto: ${JSON.stringify(pedido)}`);
        }
        if (pedido?.creado || await db.pedidos.ultimoPorTelefono(telefono)) {
          problemas.push('Se creó un pedido de 20 kg con stock 15 (duplicados no validados en conjunto).');
        }
        const almendras = await db.productos.buscarUno('Almendras');
        if (almendras && almendras.stock !== 15) problemas.push(`El stock quedó corrupto tras el intento: ${almendras.stock} (debía seguir en 15)`);
        return problemas;
      },
    }],
  },
  {
    nombre: 'Pedido grande multi-ítem con dirección',
    turnos: [
      {
        user: 'Hola, quiero 10 bolsas de pasas, 5 de higos y 3 mantequillas de maní. Soy Marco, para Av. Italia 1234.',
        mock: [
          { texto: 'Perfecto Marco: 10 pasas ($34.900), 5 higos ($21.450) y 3 mantequillas de maní ($14.970) = $71.320, a Av. Italia 1234. ¿Confirmas? 😊' },
        ],
        evaluar: async () => [],
      },
      {
        user: 'Sí, confirmo',
        mock: [
          { tools: [{ name: 'crear_pedido', input: {
            nombre_cliente: 'Marco',
            direccion: 'Av. Italia 1234',
            items: [
              { producto: 'Pasas rubias (bolsa 500 g)', cantidad: 10 },
              { producto: 'Higos secos (bolsa 250 g)', cantidad: 5 },
              { producto: 'Mantequilla de maní (frasco 500 g)', cantidad: 3 },
            ],
          } }] },
          { texto: 'Pedido #1 confirmado por $71.320 a Av. Italia 1234. 😊' },
        ],
        evaluar: async ({ capturas, db, telefono }) => {
          const problemas = [];
          const [pedido] = capturaDe(capturas, 'crear_pedido');
          if (!pedido?.creado) problemas.push(`Pedido multi-ítem falló: ${JSON.stringify(pedido)}`);
          if (pedido?.creado && pedido.pedido.total !== 71320) problemas.push(`Total esperado 71320, obtuvo ${pedido.pedido.total}`);
          const guardado = await db.pedidos.ultimoPorTelefono(telefono);
          if (guardado && guardado.direccion !== 'Av. Italia 1234') problemas.push(`Dirección no guardada: ${guardado.direccion}`);
          const pasas = await db.productos.buscarUno('Pasas rubias');
          if (pasas && pasas.stock !== 12) problemas.push(`Stock de pasas esperado 12, hay ${pasas.stock}`);
          return problemas;
        },
      },
    ],
  },
  {
    nombre: 'Ambigüedad: consultar stock de "maní" (hay salado, sin sal y mantequilla)',
    turnos: [{
      user: '¿Tienen maní? ¿a cuánto?',
      mock: [
        { tools: [{ name: 'consultar_stock', input: { producto: 'maní' } }] },
        { texto: '¿Maní salado ($4.990 el kg), maní sin sal ($4.790 el kg) o mantequilla de maní ($4.990 el frasco)? 😊' },
      ],
      evaluar: async ({ capturas, respuesta, modo }) => {
        const [stock] = capturaDe(capturas, 'consultar_stock');
        if (stock?.ambiguo === true && (stock.candidatos?.length ?? 0) >= 2) return [];
        if (modo === 'api') {
          // El modelo puede resolverlo sin consultar_stock (ej: buscar_productos
          // o preguntar directo). Lo prohibido: elegir UN producto al azar.
          const problemas = [];
          if (!/\?/.test(respuesta ?? '')) problemas.push(`Ante "maní" (ambiguo) el agente no pidió aclaración: "${respuesta}"`);
          const precios = (respuesta ?? '').match(/\$\s?[\d.]+/g) ?? [];
          if (precios.length === 1) problemas.push(`El agente eligió un producto al azar y dio un solo precio: "${respuesta}"`);
          return problemas;
        }
        return [`consultar_stock("maní") coincide con varios productos pero no avisa la ambigüedad (devuelve uno al azar): ${JSON.stringify(stock)}`];
      },
    }],
  },
  {
    nombre: 'Cambio de pedido: cancelar y volver a pedir',
    turnos: [
      {
        user: 'Quiero 2 bolsas de mix de frutos secos, soy Sofía. Confirmo.',
        mock: [
          { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Sofía', items: [{ producto: 'Mix frutos secos', cantidad: 2 }] } }] },
          { texto: 'Listo Sofía: 2 bolsas de mix, $13.980. 😊' },
        ],
        evaluar: async ({ capturas }) => {
          const [pedido] = capturaDe(capturas, 'crear_pedido');
          return pedido?.creado ? [] : [`No se pudo crear el pedido base del escenario: ${JSON.stringify(pedido)}`];
        },
      },
      {
        user: 'Uy no, me equivoqué. Mejor cancela ese pedido.',
        mock: [
          { tools: [{ name: 'cancelar_pedido', input: {} }] },
          { texto: 'Listo, cancelé tu pedido #1. ¿Quieres pedir otra cosa? 😊' },
        ],
        evaluar: async ({ capturas, db, telefono }) => {
          const problemas = [];
          const [cancelacion] = capturaDe(capturas, 'cancelar_pedido');
          if (cancelacion?.cancelado !== true) {
            problemas.push(`No existe forma de cancelar/cambiar un pedido (edge case común en WhatsApp): ${JSON.stringify(cancelacion)}`);
          } else {
            const pedido = await db.pedidos.ultimoPorTelefono(telefono);
            if (pedido?.estado !== 'cancelado') problemas.push(`El pedido no quedó en estado cancelado: ${pedido?.estado}`);
            const mix = await db.productos.buscarUno('Mix frutos secos');
            if (mix && mix.stock !== 18) problemas.push(`El stock no se repuso al cancelar: hay ${mix.stock}, esperaba 18`);
          }
          return problemas;
        },
      },
    ],
  },
  {
    nombre: 'Consultar pedido sin historial',
    turnos: [{
      user: '¿Cómo va mi pedido?',
      mock: [
        { tools: [{ name: 'consultar_pedido', input: {} }] },
        { texto: 'No encuentro pedidos a tu nombre. ¿Quieres hacer uno? 😊' },
      ],
      evaluar: async ({ capturas }) => {
        const [consulta] = capturaDe(capturas, 'consultar_pedido');
        return consulta?.encontrado === false ? [] : [`consultar_pedido sin pedidos debió responder encontrado:false: ${JSON.stringify(consulta)}`];
      },
    }],
  },
  {
    nombre: 'Usuario confuso: pregunta vaga muestra el catálogo',
    turnos: [{
      user: 'hola?? necesito comprar algo pa un picoteo',
      mock: [
        { tools: [{ name: 'buscar_productos', input: {} }] },
        { texto: 'Hola! Tenemos frutos secos al kilo, mix listos para picar y fruta deshidratada. ¿Qué andas buscando? 😊' },
      ],
      evaluar: async ({ capturas, respuesta, modo }) => {
        const [busqueda] = capturaDe(capturas, 'buscar_productos');
        if (busqueda?.resultados === 10) return [];
        if (modo === 'api') {
          // También es válido orientar con UNA pregunta corta sin herramientas
          // (es justo lo que pide el system prompt para clientes vagos).
          return /\?/.test(respuesta ?? '') ? [] : [`Ante un cliente vago el agente ni buscó ni preguntó: "${respuesta}"`];
        }
        return [`Búsqueda vacía debió listar el catálogo completo (10): ${busqueda?.resultados}`];
      },
    }],
  },
  {
    nombre: 'Datos del negocio: "¿hacen despacho?" responde con la info del prompt (solo evaluable con API)',
    turnos: [{
      user: '¿Hacen despacho a domicilio? ¿Puedo pagar con tarjeta?',
      mock: [
        { texto: 'Sí 😊 Despachamos en la RM por $2.990 (gratis sobre $30.000, llega en 24-48 horas hábiles) y puedes pagar con efectivo, tarjeta o transferencia. ¿Te tomo un pedido?' },
      ],
      evaluar: async ({ respuesta, modo }) => {
        if (modo !== 'api') return []; // sin modelo real no hay qué evaluar
        // La info de despacho/pago de la tienda ficticia está en el system
        // prompt: el agente debe usarla, no decir que "no está cargada".
        const problemas = [];
        if (!/despacho|env[ií]o|reparto|domicilio/i.test(respuesta ?? '')) {
          problemas.push(`No respondió con la información de despacho de la tienda: "${respuesta}"`);
        }
        if (/no está cargada|no tengo esa información/i.test(respuesta ?? '')) {
          problemas.push(`Dijo no tener la info de despacho, pero está en el prompt: "${respuesta}"`);
        }
        return problemas;
      },
    }],
  },
  {
    nombre: 'Pedido con producto ambiguo ("maní") debe pedir aclarar, no adivinar',
    turnos: [{
      user: 'Anótame 1 maní, soy Elisa. Confirmo.',
      mock: [
        { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Elisa', items: [{ producto: 'maní', cantidad: 1 }] } }] },
        { texto: '¿Maní salado, maní sin sal o mantequilla de maní? 😊' },
      ],
      evaluar: async ({ capturas, db, telefono, modo }) => {
        const problemas = [];
        const [pedido] = capturaDe(capturas, 'crear_pedido');
        if (modo === 'mock' && (pedido?.creado !== false || !/salado.*sin sal|sin sal.*salado/is.test(JSON.stringify(pedido?.problemas ?? '')))) {
          problemas.push(`crear_pedido con ítem ambiguo debió rechazar listando los candidatos: ${JSON.stringify(pedido)}`);
        }
        // API: puede preguntar sin llamar la herramienta — el invariante es
        // que no se cree un pedido adivinando el producto.
        if (pedido?.creado || await db.pedidos.ultimoPorTelefono(telefono)) problemas.push('Se creó un pedido pese a la ambigüedad.');
        return problemas;
      },
    }],
  },
  {
    nombre: 'Atomicidad: ítem válido + ítem inexistente no crea nada',
    turnos: [{
      user: 'Quiero 2 kg de almendras y 1 kg de pistachos. Soy Bruno, confirmo.',
      mock: [
        { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Bruno', items: [
          { producto: 'almendras', cantidad: 2 },
          { producto: 'pistachos', cantidad: 1 },
        ] } }] },
        { texto: 'Los pistachos no los tenemos. ¿Dejo solo los 2 kg de almendras? 😊' },
      ],
      evaluar: async ({ capturas, db, telefono, modo }) => {
        const problemas = [];
        const [pedido] = capturaDe(capturas, 'crear_pedido');
        if (modo === 'mock' && pedido?.creado !== false) problemas.push(`Un pedido con un ítem inexistente debió rechazarse completo: ${JSON.stringify(pedido)}`);
        const almendras = await db.productos.buscarUno('Almendras');
        if (almendras && almendras.stock !== 15) problemas.push(`El rechazo descontó stock igual: ${almendras.stock}`);
        // API: lo correcto es avisar de los pistachos y preguntar si deja solo
        // las almendras — sin crear nada todavía.
        if (await db.pedidos.ultimoPorTelefono(telefono)) problemas.push('Quedó un pedido a medias en la base (debió confirmar antes de crear parcial).');
        return problemas;
      },
    }],
  },
  {
    nombre: 'Decimales repartidos: 0,5 + 0,7 kg de almendras se suman como 1,2 kg',
    turnos: [
      {
        user: 'Medio kilo de almendras... y ponle 700 gramos más. Soy Iris, confirmo.',
        mock: [
          { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Iris', items: [
            { producto: 'almendras', cantidad: 0.5 },
            { producto: 'almendras', cantidad: 0.7 },
          ] } }] },
          { texto: 'Listo Iris: 1,2 kg de almendras, $15.588. 😊' },
        ],
        evaluar: async ({ capturas, modo }) => {
          if (modo !== 'mock') return []; // en API puede pedir confirmación primero
          const [pedido] = capturaDe(capturas, 'crear_pedido');
          return pedido?.creado ? [] : [`Pedido con decimales repartidos falló: ${JSON.stringify(pedido)}`];
        },
      },
      // El modelo real puede mostrar el total y pedir confirmación primero
      { soloApi: true, user: 'Sí, dale, confírmalo tal cual.', evaluar: async () => [] },
    ],
    alFinal: async ({ db, telefono }) => {
      const problemas = [];
      const pedido = await db.pedidos.ultimoPorTelefono(telefono);
      if (!pedido) problemas.push('El pedido de 1,2 kg de almendras nunca se creó (ni tras confirmar).');
      else if (pedido.total !== 15588) problemas.push(`Total esperado 15588 (12990 × 1,2), obtuvo ${pedido.total}`);
      const almendras = await db.productos.buscarUno('Almendras');
      if (pedido && almendras && Math.abs(almendras.stock - 13.8) > 0.001) problemas.push(`Stock esperado 13,8 kg, hay ${almendras.stock}`);
      return problemas;
    },
  },
  {
    nombre: 'Doble cancelación: la segunda no repone stock de nuevo',
    turnos: [
      {
        user: 'Quiero 2 bolsas de mix, soy Tomás. Confirmo. ...uy no, cancélalo mejor.',
        mock: [
          { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Tomás', items: [{ producto: 'Mix frutos secos', cantidad: 2 }] } }] },
          { tools: [{ name: 'cancelar_pedido', input: {} }] },
          { texto: 'Listo, pedido cancelado. 😊' },
        ],
        evaluar: async ({ capturas, modo }) => {
          if (modo !== 'mock') return []; // en API puede pedir confirmación antes de cancelar
          const [cancelacion] = capturaDe(capturas, 'cancelar_pedido');
          return cancelacion?.cancelado === true ? [] : [`No se pudo montar el escenario (cancelación inicial falló): ${JSON.stringify(cancelacion)}`];
        },
      },
      { soloApi: true, user: 'Sí, cancélalo porfa.', evaluar: async () => [] },
      {
        user: 'Cancela mi pedido porfa',
        mock: [
          { tools: [{ name: 'cancelar_pedido', input: {} }] },
          { texto: 'Ese pedido ya estaba cancelado. 😊' },
        ],
        evaluar: async ({ capturas, modo }) => {
          const [cancelacion] = capturaDe(capturas, 'cancelar_pedido');
          if (modo === 'mock') {
            return cancelacion?.cancelado === false ? [] : [`Cancelar dos veces debió rechazarse: ${JSON.stringify(cancelacion)}`];
          }
          // API: puede responder "ya está cancelado" sin llamar la herramienta,
          // pero si la llama debe rechazar la segunda cancelación.
          return cancelacion && cancelacion.cancelado !== false
            ? [`La segunda cancelación no se rechazó: ${JSON.stringify(cancelacion)}`]
            : [];
        },
      },
    ],
    alFinal: async ({ db, telefono }) => {
      const problemas = [];
      const pedido = await db.pedidos.ultimoPorTelefono(telefono);
      // Si en API el modelo optó por no crear el pedido que el cliente canceló
      // en el mismo mensaje, también es un final válido (no hay nada que cancelar).
      if (pedido && pedido.estado !== 'cancelado') problemas.push(`El pedido debió quedar cancelado: ${pedido.estado}`);
      const mix = await db.productos.buscarUno('Mix frutos secos');
      if (mix && mix.stock !== 18) problemas.push(`Stock final del mix ${mix.stock}, esperaba 18 (sin doble reposición).`);
      return problemas;
    },
  },
  {
    nombre: 'Pedido ya en preparación no se puede cancelar por el bot',
    antes: async ({ db, telefono }) => {
      const pedido = await db.pedidos.crear(
        { telefono_cliente: telefono, nombre_cliente: 'Vera', direccion: null, notas: null, total: 6990 },
        [{ producto_id: 6, nombre_producto: 'Mix frutos secos (bolsa 500 g)', cantidad: 1, precio_unitario: 6990 }]
      );
      await db.pedidos.actualizarEstado(pedido.id, 'preparando');
    },
    turnos: [
      {
        user: 'Cancela mi pedido',
        mock: [
          { tools: [{ name: 'cancelar_pedido', input: {} }] },
          { texto: 'Tu pedido ya está en preparación, así que los cambios los coordina la tienda. 😊' },
        ],
        evaluar: async ({ capturas, modo }) => {
          const [cancelacion] = capturaDe(capturas, 'cancelar_pedido');
          if (modo === 'api' && !cancelacion) return []; // puede pedir confirmación primero
          return cancelacion?.cancelado === false && /preparando/.test(cancelacion?.motivo ?? '')
            ? []
            : [`Un pedido "preparando" no debe poder cancelarse desde el bot: ${JSON.stringify(cancelacion)}`];
        },
      },
      { soloApi: true, user: 'Sí, seguro, cancélalo.', evaluar: async () => [] },
    ],
    alFinal: async ({ db, telefono }) => {
      const pedido = await db.pedidos.ultimoPorTelefono(telefono);
      return pedido?.estado === 'preparando' ? [] : [`El estado del pedido cambió igual: ${pedido?.estado}`];
    },
  },
  {
    nombre: 'Producto agotado: pedirlo todo y consultar después',
    turnos: [
      {
        user: 'Llevo los 12 frascos de mantequilla de maní, soy Óscar (tengo una cafetería). Confirmo.',
        mock: [
          { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Óscar', items: [{ producto: 'Mantequilla de maní (frasco 500 g)', cantidad: 12 }] } }] },
          { texto: 'Listo Óscar: 12 frascos, $59.880. Con eso quedamos sin stock. 😊' },
        ],
        evaluar: async ({ capturas, modo }) => {
          if (modo !== 'mock') return []; // en API puede pedir confirmación primero
          const [pedido] = capturaDe(capturas, 'crear_pedido');
          return pedido?.creado === true ? [] : [`Comprar el stock exacto (12 de 12) debió aceptarse: ${JSON.stringify(pedido)}`];
        },
      },
      { soloApi: true, user: 'Sí, dale, confírmalo.', evaluar: async () => [] },
      {
        user: '¿Y les queda mantequilla de maní?',
        mock: [
          { tools: [{ name: 'consultar_stock', input: { producto: 'Mantequilla de maní (frasco 500 g)' } }] },
          { texto: 'Se nos agotó justo con tu pedido 😅 ¿Te aviso cuando repongamos?' },
        ],
        evaluar: async ({ capturas, respuesta, modo }) => {
          const [stock] = capturaDe(capturas, 'consultar_stock');
          if (!stock) {
            // API: puede responder desde el contexto sin herramienta; lo grave
            // sería ofrecer stock que ya no existe.
            return modo === 'api' ? [] : ['(mock) consultar_stock no se ejecutó según el guion.'];
          }
          if (stock.encontrado !== true) return [`El producto agotado debe seguir apareciendo (con stock 0): ${JSON.stringify(stock)}`];
          if (stock.producto.stock !== 0 || stock.producto.disponible !== false) {
            return [`Producto agotado debía reportar stock 0 y disponible:false: ${JSON.stringify(stock.producto)}`];
          }
          return [];
        },
      },
    ],
    alFinal: async ({ db, telefono }) => {
      const problemas = [];
      const pedido = await db.pedidos.ultimoPorTelefono(telefono);
      if (!pedido || pedido.estado === 'cancelado') problemas.push('El pedido de los 12 frascos no quedó creado.');
      else if (pedido.total !== 59880) problemas.push(`Total esperado 59880, obtuvo ${pedido.total}`);
      const mantequilla = await db.productos.buscarUno('Mantequilla de maní');
      if (pedido && mantequilla && mantequilla.stock !== 0) problemas.push(`Stock esperado 0 tras vender todo, hay ${mantequilla.stock}`);
      return problemas;
    },
  },
  {
    nombre: 'Confirmación repetida: "confirmo" dos veces no duplica el pedido',
    turnos: [
      {
        user: 'Quiero 2 kg de almendras, soy Nadia. Confirmo.',
        mock: [
          { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Nadia', items: [{ producto: 'almendras', cantidad: 2 }] } }] },
          { texto: 'Listo Nadia: 2 kg de almendras, $25.980. 😊' },
        ],
        evaluar: async ({ modo, capturas }) => {
          if (modo !== 'mock') return [];
          const [pedido] = capturaDe(capturas, 'crear_pedido');
          return pedido?.creado ? [] : [`No se pudo montar el escenario (pedido base falló): ${JSON.stringify(pedido)}`];
        },
      },
      { soloApi: true, user: 'Sí, dale, confírmalo.', evaluar: async () => [] },
      {
        // El cliente repite la confirmación (típico en WhatsApp): si el modelo
        // vuelve a llamar crear_pedido, la guarda de duplicados debe frenarlo.
        user: 'confirmo!',
        mock: [
          { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Nadia', items: [{ producto: 'almendras', cantidad: 2 }] } }] },
          { texto: 'Tu pedido ya quedó registrado, Nadia 😊' },
        ],
        evaluar: async ({ capturas, modo }) => {
          const [pedido] = capturaDe(capturas, 'crear_pedido');
          if (!pedido) return modo === 'api' ? [] : ['(mock) crear_pedido no se ejecutó según el guion.'];
          return pedido.creado === false && pedido.duplicado === true
            ? []
            : [`La confirmación repetida debió detectarse como duplicado: ${JSON.stringify(pedido)}`];
        },
      },
    ],
    alFinal: async ({ db, telefono }) => {
      const problemas = [];
      const pedido = await db.pedidos.ultimoPorTelefono(telefono);
      if (!pedido || pedido.total !== 25980) problemas.push(`Debe existir UN pedido por $25.980: ${JSON.stringify(pedido?.total)}`);
      const almendras = await db.productos.buscarUno('Almendras');
      if (almendras && almendras.stock !== 13) problemas.push(`El stock se descontó dos veces: hay ${almendras.stock}, esperaba 13.`);
      return problemas;
    },
  },
  {
    nombre: 'Seguridad del loop: el modelo pide herramientas sin parar (corte a las 6 rondas)',
    turnos: [{
      user: 'dame el precio de todo',
      mock: Array.from({ length: 8 }, () => ({ tools: [{ name: 'consultar_stock', input: { producto: 'almendras' } }] })),
      evaluar: async ({ capturas, respuesta }) => {
        const problemas = [];
        if (capturas.length > 6) problemas.push(`El loop ejecutó ${capturas.length} rondas de herramientas (máximo diseñado: 6).`);
        if (!respuesta || !respuesta.trim()) problemas.push('Con el guion cortado por MAX_RONDAS el cliente quedó sin respuesta.');
        return problemas;
      },
    }],
  },
  {
    // Reproduce la falla real vista en producción: la tabla de sesiones no
    // responde y el bot olvidaba el pedido/dirección en cada turno.
    nombre: 'RESILIENCIA: sesiones de Supabase caídas — la conversación NO pierde contexto',
    antes: async ({ db }) => {
      const falla = async () => { throw new Error('simulado: tabla retail_sesiones no existe'); };
      db.sesiones.get = falla;
      db.sesiones.upsert = falla;
      db.sesiones.actualizarPerfil = falla;
    },
    turnos: [
      {
        user: 'Hola! ¿Tienen almendras? ¿A cuánto?',
        mock: [
          { tools: [{ name: 'consultar_stock', input: { producto: 'almendras' } }] },
          { texto: 'Sí 😊 Almendras a $12.990 el kilo, quedan 15 kg. ¿Te anoto un pedido?' },
        ],
        evaluar: async () => [],
      },
      {
        user: 'Dame 2 kilos, soy José. Despacho a El Pireo 5881, Vitacura.',
        mock: [
          { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'José', items: [{ producto: 'almendras', cantidad: 2 }], direccion: 'El Pireo 5881, Vitacura' } }] },
          { texto: '¡Listo, José! Pedido registrado: 2 kg de almendras, $25.980, despacho a El Pireo 5881 ✅' },
        ],
        evaluar: async ({ modo, ultimoParams }) => {
          if (modo !== 'mock') return [];
          return (ultimoParams?.messages?.length ?? 0) >= 3
            ? []
            : ['BUG: el historial no llegó al modelo con Supabase caído (el respaldo en proceso no está funcionando).'];
        },
      },
    ],
    alFinal: async ({ db, telefono }) => {
      const problemas = [];
      const pedido = await db.pedidos.ultimoPorTelefono(telefono);
      if (!pedido || pedido.total !== 25980) problemas.push(`Con las sesiones caídas igual debía crearse el pedido por $25.980: ${JSON.stringify(pedido?.total)}`);
      if (pedido && pedido.direccion !== 'El Pireo 5881, Vitacura') problemas.push(`El pedido no guardó la dirección: ${JSON.stringify(pedido?.direccion)}`);
      return problemas;
    },
  },
  {
    // La otra falla real del transcript: catálogo caído convertido en "no
    // tenemos almendras" (falso) o en un pedido "confirmado" inexistente.
    nombre: 'RESILIENCIA: catálogo caído — admite el problema, no dice "no tenemos" ni confirma pedidos',
    antes: async ({ db }) => {
      db.productos.buscar = async () => { throw new Error('simulado: productos no responde'); };
    },
    turnos: [{
      user: 'quiero comprar 2 kilos de almendras',
      mock: [
        { tools: [{ name: 'consultar_stock', input: { producto: 'almendras' } }] },
        { texto: 'Uy, tuve un problema técnico al consultar el catálogo 😅 ¿Lo intento de nuevo al tiro, o dejo tu encargo anotado para que la tienda te lo confirme por este chat?' },
      ],
      evaluar: async ({ respuesta, capturas, modo }) => {
        const problemas = [];
        if (!/problema t[eé]cnico|inconveniente/i.test(respuesta)) problemas.push('No admite el problema técnico ante el cliente.');
        if (/no tenemos|no hay stock|no nos quedan|agotad|sin stock/i.test(respuesta)) problemas.push('BUG: convirtió una falla técnica en "no tenemos almendras" (la falla real del transcript).');
        if (/pedido (registrado|creado|confirmado)|te confirmo tu pedido/i.test(respuesta)) problemas.push('BUG: confirmó un pedido que nunca se creó (la falla real del transcript).');
        if (modo === 'mock') {
          const captura = capturas.find((c) => c.name === 'consultar_stock');
          if (!captura?.error) problemas.push('La herramienta debía fallar en este escenario (montaje incorrecto).');
        }
        return problemas;
      },
    }],
    alFinal: async ({ db, telefono }) => {
      const pedido = await db.pedidos.ultimoPorTelefono(telefono);
      return pedido ? ['BUG: se creó un pedido con el catálogo caído.'] : [];
    },
  },
  {
    nombre: 'PERFIL: reconoce al cliente (nombre y dirección) en una conversación posterior',
    turnos: [
      {
        user: 'Quiero 2 kg de almendras, soy José. Despacho a El Pireo 5881, Vitacura. Confirmo.',
        mock: [
          { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'José', items: [{ producto: 'almendras', cantidad: 2 }], direccion: 'El Pireo 5881, Vitacura' } }] },
          { texto: '¡Listo, José! 2 kg de almendras, $25.980, a El Pireo 5881 ✅' },
        ],
        evaluar: async () => [],
      },
      {
        user: 'Hola! quiero pedir de nuevo',
        mock: [{ texto: '¡Hola de nuevo, José! 😊 ¿Mismo despacho a El Pireo 5881, Vitacura? ¿Qué te preparo esta vez?' }],
        evaluar: async ({ modo, ultimoParams }) => {
          if (modo !== 'mock') return [];
          const system = ultimoParams?.system || '';
          const problemas = [];
          if (!/DATOS CONOCIDOS DEL CLIENTE/.test(system)) problemas.push('El system prompt no inyecta los datos conocidos del cliente.');
          if (!/José/.test(system)) problemas.push('El perfil inyectado no contiene el nombre capturado del pedido.');
          if (!/El Pireo 5881/.test(system)) problemas.push('El perfil inyectado no contiene la dirección capturada del pedido.');
          return problemas;
        },
      },
    ],
    alFinal: async ({ db, telefono }) => {
      const sesion = await db.sesiones.get(telefono);
      return sesion?.perfil?.nombre === 'José' && /El Pireo/.test(sesion?.perfil?.direccion || '')
        ? []
        : [`El perfil no quedó persistido en la sesión: ${JSON.stringify(sesion?.perfil)}`];
    },
  },
  {
    nombre: 'DERIVACIÓN: pendiente anotado cuando el cliente pide algo fuera de alcance',
    turnos: [{
      user: '¿Arman canastas de regalo para empresas? Necesito 20 para diciembre.',
      mock: [
        { tools: [{ name: 'anotar_pendiente', input: { resumen: 'Cliente pide 20 canastas de regalo corporativas para diciembre' } }] },
        { texto: 'Eso lo cotiza directamente la tienda 😊 Dejé anotada tu consulta y te responderán por este mismo chat.' },
      ],
      evaluar: async ({ respuesta, capturas, modo }) => {
        const problemas = [];
        if (!/anotad|responder[aá]n|tienda/i.test(respuesta)) problemas.push('No le dice al cliente que su consulta quedó derivada/anotada.');
        if (modo === 'mock') {
          const [r] = capturaDe(capturas, 'anotar_pendiente');
          if (r?.anotado !== true) problemas.push('anotar_pendiente no registró el pendiente (¿herramienta no definida?).');
        }
        return problemas;
      },
    }],
  },
];

// Chequeos estáticos sobre las definiciones de herramientas (no requieren modelo)
function chequeosEstaticos(tools) {
  const problemas = [];
  const nombres = tools.TOOL_DEFINITIONS.map((t) => t.name);
  if (!nombres.includes('cancelar_pedido')) {
    problemas.push('Falta la herramienta cancelar_pedido (los clientes se equivocan y piden cambiar/cancelar).');
  }
  if (!nombres.includes('anotar_pendiente')) {
    problemas.push('Falta la herramienta anotar_pendiente (derivación a la tienda cuando el bot no puede resolver).');
  }
  const crear = tools.TOOL_DEFINITIONS.find((t) => t.name === 'crear_pedido');
  const tipo = crear?.input_schema?.properties?.items?.items?.properties?.cantidad?.type;
  if (tipo !== 'number') {
    problemas.push(`crear_pedido.items.cantidad es "${tipo}" — debe ser "number" para permitir kg decimales.`);
  }
  // Botones de Telegram (módulo puro): cada botón de inicio tiene su frase y
  // los botones contextuales siempre ofrecen Menú.
  try {
    const { TECLADO_INICIO, FRASES_BOTONES, botonesParaRespuesta } = require('../telegram/botones');
    const datos = TECLADO_INICIO.inline_keyboard.flat().map((b) => b.callback_data);
    const sinFrase = datos.filter((d) => d !== 'menu' && !FRASES_BOTONES[d]);
    if (sinFrase.length) problemas.push(`Botones de inicio sin frase asociada: ${sinFrase.join(', ')}`);
    const teclado = botonesParaRespuesta('respuesta cualquiera');
    if (!teclado.inline_keyboard.flat().some((b) => b.callback_data === 'menu')) {
      problemas.push('botonesParaRespuesta no incluye el botón Menú');
    }
    const conPedido = botonesParaRespuesta('¡Listo! Tu pedido #4 quedó registrado ✅');
    if (!conPedido.inline_keyboard.flat().some((b) => b.callback_data === 'retail:estado')) {
      problemas.push('Tras crear un pedido, los botones contextuales no ofrecen "Estado de mi pedido"');
    }
  } catch (error) {
    problemas.push(`No se pudo cargar telegram/botones.js: ${error.message}`);
  }
  return problemas;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(70));
  console.log(`Simulador de conversaciones — modo ${MODO.toUpperCase()}${MODO === 'mock' ? ' (sin ANTHROPIC_API_KEY o MOCK=true: tool calls guionizados)' : ''}`);
  console.log('═'.repeat(70));

  let fallas = 0;
  let indiceTelefono = 0;

  // Chequeos estáticos con una carga limpia
  {
    const { tools } = cargarAgenteFresco();
    const problemas = chequeosEstaticos(tools);
    console.log(`\n[${problemas.length ? 'FALLA' : 'OK   '}] Chequeos estáticos de herramientas`);
    for (const p of problemas) { console.log(`    ✗ ${p}`); fallas++; }
  }

  for (const escenario of ESCENARIOS) {
    const telefono = `5699000${String(++indiceTelefono).padStart(4, '0')}`;
    const ctx = cargarAgenteFresco();
    const problemasEscenario = [];

    // Hook opcional para montar estado previo (ej: un pedido ya "preparando")
    if (typeof escenario.antes === 'function') {
      await escenario.antes({ db: ctx.db, telefono });
    }

    for (const turno of escenario.turnos) {
      if (turno.soloApi && MODO !== 'api') continue;
      if (MODO === 'mock') estadoMock.pasos = JSON.parse(JSON.stringify(turno.mock ?? []));
      const capturasAntes = ctx.capturas.length;
      let respuesta;
      try {
        respuesta = await ctx.processMessage(telefono, turno.user);
      } catch (error) {
        problemasEscenario.push(`processMessage lanzó una excepción: ${error.message}`);
        break;
      }
      // Formato WhatsApp (solo relevante con modelo real): nada de Markdown.
      if (MODO === 'api' && /\*\*|^#{1,3}\s|\[[^\]]+\]\([^)]+\)/m.test(respuesta ?? '')) {
        problemasEscenario.push(`Respuesta con formato Markdown (WhatsApp usa *negrita* simple): "${(respuesta ?? '').slice(0, 140)}"`);
      }
      const capturasTurno = ctx.capturas.slice(capturasAntes);
      const problemas = await turno.evaluar({
        respuesta,
        capturas: capturasTurno,
        db: ctx.db,
        tools: ctx.tools,
        telefono,
        modo: MODO,
        ultimoParams: estadoMock.ultimoParams,
      });
      problemasEscenario.push(...problemas);
    }

    // Invariantes de estado final (válidos en ambos modos)
    if (typeof escenario.alFinal === 'function' && !problemasEscenario.some((p) => p.startsWith('processMessage'))) {
      problemasEscenario.push(...await escenario.alFinal({ db: ctx.db, telefono, modo: MODO }));
    }

    console.log(`\n[${problemasEscenario.length ? 'FALLA' : 'OK   '}] ${escenario.nombre}`);
    for (const p of problemasEscenario) { console.log(`    ✗ ${p}`); fallas++; }
  }

  console.log('\n' + '═'.repeat(70));
  console.log(fallas === 0
    ? '✔ Todos los escenarios pasaron.'
    : `✗ ${fallas} problema(s) encontrado(s).`);
  console.log('═'.repeat(70));
  process.exit(fallas === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Error fatal del runner:', e); process.exit(2); });
