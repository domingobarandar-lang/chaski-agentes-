// Diagnóstico del Supabase del agente de retail.
// Uso: node scripts/diagnostico-db.js   (lee SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY del .env)
//
// Dictamina exactamente qué le falta a la base real (tablas, columna perfil,
// catálogo desactualizado) y qué SQL correr en el SQL Editor de Supabase.
// No usa la API de Anthropic ni Telegram: solo consulta la base. Termina con
// exit code 1 si encontró problemas.

require('dotenv').config();

const { db, usandoMemoria, reportarSalud, productosDemo } = require('../database/supabase');

async function main() {
  console.log('═'.repeat(64));
  console.log('Diagnóstico de base de datos — agente de retail (Frutos Secos)');
  console.log('═'.repeat(64));

  if (usandoMemoria) {
    console.log('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no están configuradas.');
    console.log('El agente usa la base EN MEMORIA con los productos demo — nada que diagnosticar.');
    console.log('Para persistencia real: crear proyecto en Supabase, correr schema-compartido.sql');
    console.log('(raíz del repo) en el SQL Editor, y pegar las credenciales en .env / Railway.');
    return;
  }

  const salud = await reportarSalud();
  const acciones = [];

  const tablasMalas = (salud.estados ?? []).filter((e) => !e.ok && !e.tabla.includes('.'));
  const faltaPerfil = (salud.estados ?? []).some((e) => e.tabla === 'retail_sesiones.perfil' && !e.ok);

  if (salud.error || tablasMalas.length) {
    acciones.push('Correr schema-compartido.sql COMPLETO (raíz del repo) en el SQL Editor de Supabase — crea las tablas de los dos agentes con RLS activado (el bot entra con SUPABASE_SERVICE_ROLE_KEY).');
  } else {
    if (faltaPerfil) {
      acciones.push('Falta la columna del perfil del cliente. Correr:\n     alter table retail_sesiones add column if not exists perfil jsonb;');
    }
    // ¿El catálogo tiene los productos de la demo de frutos secos o quedó uno antiguo?
    try {
      const items = await db.productos.buscar();
      const esperado = productosDemo()[2].nombre; // 'Almendras (kg)'
      const tieneEsperado = items.some((p) => p.nombre === esperado);
      if (items.length && !tieneEsperado) {
        console.log(`\n[Catálogo] ⚠️ Hay ${items.length} productos pero NO son los de la demo de frutos secos (falta "${esperado}").`);
        console.log('[Catálogo] Primeros nombres encontrados:', items.slice(0, 5).map((p) => p.nombre).join(' | '));
        acciones.push('Catálogo desactualizado (datos de una demo anterior). En el SQL Editor correr (el orden importa por las FK):\n     delete from pedido_items;\n     delete from pedidos;\n     delete from productos;\n   y luego el insert de productos de schema-compartido.sql (o reiniciar el bot: la auto-siembra puebla la tabla si queda vacía).');
      } else if (!items.length) {
        console.log('\n[Catálogo] Vacío — el bot lo auto-siembra al arrancar (o corre el insert de schema-compartido.sql).');
      } else {
        console.log(`\n[Catálogo] ✓ ${items.length} productos de la demo de frutos secos presentes.`);
      }
    } catch (error) {
      console.log(`\n[Catálogo] ⚠️ No se pudo leer: ${error.message}`);
    }

    // ¿La base ACEPTA escrituras con la clave del servidor? Con RLS activado las
    // lecturas devuelven vacío (sin error) y las escrituras fallan: el bot
    // "funcionaría" pero ningún pedido se guardaría. Sonda inofensiva:
    // upsert + delete de una fila de sesión de diagnóstico.
    try {
      const { error } = await db.supabase
        .from('retail_sesiones')
        .upsert({ telefono: '__diagnostico__', messages: [] }, { onConflict: 'telefono' });
      if (error) throw new Error(error.message);
      await db.supabase.from('retail_sesiones').delete().eq('telefono', '__diagnostico__');
      console.log('\n[Escritura] ✓ La base acepta escrituras con la clave del servidor.');
    } catch (error) {
      console.log(`\n[Escritura] ❌ La base NO acepta escrituras con la clave del servidor: ${error.message}`);
      acciones.push('Usar SUPABASE_SERVICE_ROLE_KEY (Supabase → Project Settings → API) en el .env del servidor. Con RLS activado —como debe quedar— la clave anon no puede escribir. NO desactives RLS: sin RLS, cualquiera con la clave anon (que es pública) lee los datos de clientes.');
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
