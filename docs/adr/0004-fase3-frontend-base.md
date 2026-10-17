# ADR 0004 — Frontend base (Fase 3)

## Qué se hizo
- `packages/client`: SDK tipado (auth, `/me`, organizaciones, tenant, admin), SSE sobre `fetch` con reconexión y
  backoff, WebSocket de moderación, parser SSE con tests.
- `apps/web`: SvelteKit 3 + Tailwind 4, PWA (manifest + service worker), login/registro/onboarding/invitaciones,
  selector de organización, layout responsive (sidebar en tablet/laptop, barra inferior en móvil), dashboard,
  chat unificado con moderación, feed de eventos con filtros, integraciones. Oscuro por defecto con conmutador.
- Tauri: plugins `store` (URL del servidor + token) y `notification`, capabilities mínimas, CSP estricta.
- API: sirve el SPA con caché inmutable, fallback a `index.html` y CSP con hashes de los scripts en línea.

## Cómo probarlo
```
bun scripts/dev-db.ts                       # Postgres local
cd apps/web && bun run build                # genera apps/web/build
cd apps/api && bun src/index.ts             # sirve API + SPA en http://localhost:3000
bun scripts/screenshot.ts .shots            # capturas con Edge headless (registra usuario demo + canales mock)
cd apps/desktop && bun run tauri dev        # cliente Tauri (pide la URL del servidor en el login)
```
En desarrollo del frontend (`bun --filter @hivemonitor/web dev`) Vite hace proxy de `/api` a `:3000` (mismo origen).

## Decisiones
1. **SvelteKit 3 retiró `$lib` y `$service-worker`**: se usa `#lib/*` (campo `imports` de package.json, con extensión
   explícita en los `.ts`) y `$app/manifest` + `$app/env` en el service worker.
2. **Misma base de código web/Tauri**: `isTauri()` decide; en web las cookies, en Tauri bearer guardado en el store.
   Los extras nativos degradan con elegancia en navegador.
3. **Permisos, no roles**: la navegación y las acciones usan `app.can(permission)` con los permisos que devuelve `/api/me`.
4. **Gráfica propia en SVG** (sin librería): 2 px de línea, rejilla recesiva, leyenda cuando hay ≥ 2 series,
   etiquetas directas al final, crosshair + tooltip, vista de tabla. Color por entidad (TikTok=1, Twitch=2, YouTube=3)
   con la paleta de referencia validada (los tres primeros slots validan en todos los pares, claro y oscuro).
5. **Estado nunca solo por color**: `StatusBadge` combina icono y texto.
6. **Textos preparados para i18n** (`t()` con diccionario en español).
7. **CSP**: la API fija `script-src 'self'` + hashes sha256 de los `<script>` en línea del `index.html`;
   Tauri inyecta los suyos. `connect-src` de Tauri es amplio (`https: wss: http: ws:`) porque el servidor es configurable.
8. **WebSocket con subprotocolo `bearer.<base64url>`** desde el SDK (los navegadores no pueden poner cabeceras).

## Limitaciones conocidas
- Token de Tauri en `plugin-store` (archivo JSON en el directorio de datos de la app), no en el llavero del sistema.
  Mejora futura: Stronghold o keyring.
- Login social en Tauri abre el navegador del sistema pero el retorno requiere deep link (`hivemonitor://`), no implementado.
- Android con servidor `http://` en LAN requiere permitir tráfico en claro; se recomienda HTTPS.
- La gráfica solo tiene datos desde que se abre el panel (+ el buffer reciente del servidor); el histórico llega en la Fase 6.
