// Simulador de conversaciones AUTOMATIZADO — evalúa el agente sin WhatsApp.
//
// Uso: npm test   (o: node scripts/test-chat.js)
// Forzar mock aunque haya API key: MOCK=true npm test
//
// Dos modos, según haya o no GEMINI_API_KEY en el entorno / .env (y MOCK):
//  - Modo API : las conversaciones pasan por Gemini de verdad (Google AI Studio).
//  - Modo MOCK: se inyecta un doble de pruebas del cliente que ejecuta los tool
//    calls que el modelo haría en cada escenario. Evalúa la capa de
//    herramientas, el loop de core.js y la memoria — sin llamar a la API.
//
// En ambos modos la base de datos es la EN MEMORIA (no configurar SUPABASE_*
// al correr los tests). Cada escenario parte con la base limpia.

require('dotenv').config();

const path = require('path');

const MODO = (process.env.MOCK === 'true' || !process.env.GEMINI_API_KEY) ? 'mock' : 'api';

if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  console.error('Los tests usan la base EN MEMORIA: quita SUPABASE_URL/SUPABASE_KEY del entorno antes de correrlos.');
  process.exit(1);
}

// ─── Doble de pruebas del SDK de Anthropic (modo mock) ───────────────────────

// Guion del turno actual: lista de pasos que el "modelo" ejecuta en orden.
// Cada paso es { tools: [{name, input}] } (ronda de tool use) o { texto }.
const estadoMock = { pasos: [] };
let contadorToolUse = 0;

