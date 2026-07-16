# Chaski Agentes

Dos bots de WhatsApp/Telegram, demo/MVP, generados a partir de la misma base (contestador de Gesta). Cada uno atiende como una **empresa ficticia** lista para mostrar en demos comerciales:

- **`agente-citas/`** — reservas de horas. Demo: **Clínica Dental Sonrisa del Valle** (catálogo de servicios dentales, horarios, dirección y equipo inventados).
- **`agente-retail/`** — catálogo, stock y pedidos. Demo: **Frutos Secos La Cosecha** (maní, almendras, nueces, mix, fruta deshidratada; despacho y medios de pago inventados).

Ambos comparten arquitectura: Express + webhook de WhatsApp Cloud API, bot de Telegram opcional, Supabase (o base en memoria si no hay credenciales), y un **adapter LLM multi-proveedor** (`agent/llm.js`): por defecto Claude vía la API de Anthropic, pero cambiando variables de entorno (`LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL`) corre con Gemini, Groq, DeepSeek, OpenRouter, Ollama o cualquier endpoint OpenAI-compatible — sin tocar código.

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

Requiere el token del bot en `.env` — la variable es **`TELEGRAM_TOKEN_CITAS`** en `agente-citas` y **`TELEGRAM_TOKEN_RETAIL`** en `agente-retail` (propio por agente, no compartido) — más una key de LLM (`ANTHROPIC_API_KEY`, o `LLM_API_KEY` si usas otro proveedor):

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
| `TELEGRAM_TOKEN_CITAS` / `TELEGRAM_TOKEN_RETAIL` | ✅ configurado (bot principal) | ⬜ **vacío — falta crear un segundo bot** | ⚠️ El código lee `TELEGRAM_TOKEN_CITAS` (citas) y `TELEGRAM_TOKEN_RETAIL` (retail) — no `TELEGRAM_BOT_TOKEN`. Dos bots no pueden compartir token (conflicto 409 de polling). Crear en @BotFather (`/newbot`). |
| `TELEGRAM_CHAT_DUENO` | ⬜ opcional | ⬜ opcional | Chat de Telegram del dueño del negocio: recibe aviso automático de cada cita/pedido nuevo, cancelación y pendiente. Obtener el id con @userinfobot. Vacío = los avisos quedan solo en los logs. |
| `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_MODEL` | ⬜ opcionales | ⬜ opcionales | Adapter multi-proveedor: `gemini` (free tier — demo a costo $0), `groq`, `deepseek`, `openrouter`, `ollama`, `openai-compat`. Sin definir = Anthropic con `ANTHROPIC_API_KEY`. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | ⬜ vacías | ⬜ vacías | ⚠️ El código lee `SUPABASE_ANON_KEY` (no `SUPABASE_KEY`). Sin ellas, cada agente usa una base **en memoria** con datos demo (se resetea al reiniciar). Para persistencia: crear proyecto Supabase y correr **`schema-compartido.sql`** (raíz del repo) — deja las tablas sin RLS, así que la clave `anon` funciona. Verificar con `npm run diagnostico`. |
| `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_ID` / `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_APP_SECRET` | ⬜ vacías | ⬜ vacías | Sin ellas, el webhook corre en modo demo (mensajes salientes por consola). Para producción: app en Meta for Developers + producto WhatsApp Cloud API. |

## Deploy en Railway

**Esquema actual (Opción A, el que corre hoy): UN solo servicio con los dos bots de Telegram.** El `railway.toml` de la raíz arranca `node index.js`, que levanta `agente-citas` y `agente-retail` en el mismo proceso, cada uno con su propio token. Por *polling* — no necesita dominio público, TLS ni webhook. **Decisión del dueño (2026-07-16): los demos viven SOLO en Telegram**; el código de WhatsApp queda en el repo para los clones de producción, pero no se despliega en la demo.

### 1. Crear el servicio

1. En Railway: **New Project → Deploy from GitHub repo** → elegir `chaski-agentes-` (sin tocar Root Directory: la raíz es la que trae `railway.toml` + `nixpacks.toml` con Node 22).
2. Railway detecta `builder = "nixpacks"` y `startCommand = "node index.js"` automáticamente.

