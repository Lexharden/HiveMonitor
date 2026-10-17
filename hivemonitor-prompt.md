# Proyecto: HiveMonitor

## Rol

Actúa como ingeniero de software senior full-stack con experiencia en sistemas en tiempo real, arquitecturas multi-tenant, seguridad, Tauri 2 y despliegue en Linux. Escribe código de producción: tipado estricto, modular, testeable y documentado. Trabaja por fases, confirma que cada fase funciona antes de avanzar y pregúntame ante cualquier ambigüedad que afecte la arquitectura.

## Punto de partida (proyecto existente)

El proyecto ya fue creado con `bun create tauri-app` en `D:\Desarrollo\rust\hive-monitor`:

- Nombre: `hive-monitor` · Identificador: `com.yafeldev.hive-monitor`
- Tauri 2 + Svelte (SvelteKit, TypeScript) · Gestor de paquetes: bun
- Estructura actual de plantilla: `src/` (SvelteKit), `src-tauri/` (Rust), `static/`, `package.json`, `svelte.config.js`, `vite.config.ts`

**Primera tarea:** reestructurar este proyecto en un monorepo (ver estructura abajo) **sin perder** la configuración de Tauri ni del frontend:

- El frontend SvelteKit pasa a `apps/web` (mantener `adapter-static`, SSR desactivado).
- `src-tauri/` pasa a `apps/desktop/src-tauri`, con `tauri.conf.json` apuntando a `../../web` (`devUrl` del servidor de Vite y `frontendDist` al build de `apps/web`).
- Se crea el servidor en `apps/api`.
- Verifica que `bun run tauri dev` (desde `apps/desktop`) y el modo web en navegador sigan funcionando tras la migración.
- Verifica que el identificador sea válido para Android (los guiones no son válidos en nombres de paquete Android); si hace falta, propón un ajuste antes de aplicarlo.

## Contexto

HiveMonitor es una aplicación **autoalojada en VPS** para monitorear y gestionar transmisiones en vivo en tiempo real. Forma parte del ecosistema "Hive" (HiveShock, HiveBuzz). Es **multi-tenant**: varios streamers, cada uno con su organización, monitorean sus propios streams de forma aislada, con miembros y roles.

**El servidor es el núcleo.** Los clientes son:

1. **Web / PWA** (principal): se abre desde el navegador de laptop o tablet y es instalable.
2. **Tauri 2** (secundario): el mismo frontend envuelto como app de escritorio (Windows/macOS/Linux) y Android, que se conecta a un servidor configurable (URL del servidor en la pantalla de inicio de sesión, guardada en el almacenamiento de Tauri). La app Tauri **no** contiene lógica de servidor ni ejecuta conectores; es solo un cliente.

El frontend debe funcionar igual en ambos modos: detecta si corre dentro de Tauri (`window.__TAURI_INTERNALS__` o la API de Tauri) para habilitar extras nativos (notificaciones del sistema, bandeja, autoarranque) y degrada con elegancia en navegador.

Plataformas de streaming:

- **TikTok LIVE** (prioridad 1; conector no oficial `tiktok-live-connector`)
- **Twitch** (prioridad 2; API oficial EventSub)
- **YouTube Live** (futuro; dejar el adaptador preparado, no implementarlo aún)

## Objetivos no funcionales

- **Ligero:** consumo bajo de RAM/CPU; debe correr cómodo en un VPS de 1–2 vCPU y 2 GB RAM con decenas de tenants.
- **Robusto:** reconexión automática con backoff exponencial y jitter; el fallo de un tenant o plataforma nunca afecta a otros; apagado ordenado (SIGTERM).
- **Despliegue dual idéntico del servidor:** el mismo artefacto debe funcionar en
  1. **Nativo:** binario único (`bun build --compile`) con el frontend web embebido + unidad systemd.
  2. **Docker** (`docker compose`).
  3. **Podman** (`podman compose` / `podman-compose`, rootless) + archivos **Quadlet** para systemd.
     Toda la configuración por variables de entorno (12-factor), con `.env.example` documentado. Nada de rutas ni supuestos específicos de contenedor en el código.
- **Seguro por defecto:** aislamiento estricto entre tenants, secretos cifrados, mínimo privilegio.

## Stack (obligatorio)

- Runtime del servidor: **Bun** · Lenguaje: **TypeScript estricto**
- API: **Hono** + **Zod**
- Auth: **Better Auth** (plugin organizations; OAuth Twitch y Google; email/contraseña). Debe funcionar tanto con cookies (web) como con tokens bearer (cliente Tauri, origen distinto).
- DB: **PostgreSQL 16+** con **Drizzle ORM** y migraciones versionadas; **Row-Level Security** por `tenant_id`
- Frontend: **SvelteKit** (adapter-static) + **Tailwind**, **PWA** (manifest + service worker), responsive con prioridad tablet/laptop, modo oscuro por defecto
- Cliente nativo: **Tauri 2** (escritorio + Android), plugins oficiales mínimos necesarios (store, notification, http si aplica)
- Tiempo real: **SSE** para streams de eventos del panel; **WebSocket** para acciones bidireccionales (moderación)
- Logs: **pino** (JSON); niveles configurables
- Monorepo con **Bun workspaces**

