# Copias de seguridad

Lo único que no se puede reconstruir es la base de datos PostgreSQL (usuarios, organizaciones, tokens de Twitch cifrados, historial).
**Y la clave `ENCRYPTION_KEY`**: sin ella los tokens de Twitch de una copia no se pueden descifrar. Guárdala aparte (gestor de contraseñas).

Regla práctica **3-2-1**: 3 copias, en 2 sitios distintos, 1 fuera del servidor.

## Opción A — Docker/Podman compose (servicio incluido)

El servicio `backup` de `deploy/compose.yaml` hace un volcado cada 24 h, comprueba que el archivo es legible, borra los de más de 14 días y,
si algo falla, avisa por Discord. Está en un perfil opcional:

```bash
# .env (opcionales)
# BACKUP_INTERVAL_HOURS=24     BACKUP_KEEP_DAYS=14     BACKUP_DIR=/srv/hivemonitor-backups
# BACKUP_FAIL_WEBHOOK=https://discord.com/api/webhooks/…   (solo Discord)

docker compose -f deploy/compose.yaml --env-file .env --profile backup up -d
docker compose -f deploy/compose.yaml --env-file .env --profile backup run --rm backup once   # una copia ahora mismo
ls -lh backups/                                                                                  # por defecto, ./backups junto al repo
```

`POSTGRES_IMAGE` (mismo valor para `db` y `backup`) permite subir de versión de PostgreSQL; `pg_dump` debe ser de la misma versión mayor que el servidor.

## Opción B — systemd timer (nativo, o Docker/Podman desde el host)

```bash
sudo tee /etc/hivemonitor/backup.env >/dev/null <<'EOT'
HM_RUNTIME=docker                    # native | docker | podman
BACKUP_DIR=/srv/hivemonitor-backups
KEEP_DAYS=14
# DATABASE_URL=postgres://hive:…@localhost:5432/hivemonitor     (solo native)
# BACKUP_FAIL_WEBHOOK=https://discord.com/api/webhooks/…
EOT
sudo chmod 600 /etc/hivemonitor/backup.env
sudo cp deploy/systemd/hivemonitor-backup.{service,timer} /etc/systemd/system/   # ajusta WorkingDirectory/ExecStart a la ruta del repo
sudo systemctl daemon-reload && sudo systemctl enable --now hivemonitor-backup.timer
systemctl list-timers hivemonitor-backup.timer
sudo systemctl start hivemonitor-backup.service && journalctl -u hivemonitor-backup -n 20      # prueba manual
```

## Sacar la copia del servidor (la «1» del 3-2-1)

`scripts/backup.sh` ejecuta `BACKUP_POST_HOOK` tras cada copia correcta (el archivo llega como `$1`). Ejemplos:

```bash
# rclone (S3, Backblaze B2, Cloudflare R2, Google Drive…): rclone config  → remoto "r2"
BACKUP_POST_HOOK='rclone copyto "$1" r2:mi-bucket/hivemonitor/$(basename "$1")'
# otro servidor por SSH
BACKUP_POST_HOOK='scp -q "$1" backup@otro-servidor:/srv/backups/hivemonitor/'
```

Si el hook falla, la copia local se conserva y se avisa del error. Con el servicio de compose, sincroniza la carpeta `BACKUP_DIR` con un cron
(`rclone sync /srv/hivemonitor-backups r2:mi-bucket/hivemonitor`).

## Comprobar que se puede restaurar (hazlo una vez al mes)

Una copia que no se ha restaurado nunca es una esperanza, no una copia. `verify-backup.sh` la carga en una base **temporal**, cuenta tablas y
filas clave, y la borra; no toca los datos reales.

```bash
HM_RUNTIME=docker BACKUP_DIR=./backups scripts/verify-backup.sh          # la más reciente
HM_RUNTIME=docker scripts/verify-backup.sh backups/hivemonitor-20261017T033000Z.dump
```

## Restaurar de verdad (desastre)

```bash
docker compose -f deploy/compose.yaml --env-file .env stop app                      # que nadie escriba durante la restauración
HM_RUNTIME=docker scripts/restore.sh backups/hivemonitor-XXXX.dump --yes             # reemplaza los datos actuales
docker compose -f deploy/compose.yaml --env-file .env up -d app                      # las migraciones pendientes se aplican solas
```

En un servidor nuevo: levanta compose (con el mismo `ENCRYPTION_KEY` y `BETTER_AUTH_SECRET` del original), restaura y arranca.
Con `BETTER_AUTH_SECRET` distinto las sesiones activas se invalidan (hay que volver a entrar), pero no se pierden datos.

## Qué cubren (y qué no)

- Cubren: usuarios, organizaciones, miembros, conexiones, tokens cifrados, eventos dentro de la retención, estadísticas, alertas, auditoría.
- No cubren: `.env` ni `ENCRYPTION_KEY` (guárdalos tú), ni la configuración de Nginx.
- Las copias contienen datos personales y tokens cifrados: permisos `0600`, y cifra el destino externo.
