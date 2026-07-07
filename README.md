# Chaski Agentes

Dos bots de WhatsApp/Telegram, demo/MVP, generados a partir de la misma base (contestador de Gesta):

- **`agente-citas/`** — reservas de horas (dentista, restaurante, servicios).
- **`agente-retail/`** — catálogo, stock y pedidos (abarrotes, mariscos, pet shop).

Ambos comparten arquitectura: Express + webhook de WhatsApp Cloud API, bot de Telegram opcional, Supabase (o base en memoria si no hay credenciales), y el modelo vía **OpenRouter** (`agent/llm.js`, API compatible con OpenAI — no el SDK de Anthropic directo).

## Levantar cada agente

Cada carpeta es un proyecto Node independiente con su propio `package.json` y `.env`.

```bash
cd agente-citas      # o agente-retail
npm install
copy .env.example .env    # si no existe ya
```

### Modo MOCK (recomendado para probar — no gasta ni un token)

No requiere ninguna API key, ni de OpenRouter ni de Telegram real. Simula 3 conversaciones de demostración por consola contra el loop completo del agente (tools, memoria, base en memoria):

```bash
npm run telegram:mock
```

### Servidor (webhook de WhatsApp)

```bash
npm start
```

Arranca en el puerto de `.env` (`agente-citas` → 3300, `agente-retail` → 3400 — así pueden correr **simultáneamente**). Sin `WHATSAPP_TOKEN` configurado, los mensajes salientes solo se imprimen por consola (no falla).

### Telegram real (polling, sin webhook)

Requiere `TELEGRAM_BOT_TOKEN` (propio, no compartido — ver más abajo) y `OPENROUTER_API_KEY` en `.env`:

```bash
npm run telegram
```

### Chat de consola (sin Telegram ni WhatsApp)

```bash
npm run chat
```

Este sí necesita `OPENROUTER_API_KEY` real (llama al modelo de verdad, no hay modo mock para este script).

## Variables de entorno

| Variable | agente-citas | agente-retail | Notas |
|---|---|---|---|
| `OPENROUTER_API_KEY` | ✅ configurada | ✅ configurada (misma key) | Compartir la key entre ambos bots está bien — el conflicto es solo con el token de Telegram. Necesaria para `npm run chat`, `npm run telegram` (real) y `npm start` con tráfico real; **no** para `telegram:mock`. |
| `OPENROUTER_MODEL` | `anthropic/claude-sonnet-4.5` | `anthropic/claude-sonnet-4.5` | Cambiar sin tocar código si hace falta otro modelo de OpenRouter. |
| `MOCK` | `false` | `false` | `MOCK=true` fuerza respuestas simuladas en `telegram/bot.js` y `npm test` sin llamar nunca a OpenRouter, aunque haya `OPENROUTER_API_KEY` configurada. |
| `TELEGRAM_BOT_TOKEN` | ✅ configurado (bot principal) | ⬜ **vacío — falta crear un segundo bot** | Dos bots no pueden compartir token (conflicto 409 de polling). Crear en @BotFather (`/newbot`) y pegar en `agente-retail/.env`. |
| `SUPABASE_URL` / `SUPABASE_KEY` | ⬜ vacías | ⬜ vacías | Sin ellas, cada agente usa una base **en memoria** con datos demo (se resetea al reiniciar). Para producción: crear proyecto Supabase, correr `database/schema.sql`, y usar la clave **service_role** (la `anon` da *permission denied* con RLS). |
| `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_ID` / `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_APP_SECRET` | ⬜ vacías | ⬜ vacías | Sin ellas, el webhook corre en modo demo (mensajes salientes por consola). Para producción: app en Meta for Developers + producto WhatsApp Cloud API. |

### Checklist exacto de lo que falta para producción

1. **Segundo token de Telegram** para `agente-retail` (`@BotFather` → `/newbot`).
2. **Supabase** en ambos: crear proyecto, correr `database/schema.sql`, pegar `SUPABASE_URL` + `SUPABASE_KEY` (service_role) en cada `.env`. Sin esto, cualquier reinicio del proceso borra citas/pedidos.
3. **WhatsApp Cloud API** en ambos (si el canal final es WhatsApp y no Telegram): app en Meta for Developers, desplegar el servidor en un dominio público (Railway u otro), configurar el webhook con `WHATSAPP_VERIFY_TOKEN`.
4. **Confirmar que `OPENROUTER_API_KEY` tiene crédito activo** antes de tráfico real — en `MOCK=true`/`telegram:mock` nunca se usa, así que no se ha verificado en este proceso.
5. `npm test` en ambos proyectos corre `scripts/test-chat.js`, que cae a modo mock automáticamente si falta `OPENROUTER_API_KEY` (o si se fuerza con `MOCK=true`) — así que `npm test` nunca gasta créditos por accidente. Para probar contra el modelo real, asegúrate de tener `OPENROUTER_API_KEY` con crédito y `MOCK=false` (o sin definir).

## Estructura (igual en ambos proyectos)

```
agente-*/
├── index.js               # Servidor Express (webhook WhatsApp) + salud
├── whatsapp/               # webhook.js (verify + mensajes) + sender.js (Graph API o consola)
├── telegram/bot.js         # Polling real, o modo mock sin ninguna credencial
├── agent/
│   ├── core.js            # Loop agéntico: historial → modelo → tools → respuesta
│   ├── llm.js              # Adaptador OpenRouter (formato Anthropic Messages ↔ OpenAI chat.completions)
│   ├── prompts.js / tools.js / memory.js
├── database/                # supabase.js (CRUD + fallback en memoria) + schema.sql
└── scripts/                 # chat-local.js, test-chat.js
```
