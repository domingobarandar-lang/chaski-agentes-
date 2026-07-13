# Chaski Agentes

Dos bots de WhatsApp/Telegram, demo/MVP, generados a partir de la misma base (contestador de Gesta). Cada uno atiende como una **empresa ficticia** lista para mostrar en demos comerciales:

- **`agente-citas/`** — reservas de horas. Demo: **Clínica Dental Sonrisa del Valle** (catálogo de servicios dentales, horarios, dirección y equipo inventados).
- **`agente-retail/`** — catálogo, stock y pedidos. Demo: **Frutos Secos La Cosecha** (maní, almendras, nueces, mix, fruta deshidratada; despacho y medios de pago inventados).

Ambos comparten arquitectura: Express + webhook de WhatsApp Cloud API, bot de Telegram opcional, Supabase (o base en memoria si no hay credenciales), y el modelo **Claude vía la API de Anthropic** (`agent/llm.js`, cliente sobre el SDK oficial `@anthropic-ai/sdk`).

## Levantar cada agente

Cada carpeta es un proyecto Node independiente con su propio `package.json` y `.env`.

```bash
cd agente-citas      # o agente-retail
npm install
copy .env.example .env    # si no existe ya
```

### Modo MOCK (recomendado para probar — no gasta ni un token)

No requiere ninguna API key, ni de Anthropic ni de Telegram real. Simula 3 conversaciones de demostración por consola contra el loop completo del agente (tools, memoria, base en memoria):

```bash
npm run telegram:mock
```

### Servidor (webhook de WhatsApp)

```bash
npm start
```

Arranca en el puerto de `.env` (`agente-citas` → 3300, `agente-retail` → 3400 — así pueden correr **simultáneamente**). Sin `WHATSAPP_TOKEN` configurado, los mensajes salientes solo se imprimen por consola (no falla).

### Telegram real (polling, sin webhook)

Requiere `TELEGRAM_BOT_TOKEN` (propio, no compartido — ver más abajo) y `ANTHROPIC_API_KEY` en `.env`:

```bash
npm run telegram
```

### Chat de consola (sin Telegram ni WhatsApp)

```bash
npm run chat
```

Este sí necesita `ANTHROPIC_API_KEY` real (llama al modelo de verdad, no hay modo mock para este script).

## Variables de entorno

| Variable | agente-citas | agente-retail | Notas |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ configurada | ✅ configurada (misma key) | Compartir la key entre ambos bots está bien — el conflicto es solo con el token de Telegram. Necesaria para `npm run chat`, `npm run telegram` (real) y `npm start` con tráfico real; **no** para `telegram:mock`. |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | `claude-haiku-4-5-20251001` | Cambiar sin tocar código si hace falta otro modelo de Anthropic. |
| `MOCK` | `false` | `false` | `MOCK=true` fuerza respuestas simuladas en `telegram/bot.js` y `npm test` sin llamar nunca a Anthropic, aunque haya `ANTHROPIC_API_KEY` configurada. |
| `TELEGRAM_BOT_TOKEN` | ✅ configurado (bot principal) | ⬜ **vacío — falta crear un segundo bot** | Dos bots no pueden compartir token (conflicto 409 de polling). Crear en @BotFather (`/newbot`) y pegar en `agente-retail/.env`. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | ⬜ vacías | ⬜ vacías | ⚠️ El código lee `SUPABASE_ANON_KEY` (no `SUPABASE_KEY`). Sin ellas, cada agente usa una base **en memoria** con datos demo (se resetea al reiniciar). Para persistencia: crear proyecto Supabase y correr **`schema-compartido.sql`** (raíz del repo) — deja las tablas sin RLS, así que la clave `anon` funciona. Verificar con `npm run diagnostico`. |
| `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_ID` / `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_APP_SECRET` | ⬜ vacías | ⬜ vacías | Sin ellas, el webhook corre en modo demo (mensajes salientes por consola). Para producción: app en Meta for Developers + producto WhatsApp Cloud API. |

