# ADR 0006 — Twitch (Fase 5)

## Qué se hizo
- `packages/adapters/src/twitch`: cliente Helix (con gestión de 429), mapeo de EventSub → evento normalizado,
  transporte **WebSocket** (desarrollo), adaptador con moderación real (ban/timeout/unban/delete).
- `apps/api/src/twitch`: OAuth por tenant con `state` firmado, gestor de tokens, **conduit + webhook** con HMAC.
- Rutas: `POST /api/t/:tenantId/integrations/twitch/authorize`, `GET /api/integrations/twitch/callback`,
  `POST /webhooks/twitch/eventsub`. UI: botón "Autorizar con Twitch" en Integraciones.

## Cómo probarlo
```
bun test apps/api/test/twitch.test.ts packages/adapters/test/twitch.test.ts   # Twitch falso: OAuth, conduit, webhook, tokens
```
Real: crear una aplicación en https://dev.twitch.tv/console, registrar las dos Redirect URIs (ver `.env.example`),
definir `TWITCH_CLIENT_ID/SECRET`. En local el modo es WebSocket (no necesita URL pública); en producción `webhook`.
**No se probó contra Twitch real** (requiere credenciales y un canal); sí contra un Twitch simulado fiel a la API.

## Decisiones
1. **Dos usos de OAuth, una sola aplicación de Twitch**: login de usuarios (Better Auth) y autorización del canal
   (flujo propio, scopes de EventSub/moderación, `force_verify`).
2. **State** = payload (tenant, usuario, cliente, caducidad, nonce) + HMAC; caduca a 10 min y es de un solo uso. Al volver,
   se **revalida el permiso** del usuario (el state solo prueba que lo tuvo al iniciar).
3. **Tokens cifrados** (AES-256-GCM) en `platform_connection.credentials_enc`. Renovación 5 min antes de expirar,
   **validación horaria** (requisito de Twitch), renovaciones simultáneas deduplicadas. Si Twitch responde que el refresh
   token es inválido → conexión **deshabilitada** (no hay bucle de reintentos) con mensaje para reautorizar.
4. **Webhook con conduit**: un conduit y un shard (callback + secreto únicos) para todos los canales. Verificación HMAC en
   tiempo constante, ventana de 10 min anti-replay, deduplicación por `Message-Id`, respuesta de `challenge` en texto plano,
   `revocation` tratado. Comprobación de shards cada 5 min con reconfiguración automática.
   El endpoint está fuera de `/api` (sin CORS ni límite por IP: la autenticidad la da la firma).
5. **Modo WebSocket** para desarrollo: una sesión por canal, keepalive con watchdog, `session_reconnect` sin cortar el flujo.
6. **Estado pasivo**: Twitch mantiene suscripciones aunque no haya directo → `offline` con `passive: true` (nuevo en
   `StatusChange`): el supervisor cierra la sesión pero no reconecta; `stream.online` o el sondeo (60 s) pasan a `live`.
   El sondeo también corrige un `stream.offline` perdido.
7. **Sin dobles conteos**: las subs regaladas se cuentan por receptor (`channel.subscribe`) y se ignora el resumen
   `subscription.gift`; los bits llegan por `channel.cheer`, no por el mensaje de chat.
8. Suscripciones opcionales se omiten si falta el alcance o Twitch las rechaza (degradación); `stream.online/offline` son obligatorias.
9. Moderación: usa el token del broadcaster (moderador de su propio canal) y emite el evento `moderation` al aplicarla.

## Pendiente / limitaciones
- No se solicitan `channel.moderate` ni eventos de moderación hechos fuera de HiveMonitor.
- El viewer count es por sondeo (1/min por canal); con decenas de canales conviene agrupar las consultas (Get Streams admite 100 ids).
