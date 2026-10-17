# Reverse proxy (Nginx Proxy Manager y Nginx nativo)

Ejemplo: `https://hivemonitor.yafel.dev` → HiveMonitor en `127.0.0.1:3000` (o `hivemonitor:3000` si NPM comparte red con el contenedor).

## Servidor

En `.env`:

```
BASE_URL=https://hivemonitor.yafel.dev
TRUSTED_PROXIES=<IP o red de Nginx Proxy Manager>   # p. ej. 172.18.0.0/16 o 127.0.0.1
CORS_ORIGINS=http://tauri.localhost,https://tauri.localhost,tauri://localhost   # solo si usas el cliente Tauri
```

`X-Forwarded-For` solo se respeta si la conexión llega desde `TRUSTED_PROXIES`; si no, se usa la IP directa
(así nadie puede falsificar su IP para esquivar el límite de tasa).

## Nginx Proxy Manager

1. **Proxy Host**: dominio, esquema `http`, host/puerto de HiveMonitor. Activa *Block Common Exploits*.
2. **SSL**: certificado Let's Encrypt, *Force SSL* y *HTTP/2*. (HSTS lo envía la propia app cuando `BASE_URL` es https.)
3. **Websockets Support**: ACTIVADO (el WebSocket de moderación).
4. Pestaña **Advanced** → *Custom Nginx Configuration* (SSE: sin buffering y tiempos largos):

```nginx
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_http_version 1.1;
chunked_transfer_encoding on;
```

El flujo SSE envía un latido cada 15 s y se cierra solo a los 30 min para reevaluar permisos (el cliente reconecta); aun así
`proxy_read_timeout` por debajo de ~60 s cortaría los flujos.

## Nginx nativo (sin Proxy Manager)

Configuración lista en [`deploy/nginx/hivemonitor.conf`](../deploy/nginx/hivemonitor.conf): redirección a HTTPS, TLS (rutas de certbot), WebSocket, SSE
(sin buffering, tiempos de 1 h), cabeceras `X-Forwarded-*` y límite de cuerpo.

```bash
sudo cp deploy/nginx/hivemonitor.conf /etc/nginx/conf.d/hivemonitor.conf
sudo sed -i 's/hivemonitor.yafel.dev/TU.DOMINIO/g' /etc/nginx/conf.d/hivemonitor.conf
sudo certbot certonly --nginx -d TU.DOMINIO
sudo nginx -t && sudo systemctl reload nginx
```

En el `.env` de HiveMonitor: `BASE_URL=https://TU.DOMINIO` y `TRUSTED_PROXIES=127.0.0.1` (Nginx en el mismo host; con `HOST=127.0.0.1` solo el proxy llega a la app).
Si emites el certificado antes de activar el bloque 443, comenta temporalmente ese `server` y usa solo el de puerto 80.

### Variante sin TLS

[`deploy/nginx/hivemonitor-nossl.conf`](../deploy/nginx/hivemonitor-nossl.conf) escucha solo en el puerto 80, sin certificados ni redirección.
Úsala cuando el HTTPS lo termina otra capa (Cloudflare, balanceador, otro proxy) o en una red local de confianza. Si es la capa pública,
cookies y tokens irían en claro: usa la versión con TLS. Mismos requisitos de `.env` (`TRUSTED_PROXIES` = IP de este Nginx).

## Webhook de Twitch (EventSub)

Con `TWITCH_EVENTSUB_MODE=webhook`, Twitch llama a `https://<tu dominio>/webhooks/twitch/eventsub`. No restrinjas esa ruta por IP
ni la pongas detrás de autenticación del proxy: la autenticidad la da la firma HMAC.

## Comprobación

```bash
curl -sN https://hivemonitor.yafel.dev/readyz
# SSE (con sesión): debe llegar "event: snapshot" de inmediato, sin esperar a que se llene un búfer
```
