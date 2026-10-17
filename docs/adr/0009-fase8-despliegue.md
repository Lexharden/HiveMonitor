# ADR 0009 — Despliegue (Fase 8)

## Qué se hizo
- **Binario único** (`scripts/build-binary.ts`): `bun build --compile` con frontend y migraciones embebidos (`import … with { type }`),
  generando y restaurando `embedded.generated.ts`. Objetivos: linux-x64, linux-arm64, windows-x64.
- **CLI** en el propio binario: `serve | healthcheck | migrate | make-superadmin | version` (sin Bun ni repositorio en producción).
- **Contenedor**: `deploy/Containerfile` (build en Bun, imagen final `distroless/cc nonroot`, sin shell, HEALTHCHECK con el binario).
- **Compose** (Docker y Podman), **Quadlet** (red, volumen, db y app) y **systemd** endurecido para el modo nativo.
- **Backup/restore** (`scripts/backup.sh`, `restore.sh`) para native/docker/podman, con confirmación `--yes` y rechazo de volcados vacíos.
- **/metrics** Prometheus protegido por `METRICS_TOKEN` (404 si no está definido).
- **Calidad**: ESLint (typescript-eslint + svelte), Prettier, `bun run ci`; CI de GitHub Actions (checks con PostgreSQL 16, clippy/fmt,
  binarios, imagen, instaladores de escritorio en 3 SO, APK de Android).
- **Docs**: README, arquitectura, despliegue nativo/Docker/Podman, reverse proxy (SSE/WS), cliente de escritorio y Android.

## Verificado
Binario de Windows ejecutado desde un directorio vacío contra una base nueva: migra, sirve el SPA (CSP con hash), `/readyz`,
`/metrics` (401 sin token), `healthcheck` y 404 de archivos inexistentes. Los de Linux compilan (compilación cruzada).
Suite completa: 158 tests, ESLint, Prettier, `svelte-check`, `tsc`, clippy y `cargo fmt` limpios.

## NO verificado en este entorno (no hay Docker/Podman/Linux)
Construcción de la imagen, `compose`, Quadlet, la unidad systemd, `backup.sh`/`restore.sh` (solo `bash -n`), los workflows de CI,
`tauri build` y el APK de Android. Están escritos según la documentación de cada herramienta; conviene ejecutarlos una vez.

## Decisiones
1. TypeScript 6 también en la raíz: `typescript-eslint` aún no soporta TS 7 (igual que SvelteKit 3.1 en `apps/web`).
2. El binario no necesita ficheros externos; las migraciones se embeben como texto y conservan la verificación de checksums.
3. La imagen no tiene shell: el healthcheck y las tareas de operación son subcomandos del binario.
4. En compose, `DATABASE_URL`/`DATABASE_APP_URL` los fija el propio archivo (host `db`), por encima del `.env`.
