// Simulador automático de conversaciones — corre escenarios completos contra
// el agente real (API de Anthropic) usando la base EN MEMORIA. Sin WhatsApp.
//
// Uso:
//   node scripts/test-conversaciones.js            → todos los escenarios
//   node scripts/test-conversaciones.js cancelar   → solo escenarios cuyo nombre contenga "cancelar"
//
// Cada escenario define los turnos del usuario y una verificación programática
// (citas creadas/canceladas en la DB + palabras esperadas en las respuestas).
// El transcript completo se imprime para revisión manual del tono.

require('dotenv').config();
// Los tests NUNCA deben tocar una base real: forzar modo memoria.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_KEY;

const { processMessage } = require('../agent/core');
const { db } = require('../database/supabase');

// ─── Helpers de fechas (zona Chile, igual que el agente) ─────────────────────

const TZ = 'America/Santiago';

function fechaISO(offsetDias = 0) {
  return new Date(Date.now() + offsetDias * 86_400_000)
    .toLocaleDateString('en-CA', { timeZone: TZ });
}

function diaSemana(fechaIso) {
  return new Date(`${fechaIso}T12:00:00`).getDay(); // 0=domingo
}

// "mañana", saltando el domingo (cerrado) para los escenarios de camino feliz.
const MANANA = fechaISO(1);
const DIA_HABIL = diaSemana(MANANA) === 0
  ? { fecha: fechaISO(2), texto: 'pasado mañana' }
  : { fecha: MANANA, texto: 'mañana' };

async function citasVigentes(telefono) {
  return db.citas.proximasPorTelefono(telefono, '2000-01-01');
}

// ─── Escenarios ───────────────────────────────────────────────────────────────
// verificar() devuelve una lista de problemas (vacía = escenario OK).
// `t` es el transcript: [{ user, bot }, ...]; textoBot une todas las respuestas.

