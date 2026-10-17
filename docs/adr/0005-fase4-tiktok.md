# ADR 0005 — TikTok LIVE (Fase 4)

## Qué se hizo
- `packages/adapters/src/tiktok`: adaptador sobre `tiktok-live-connector` 2.5 aislado tras `TikTokClientLike`
  (carga perezosa; solo este archivo conoce nombres de eventos y errores de la librería).
- Supervisor: **cooldown global** por plataforma ante rate limit, contador `rateLimitHits`, estado visible.
- `GET /api/admin/system`: conexiones por estado, cola, rate limits, cooldown y memoria del proceso.

## Cómo probarlo
```
bun test packages/adapters apps/api/test/supervisor.test.ts
# real: crear una conexión TikTok (sin config.mode) con el usuario de un directo activo
```
Verificado contra la librería real: un canal sin directo devuelve `UserOfflineError` → estado `offline`.
**No se pudo probar con un directo activo** en el desarrollo (requiere un streamer en vivo y API key de firma).

## Decisiones
1. **Estados**: `UserOfflineError` → `offline` (se reintenta cada `OFFLINE_RETRY_MS` ±20 %, sin contar como fallo);
   `SignatureRateLimitError` → `rate_limited` con `retryInMs`; usuario inválido → `error`; caída del WebSocket → `error`
   (el supervisor reconecta con backoff exponencial + jitter). `connect()` no lanza si ya informó el estado, para que
   el supervisor no lo sobrescriba.
2. **Concurrencia**: semáforo `TIKTOK_MAX_CONCURRENCY` (cola visible "en cola de conexión") + cooldown global: el
   límite del servicio de firma es por API key, así que un 429 pausa las conexiones *nuevas* de todos los tenants.
3. **Regalos en racha** (`giftType 1`): solo se cuenta el evento final (`repeatEnd`) para no sumar de más.
   Monto = `diamondCount × repeatCount` en `TIKTOK_COIN`; `usdMinorEstimate` configurable (`TIKTOK_USD_CENTS_PER_COIN`).
4. **IDs de evento** `tt_<canal>_<msgId>` → la reconexión no duplica filas (`ON CONFLICT DO NOTHING`).
5. Eventos malformados se descartan sin afectar al resto.
6. Los `member` (entradas de espectadores) se ignoran: volumen alto y poco valor para el panel.
7. Producción real: la librería es ingeniería inversa y su propio README recomienda el WebSocket de pago de Euler.
   Cambiar de proveedor es sustituir `clientFactory`.