## Deploy en Railway

Cada agente es un **servicio Railway independiente**, aunque compartan el mismo repo (mismo mecanismo que dos apps en un monorepo). Ambos se despliegan corriendo el bot de Telegram en modo *polling* — no necesitan dominio público, TLS ni webhook.

### 1. Crear los dos servicios

1. En Railway: **New Project → Deploy from GitHub repo** → elegir `chaski-agentes-`.
2. Railway crea un servicio para el repo completo. En **Settings → Root Directory**, poner `agente-citas` (así Railway solo builda/corre esa carpeta).
3. Agregar un segundo servicio al mismo proyecto: **New → GitHub Repo** (mismo repo) → **Settings → Root Directory** → `agente-retail`.
4. Cada carpeta ya trae su propio `railway.toml`, así que Railway detecta automáticamente `builder = "nixpacks"` y `startCommand = "node telegram/bot.js"` — no hace falta configurar el comando de arranque a mano.

### 2. Variables de entorno (Settings → Variables, por servicio)

Los `.env` locales **no se suben** (están en `.gitignore`); las variables se cargan directo en el dashboard de Railway, usando `.env.example` de cada carpeta como referencia:

| Variable | Obligatoria | Notas |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | Token propio por servicio (@BotFather → `/newbot`). **Sin ella, el bot arranca en modo mock**: corre la demo por consola y el proceso termina — no queda un bot "vivo" respondiendo. |
| `ANTHROPIC_API_KEY` | ✅ | Key de la consola de Anthropic (console.anthropic.com). Sin ella, el bot real aborta al arrancar aunque el token de Telegram esté configurado. |
| `ANTHROPIC_MODEL` | Opcional | Default `claude-haiku-4-5-20251001`. |
| `MOCK` | No definir en producción | Dejar sin declarar (o `false`). `true` fuerza el modo demo y el proceso termina solo tras la simulación. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Recomendada | ⚠️ La variable se llama `SUPABASE_ANON_KEY`. Sin ellas, cada reinicio/redeploy del servicio borra citas o pedidos (base en memoria). Correr antes **`schema-compartido.sql`** en el SQL Editor (crea las tablas de ambos agentes sin RLS: la clave `anon` funciona). |
| `PORT` | No usar | El `startCommand` de producción (`telegram/bot.js`) no levanta servidor HTTP — corre por *polling*. `PORT`/Express solo aplican si en el futuro se cambia el `startCommand` a `node index.js` para servir el webhook de WhatsApp. |

### 3. Verificar el deploy

- En **Logs** del servicio debe aparecer `[Telegram] Bot de citas/retail escuchando (polling)…` seguido del **chequeo de salud de la base**: una línea `[DB] ✓ tabla (N filas)` por cada tabla. Si sale `[DB] ⚠️ ...`, el propio log dice qué SQL correr (casi siempre `schema-compartido.sql`). Si el catálogo existe pero está vacío, el bot lo **auto-siembra** con los datos demo.
- Para un dictamen completo desde tu máquina: `npm run diagnostico` en cada carpeta (con las mismas `SUPABASE_URL`/`SUPABASE_ANON_KEY` del servicio en el `.env`) — dice exactamente qué falta y qué SQL correr.
- Escribirle al bot en Telegram (buscarlo por su username) y confirmar que responde. El `/start` debe mostrar **botones** (Ver catálogo / Agendar / etc.).
- Si el proceso termina solo (estado *Crashed* o *Completed* en vez de *Active*) revisar los logs: casi siempre falta `TELEGRAM_BOT_TOKEN` u `ANTHROPIC_API_KEY`, o `MOCK` quedó en `true`.
- `restartPolicyType = "on_failure"` (máx. 3 reintentos) ya está en `railway.toml`: un crash por error transitorio se reintenta solo; un mal arranque por variables faltantes NO se arregla reintentando — hay que corregir las variables.

### Checklist exacto de lo que falta para producción

