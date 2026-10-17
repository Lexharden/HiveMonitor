#!/usr/bin/env bash
# Comprueba que una copia SE PUEDE RESTAURAR: la carga en una base de datos temporal, cuenta tablas y filas clave
# y borra la base temporal. No toca los datos reales. Hazlo de vez en cuando (p. ej. una vez al mes).
#
#   HM_RUNTIME=native DATABASE_URL=postgres://… scripts/verify-backup.sh [archivo.dump]
#   HM_RUNTIME=docker scripts/verify-backup.sh [archivo.dump]
#
# Sin archivo usa la copia más reciente de BACKUP_DIR (def. ./backups).
set -euo pipefail

RUNTIME="${HM_RUNTIME:-native}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
PG_USER="${POSTGRES_USER:-hive}"
FILE="${1:-$(ls -1t "$BACKUP_DIR"/hivemonitor-*.dump 2>/dev/null | head -1 || true)}"
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "No hay copias en $BACKUP_DIR" >&2; exit 2; }
TMPDB="hm_verify_$(date +%s)_$$"
echo "verificando $FILE en la base temporal $TMPDB…"

if [ "$RUNTIME" = native ]; then
  : "${DATABASE_URL:?define DATABASE_URL (usuario con permiso para crear bases)}"
  ROOT_URL="${DATABASE_URL%/*}/postgres"
  TMP_URL="${DATABASE_URL%/*}/$TMPDB"
  q() { psql "$TMP_URL" -tAc "$1"; }
  mk() { psql "$ROOT_URL" -qc "create database $TMPDB"; }
  rm_() { psql "$ROOT_URL" -qc "drop database if exists $TMPDB with (force)" > /dev/null 2>&1 || true; }
  restore() { pg_restore --no-owner --exit-on-error --dbname="$TMP_URL" "$FILE"; }
else
  CONTAINER="${DB_CONTAINER:-$([ "$RUNTIME" = docker ] && echo hivemonitor-db-1 || echo hivemonitor-db)}"
  q() { "$RUNTIME" exec "$CONTAINER" psql -U "$PG_USER" -d "$TMPDB" -tAc "$1"; }
  mk() { "$RUNTIME" exec "$CONTAINER" createdb -U "$PG_USER" "$TMPDB"; }
  rm_() { "$RUNTIME" exec "$CONTAINER" dropdb -U "$PG_USER" --if-exists "$TMPDB" > /dev/null 2>&1 || true; }
  restore() { "$RUNTIME" exec -i "$CONTAINER" pg_restore --no-owner --exit-on-error -U "$PG_USER" -d "$TMPDB" < "$FILE"; }
fi

trap rm_ EXIT
mk
restore
TABLES="$(q "select count(*) from information_schema.tables where table_schema='public'")"
MIGS="$(q "select count(*) from _migrations")"
USERS="$(q "select count(*) from \"user\"")"
ORGS="$(q "select count(*) from organization")"
EVENTS="$(q "select count(*) from event")"
echo "tablas: $TABLES · migraciones: $MIGS · usuarios: $USERS · organizaciones: $ORGS · eventos: $EVENTS"
[ "$TABLES" -gt 10 ] && [ "$MIGS" -gt 0 ] || { echo "La copia se restauró pero parece incompleta" >&2; exit 1; }
echo "OK: la copia es restaurable."
