#!/usr/bin/env bash
# Copia de seguridad de PostgreSQL (formato custom de pg_dump, comprimido), con verificación del archivo.
#
#   HM_RUNTIME=native  DATABASE_URL=postgres://… scripts/backup.sh
#   HM_RUNTIME=docker  scripts/backup.sh           # contenedor "hivemonitor-db-1" (compose)
#   HM_RUNTIME=podman  scripts/backup.sh           # contenedor "hivemonitor-db" (Quadlet) o compose
#
# Variables: BACKUP_DIR (def. ./backups), KEEP_DAYS (def. 14), DB_CONTAINER, POSTGRES_USER, POSTGRES_DB,
#            BACKUP_POST_HOOK (comando que se ejecuta tras una copia correcta; se ejecuta con `sh -c` y la ruta del archivo
#            llega como $1; úsalo para subirla fuera del servidor. Ej.: BACKUP_POST_HOOK='rclone copyto "$1" r2:bucket/hivemonitor/$(basename "$1")'), BACKUP_FAIL_WEBHOOK (Discord)
set -euo pipefail

RUNTIME="${HM_RUNTIME:-native}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
PG_USER="${POSTGRES_USER:-hive}"
PG_DB="${POSTGRES_DB:-hivemonitor}"
mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/hivemonitor-$(date -u +%Y%m%dT%H%M%SZ).dump"
umask 077

fail() {
  echo "FALLO: $1" >&2
  rm -f "$FILE.tmp"
  case "${BACKUP_FAIL_WEBHOOK:-}" in
    https://discord.com/api/webhooks/* | https://discordapp.com/api/webhooks/*)
      curl -fsS -m 10 -H 'Content-Type: application/json' \
        -d "{\"username\":\"HiveMonitor\",\"allowed_mentions\":{\"parse\":[]},\"content\":\"⚠️ Falló la copia de seguridad de HiveMonitor: $1\"}" \
        "$BACKUP_FAIL_WEBHOOK" > /dev/null || true ;;
  esac
  exit 1
}

case "$RUNTIME" in
  native)
    : "${DATABASE_URL:?define DATABASE_URL (usuario propietario)}"
    pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" --file="$FILE.tmp" || fail "pg_dump terminó con error"
    pg_restore --list "$FILE.tmp" > /dev/null 2>&1 || fail "el volcado es ilegible"
    ;;
  docker | podman)
    CONTAINER="${DB_CONTAINER:-$([ "$RUNTIME" = docker ] && echo hivemonitor-db-1 || echo hivemonitor-db)}"
    "$RUNTIME" exec "$CONTAINER" pg_dump --format=custom --no-owner -U "$PG_USER" -d "$PG_DB" > "$FILE.tmp" || fail "pg_dump terminó con error"
    "$RUNTIME" exec -i "$CONTAINER" pg_restore --list < "$FILE.tmp" > /dev/null 2>&1 || fail "el volcado es ilegible"
    ;;
  *) echo "HM_RUNTIME debe ser native, docker o podman" >&2; exit 2 ;;
esac

# Un volcado vacío o truncado nunca debe quedar como copia válida
[ -s "$FILE.tmp" ] || fail "el volcado salió vacío"
mv "$FILE.tmp" "$FILE"
echo "copia creada: $FILE ($(du -h "$FILE" | cut -f1))"

if [ -n "${BACKUP_POST_HOOK:-}" ]; then
  # shellcheck disable=SC2086
  sh -c "$BACKUP_POST_HOOK" _ "$FILE" || fail "el comando BACKUP_POST_HOOK terminó con error (la copia local existe: $FILE)"
fi

find "$BACKUP_DIR" -name 'hivemonitor-*.dump' -mtime +"$KEEP_DAYS" -print -delete | sed 's/^/eliminada (antigua): /'