> Alternativa (dos servicios independientes): crear dos servicios sobre el mismo repo con **Settings → Root Directory** = `agente-citas` y `agente-retail`; cada carpeta trae su `railway.toml` con `startCommand = "node telegram/bot.js"`. Las variables son las mismas de abajo, cada servicio con su token.

### 2. Variables de entorno (Settings → Variables)

Los `.env` locales **no se suben** (están en `.gitignore`); las variables se cargan directo en el dashboard de Railway, usando `.env.example` de cada carpeta como referencia:

| Variable | Obligatoria | Notas |
|---|---|---|
| `TELEGRAM_TOKEN_CITAS` y `TELEGRAM_TOKEN_RETAIL` | ✅ | Un token por bot (@BotFather → `/newbot`). ⚠️ Estos son los nombres que lee el código — no `TELEGRAM_BOT_TOKEN`. **Si falta un token en producción, el proceso aborta con error explícito** (exit 1) en vez de caer a modo mock en silencio. |
| `ANTHROPIC_API_KEY` | ✅ (proveedor default) | Key de console.anthropic.com. Con `LLM_PROVIDER` definido, la obligatoria pasa a ser `LLM_API_KEY` del proveedor elegido. |
| `ANTHROPIC_MODEL` / `LLM_MODEL` | Opcional | Default `claude-haiku-4-5-20251001`. `LLM_MODEL` manda con cualquier proveedor del adapter. |
| `TELEGRAM_CHAT_DUENO` | Recomendada | Chat del dueño: recibe aviso de cada cita/pedido/cancelación/pendiente. Sin ella, los avisos quedan solo en los logs. |
| `MOCK` | No definir en producción | Dejar sin declarar (o `false`). `true` fuerza el modo demo y el proceso termina solo tras la simulación. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Recomendada | ⚠️ La variable se llama `SUPABASE_ANON_KEY`. Sin ellas, cada reinicio/redeploy del servicio borra citas o pedidos (base en memoria). Correr antes **`schema-compartido.sql`** en el SQL Editor (crea las tablas de ambos agentes sin RLS: la clave `anon` funciona). |
| `PORT` | No usar | El deploy de demo no levanta servidor HTTP — corre por *polling*. `PORT`/Express solo aplican al desplegar el webhook de WhatsApp en un clon de producción. |

### 3. Verificar el deploy

- En **Logs** del servicio debe aparecer `[Telegram] Bot de citas/retail escuchando (polling)…` seguido del **chequeo de salud de la base**: una línea `[DB] ✓ tabla (N filas)` por cada tabla. Si sale `[DB] ⚠️ ...`, el propio log dice qué SQL correr (casi siempre `schema-compartido.sql`). Si el catálogo existe pero está vacío, el bot lo **auto-siembra** con los datos demo.
- Para un dictamen completo desde tu máquina: `npm run diagnostico` en cada carpeta (con las mismas `SUPABASE_URL`/`SUPABASE_ANON_KEY` del servicio en el `.env`) — dice exactamente qué falta y qué SQL correr.
- Escribirle al bot en Telegram (buscarlo por su username) y confirmar que responde. El `/start` debe mostrar **botones** (Ver catálogo / Agendar / etc.).
- Si el proceso termina solo (estado *Crashed* en vez de *Active*) revisar los logs: casi siempre falta `TELEGRAM_TOKEN_CITAS`/`TELEGRAM_TOKEN_RETAIL` o la key del LLM, o `MOCK` quedó en `true`. En producción estos errores ahora se anuncian con mensaje explícito antes de abortar.
- `restartPolicyType = "on_failure"` (máx. 3 reintentos) ya está en `railway.toml`: un crash por error transitorio se reintenta solo; un mal arranque por variables faltantes NO se arregla reintentando — hay que corregir las variables.

### Checklist exacto de lo que falta para producción

