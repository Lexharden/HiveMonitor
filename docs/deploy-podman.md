# Despliegue con Podman (rootless)

El mismo `deploy/Containerfile` y `deploy/compose.yaml` funcionan con Podman. Dos vías.

## A) `podman compose` / `podman-compose`

```bash
cp .env.example .env     # añade POSTGRES_PASSWORD y DATABASE_APP_PASSWORD (ver deploy-docker.md)
podman compose -f deploy/compose.yaml --env-file .env up -d --build
```

## B) Quadlet + systemd (recomendado en servidores)

Los archivos están en `deploy/quadlet/`. Se instalan en el directorio del usuario que ejecuta los contenedores.

```bash
# 1) Imagen
podman build -f deploy/Containerfile -t localhost/hivemonitor:latest .

# 2) Configuración (fuera del repositorio, permisos 0600)
mkdir -p ~/.config/hivemonitor && chmod 700 ~/.config/hivemonitor
cat > ~/.config/hivemonitor/db.env <<'EOT'
POSTGRES_USER=hive
POSTGRES_PASSWORD=una-clave-larga
POSTGRES_DB=hivemonitor
EOT
cp .env.example ~/.config/hivemonitor/hivemonitor.env      # y edítalo:
#   DATABASE_URL=postgres://hive:una-clave-larga@hivemonitor-db:5432/hivemonitor
#   DATABASE_APP_URL=postgres://hive_app:otra-clave@hivemonitor-db:5432/hivemonitor
#   DATABASE_APP_PASSWORD=otra-clave
chmod 600 ~/.config/hivemonitor/*.env

# 3) Quadlet
mkdir -p ~/.config/containers/systemd
cp deploy/quadlet/* ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start hivemonitor-db hivemonitor
loginctl enable-linger "$USER"        # que sigan al cerrar sesión y arranquen con el equipo

journalctl --user -u hivemonitor -f
```

Para un despliegue de sistema (root) copia a `/etc/containers/systemd/` y usa `systemctl` sin `--user`
(cambia `%h/.config/hivemonitor` por `/etc/hivemonitor` en los `.container`).

## Notas de Podman

- Los puertos < 1024 no se pueden publicar rootless: se usa `127.0.0.1:3000` y el reverse proxy da la cara pública.
- El volumen `hivemonitor-db` lo gestiona Podman (propiedad correcta con el mapeo de UID rootless).
- Backup/restore: `HM_RUNTIME=podman scripts/backup.sh` (contenedor `hivemonitor-db`; con compose, `DB_CONTAINER=hivemonitor_db_1`).
- Superadmin: `podman exec hivemonitor /app/hivemonitor make-superadmin tu@correo.com` (necesita `DATABASE_URL` en el entorno del contenedor: ya lo tiene).
- Actualizar: reconstruye la imagen y `systemctl --user restart hivemonitor`.