function mockCreate() {
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
// NOTA: MODO se decide arriba por GEMINI_API_KEY; este cliente doble se
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
    nombre: 'Búsqueda multi-palabra: "alimento para perros de 15kg"',
    turnos: [{
      user: '¿Tienen alimento para perros de 15kg?',
      mock: [
        { tools: [{ name: 'buscar_productos', input: { consulta: 'alimento para perros' } }] },
        { texto: 'Sí, tenemos Comida perro adulto (15 kg) a $34.990. ¿Te lo anoto? 🐶' },
      ],
      evaluar: async ({ capturas }) => {
        const problemas = [];
        const busquedas = capturaDe(capturas, 'buscar_productos');
        const nombres = busquedas.flatMap(nombresProductos);
        if (!nombres.some((n) => /comida perro adulto/i.test(n))) {
          problemas.push(`buscar_productos("alimento para perros") NO encontró "Comida perro adulto (15 kg)". Resultados: ${JSON.stringify(nombres)}`);
        }
        return problemas;
      },
    }],
  },
  {
    nombre: 'Búsqueda con conector y singular: "comida de gato"',
    turnos: [{
      user: '¿Tienen comida de gato?',
      mock: [
        { tools: [{ name: 'buscar_productos', input: { consulta: 'comida de gato' } }] },
        { texto: 'Sí: Comida gato (3 kg) a $12.990. 🐱' },
      ],
      evaluar: async ({ capturas }) => {
        const nombres = capturaDe(capturas, 'buscar_productos').flatMap(nombresProductos);
        return nombres.some((n) => /comida gato/i.test(n))
          ? []
          : [`buscar_productos("comida de gato") NO encontró "Comida gato (3 kg)". Resultados: ${JSON.stringify(nombres)}`];
      },
    }],
  },
  {
    nombre: 'Producto inexistente: "¿cuánto cuesta el kilo de lenguado?"',
    turnos: [{
      user: '¿Cuánto cuesta el kilo de lenguado?',
      mock: [
        { tools: [{ name: 'consultar_stock', input: { producto: 'lenguado' } }] },
        { texto: 'No tenemos lenguado, pero en mariscos hay salmón, camarones y choritos. ¿Te sirve alguno? 🐟' },
      ],
      evaluar: async ({ capturas, respuesta, modo }) => {
        const problemas = [];
        const [stock] = capturaDe(capturas, 'consultar_stock');
        if (stock?.encontrado !== false) problemas.push('consultar_stock("lenguado") debió responder encontrado:false.');
        const tieneAyuda = stock && (stock.categorias_disponibles?.length || stock.sugerencias?.length);
        if (!tieneAyuda) problemas.push('consultar_stock sin resultados no entrega alternativas (categorías/sugerencias) para que el agente ofrezca otra cosa.');
        if (modo === 'api' && /\$\s?\d/.test(respuesta) && /lenguado/i.test(respuesta)) {
          problemas.push(`Posible precio inventado para un producto inexistente: "${respuesta}"`);
        }
        return problemas;
      },
    }],
  },
  {
    nombre: 'Sin stock en catálogo: "¿tienen frutos secos?"',
    turnos: [{
      user: '¿Tienen stock de frutos secos?',
      mock: [
        { tools: [{ name: 'buscar_productos', input: { consulta: 'frutos secos' } }] },
        { texto: 'Por ahora no tenemos frutos secos. Manejamos abarrotes, mariscos y mascotas. 😊' },
      ],
      evaluar: async ({ capturas }) => {
        const problemas = [];
        const [busqueda] = capturaDe(capturas, 'buscar_productos');
        if (!busqueda || busqueda.resultados !== 0) {
          problemas.push(`buscar_productos("frutos secos") debió dar 0 resultados (no hay falsos positivos). Obtuvo: ${JSON.stringify(nombresProductos(busqueda))}`);
        }
        if (busqueda && !busqueda.categorias_disponibles?.length) {
          problemas.push('Búsqueda sin resultados no informa las categorías disponibles.');
        }
        return problemas;
      },
    }],
  },
  {
    nombre: 'Pedido feliz: 2 kg de salmón (consulta → confirmación → creación)',
    turnos: [
      {
        user: 'Hola! Quiero pedir 2 kilos de salmón',
        mock: [
          { tools: [{ name: 'consultar_stock', input: { producto: 'salmón' } }] },
          { texto: 'Tenemos Salmón fresco a $12.990 el kg (hay 15 kg). Serían $25.980. ¿A nombre de quién dejo el pedido? 😊' },
        ],
        evaluar: async ({ capturas }) => {
          const [stock] = capturaDe(capturas, 'consultar_stock');
          return stock?.encontrado && /salm/i.test(stock.producto?.nombre ?? '')
            ? []
            : [`consultar_stock("salmón") no encontró el salmón: ${JSON.stringify(stock)}`];
        },
      },
      {
        user: 'A nombre de Carla Pérez. Confirmo!',
        mock: [
          { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Carla Pérez', items: [{ producto: 'salmón', cantidad: 2 }] } }] },
          { texto: 'Listo Carla, pedido #1 por 2 kg de salmón, total $25.980. Te avisamos cuando esté listo. 😊' },
        ],
        evaluar: async ({ capturas, db, telefono }) => {
          const problemas = [];
          const [pedido] = capturaDe(capturas, 'crear_pedido');
          if (!pedido?.creado) problemas.push(`crear_pedido falló: ${JSON.stringify(pedido)}`);
          if (pedido?.creado && pedido.pedido.total !== 25980) problemas.push(`Total incorrecto: esperaba 25980, obtuvo ${pedido.pedido.total}`);
          const salmon = await db.productos.buscarUno('Salmón fresco');
          if (salmon && salmon.stock !== 13) problemas.push(`Stock no descontado correctamente: esperaba 13 kg, hay ${salmon.stock}`);
          const guardado = await db.pedidos.ultimoPorTelefono(telefono);
          if (!guardado) problemas.push('El pedido no quedó asociado al teléfono del cliente.');
          return problemas;
        },
      },
    ],
  },
  {
    nombre: 'Cantidad decimal: 1,5 kg de salmón (definición de la herramienta)',
    turnos: [
      {
        user: 'Quiero 1,5 kg de salmón, soy Ana. Confirmo.',
        mock: [
          { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Ana', items: [{ producto: 'Salmón fresco (kg)', cantidad: 1.5 }] } }] },
          { texto: 'Listo Ana: 1,5 kg de salmón, total $19.485. 😊' },
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
    nombre: 'Decimal en producto por unidad debe rechazarse (2,5 sacos)',
    turnos: [{
      user: 'Quiero 2,5 sacos de comida de perro, soy Raúl. Confirmo.',
      mock: [
        { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Raúl', items: [{ producto: 'Comida perro adulto (15 kg)', cantidad: 2.5 }] } }] },
        { texto: 'Los sacos se venden por unidad: ¿te anoto 2 o 3? 😊' },
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
    nombre: 'Stock insuficiente: 50 kg de salmón (hay 15)',
    turnos: [{
      user: 'Necesito 50 kg de salmón para un evento, soy Pedro. Dale no más.',
      mock: [
        { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Pedro', items: [{ producto: 'salmón', cantidad: 50 }] } }] },
        { texto: 'Uy, solo nos quedan 15 kg de salmón. ¿Te sirven? 😊' },
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
        const salmon = await db.productos.buscarUno('Salmón fresco');
        if (salmon && salmon.stock !== 15) problemas.push(`El rechazo alteró el stock: quedó en ${salmon.stock}`);
        return problemas;
      },
    }],
  },
  {
    nombre: 'BUG ítems duplicados: 10 + 10 kg de salmón (hay 15) debe rechazarse',
    turnos: [{
      user: 'Quiero 10 kg de salmón... ah y agrégame otros 10 kg más. Soy Diego, confirmo.',
      mock: [
        { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Diego', items: [
          { producto: 'salmón', cantidad: 10 },
          { producto: 'Salmón fresco (kg)', cantidad: 10 },
        ] } }] },
        { texto: 'Solo tenemos 15 kg de salmón en total. ¿Los dejo así? 😊' },
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
        const salmon = await db.productos.buscarUno('Salmón fresco');
        if (salmon && salmon.stock !== 15) problemas.push(`El stock quedó corrupto tras el intento: ${salmon.stock} (debía seguir en 15)`);
        return problemas;
      },
    }],
  },
  {
    nombre: 'Pedido grande multi-ítem con dirección',
    turnos: [
      {
        user: 'Hola, quiero 10 arroz, 5 lentejas y 3 aceites. Soy Marco, para Av. Italia 1234.',
        mock: [
          { texto: 'Perfecto Marco: 10 arroz ($18.900), 5 lentejas ($12.450) y 3 aceites ($8.970) = $40.320, a Av. Italia 1234. ¿Confirmas? 😊' },
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
              { producto: 'Arroz grado 1 (1 kg)', cantidad: 10 },
              { producto: 'Lentejas (1 kg)', cantidad: 5 },
              { producto: 'Aceite vegetal (900 ml)', cantidad: 3 },
            ],
          } }] },
          { texto: 'Pedido #1 confirmado por $40.320 a Av. Italia 1234. 😊' },
        ],
        evaluar: async ({ capturas, db, telefono }) => {
          const problemas = [];
          const [pedido] = capturaDe(capturas, 'crear_pedido');
          if (!pedido?.creado) problemas.push(`Pedido multi-ítem falló: ${JSON.stringify(pedido)}`);
          if (pedido?.creado && pedido.pedido.total !== 40320) problemas.push(`Total esperado 40320, obtuvo ${pedido.pedido.total}`);
          const guardado = await db.pedidos.ultimoPorTelefono(telefono);
          if (guardado && guardado.direccion !== 'Av. Italia 1234') problemas.push(`Dirección no guardada: ${guardado.direccion}`);
          const arroz = await db.productos.buscarUno('Arroz grado 1');
          if (arroz && arroz.stock !== 30) problemas.push(`Stock de arroz esperado 30, hay ${arroz.stock}`);
          return problemas;
        },
      },
    ],
  },
  {
    nombre: 'Ambigüedad: consultar stock de "comida" (hay de perro y de gato)',
    turnos: [{
      user: '¿Tienen comida? ¿a cuánto?',
      mock: [
        { tools: [{ name: 'consultar_stock', input: { producto: 'comida' } }] },
        { texto: '¿Comida para perro ($34.990 el saco 15 kg) o para gato ($12.990 los 3 kg)? 😊' },
      ],
      evaluar: async ({ capturas, respuesta, modo }) => {
        const [stock] = capturaDe(capturas, 'consultar_stock');
        if (stock?.ambiguo === true && (stock.candidatos?.length ?? 0) >= 2) return [];
        if (modo === 'api') {
          // El modelo puede resolverlo sin consultar_stock (ej: buscar_productos
          // o preguntar directo). Lo prohibido: elegir UN producto al azar.
          const problemas = [];
          if (!/\?/.test(respuesta ?? '')) problemas.push(`Ante "comida" (ambiguo) el agente no pidió aclaración: "${respuesta}"`);
          const precios = (respuesta ?? '').match(/\$\s?[\d.]+/g) ?? [];
          if (precios.length === 1) problemas.push(`El agente eligió un producto al azar y dio un solo precio: "${respuesta}"`);
          return problemas;
        }
        return [`consultar_stock("comida") coincide con varios productos pero no avisa la ambigüedad (devuelve uno al azar): ${JSON.stringify(stock)}`];
      },
    }],
  },
  {
    nombre: 'Cambio de pedido: cancelar y volver a pedir',
    turnos: [
      {
        user: 'Quiero 2 mallas de choritos, soy Sofía. Confirmo.',
        mock: [
          { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Sofía', items: [{ producto: 'Choritos', cantidad: 2 }] } }] },
          { texto: 'Listo Sofía: 2 mallas de choritos, $6.980. 😊' },
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
            const choritos = await db.productos.buscarUno('Choritos');
            if (choritos && choritos.stock !== 18) problemas.push(`El stock no se repuso al cancelar: hay ${choritos.stock}, esperaba 18`);
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
      user: 'hola?? necesito comprar algo pa la casa',
      mock: [
        { tools: [{ name: 'buscar_productos', input: {} }] },
        { texto: 'Hola! Tenemos abarrotes, mariscos y productos para mascotas. ¿Qué andas buscando? 😊' },
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
    nombre: 'Fuera de alcance: "¿hacen delivery?" (solo evaluable con API)',
    turnos: [{
      user: '¿Hacen delivery? ¿Puedo pagar con tarjeta?',
      mock: [
        { texto: 'Esa información aún no está cargada en el sistema. Te puedo ayudar con catálogo, stock y pedidos. 😊' },
      ],
      evaluar: async ({ respuesta, modo }) => {
        if (modo !== 'api') return []; // sin modelo real no hay qué evaluar
        const inventaDatos = /(lunes|martes|hora|km|\$\s?\d+.*(despacho|delivery|envío))/i.test(respuesta);
        return inventaDatos ? [`Posible información de negocio inventada: "${respuesta}"`] : [];
      },
    }],
  },
  {
    nombre: 'Pedido con producto ambiguo ("comida") debe pedir aclarar, no adivinar',
    turnos: [{
      user: 'Anótame 1 comida, soy Elisa. Confirmo.',
      mock: [
        { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Elisa', items: [{ producto: 'comida', cantidad: 1 }] } }] },
        { texto: '¿Comida para perro o para gato? 😊' },
      ],
      evaluar: async ({ capturas, db, telefono, modo }) => {
        const problemas = [];
        const [pedido] = capturaDe(capturas, 'crear_pedido');
        if (modo === 'mock' && (pedido?.creado !== false || !/perro.*gato|gato.*perro/is.test(JSON.stringify(pedido?.problemas ?? '')))) {
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
      user: 'Quiero 2 kg de salmón y 1 kg de lenguado. Soy Bruno, confirmo.',
      mock: [
        { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Bruno', items: [
          { producto: 'salmón', cantidad: 2 },
          { producto: 'lenguado', cantidad: 1 },
        ] } }] },
        { texto: 'El lenguado no lo tenemos. ¿Dejo solo los 2 kg de salmón? 😊' },
      ],
      evaluar: async ({ capturas, db, telefono, modo }) => {
        const problemas = [];
        const [pedido] = capturaDe(capturas, 'crear_pedido');
        if (modo === 'mock' && pedido?.creado !== false) problemas.push(`Un pedido con un ítem inexistente debió rechazarse completo: ${JSON.stringify(pedido)}`);
        const salmon = await db.productos.buscarUno('Salmón fresco');
        if (salmon && salmon.stock !== 15) problemas.push(`El rechazo descontó stock igual: ${salmon.stock}`);
        // API: lo correcto es avisar del lenguado y preguntar si deja solo el
        // salmón — sin crear nada todavía.
        if (await db.pedidos.ultimoPorTelefono(telefono)) problemas.push('Quedó un pedido a medias en la base (debió confirmar antes de crear parcial).');
        return problemas;
      },
    }],
  },
  {
    nombre: 'Decimales repartidos: 0,5 + 0,7 kg de salmón se suman como 1,2 kg',
    turnos: [
      {
        user: 'Medio kilo de salmón... y ponle 700 gramos más. Soy Iris, confirmo.',
        mock: [
          { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Iris', items: [
            { producto: 'salmón', cantidad: 0.5 },
            { producto: 'salmón', cantidad: 0.7 },
          ] } }] },
          { texto: 'Listo Iris: 1,2 kg de salmón, $15.588. 😊' },
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
      if (!pedido) problemas.push('El pedido de 1,2 kg de salmón nunca se creó (ni tras confirmar).');
      else if (pedido.total !== 15588) problemas.push(`Total esperado 15588 (12990 × 1,2), obtuvo ${pedido.total}`);
      const salmon = await db.productos.buscarUno('Salmón fresco');
      if (pedido && salmon && Math.abs(salmon.stock - 13.8) > 0.001) problemas.push(`Stock esperado 13,8 kg, hay ${salmon.stock}`);
      return problemas;
    },
  },
  {
    nombre: 'Doble cancelación: la segunda no repone stock de nuevo',
    turnos: [
      {
        user: 'Quiero 2 mallas de choritos, soy Tomás. Confirmo. ...uy no, cancélalo mejor.',
        mock: [
          { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Tomás', items: [{ producto: 'Choritos', cantidad: 2 }] } }] },
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
      const choritos = await db.productos.buscarUno('Choritos');
      if (choritos && choritos.stock !== 18) problemas.push(`Stock final de choritos ${choritos.stock}, esperaba 18 (sin doble reposición).`);
      return problemas;
    },
  },
  {
    nombre: 'Pedido ya en preparación no se puede cancelar por el bot',
    antes: async ({ db, telefono }) => {
      const pedido = await db.pedidos.crear(
        { telefono_cliente: telefono, nombre_cliente: 'Vera', direccion: null, notas: null, total: 3490 },
        [{ producto_id: 6, nombre_producto: 'Choritos (malla 1 kg)', cantidad: 1, precio_unitario: 3490 }]
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
        user: 'Llevo los 12 sacos de comida de perro, soy Óscar (tengo un criadero). Confirmo.',
        mock: [
          { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Óscar', items: [{ producto: 'Comida perro adulto (15 kg)', cantidad: 12 }] } }] },
          { texto: 'Listo Óscar: 12 sacos, $419.880. Con eso quedamos sin stock. 😊' },
        ],
        evaluar: async ({ capturas, modo }) => {
          if (modo !== 'mock') return []; // en API puede pedir confirmación (es un pedido de $419.880)
          const [pedido] = capturaDe(capturas, 'crear_pedido');
          return pedido?.creado === true ? [] : [`Comprar el stock exacto (12 de 12) debió aceptarse: ${JSON.stringify(pedido)}`];
        },
      },
      { soloApi: true, user: 'Sí, dale, confírmalo.', evaluar: async () => [] },
      {
        user: '¿Y les queda comida de perro?',
        mock: [
          { tools: [{ name: 'consultar_stock', input: { producto: 'Comida perro adulto (15 kg)' } }] },
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
      if (!pedido || pedido.estado === 'cancelado') problemas.push('El pedido de los 12 sacos no quedó creado.');
      else if (pedido.total !== 419880) problemas.push(`Total esperado 419880, obtuvo ${pedido.total}`);
      const comida = await db.productos.buscarUno('Comida perro adulto');
      if (pedido && comida && comida.stock !== 0) problemas.push(`Stock esperado 0 tras vender todo, hay ${comida.stock}`);
      return problemas;
    },
  },
  {
    nombre: 'Confirmación repetida: "confirmo" dos veces no duplica el pedido',
    turnos: [
      {
        user: 'Quiero 2 kg de salmón, soy Nadia. Confirmo.',
        mock: [
          { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Nadia', items: [{ producto: 'salmón', cantidad: 2 }] } }] },
          { texto: 'Listo Nadia: 2 kg de salmón, $25.980. 😊' },
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
          { tools: [{ name: 'crear_pedido', input: { nombre_cliente: 'Nadia', items: [{ producto: 'salmón', cantidad: 2 }] } }] },
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
      const salmon = await db.productos.buscarUno('Salmón fresco');
      if (salmon && salmon.stock !== 13) problemas.push(`El stock se descontó dos veces: hay ${salmon.stock}, esperaba 13.`);
      return problemas;
    },
  },
  {
    nombre: 'Seguridad del loop: el modelo pide herramientas sin parar (corte a las 6 rondas)',
    turnos: [{
      user: 'dame el precio de todo',
      mock: Array.from({ length: 8 }, () => ({ tools: [{ name: 'consultar_stock', input: { producto: 'salmón' } }] })),
      evaluar: async ({ capturas, respuesta }) => {
        const problemas = [];
        if (capturas.length > 6) problemas.push(`El loop ejecutó ${capturas.length} rondas de herramientas (máximo diseñado: 6).`);
        if (!respuesta || !respuesta.trim()) problemas.push('Con el guion cortado por MAX_RONDAS el cliente quedó sin respuesta.');
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
  const crear = tools.TOOL_DEFINITIONS.find((t) => t.name === 'crear_pedido');
  const tipo = crear?.input_schema?.properties?.items?.items?.properties?.cantidad?.type;
  if (tipo !== 'number') {
    problemas.push(`crear_pedido.items.cantidad es "${tipo}" — debe ser "number" para permitir kg decimales.`);
  }
  return problemas;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(70));
  console.log(`Simulador de conversaciones — modo ${MODO.toUpperCase()}${MODO === 'mock' ? ' (sin GEMINI_API_KEY o MOCK=true: tool calls guionizados)' : ''}`);
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
