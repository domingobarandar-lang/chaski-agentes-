# Chaski Agentes

Dos bots de WhatsApp/Telegram, demo/MVP, generados a partir de la misma base (contestador de Gesta):

- **`agente-citas/`** — reservas de horas (dentista, restaurante, servicios).
- **`agente-retail/`** — catálogo, stock y pedidos (abarrotes, mariscos, pet shop).

Ambos comparten arquitectura: Express + webhook de WhatsApp Cloud API, bot de Telegram opcional, Supabase (o base en memoria si no hay credenciales), y el modelo **Gemini vía Google AI Studio** (`agent/llm.js`, adaptador propio — expone el formato de mensajes de Anthropic hacia el resto del agente).

## Levantar cada agente

Cada carpeta es un proyecto Node independiente con su propio `package.json` y `.env`.

```bash
cd agente-citas      # o agente-retail
npm install
copy .env.example .env    # si no existe ya
```

### Modo MOCK (recomendado para probar — no gasta ni un token)

No requiere ninguna API key, ni de Gemini ni de Telegram real. Simula 3 conversaciones de demostración por consola contra el loop completo del agente (tools, memoria, base en memoria):

```bash
npm run telegram:mock
```

### Servidor (webhook de WhatsApp)

```bash
npm start
```

Arranca en el puerto de `.env` (`agente-citas` → 3300, `agente-retail` → 3400 — así pueden correr **simultáneamente**). Sin `WHATSAPP_TOKEN` configurado, los mensajes salientes solo se imprimen por consola (no falla).

### Telegram real (polling, sin webhook)

Requiere `TELEGRAM_BOT_TOKEN` (propio, no compartido — ver más abajo) y `GEMINI_API_KEY` en `.env`:

```bash
npm run telegram
```

### Chat de consola (sin Telegram ni WhatsApp)

```bash
npm run chat
```

Este sí necesita `GEMINI_API_KEY` real (llama al modelo de verdad, no hay modo mock para este script).

## Variables de entorno

| Variable | agente-citas | agente-retail | Notas |
|---|---|---|---|
| `GEMINI_API_KEY` | ✅ configurada | ✅ configurada (misma key) | Compartir la key entre ambos bots está bien — el conflicto es solo con el token de Telegram. Necesaria para `npm run chat`, `npm run telegram` (real) y `npm start` con tráfico real; **no** para `telegram:mock`. |
| `GEMINI_MODEL` | `gemini-2.0-flash` | `gemini-2.0-flash` | Cambiar sin tocar código si hace falta otro modelo de Google AI Studio. |
| `MOCK` | `false` | `false` | `MOCK=true` fuerza respuestas simuladas en `telegram/bot.js` y `npm test` sin llamar nunca a Gemini, aunque haya `GEMINI_API_KEY` configurada. |
| `TELEGRAM_BOT_TOKEN` | ✅ configurado (bot principal) | ⬜ **vacío — falta crear un segundo bot** | Dos bots no pueden compartir token (conflicto 409 de polling). Crear en @BotFather (`/newbot`) y pegar en `agente-retail/.env`. |
| `SUPABASE_URL` / `SUPABASE_KEY` | ⬜ vacías | ⬜ vacías | Sin ellas, cada agente usa una base **en memoria** con datos demo (se resetea al reiniciar). Para producción: crear proyecto Supabase, correr `database/schema.sql`, y usar la clave **service_role** (la `anon` da *permission denied* con RLS). |
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
| `GEMINI_API_KEY` | ✅ | Key de Google AI Studio (gratis, con cuota). Sin ella, el bot real aborta al arrancar aunque el token de Telegram esté configurado. |
| `GEMINI_MODEL` | Opcional | Default `gemini-2.0-flash`. |
| `MOCK` | No definir en producción | Dejar sin declarar (o `false`). `true` fuerza el modo demo y el proceso termina solo tras la simulación. |
| `SUPABASE_URL` / `SUPABASE_KEY` | Recomendada | Sin ellas, cada reinicio/redeploy del servicio borra citas o pedidos (base en memoria). Usar la clave **service_role**, no `anon`. |
| `PORT` | No usar | El `startCommand` de producción (`telegram/bot.js`) no levanta servidor HTTP — corre por *polling*. `PORT`/Express solo aplican si en el futuro se cambia el `startCommand` a `node index.js` para servir el webhook de WhatsApp. |

### 3. Verificar el deploy

- En **Logs** del servicio debe aparecer `[Telegram] Bot de citas/retail escuchando (polling)…` seguido de `[DB] Conexión a Supabase OK` (o el warning de base en memoria, si Supabase aún no está configurado).
- Escribirle al bot en Telegram (buscarlo por su username) y confirmar que responde.
- Si el proceso termina solo (estado *Crashed* o *Completed* en vez de *Active*) revisar los logs: casi siempre falta `TELEGRAM_BOT_TOKEN` u `GEMINI_API_KEY`, o `MOCK` quedó en `true`.
- `restartPolicyType = "on_failure"` (máx. 3 reintentos) ya está en `railway.toml`: un crash por error transitorio se reintenta solo; un mal arranque por variables faltantes NO se arregla reintentando — hay que corregir las variables.

### Checklist exacto de lo que falta para producción

1. **Segundo token de Telegram** para `agente-retail` (`@BotFather` → `/newbot`).
2. **Supabase** en ambos: crear proyecto, correr `database/schema.sql`, pegar `SUPABASE_URL` + `SUPABASE_KEY` (service_role) en cada `.env`. Sin esto, cualquier reinicio del proceso borra citas/pedidos.
3. **WhatsApp Cloud API** en ambos (si el canal final es WhatsApp y no Telegram): app en Meta for Developers, desplegar el servidor en un dominio público (Railway u otro), configurar el webhook con `WHATSAPP_VERIFY_TOKEN`.
4. **Confirmar que `GEMINI_API_KEY` esté activa y dentro de su cuota** antes de tráfico real — en `MOCK=true`/`telegram:mock` nunca se usa, así que no se ha verificado en este proceso.
5. `npm test` en ambos proyectos corre `scripts/test-chat.js`, que cae a modo mock automáticamente si falta `GEMINI_API_KEY` (o si se fuerza con `MOCK=true`) — así que `npm test` nunca gasta cuota por accidente. Para probar contra el modelo real, asegúrate de tener `GEMINI_API_KEY` configurada y `MOCK=false` (o sin definir).

**Estado verificado en modo mock (sin gastar créditos, `MOCK=true`):** `agente-citas` 13/13 escenarios OK, `agente-retail` 24/24 (23 escenarios + chequeos estáticos) OK, y `npm run telegram:mock` 3/3 conversaciones OK en ambos. Esto confirma que el loop del agente, las herramientas y la memoria funcionan — falta únicamente lo listado en los puntos 1-4 (credenciales reales) para tráfico de producción.

## Estructura (igual en ambos proyectos)

```
agente-*/
├── index.js               # Servidor Express (webhook WhatsApp) + salud
├── whatsapp/               # webhook.js (verify + mensajes) + sender.js (Graph API o consola)
├── telegram/bot.js         # Polling real, o modo mock sin ninguna credencial
├── agent/
│   ├── core.js            # Loop agéntico: historial → modelo → tools → respuesta
│   ├── llm.js              # Adaptador Gemini (formato Anthropic Messages ↔ generateContent de Google AI Studio)
│   ├── prompts.js / tools.js / memory.js
├── database/                # supabase.js (CRUD + fallback en memoria) + schema.sql
└── scripts/                 # chat-local.js, test-chat.js
```
