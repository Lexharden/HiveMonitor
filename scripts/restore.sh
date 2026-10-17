#!/usr/bin/env bash
# Restaura una copia creada por backup.sh. DESTRUCTIVO: reemplaza los datos actuales.
#
#   HM_RUNTIME=native DATABASE_URL=postgres://… scripts/restore.sh backups/hivemonitor-XXXX.dump --yes
#
# Recomendado: detener HiveMonitor antes (systemctl stop hivemonitor / compose stop app).
set -euo pipefail

FILE="${1:-}"
CONFIRM="${2:-}"
RUNTIME="${HM_RUNTIME:-native}"
PG_USER="${POSTGRES_USER:-hive}"
PG_DB="${POSTGRES_DB:-hivemonitor}"

[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "Uso: restore.sh <archivo.dump> --yes" >&2; exit 2; }
if [ "$CONFIRM" != "--yes" ]; then
  echo "Esto sobrescribirá la base de datos con $FILE. Repite el comando con --yes para confirmar." >&2
  exit 2
fi

case "$RUNTIME" in
  native)
    : "${DATABASE_URL:?define DATABASE_URL}"
    pg_restore --clean --if-exists --no-owner --exit-on-error --dbname="$DATABASE_URL" "$FILE"
    ;;
  docker | podman)
    CONTAINER="${DB_CONTAINER:-$([ "$RUNTIME" = docker ] && echo hivemonitor-db-1 || echo hivemonitor-db)}"
    "$RUNTIME" exec -i "$CONTAINER" pg_restore --clean --if-exists --no-owner --exit-on-error -U "$PG_USER" -d "$PG_DB" < "$FILE"
    ;;
  *) echo "HM_RUNTIME debe ser native, docker o podman" >&2; exit 2 ;;
esac
echo "restauración completada. Arranca HiveMonitor de nuevo (las migraciones pendientes se aplican solas)."
