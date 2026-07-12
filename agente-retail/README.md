# Agente de Retail — WhatsApp (demo/MVP)

Chatbot de WhatsApp para comercios al por menor. En esta demo el bot atiende como **"Frutos Secos La Cosecha"**, una **empresa ficticia** que vende frutos secos y fruta deshidratada (maní, almendras, nueces, mix, pasas...), con catálogo, stock, despacho y datos de contacto inventados — pensada para mostrar el producto a clientes potenciales (el mismo agente sirve para almacenes, pet shops, pescaderías, etc. cambiando catálogo y prompt).

**Alcance limitado por diseño:**

1. Mostrar/buscar productos del catálogo
2. Consultar stock y precios
3. Tomar pedidos (descuenta stock)
4. Informar el estado del último pedido

Cualquier otra petición la rechaza amablemente.

## Stack

- **Node.js + Express** — webhook de Meta WhatsApp Cloud API
- **Claude (claude-haiku-4-5-20251001) vía la API de Anthropic** (`agent/llm.js`, cliente sobre el SDK oficial `@anthropic-ai/sdk`)
- **Supabase** — historial, productos, pedidos (`database/schema.sql`)

## Estructura

```
agente-retail/
├── index.js               # Servidor Express + salud + arranque
├── whatsapp/
│   ├── webhook.js         # GET verify + POST mensajes (firma de Meta validada)
│   └── sender.js          # Envío vía Graph API (o consola en modo demo)
├── telegram/
│   └── bot.js             # Bot de Telegram (polling) — o modo mock sin token
├── agent/
│   ├── core.js            # Loop agéntico: historial → Claude → tools → respuesta
│   ├── prompts.js         # System prompt de la tienda ficticia (datos demo)
│   ├── tools.js           # buscar_productos / consultar_stock / crear_pedido / consultar_pedido
│   └── memory.js          # Historial por teléfono (ventana de 30 mensajes)
├── database/
│   ├── supabase.js        # CRUD + fallback en memoria si no hay credenciales
│   └── schema.sql         # Tablas + productos de ejemplo
└── scripts/chat-local.js  # Chat por consola sin WhatsApp
```

## Probar en 2 minutos (sin WhatsApp ni Supabase)

```bash
cd agente-retail
npm install
copy .env.example .env      # y pegar tu ANTHROPIC_API_KEY
npm run chat
```

Sin credenciales de Supabase el agente usa una base **en memoria** con los 10 productos demo de la tienda ficticia (frutos secos al kilo, mix, fruta deshidratada y mantequilla de maní).

Ejemplos para probar:

- "Hola, ¿qué venden?"
- "¿Tienen almendras? ¿A cuánto el kilo?"
- "Quiero 2 kilos de almendras y una bolsa de mix"
- "¿Hacen despacho? ¿Cuánto cuesta?"
- "¿Cómo va mi pedido?"

## Conectar Supabase

1. Crear un proyecto en Supabase.
2. Ejecutar `database/schema.sql` en el **SQL Editor** (crea tablas + productos demo).
3. En `.env`: `SUPABASE_URL` y `SUPABASE_KEY` con la clave **service_role** (⚠️ la clave `anon` da *permission denied*).
4. Cargar los productos reales del comercio en la tabla `productos` (y ajustar el nombre/datos del negocio en `agent/prompts.js`).

## Conectar Telegram (gratis — ideal para demos)

Telegram no exige cuenta de empresa ni verificación de Meta: el bot se crea en 1 minuto y es gratis.

1. En Telegram, abrir un chat con **@BotFather** (el bot oficial, con check azul).
2. Enviar `/newbot`; te pedirá un nombre visible (ej: *Tienda Demo*) y un username terminado en `bot` (ej: `agente_retail_demo_bot`).
3. BotFather responde con el **token** (formato `123456789:AAF...`). Copiarlo a `.env`:
   ```
   TELEGRAM_BOT_TOKEN=123456789:AAF...
   ```
4. Arrancar el bot (usa *polling*, no necesita webhook ni dominio público):
   ```bash
   npm run telegram
   ```
5. Buscar el bot por su username en Telegram, apretar **Start** y conversar.

Notas:

- Requiere `ANTHROPIC_API_KEY` en `.env` (el agente es el mismo que en WhatsApp; solo cambia el canal).
- **No reutilizar el `TELEGRAM_BOT_TOKEN` de `agente-citas`** — cada bot necesita el suyo (crear uno nuevo en @BotFather); dos bots con el mismo token chocan (409) en polling.
- El formato `*negrita*` que ya usa el agente funciona igual en Telegram.
- **Modo mock** (sin token de Telegram y sin API de Anthropic): `npm run telegram:mock` simula 3 conversaciones de demostración por consola — útil para verificar el flujo completo sin ninguna credencial.

## Conectar WhatsApp (cuando toque, no ahora)

1. App en [Meta for Developers](https://developers.facebook.com) con producto WhatsApp.
2. En `.env`: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_VERIFY_TOKEN` (lo inventas tú), `WHATSAPP_APP_SECRET`.
3. Desplegar (Railway u otro) y configurar el webhook en Meta: URL `https://tu-dominio/webhook`, verify token igual al del `.env`, suscrito al campo `messages`.

Mientras `WHATSAPP_TOKEN` esté vacío, los mensajes salientes se imprimen por consola (modo demo).

## Notas de producción pendientes

- El descuento de stock es lectura+update (no atómico). Para producción real: función RPC en Postgres.
- Los estados del pedido (`preparando`, `despachado`...) se cambian a mano en la tabla `pedidos`; el bot solo los informa.