1. **Segundo token de Telegram** para `agente-retail` (`@BotFather` → `/newbot`).
2. **Supabase** en ambos: crear proyecto, correr **`schema-compartido.sql`** (raíz del repo, una sola vez — crea las tablas de los dos agentes), pegar `SUPABASE_URL` + `SUPABASE_ANON_KEY` en cada `.env`/servicio. Sin esto, cualquier reinicio del proceso borra citas/pedidos (aunque el bot sigue conversando bien: memoria de respaldo en proceso + auto-siembra del catálogo). Verificar con `npm run diagnostico`.
3. **WhatsApp Cloud API** — solo para clones de producción de un cliente real (la demo es Telegram-only por decisión del dueño): app en Meta for Developers, desplegar el servidor en un dominio público, configurar el webhook con `WHATSAPP_VERIFY_TOKEN`.
4. **Confirmar que `ANTHROPIC_API_KEY` esté activa y con crédito disponible** antes de tráfico real — en `MOCK=true`/`telegram:mock` nunca se usa, así que no se ha verificado en este proceso.
5. `npm test` en ambos proyectos corre `scripts/test-chat.js`, que cae a modo mock automáticamente si falta `ANTHROPIC_API_KEY` (o si se fuerza con `MOCK=true`) — así que `npm test` nunca gasta crédito por accidente. Para probar contra el modelo real, asegúrate de tener `ANTHROPIC_API_KEY` configurada y `MOCK=false` (o sin definir).

**Estado verificado en modo mock (sin gastar créditos, `MOCK=true`):** `agente-citas` 17/17 escenarios OK, `agente-retail` suite completa OK (27 escenarios + chequeos estáticos, botones incluidos), y `npm run telegram:mock` 3/3 conversaciones OK en ambos. Cubre además los casos de resiliencia: Supabase caído sin perder el contexto de la conversación, herramienta caída sin inventar "no tenemos X" ni confirmar pedidos fantasma, perfil del cliente recordado entre conversaciones y derivación con `anotar_pendiente`. Falta únicamente lo listado en los puntos 1-4 (credenciales reales) para tráfico de producción.

## Experiencia del cliente (Telegram)

- **Botones**: `/start` y `/help` muestran accesos rápidos (inline keyboard); tras mostrar catálogo, agendar o crear un pedido aparecen botones contextuales (p. ej. *Estado de mi pedido*) y siempre un botón *Menú*. Cada botón entra por el mismo loop del agente que un mensaje escrito (`telegram/botones.js`).
- **Memoria confiable**: el historial se persiste en Supabase Y en un respaldo en proceso — si Supabase falla, la conversación no pierde el hilo (y los logs lo avisan).
- **Perfil del cliente**: al agendar una cita o crear un pedido con éxito, el nombre (y la dirección en retail) quedan guardados en la sesión; en la próxima conversación el bot reconoce al cliente por su nombre.
- **Autonomía sin inventar**: si una herramienta falla, el bot lo admite ("tuve un problema técnico"), nunca dice que no hay stock/horas por una falla ni confirma acciones no realizadas, y puede dejar el encargo **anotado** (`anotar_pendiente`, visible en los logs como `[Pendiente] ...`) para que el negocio responda por el mismo chat.
- **El dueño se entera al instante**: cada cita/pedido nuevo, cancelación o pendiente dispara un aviso por Telegram al chat configurado en `TELEGRAM_CHAT_DUENO` (`agent/avisos.js`) — sin configurar, queda en los logs.
- **Agenda sin doble reserva** (citas): la disponibilidad ocupa la **duración real** del servicio según el catálogo — un blanqueamiento de 90 min a las 10:00 bloquea también las 11:00.

## Estructura (igual en ambos proyectos)

```
agente-*/
├── index.js               # Servidor Express (webhook WhatsApp) + salud
├── whatsapp/               # webhook.js (verify + mensajes) + sender.js (Graph API o consola)
├── telegram/bot.js         # Polling real, o modo mock sin ninguna credencial
├── agent/
│   ├── core.js            # Loop agéntico: historial → modelo → tools → respuesta
│   ├── llm.js              # Adapter LLM multi-proveedor (Anthropic default; Gemini/Groq/DeepSeek/etc. por env)
│   ├── avisos.js           # Aviso al dueño por Telegram (cita/pedido/pendiente)
│   ├── prompts.js / tools.js / memory.js
├── database/                # supabase.js (CRUD + fallback en memoria) + schema.sql
└── scripts/                 # chat-local.js, test-chat.js
```