1. **Segundo token de Telegram** para `agente-retail` (`@BotFather` → `/newbot`).
2. **Supabase** en ambos: crear proyecto, correr **`schema-compartido.sql`** (raíz del repo, una sola vez — crea las tablas de los dos agentes), pegar `SUPABASE_URL` + `SUPABASE_ANON_KEY` en cada `.env`/servicio. Sin esto, cualquier reinicio del proceso borra citas/pedidos (aunque el bot sigue conversando bien: memoria de respaldo en proceso + auto-siembra del catálogo). Verificar con `npm run diagnostico`.
3. **WhatsApp Cloud API** en ambos (si el canal final es WhatsApp y no Telegram): app en Meta for Developers, desplegar el servidor en un dominio público (Railway u otro), configurar el webhook con `WHATSAPP_VERIFY_TOKEN`.
4. **Confirmar que `ANTHROPIC_API_KEY` esté activa y con crédito disponible** antes de tráfico real — en `MOCK=true`/`telegram:mock` nunca se usa, así que no se ha verificado en este proceso.
5. `npm test` en ambos proyectos corre `scripts/test-chat.js`, que cae a modo mock automáticamente si falta `ANTHROPIC_API_KEY` (o si se fuerza con `MOCK=true`) — así que `npm test` nunca gasta crédito por accidente. Para probar contra el modelo real, asegúrate de tener `ANTHROPIC_API_KEY` configurada y `MOCK=false` (o sin definir).

**Estado verificado en modo mock (sin gastar créditos, `MOCK=true`):** `agente-citas` 17/17 escenarios OK, `agente-retail` suite completa OK (27 escenarios + chequeos estáticos, botones incluidos), y `npm run telegram:mock` 3/3 conversaciones OK en ambos. Cubre además los casos de resiliencia: Supabase caído sin perder el contexto de la conversación, herramienta caída sin inventar "no tenemos X" ni confirmar pedidos fantasma, perfil del cliente recordado entre conversaciones y derivación con `anotar_pendiente`. Falta únicamente lo listado en los puntos 1-4 (credenciales reales) para tráfico de producción.

## Experiencia del cliente (Telegram)

- **Botones**: `/start` y `/help` muestran accesos rápidos (inline keyboard); tras mostrar catálogo, agendar o crear un pedido aparecen botones contextuales (p. ej. *Estado de mi pedido*) y siempre un botón *Menú*. Cada botón entra por el mismo loop del agente que un mensaje escrito (`telegram/botones.js`).
- **Memoria confiable**: el historial se persiste en Supabase Y en un respaldo en proceso — si Supabase falla, la conversación no pierde el hilo (y los logs lo avisan).
- **Perfil del cliente**: al agendar una cita o crear un pedido con éxito, el nombre (y la dirección en retail) quedan guardados en la sesión; en la próxima conversación el bot reconoce al cliente por su nombre.
- **Autonomía sin inventar**: si una herramienta falla, el bot lo admite ("tuve un problema técnico"), nunca dice que no hay stock/horas por una falla ni confirma acciones no realizadas, y puede dejar el encargo **anotado** (`anotar_pendiente`, visible en los logs como `[Pendiente] ...`) para que el negocio responda por el mismo chat.

## Estructura (igual en ambos proyectos)

```
agente-*/
├── index.js               # Servidor Express (webhook WhatsApp) + salud
├── whatsapp/               # webhook.js (verify + mensajes) + sender.js (Graph API o consola)
├── telegram/bot.js         # Polling real, o modo mock sin ninguna credencial
├── agent/
│   ├── core.js            # Loop agéntico: historial → modelo → tools → respuesta
│   ├── llm.js              # Cliente de Anthropic (@anthropic-ai/sdk) — formato Anthropic Messages nativo
│   ├── prompts.js / tools.js / memory.js
├── database/                # supabase.js (CRUD + fallback en memoria) + schema.sql
└── scripts/                 # chat-local.js, test-chat.js
```
