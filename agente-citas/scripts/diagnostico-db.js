// Diagnóstico del Supabase del agente de citas.
// Uso: node scripts/diagnostico-db.js   (lee SUPABASE_URL / SUPABASE_ANON_KEY del .env)
//
// Dictamina exactamente qué le falta a la base real (tablas, columna perfil,
// catálogo desactualizado) y qué SQL correr en el SQL Editor de Supabase.
// No usa la API de Anthropic ni Telegram: solo consulta la base. Termina con
// exit code 1 si encontró problemas.

require('dotenv').config();

const { db, usandoMemoria, reportarSalud, CATALOGO_DEMO } = require('../database/supabase');

async function main() {
  console.log('═'.repeat(64));
  console.log('Diagnóstico de base de datos — agente de citas (Clínica Dental)');
  console.log('═'.repeat(64));

  if (usandoMemoria) {
    console.log('SUPABASE_URL / SUPABASE_ANON_KEY no están configuradas.');
    console.log('El agente usa la base EN MEMORIA con los datos demo — nada que diagnosticar.');
    console.log('Para persistencia real: crear proyecto en Supabase, correr schema-compartido.sql');
    console.log('(raíz del repo) en el SQL Editor, y pegar las credenciales en .env / Railway.');
    return;
  }

  const salud = await reportarSalud();
  const acciones = [];

  const tablasMalas = (salud.estados ?? []).filter((e) => !e.ok && !e.tabla.includes('.'));
  const faltaPerfil = (salud.estados ?? []).some((e) => e.tabla === 'citas_sesiones.perfil' && !e.ok);

  if (salud.error || tablasMalas.length) {
    acciones.push('Correr schema-compartido.sql COMPLETO (raíz del repo) en el SQL Editor de Supabase — crea las tablas de los dos agentes con RLS deshabilitado.');
  } else {
    if (faltaPerfil) {
      acciones.push('Falta la columna del perfil del cliente. Correr:\n     alter table citas_sesiones add column if not exists perfil jsonb;');
    }
    // ¿El catálogo tiene los datos de la demo dental o quedó uno antiguo?
    try {
      const items = await db.catalogo.listar();
      const esperado = CATALOGO_DEMO[1].nombre; // 'Limpieza dental'
      const tieneEsperado = items.some((s) => s.nombre === esperado);
      if (items.length && !tieneEsperado) {
        console.log(`\n[Catálogo] ⚠️ Hay ${items.length} servicios pero NO son los de la demo dental (falta "${esperado}").`);
        console.log('[Catálogo] Primeros nombres encontrados:', items.slice(0, 5).map((s) => s.nombre).join(' | '));
        acciones.push('Catálogo desactualizado (datos de una demo anterior). En el SQL Editor correr:\n     delete from catalogo;\n   y luego el insert de catalogo de schema-compartido.sql (o reiniciar el bot: la auto-siembra puebla la tabla si queda vacía).');
      } else if (!items.length) {
        console.log('\n[Catálogo] Vacío — el bot lo auto-siembra al arrancar (o corre el insert de schema-compartido.sql).');
      } else {
        console.log(`\n[Catálogo] ✓ ${items.length} servicios de la demo dental presentes.`);
      }
    } catch (error) {
      console.log(`\n[Catálogo] ⚠️ No se pudo leer: ${error.message}`);
    }
  }

  console.log('\n' + '═'.repeat(64));
  if (!acciones.length) {
    console.log('VEREDICTO: ✅ La base está lista para la demo.');
  } else {
    console.log('VEREDICTO: ⚠️ Acciones pendientes (en este orden):');
    acciones.forEach((a, i) => console.log(`${i + 1}. ${a}`));
    process.exitCode = 1;
  }
  console.log('═'.repeat(64));
}

main().catch((error) => {
  console.error('Error inesperado en el diagnóstico:', error.message);
  process.exitCode = 1;
});
