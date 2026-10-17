# Despliegue nativo (binario + systemd)

Requisitos: Linux x64/arm64, PostgreSQL 16+ (local o remoto), un reverse proxy con TLS ([guía](reverse-proxy.md)).

## 1. Base de datos

Un usuario propietario que pueda crear roles (las migraciones crean el rol `hive_app` sujeto a RLS):

```sql
CREATE ROLE hive LOGIN PASSWORD 'cambia-esto' CREATEROLE;
CREATE DATABASE hivemonitor OWNER hive;
```

## 2. Binario

Descarga `hivemonitor-linux-x64` (o `-arm64`) de los artefactos de CI, o compílalo:

```bash
bun install && bun scripts/build-binary.ts --targets=linux-x64
sudo useradd --system --home /opt/hivemonitor --shell /usr/sbin/nologin hivemonitor
sudo install -D -m 0755 dist/hivemonitor-linux-x64 /opt/hivemonitor/hivemonitor
```

El binario lleva el frontend y las migraciones: no necesita nada más en disco.

## 3. Configuración

```bash
sudo install -d -m 0750 -o root -g hivemonitor /etc/hivemonitor
sudo cp .env.example /etc/hivemonitor/hivemonitor.env
sudo chown root:hivemonitor /etc/hivemonitor/hivemonitor.env && sudo chmod 0640 /etc/hivemonitor/hivemonitor.env
sudoedit /etc/hivemonitor/hivemonitor.env
```

Obligatorios: `DATABASE_URL`, `DATABASE_APP_URL`, `DATABASE_APP_PASSWORD` (misma contraseña que en `DATABASE_APP_URL`),
`BASE_URL`, `BETTER_AUTH_SECRET` (`openssl rand -base64 48`), `ENCRYPTION_KEY` (`openssl rand -base64 32`; **no la pierdas**: cifra los tokens de terceros).
Para Nginx Proxy Manager en el mismo host: `TRUSTED_PROXIES=127.0.0.1` (y `HOST=127.0.0.1` si solo el proxy debe llegar).

## 4. Servicio

```bash
sudo cp deploy/systemd/hivemonitor.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now hivemonitor
journalctl -u hivemonitor -f          # logs JSON (pino)
curl -s localhost:3000/readyz
```

`AUTO_MIGRATE=true` (por defecto) aplica migraciones al arrancar. Para hacerlo a mano: `hivemonitor migrate`.

## 5. Primer usuario y superadmin

Regístrate en la web y luego:

```bash
sudo -u hivemonitor env $(cat /etc/hivemonitor/hivemonitor.env | xargs) /opt/hivemonitor/hivemonitor make-superadmin tu@correo.com
```

## 6. Nginx

Publica el servicio con TLS usando [`deploy/nginx/hivemonitor.conf`](../deploy/nginx/hivemonitor.conf) (instrucciones en [reverse-proxy.md](reverse-proxy.md)).

## Operación

- Actualizar: reemplaza el binario y `systemctl restart hivemonitor` (SIGTERM = apagado ordenado, hasta 25 s).
- Backup: `HM_RUNTIME=native DATABASE_URL=… scripts/backup.sh` (cron diario). Restore: `scripts/restore.sh <dump> --yes`.
- Métricas: `curl -H "Authorization: Bearer $METRICS_TOKEN" localhost:3000/metrics`.
