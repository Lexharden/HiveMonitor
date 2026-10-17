# ADR 0003 — Núcleo de eventos (Fase 2)

## Qué se hizo
- `packages/core`: `EVENT_PERMISSION` (permiso por tipo de evento), `ModerationRequest`, `AdapterContext.platform`.
- `packages/adapters`: adaptador **mock** (modos `synthetic` reproducible por semilla y `replay` de grabaciones;
  simula offline/fallos) y stub de YouTube (`docs/youtube-notes.md`).
- `apps/api/src/ingest`: `Supervisor` (una conexión por tenant+plataforma+canal), `IngestPipeline`
  (bus + buffer de recientes + sesiones + persistencia por lotes), `backoff`, gestor de ingest.
- Rutas por tenant: CRUD de conexiones, `/live`, SSE `/stream`, WebSocket `/ws` (moderación).

## Cómo probarlo
```
bun test                 # 80+ tests; apps/api/test/{supervisor,realtime}.test.ts cubren esta fase
bun scripts/dev-db.ts    # y en otra terminal: cd apps/api && bun src/index.ts
# crear una conexión mock: POST /api/t/:tenantId/connections {"platform":"tiktok","channelId":"demo","config":{"mode":"mock"}}
```

## Decisiones
1. **Reconexión**: backoff exponencial con *equal jitter* (2 s → 5 min). `offline` no cuenta como fallo y se
   comprueba cada `OFFLINE_RETRY_MS` (±20 %); `rate_limited` respeta `retryInMs`. Cada intento crea un adaptador nuevo y
   los eventos de adaptadores obsoletos se ignoran (contador de generación).
2. **Aislamiento**: el supervisor descarta cualquier evento cuyo tenant/plataforma/canal no coincida con su conexión;
   los fallos (incluidas excepciones síncronas de la factoría) quedan confinados a su conexión.
3. **Concurrencia de connect()**: semáforo por plataforma (`TIKTOK_MAX_CONCURRENCY`) con cola visible
   (`queued`, detalle "en cola de conexión"). Pensado para el límite del servicio de firma de TikTok (Fase 4).
4. **Persistencia por lotes** (1 s o 500 eventos) con una transacción por tenant bajo RLS. `viewer_count` se
   muestrea a 1 cada 30 s por canal (el tiempo real va por SSE; el histórico no necesita más).
   Cola acotada (20 000): al saturarse se descartan los más antiguos con aviso.
5. **Eventos venenosos**: errores de datos de Postgres (SQLSTATE 22/23) se aíslan por bisección y solo se descarta el
   evento culpable; los fallos transitorios reencolan el lote. (Detectado en tests: un emoji fallaba en un Postgres
   Windows con codificación WIN1252 y bloqueaba todo el lote.)
6. **Sesiones de directo** derivadas del flujo: `stream_start` abre, `stream_end`/offline sostenido/inactividad de 10 min
   cierran. Contadores (mensajes, likes, seguidores, donaciones por moneda) y pico de viewers en `stream_session.stats`.
   Al arrancar se cierran las sesiones huérfanas.
7. **SSE**: primero `snapshot` (conexiones, estado en vivo, eventos recientes filtrados y permisos), luego eventos
   filtrados por los permisos del usuario (chat→`chat.view`, donaciones/follows/…→`events.view`, viewers/estado→`stream.view`).
   Ping cada 15 s, `X-Accel-Buffering: no`, máx. 8 flujos por usuario, el flujo se cierra a los 30 min
   (`event: reconnect`) para reevaluar permisos.
8. **WebSocket**: solo acciones (moderación). Cada mensaje revalida `chat.moderate`, se limita a 20 msg/10 s y se audita.
   Auth: cookie (web) o subprotocolo `bearer.<token en base64url>` (Tauri; el token no es válido tal cual como
   subprotocolo porque contiene `/ + =`). Se comprueba `Origin` contra la lista permitida (anti CSWSH).
9. **Mock** solo si `ALLOW_MOCK_ADAPTERS` (por defecto fuera de producción). Límite de conexiones por tenant
   (`limits.maxConnections`, 5 por defecto). Suspender un tenant detiene sus conexiones.