## Estructura del monorepo

```
hive-monitor/
├─ apps/
│  ├─ api/          # Hono: HTTP, auth, SSE/WS, sirve el frontend estático embebido
│  ├─ web/          # SvelteKit PWA (migrado desde src/ de la plantilla)
│  └─ desktop/      # Tauri 2 (migrado desde src-tauri/), cliente de escritorio y Android
├─ packages/
│  ├─ core/         # tipos de eventos normalizados, permisos, roles, contratos de adaptadores
│  ├─ db/           # esquema Drizzle, migraciones, políticas RLS
│  ├─ adapters/     # tiktok/, twitch/, youtube/ (stub)
│  └─ client/       # SDK TS tipado para consumir la API (usado por web y desktop)
├─ deploy/
│  ├─ Containerfile
│  ├─ compose.yaml
│  ├─ quadlet/      # hivemonitor.container, hivemonitor-db.container, red y volúmenes
│  └─ systemd/      # hivemonitor.service (modo nativo)
├─ scripts/         # build del binario, backup/restore de Postgres
└─ docs/            # arquitectura, despliegue (nativo/docker/podman), ADRs
```

## Arquitectura del servidor

Monolito modular, preparado para separarse después:

1. **Capa de ingest:** un supervisor administra una conexión por (tenant, plataforma). Cada adaptador implementa una interfaz común de `packages/core`:
   - `connect()`, `disconnect()`, `status()`, emisión de eventos normalizados y de cambios de estado (`connecting | live | offline | error | rate_limited`).
2. **Evento normalizado** (contrato central). Cualquier evento de plataforma se transforma a:
   `{ id, tenantId, platform, channelId, type, occurredAt, actor: {id, name, avatar}, payload, raw? }`
   Tipos mínimos: `chat`, `donation` (regalos TikTok, bits, Super Chat; con monto y moneda normalizados), `follow`, `subscription`, `raid`, `like`, `share`, `viewer_count`, `stream_start`, `stream_end`, `moderation`.
3. **Bus de eventos:** interfaz abstracta con implementación in-process (EventEmitter) al inicio. Debe poder sustituirse por Redis Streams o NATS sin tocar productores ni consumidores.
4. **Persistencia:** eventos crudos con retención configurable (por defecto 60 días) y agregados por hora y por día (viewers pico/promedio, donaciones, mensajes, nuevos seguidores) para estadísticas históricas.
5. **Entrega:** canal SSE por tenant con filtrado por permisos del usuario conectado. CORS configurable para permitir el origen del cliente Tauri (`CORS_ORIGINS`).

## Multi-tenancy, usuarios y roles

- Tenant = organización de Better Auth. Un usuario puede pertenecer a varias organizaciones y cambiar entre ellas.
- Autorización por **permisos**; los roles son conjuntos de permisos. El frontend muestra u oculta vistas y acciones por permiso, nunca por nombre de rol.
- Permisos iniciales: `stream.view`, `chat.view`, `chat.moderate`, `events.view`, `analytics.view`, `integrations.manage`, `alerts.manage`, `members.manage`, `org.manage`, `system.admin`.
- Roles por defecto:
  - **Superadmin** (global): todos los tenants, salud del sistema, suspender tenants, límites.
  - **Owner:** todo dentro de su tenant, incluido conectar plataformas y borrar la organización.
  - **Admin:** todo excepto borrar la organización o transferir la propiedad.
  - **Moderador:** chat unificado, moderación, feed de eventos.
  - **Analista:** solo dashboards e historial, sin acciones.
- Diseña el modelo para permitir roles personalizados por tenant más adelante.
- Invitaciones por enlace o email con rol asignado.
- Toda consulta pasa por el contexto de tenant; RLS como segunda línea de defensa. Incluye tests que demuestren que un tenant no puede leer datos de otro.

## Integraciones

### TikTok LIVE

- Usar `tiktok-live-connector`. Aislar la dependencia detrás del adaptador para poder cambiarla.
- Reconexión con backoff; detección de stream offline vs error.
- Tener en cuenta los límites del servicio de firma externo: control de concurrencia global configurable, cola de conexiones, métricas de rate limit y estado `rate_limited` visible en el panel.

### Twitch

- OAuth por tenant (el owner autoriza su canal); tokens **cifrados en reposo** (AES-256-GCM con clave de `ENCRYPTION_KEY`) y refresh automático.
- EventSub por **webhook con conduits** (verificación de firma HMAC, manejo de reintentos y revocaciones). Incluir modo WebSocket para desarrollo local.
- Chat vía EventSub `channel.chat.message`.

