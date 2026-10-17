# ADR 0008 — Alertas, miembros, auditoría, superadmin y heartbeat (Fase 7)

## Qué se hizo
- **Alertas**: motor (`apps/api/src/alerts`) con 4 tipos — donación sobre umbral, caída de viewers, desconexión de plataforma,
  app sin señal (heartbeat) — y 3 canales: panel (SSE + toasts), nativa (notificación del sistema/navegador) y webhook de Discord.
- **Miembros**: listado, invitaciones por correo (SMTP opcional) o enlace, cambio de rol, expulsión, **transferencia de propiedad**.
- **Auditoría**: cambios de rol, altas/bajas, invitaciones, alertas, conexiones, tokens, moderación, suspensiones.
- **Superadmin**: organizaciones (suspender, límite de canales), salud del sistema, conexiones y errores recientes.
- **Heartbeat externo**: tokens por tenant + `POST /api/heartbeat`; tarjetas en el panel y alerta de silencio.
- **Tauri**: bandeja del sistema, cerrar-a-bandeja (el monitoreo sigue), inicio automático (`--minimized`), notificaciones.

## Cómo probarlo
`bun test apps/api/test/phase7.test.ts` (23 tests) · `cargo clippy` en `apps/desktop/src-tauri` ·
`DATABASE_URL=… bun scripts/screenshot.ts .shots` (capturas 08–11).

## Decisiones
1. **Webhooks solo a Discord** (host + ruta `/api/webhooks/<id>/<token>` validados, https, sin puerto/credenciales, `redirect: error`,
   timeout 5 s, `allowed_mentions: none`): evita SSRF y es lo que pide el producto. La URL se guarda **cifrada** y nunca se devuelve.
2. **Motor de alertas** observa el pipeline y el supervisor mediante *taps* (un observador roto no afecta al flujo). Cada regla tiene
   `cooldownSec`; la desconexión espera un margen (`graceSec`) y se cancela si la conexión se recupera; el silencio de heartbeat
   avisa una vez y se rearma con el siguiente latido. Reglas cacheadas 30 s con carga compartida e invalidación al editar.
3. **Condición de carrera corregida**: las muestras de viewers se registran de forma síncrona antes de cargar reglas; la evaluación
   solo mira muestras hasta su instante. (Detectado por un test.)
4. **Heartbeat**: el token (`hm_…`) se muestra una vez y solo se guarda su SHA-256; el tenant se resuelve con la función
   `SECURITY DEFINER` de la migración 0001; límite 60/min por token, cuerpo ≤ 8 KB, métricas planas (≤ 50), retención 24 h por fuente.
5. **Auditoría de Better Auth**: sus ganchos no dicen quién actúa → `AsyncLocalStorage` fija el actor en las rutas
   `/api/auth/organization/*`. Así se audita cualquier vía (UI, SDK o llamada directa). Better Auth ya impide que un admin toque
   al owner o asigne `owner` (verificado por tests); la propiedad solo se transfiere con `POST /members/transfer-ownership`.
6. **Roles personalizados**: siguen siendo solo modelo (`role_definition` + resolución de permisos); el CRUD queda para "más adelante".
7. El audit_log de una organización se borra en cascada con ella (queda un `warn` en el log del servidor).
8. Notificaciones nativas con la misma API en Tauri (`plugin-notification`) y navegador (`Notification`), degradando si no hay permiso.

## Limitaciones
- Las alertas se evalúan en memoria de un solo proceso (sin Redis); con varias réplicas habría que mover cooldowns al bus compartido.
- No hay recuperación de contraseña ni verificación de correo (requeriría flujos de correo adicionales).
