# Despliegue con Docker Compose

```bash
cp .env.example .env
```

Edita `.env`: además de los secretos (`BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `BASE_URL`…) añade lo que usa compose:

```
POSTGRES_PASSWORD=una-clave-larga
DATABASE_APP_PASSWORD=otra-clave-larga
```

`DATABASE_URL` y `DATABASE_APP_URL` los compone `compose.yaml` apuntando al servicio `db`; las que haya en `.env` se ignoran.

```bash
docker compose -f deploy/compose.yaml --env-file .env up -d --build
docker compose -f deploy/compose.yaml logs -f app
curl -s localhost:3000/readyz
```

La app solo escucha en `127.0.0.1:3000`; publícala con el [reverse proxy](reverse-proxy.md) (`TRUSTED_PROXIES` = IP/red del proxy).

## Endurecimiento incluido

Imagen sin shell (`distroless`, usuario 65532), sistema de archivos de solo lectura (`/tmp` en tmpfs), `cap_drop: ALL`,
`no-new-privileges`, base de datos en una red interna sin puertos publicados, healthchecks y arranque ordenado (`depends_on: service_healthy`).

## Operación

```bash
docker compose -f deploy/compose.yaml exec app /app/hivemonitor make-superadmin tu@correo.com
HM_RUNTIME=docker scripts/backup.sh                       # contenedor hivemonitor-db-1
HM_RUNTIME=docker scripts/restore.sh backups/XXX.dump --yes
docker compose -f deploy/compose.yaml up -d --build       # actualizar
```

Detén `app` antes de restaurar: `docker compose -f deploy/compose.yaml stop app`.
