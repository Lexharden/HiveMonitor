#!/usr/bin/env bash
# Copia de seguridad de PostgreSQL (formato custom de pg_dump, comprimido).
#
#   HM_RUNTIME=native  DATABASE_URL=postgres://… scripts/backup.sh
#   HM_RUNTIME=docker  scripts/backup.sh           # contenedor "hivemonitor-db-1" (compose)
#   HM_RUNTIME=podman  scripts/backup.sh           # contenedor "hivemonitor-db" (Quadlet) o compose
#
# Variables: BACKUP_DIR (def. ./backups), KEEP_DAYS (def. 14), DB_CONTAINER, POSTGRES_USER, POSTGRES_DB
set -euo pipefail

RUNTIME="${HM_RUNTIME:-native}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
PG_USER="${POSTGRES_USER:-hive}"
PG_DB="${POSTGRES_DB:-hivemonitor}"
mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/hivemonitor-$(date -u +%Y%m%dT%H%M%SZ).dump"
umask 077

case "$RUNTIME" in
  native)
    : "${DATABASE_URL:?define DATABASE_URL (usuario propietario)}"
    pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" --file="$FILE.tmp"
    ;;
  docker | podman)
    CONTAINER="${DB_CONTAINER:-$([ "$RUNTIME" = docker ] && echo hivemonitor-db-1 || echo hivemonitor-db)}"
    "$RUNTIME" exec "$CONTAINER" pg_dump --format=custom --no-owner -U "$PG_USER" -d "$PG_DB" > "$FILE.tmp"
    ;;
  *) echo "HM_RUNTIME debe ser native, docker o podman" >&2; exit 2 ;;
esac

# Un volcado vacío o truncado nunca debe quedar como copia válida
[ -s "$FILE.tmp" ] || { echo "El volcado salió vacío" >&2; rm -f "$FILE.tmp"; exit 1; }
mv "$FILE.tmp" "$FILE"
echo "copia creada: $FILE ($(du -h "$FILE" | cut -f1))"

find "$BACKUP_DIR" -name 'hivemonitor-*.dump' -mtime +"$KEEP_DAYS" -print -delete | sed 's/^/eliminada (antigua): /'
