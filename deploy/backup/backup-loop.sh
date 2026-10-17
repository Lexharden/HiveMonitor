#!/bin/sh
# Servicio de copias de seguridad de HiveMonitor (se ejecuta DENTRO del contenedor "backup" de compose, imagen de PostgreSQL).
# Hace un volcado cada BACKUP_INTERVAL_HOURS, comprueba que el archivo es válido y borra los antiguos.
# Si algo falla avisa por un webhook de Discord (BACKUP_FAIL_WEBHOOK) y reintenta en el siguiente ciclo.
set -u

INTERVAL_H="${BACKUP_INTERVAL_HOURS:-24}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
DIR="${BACKUP_DIR:-/backups}"
FIRST_DELAY="${BACKUP_FIRST_DELAY_SECONDS:-60}"
export PGPASSWORD="${PGPASSWORD:?define PGPASSWORD}"
HOST="${PGHOST:-db}"
USER_="${PGUSER:-hive}"
DB="${PGDATABASE:-hivemonitor}"

log() { echo "$(date -u +%FT%TZ) backup: $*"; }

notify_failure() {
  log "FALLO: $1"
  case "${BACKUP_FAIL_WEBHOOK:-}" in
    https://discord.com/api/webhooks/* | https://discordapp.com/api/webhooks/*)
      wget -q -O /dev/null --header 'Content-Type: application/json' \
        --post-data "{\"username\":\"HiveMonitor\",\"allowed_mentions\":{\"parse\":[]},\"content\":\"⚠️ Falló la copia de seguridad de HiveMonitor: $1\"}" \
        "$BACKUP_FAIL_WEBHOOK" 2>/dev/null || true ;;
  esac
}

run_once() {
  mkdir -p "$DIR" || { notify_failure "no se puede escribir en $DIR"; return 1; }
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  file="$DIR/hivemonitor-$ts.dump"
  umask 077
  if ! pg_dump --format=custom --no-owner -h "$HOST" -U "$USER_" -d "$DB" -f "$file.tmp"; then
    rm -f "$file.tmp"; notify_failure "pg_dump terminó con error"; return 1
  fi
  # Un archivo vacío o ilegible no cuenta como copia
  if [ ! -s "$file.tmp" ] || ! pg_restore --list "$file.tmp" > /dev/null 2>&1; then
    rm -f "$file.tmp"; notify_failure "el volcado salió vacío o corrupto"; return 1
  fi
  mv "$file.tmp" "$file"
  log "copia creada: $file ($(du -h "$file" | cut -f1))"
  find "$DIR" -name 'hivemonitor-*.dump' -mtime +"$KEEP_DAYS" -print -delete | sed 's/^/backup: eliminada (antigua): /'
  return 0
}

# Si se ejecuta con "once" hace una sola copia y sale (útil para pruebas: docker compose run --rm backup once)
if [ "${1:-}" = "once" ]; then run_once; exit $?; fi

log "servicio iniciado: cada ${INTERVAL_H} h, conserva ${KEEP_DAYS} días, destino ${DIR}"
sleep "$FIRST_DELAY"
while true; do
  run_once || true
  sleep $((INTERVAL_H * 3600))
done