### YouTube (stub)

- Crear el adaptador con la interfaz implementada y `NotImplemented`, y un documento con notas sobre cuotas de la API para la implementación futura.

## Funcionalidades del panel (MVP)

- **Dashboard en vivo:** estado por plataforma, viewers en tiempo real (gráfica), duración del stream, contadores de la sesión.
- **Chat unificado** multi-plataforma con insignia de plataforma; acciones de moderación donde la API lo permita.
- **Feed de eventos** (donaciones, follows, subs, raids) con filtros.
- **Historial y analíticas:** sesiones pasadas, top donadores, picos de audiencia, comparativas.
- **Integraciones:** conectar o desconectar plataformas y ver su estado.
- **Miembros y roles:** invitar, cambiar rol, revocar.
- **Alertas configurables:** por ejemplo, caída de viewers, desconexión de plataforma, donación sobre un umbral; notificación en el panel, notificación nativa en Tauri y webhook saliente (Discord).
- **Vista superadmin:** tenants, conexiones activas, uso de recursos, errores.
- **Heartbeat externo:** endpoint autenticado por token de tenant para que apps del ecosistema (HiveShock, HiveBuzz) o un agente local reporten su estado (por ejemplo, métricas de OBS).

## Seguridad

- Cookies de sesión seguras (web) y tokens bearer de vida corta con refresh (Tauri); CSRF, rate limiting en login y API, cabeceras de seguridad (CSP estricta, HSTS).
- En Tauri: CSP estricta en `tauri.conf.json`, capabilities mínimas, tokens guardados de forma segura.
- Tokens de terceros cifrados; nunca loguear secretos ni tokens.
- Validación Zod en toda entrada; auditoría de acciones sensibles (cambios de rol, conexiones, moderación) en tabla `audit_log`.
- Contenedor rootless, usuario no root, sistema de archivos de solo lectura salvo volúmenes necesarios.

## Operación

- Endpoints `/healthz` (liveness) y `/readyz` (DB y bus listos).
- Endpoint `/metrics` opcional (formato Prometheus) protegido.
- Migraciones automáticas al arrancar, configurables con `AUTO_MIGRATE=true|false`.
- Scripts de backup y restore de Postgres para modo nativo y contenedor.
- Detrás de reverse proxy (Nginx Proxy Manager): respetar `X-Forwarded-*` según `TRUSTED_PROXIES`; ejemplo de dominio `hivemonitor.yafel.dev`. Documentar la configuración necesaria para SSE y WebSocket (timeouts, buffering desactivado).

## Calidad

- TypeScript `strict`, ESLint y Prettier; `cargo clippy` y `cargo fmt` para la parte Rust de Tauri.
- Tests con `bun test`: unitarios (normalización de eventos, permisos), integración (API + Postgres en contenedor), aislamiento entre tenants.
- Adaptadores con modo **mock/replay** que reproduzca eventos grabados, para desarrollar sin estar en vivo.
- CI de ejemplo (GitHub Actions): lint, tests, build del binario del servidor, de la imagen de contenedor y de los instaladores de Tauri.
- README claro y `docs/deploy-*.md` paso a paso para nativo, Docker y Podman, más `docs/desktop.md` para compilar el cliente Tauri (escritorio y Android).

## Plan por fases

1. **Migración y fundaciones:** reestructurar la plantilla Tauri en el monorepo, verificar que Tauri y web siguen funcionando; configuración por env, logging, esquema base, Better Auth con organizaciones, roles y permisos, RLS, tests de aislamiento.
2. **Núcleo de eventos:** contrato normalizado, bus, supervisor de adaptadores, adaptador mock/replay, SSE.
3. **Frontend base:** PWA, login (con campo de URL del servidor en Tauri), selector de organización, layout responsive, dashboard y feed alimentados por el mock.
4. **TikTok LIVE:** adaptador real con reconexión y control de concurrencia.
5. **Twitch:** OAuth, cifrado de tokens, EventSub con conduits, chat.
6. **Analíticas e historial:** agregados, retención, vistas históricas.
7. **Alertas, miembros e invitaciones, auditoría, vista superadmin, heartbeat externo, notificaciones nativas en Tauri.**
8. **Despliegue:** binario nativo + systemd, Containerfile, compose, Quadlet, builds de Tauri (escritorio y Android), documentación y scripts de backup.

Al terminar cada fase: resume qué se hizo, cómo probarlo, y decisiones tomadas (registrarlas como ADR en `docs/adr/`).

## Fuera de alcance por ahora

- Implementación real de YouTube, pagos o planes, iOS, internacionalización (UI en español, con textos preparados para i18n).

## Cómo empezar

1. Analiza el proyecto existente y preséntame el plan de migración al monorepo (qué archivos se mueven, qué configuraciones cambian).
2. Preséntame el esquema de base de datos propuesto y la matriz de roles y permisos.
3. Espera mi aprobación antes de escribir código.
