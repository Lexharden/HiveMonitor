# HiveMonitor

Panel **autoalojado** para monitorear y gestionar transmisiones en vivo (TikTok LIVE, Twitch; YouTube preparado) en tiempo real.
Multi-tenant (organizaciones con miembros y roles), parte del ecosistema Hive (HiveShock, HiveBuzz).

- **El servidor es el núcleo**: un binario único (Bun) con la API, el tiempo real (SSE/WebSocket) y el frontend embebido.
- **Clientes**: web/PWA (principal) y app Tauri 2 (Windows/macOS/Linux/Android) que se conecta al servidor que elijas.

## Estructura

```
apps/api       Hono + Better Auth + supervisor de adaptadores + SSE/WS (Bun, TypeScript estricto)
apps/web       SvelteKit (adapter-static) + Tailwind 4, PWA, oscuro por defecto
apps/desktop   Tauri 2: cliente de escritorio y Android (no ejecuta lógica de servidor)
packages/core  eventos normalizados, permisos, roles, contratos de adaptador y bus
packages/db    esquema Drizzle, migraciones SQL, RLS por tenant
packages/adapters  mock/replay, TikTok, Twitch, YouTube (stub)
packages/client    SDK tipado (web y desktop)
deploy/        Containerfile, compose, Quadlet (Podman), systemd
scripts/       build del binario, backup/restore, utilidades de desarrollo
docs/          arquitectura, despliegue, ADRs
```

## Desarrollo

Requisitos: Bun ≥ 1.4, Rust (solo para el cliente Tauri). No hace falta Docker: PostgreSQL de desarrollo con binarios embebidos.

```bash
bun install
bun scripts/dev-db.ts                 # PostgreSQL local (puerto 54329); imprime las variables
cp .env.example apps/api/.env         # ajusta DATABASE_*, BETTER_AUTH_SECRET, ENCRYPTION_KEY
bun --filter @hivemonitor/web dev     # frontend (proxy de /api a :3000)
bun --filter @hivemonitor/api dev     # API
cd apps/desktop && bun run tauri dev  # cliente Tauri (opcional)
```

Un canal de demostración sin estar en directo: en **Integraciones** marca «Modo demostración» (datos simulados).
Hacerse superadmin: `bun scripts/make-superadmin.ts correo@dominio.com` (el usuario debe existir).

## Calidad

```bash
bun run ci      # eslint + prettier + tipos + tests
bun test        # unitarios, integración (PostgreSQL real) y aislamiento entre tenants
```

Los tests usan PostgreSQL embebido, o `TEST_DATABASE_URL` si existe (así corre en CI con PostgreSQL 16).

## Despliegue

Un mismo artefacto, tres formas. Toda la configuración es por variables de entorno (`.env.example`).

| Modo | Guía |
|---|---|
| Nativo (binario + systemd) | [docs/deploy-nativo.md](docs/deploy-nativo.md) |
| Docker Compose | [docs/deploy-docker.md](docs/deploy-docker.md) |
| Podman rootless (compose o Quadlet) | [docs/deploy-podman.md](docs/deploy-podman.md) |
| Detrás de Nginx Proxy Manager | [docs/reverse-proxy.md](docs/reverse-proxy.md) |
| Cliente de escritorio y Android | [docs/desktop.md](docs/desktop.md) |

## Documentación

- [Arquitectura](docs/architecture.md)
- [ADRs](docs/adr/) — una decisión por fase, con cómo probarla
- [Notas de YouTube (cuotas)](docs/youtube-notes.md)

## Operación en una línea

`/healthz` (liveness) · `/readyz` (BD + bus) · `/metrics` (Prometheus, requiere `METRICS_TOKEN`) · SIGTERM = apagado ordenado ·
`hivemonitor migrate|make-superadmin|healthcheck` · backups con `scripts/backup.sh` / `scripts/restore.sh`.
