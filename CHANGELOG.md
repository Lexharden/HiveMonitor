# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versionado [SemVer](https://semver.org/lang/es/).

## [0.4.0] - 2026-10-17

### Añadido

- Cockpit: **vista previa del directo** (reproductor oficial de Twitch incrustado, sin sonido por defecto; TikTok no permite incrustar, por lo que ofrece un
  botón que lo abre en otra pestaña). La CSP permite únicamente `frame-src https://player.twitch.tv`.

### Corregido

- Login: los botones de Twitch/Google solo aparecen si el proveedor está configurado; al volver rechazado (cuenta nueva sin invitación) se muestra un mensaje claro.
- Tests que demuestran que `SIGNUP_MODE` también se aplica al registro con login social.

## [0.3.0] - 2026-10-17

### Añadido

- **Cockpit** (`/cockpit`): pantalla única para tablet y segundo monitor, con soporte de multistream (viewers y tendencia por plataforma, estado de OBS,
  ritmo del chat y likes, meta de donaciones, top donadores, chat con resaltado de lo importante y moderación a un toque), botón «marcar momento»,
  silenciar avisos, pantalla siempre encendida, pantalla completa y modo compacto. Marcadores automáticos (raid, donación grande, pico de espectadores). Ver `docs/cockpit.md`.
- `SIGNUP_MODE` (`open|invite|closed`, por defecto `invite`): control de quién puede crear cuenta; el primer usuario siempre puede.
- Verificación de correo y recuperación de contraseña por SMTP (pantallas `/forgot-password` y `/reset-password`).
- `hivemonitor reset-password <correo>` para recuperar acceso sin SMTP.
- Copias de seguridad automáticas: servicio `backup` de compose (perfil opcional), timer de systemd, verificación de cada volcado, aviso por Discord
  si falla, gancho para subirla fuera del servidor y `scripts/verify-backup.sh` (restauración real en una base temporal). Guía en `docs/backups.md`.

## [0.2.1] - 2026-10-17

### Corregido

- El build de la imagen fallaba por usar `git` y `cargo` inexistentes en la etapa de Bun; ahora son opcionales.
- Aviso de `tsconfig` de SvelteKit sobre el service worker; `.dockerignore` añadido.

## [0.2.0] - 2026-10-17

### Añadido

- `apps/tiktok-bridge`: puente en Rust sobre `piratetok-live-rs` (sin servicio de firma ni API key), proveedor de TikTok por defecto
  (`TIKTOK_PROVIDER=bridge`); `tiktok-live-connector` queda como respaldo (`connector`).
- Configuración de Nginx nativo con TLS y sin TLS (`deploy/nginx/`).

### Cambiado

- El binario se compila sin minificar identificadores, para que los errores de las librerías se reconozcan por nombre.

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
