# Arquitectura

Monolito modular preparado para separarse (bus, adaptadores y persistencia están detrás de interfaces).

```
 TikTok / Twitch ──► Adaptador ──► Supervisor ──► IngestPipeline ──► Bus (in-process) ──► SSE por tenant ──► Web / Tauri
 (WebSocket/EventSub)  (1 por canal)  backoff,       sesiones,         aislado por        filtrado por
                                      cola, cooldown  agregados,        tenant             permisos
                                                      persistencia      │
                                                      por lotes         └─► Motor de alertas ─► panel / nativa / Discord
```

## Piezas

| Pieza | Dónde | Notas |
|---|---|---|
| Evento normalizado | `packages/core/src/events.ts` | `{ id, tenantId, platform, channelId, type, occurredAt, actor, payload, raw? }`, validado con Zod |
| Contrato de adaptador | `packages/core/src/adapter.ts` | `connect/disconnect/status`, `moderate?`; estados `connecting\|live\|offline\|error\|rate_limited` (+ `passive`) |
| Bus | `packages/core/src/bus.ts`, `apps/api/src/bus` | interfaz; implementación in-process; sustituible por Redis Streams/NATS sin tocar productores ni consumidores |
| Supervisor | `apps/api/src/ingest/supervisor.ts` | una conexión por (tenant, plataforma, canal); backoff exponencial con jitter; semáforo y cooldown global por plataforma |
| Pipeline | `apps/api/src/ingest/pipeline.ts` | publica al bus, sesiones de directo, contadores, persistencia por lotes bajo RLS, agregados por hora/día |
| Alertas | `apps/api/src/alerts` | 4 tipos, 3 canales, cooldowns |
| Auth | `apps/api/src/auth.ts` | Better Auth: email/contraseña, OAuth Twitch/Google, organizaciones; cookies (web) y bearer (Tauri) |
| Permisos | `packages/core/src/{permissions,roles}.ts` | roles = conjuntos de permisos; la UI decide por permiso, nunca por nombre de rol |

## Multi-tenancy

- Tenant = organización de Better Auth. Cada consulta de datos pasa por `withTenant` (`SET LOCAL app.tenant_id`).
- **RLS** como segunda línea de defensa: la API usa el rol `hive_app` (sin `BYPASSRLS`, sin propiedad de las tablas, sin acceso a las
  tablas de autenticación). La conexión propietaria (`DATABASE_URL`) solo hace migraciones, autenticación, vista superadmin y mantenimiento.
- Los tests de aislamiento (`packages/db/test`, `apps/api/test`) demuestran que un tenant no lee, escribe ni borra datos de otro.

## Datos

`event` está particionada por mes; la retención (`EVENT_RETENTION_DAYS`, 60 por defecto) elimina particiones completas.
`stats_hourly`/`stats_daily` se actualizan por upsert aditivo y se conservan. `audit_log` es de solo inserción (trigger).
Todo en UTC (las conexiones fuerzan `TimeZone=UTC`).

## Tiempo real

- **SSE** `/api/t/:tenantId/stream`: `snapshot` inicial (estado + recientes) y luego eventos filtrados por los permisos del usuario.
- **WebSocket** `/api/t/:tenantId/ws`: solo acciones de moderación; cada mensaje revalida `chat.moderate` y se audita.
- Autenticación del WebSocket en Tauri: subprotocolo `bearer.<token base64url>`; se comprueba `Origin`.

## Seguridad

Cookies seguras / bearer, comprobación de `Origin` (CSRF y CSWSH), CSP estricta con hashes de scripts en línea, HSTS, límite de tasa,
secretos de terceros cifrados con AES-256-GCM (clave versionada), validación Zod en toda entrada, webhooks salientes solo a Discord,
`X-Forwarded-*` solo desde `TRUSTED_PROXIES`, contenedor rootless de solo lectura sin capacidades.