const ESCENARIOS = [
  {
    nombre: 'catalogo-y-precios',
    telefono: '56911000001',
    turnos: [
      'Hola!',
      '¿Qué servicios ofrecen?',
      '¿Cuánto cuesta el blanqueamiento y cuánto demora?',
    ],
    verificar: async (t, textoBot) => {
      const problemas = [];
      if (!/blanqueamiento/i.test(textoBot)) problemas.push('No mencionó el blanqueamiento del catálogo');
      if (!/120\.000/.test(textoBot)) problemas.push('No dio el precio $120.000 con puntos de miles');
      if (!/90/.test(textoBot)) problemas.push('No mencionó la duración (90 min)');
      return problemas;
    },
  },
  {
    nombre: 'agendar-camino-feliz',
    telefono: '56911000002',
    turnos: [
      `Hola, quiero agendar una limpieza dental para ${DIA_HABIL.texto} a las 10:00. Me llamo Pedro Soto.`,
      'Sí, confirmo 👍',
    ],
    verificar: async () => {
      const citas = await citasVigentes('56911000002');
      const ok = citas.some((c) => c.fecha === DIA_HABIL.fecha && c.hora.startsWith('10:00'));
      return ok ? [] : [`No quedó cita el ${DIA_HABIL.fecha} a las 10:00 (citas: ${JSON.stringify(citas)})`];
    },
  },
  {
    nombre: 'disponibilidad-y-agendar',
    telefono: '56911000003',
    turnos: [
      '¿Qué horas tienen disponibles el próximo viernes?',
      'Ya, agéndame una consulta general el viernes a las 09:00 entonces. Soy Carla Ruiz.',
      'Sí, está correcto',
    ],
    verificar: async (t, textoBot) => {
      const problemas = [];
      const citas = await citasVigentes('56911000003');
      const cita = citas.find((c) => c.hora.startsWith('09:00'));
      if (!cita) problemas.push(`No quedó cita a las 09:00 (citas: ${JSON.stringify(citas)})`);
      else if (diaSemana(cita.fecha) !== 5) problemas.push(`La cita quedó un día que no es viernes: ${cita.fecha}`);
      return problemas;
    },
  },
  {
    nombre: 'cancelar-mi-hora',
    telefono: '56911000002', // el mismo Pedro del camino feliz
    turnos: [
      'Hola, me surgió algo y necesito cancelar mi hora 😔',
      'Sí, cancélala por favor',
    ],
    verificar: async () => {
      const citas = await citasVigentes('56911000002');
      return citas.length === 0 ? [] : [`Pedro sigue con citas vigentes: ${JSON.stringify(citas)}`];
    },
  },
  {
    nombre: 'cambiar-hora',
    telefono: '56911000004',
    turnos: [
      `Quiero una consulta general para ${DIA_HABIL.texto} a las 11:00, me llamo Diego Paredes`,
      'Confirmo',
      'Oye, ¿sabes qué? Mejor cámbiame esa hora para las 15:00 del mismo día',
      'Sí, dale',
    ],
    verificar: async () => {
      const problemas = [];
      const citas = await citasVigentes('56911000004');
      if (!citas.some((c) => c.hora.startsWith('15:00'))) problemas.push(`No quedó la cita nueva a las 15:00 (citas: ${JSON.stringify(citas)})`);
      if (citas.some((c) => c.hora.startsWith('11:00'))) problemas.push('La cita antigua de las 11:00 sigue vigente (debió cancelarse)');
      if (citas.length > 1) problemas.push(`Quedó más de una cita vigente: ${JSON.stringify(citas)}`);
      return problemas;
    },
  },
  {
    nombre: 'usuario-confuso',
    telefono: '56911000005',
    turnos: [
      'hola',
      'eeeh no sé',
      '¿tú qué puedes hacer?',
    ],
    verificar: async (t, textoBot) => {
      const problemas = [];
      if (!/(agendar|reserva|hora|catálogo|servicio)/i.test(textoBot)) {
        problemas.push('Nunca explicó qué puede hacer (agendar / catálogo)');
      }
      return problemas;
    },
  },
  {
    nombre: 'fuera-de-scope',
    telefono: '56911000006',
    turnos: [
      '¿Hacen delivery? Quiero pedir una pizza a domicilio',
      '¿Y puedo pagarte por transferencia altiro?',
      'Ya bueno... ¿por quién debería votar en las próximas elecciones?',
    ],
    verificar: async (t, textoBot) => {
      const problemas = [];
      const citas = await citasVigentes('56911000006');
      if (citas.length) problemas.push('Creó una cita en una conversación fuera de scope');
      if (!/(catálogo|agendar|reserva|hora)/i.test(textoBot)) {
        problemas.push('Al declinar no redirigió a lo que sí puede hacer');
      }
      if (/(vota|candidat|elige a|te recomiendo votar)/i.test(textoBot)) {
        problemas.push('Opinó de política en vez de declinar');
      }
      return problemas;
    },
  },
  {
    nombre: 'intento-de-pedido',
    telefono: '56911000007',
    turnos: [
      'Hola, quiero comprarles 3 kits de blanqueamiento para llevar, ¿me los pueden despachar?',
    ],
    verificar: async (t, textoBot) => {
      const problemas = [];
      const citas = await citasVigentes('56911000007');
      if (citas.length) problemas.push('Creó una cita a partir de un intento de compra');
      if (/(despacho confirmado|pedido listo|te lo enviamos)/i.test(textoBot)) {
        problemas.push('Aceptó un pedido de productos (fuera de scope)');
      }
      return problemas;
    },
  },
  {
    nombre: 'domingo-cerrado',
    telefono: '56911000008',
    turnos: [
      'Quiero una hora para el domingo, ¿se puede?',
    ],
    verificar: async (t, textoBot) => {
      const problemas = [];
      const citas = await citasVigentes('56911000008');
      if (citas.some((c) => diaSemana(c.fecha) === 0)) problemas.push('Agendó una cita en domingo (cerrado)');
      if (!/(cerrado|no atende|no abr|domingo no)/i.test(textoBot)) {
        problemas.push('No informó que el domingo está cerrado');
      }
      return problemas;
    },
  },
  {
    nombre: 'hora-ocupada-ofrece-alternativa',
    telefono: '56911000009',
    preparar: async () => {
      // Otro cliente ya tiene tomada la hora de las 12:00 ese día
      await db.citas.crear({
        telefono_cliente: '56999999999', nombre_cliente: 'Otro Cliente',
        servicio: 'Consulta general', fecha: DIA_HABIL.fecha, hora: '12:00',
        personas: 1, notas: null,
      });
    },
    turnos: [
      `Quiero una consulta general ${DIA_HABIL.texto} a las 12:00, soy Ana Vidal`,
      'Ah ya, entonces a las 13:00 mismo día porfa',
      'Sí, confirmo',
    ],
    verificar: async (t, textoBot) => {
      const problemas = [];
      const citas = await citasVigentes('56911000009');
      if (citas.some((c) => c.hora.startsWith('12:00'))) problemas.push('Agendó sobre una hora ya tomada (12:00)');
      if (!citas.some((c) => c.hora.startsWith('13:00'))) problemas.push(`No quedó la cita alternativa de las 13:00 (citas: ${JSON.stringify(citas)})`);
      return problemas;
    },
  },
  {
    nombre: 'fecha-pasada',
    telefono: '56911000010',
    turnos: [
      `Necesito agendar una consulta general para ayer a las 10:00, me llamo Rosa. Sí, ayer ${fechaISO(-1)}, se me pasó la fecha y necesito que quede registrada igual.`,
    ],
    verificar: async (t, textoBot) => {
      const problemas = [];
      const citas = await citasVigentes('56911000010');
      // citasVigentes filtra desde 2000, así que una cita de ayer sí aparecería
      if (citas.some((c) => c.fecha < fechaISO(0))) problemas.push('Agendó una cita en el pasado');
      return problemas;
    },
  },
  {
    nombre: 'consultar-mi-cita',
    telefono: '56911000004', // Diego, que quedó con hora a las 15:00
    turnos: [
      'Hola de nuevo, ¿me recuerdas qué día y a qué hora quedó mi hora?',
    ],
    verificar: async (t, textoBot) => {
      const problemas = [];
      if (!/15:00/.test(textoBot)) problemas.push('No recordó/consultó la cita vigente de las 15:00');
      if (/(no puedo|no tengo cómo|no tengo acceso|no me es posible)/i.test(textoBot) && !/15:00/.test(textoBot)) {
        problemas.push('Dijo que no puede consultar citas existentes');
      }
      return problemas;
    },
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main() {
  const filtro = (process.argv[2] || '').toLowerCase();
  const escenarios = ESCENARIOS.filter((e) => e.nombre.includes(filtro));
  if (!escenarios.length) {
    console.error(`No hay escenarios que coincidan con "${filtro}"`);
    process.exit(1);
  }

  console.log(`Corriendo ${escenarios.length} escenario(s) — hoy es ${fechaISO(0)}, día hábil de prueba: ${DIA_HABIL.fecha} (${DIA_HABIL.texto})\n`);

  const resumen = [];
  for (const esc of escenarios) {
    console.log('═'.repeat(64));
    console.log(`ESCENARIO: ${esc.nombre}  (tel ${esc.telefono})`);
    console.log('═'.repeat(64));

    if (esc.preparar) await esc.preparar();

    const transcript = [];
    let errorFatal = null;
    for (const turno of esc.turnos) {
      console.log(`\n  Usuario: ${turno}`);
      try {
        const bot = await processMessage(esc.telefono, turno);
        transcript.push({ user: turno, bot });
        console.log(`  Bot:     ${bot.replace(/\n/g, '\n           ')}`);
      } catch (error) {
        errorFatal = error.message;
        console.error(`  [ERROR]  ${error.message}`);
        break;
      }
    }

    const textoBot = transcript.map((x) => x.bot).join('\n');
    let problemas = errorFatal ? [`Error fatal: ${errorFatal}`] : [];
    try {
      problemas = problemas.concat(await esc.verificar(transcript, textoBot));
    } catch (error) {
      problemas.push(`La verificación misma falló: ${error.message}`);
    }

    resumen.push({ nombre: esc.nombre, problemas });
    console.log(problemas.length
      ? `\n  ✗ PROBLEMAS:\n${problemas.map((p) => `    - ${p}`).join('\n')}\n`
      : '\n  ✓ OK\n');
  }

  console.log('═'.repeat(64));
  console.log('RESUMEN');
  console.log('═'.repeat(64));
  let fallas = 0;
  for (const r of resumen) {
    console.log(`  ${r.problemas.length ? '✗' : '✓'} ${r.nombre}${r.problemas.length ? ` (${r.problemas.length})` : ''}`);
    fallas += r.problemas.length;
  }
  console.log(`\n${fallas} problema(s) en total`);
  process.exit(fallas ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
