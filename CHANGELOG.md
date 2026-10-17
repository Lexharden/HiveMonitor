# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versionado [SemVer](https://semver.org/lang/es/).

## [0.1.0] - 2026-10-17

Primera versión.

### Añadido

- Monorepo Bun (`apps/api`, `apps/web`, `apps/desktop`, `packages/*`), identificador Tauri `com.yafeldev.hivemonitor`.
- Servidor Hono + Better Auth (organizaciones, roles por permisos, OAuth Twitch/Google, bearer para Tauri), PostgreSQL con RLS por tenant,
  migraciones versionadas, `audit_log` de solo inserción.
- Núcleo de eventos normalizados, bus abstracto, supervisor con backoff exponencial + jitter, adaptador mock/replay, SSE y WebSocket (moderación).
- Frontend SvelteKit 3 + Tailwind 4 (PWA, oscuro por defecto): en vivo, chat unificado, eventos, historial y analíticas, integraciones,
  alertas, miembros e invitaciones, superadmin, ajustes.
- Adaptadores TikTok LIVE (cooldown global de rate limit) y Twitch (OAuth por tenant, tokens cifrados, EventSub conduit/webhook y WebSocket, moderación).
- Alertas (donación, caída de viewers, desconexión, heartbeat perdido) por panel, notificación nativa y webhook de Discord.
- Heartbeat externo con tokens por tenant; métricas Prometheus (`/metrics`).
- Cliente Tauri 2: bandeja, inicio automático, notificaciones.
- Binario único con frontend y migraciones embebidos; Containerfile, compose, Quadlet, systemd, backup/restore; CI de GitHub Actions; documentación y ADRs.

### Limitaciones conocidas

- Login social en Tauri sin retorno por deep link; sin verificación de correo ni recuperación de contraseña; roles personalizados solo como modelo.
- Despliegue en contenedores, CI, `tauri build` y Android escritos pero no ejecutados en el entorno de desarrollo.
