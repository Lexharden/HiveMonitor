# ADR 0002 — Fundaciones del servidor (Fase 1)

## Qué se hizo
- `packages/core`: permisos, roles del sistema, evento normalizado (Zod), contratos de adaptador y de bus.
- `packages/db`: migraciones SQL versionadas (`migrations/`), esquema Drizzle (tipos), `withTenant`, migrador propio.
- `apps/api`: config por env (Zod), pino con redacción de secretos, Better Auth (organization + bearer),
  middleware de seguridad, rutas base (`/healthz`, `/readyz`, `/api/me`, `/api/t/:tenantId/*`, `/api/admin/*`).

## Cómo probarlo
```
bun test                      # core + db (RLS) + api (integración con Postgres real)
bun scripts/dev-db.ts         # Postgres local sin Docker (puerto 54329)
cd apps/api && bun src/index.ts
```

## Decisiones
1. **Dos conexiones a Postgres.** `DATABASE_URL` (propietario: migraciones, Better Auth, superadmin, mantenimiento)
   y `DATABASE_APP_URL` (rol `hive_app`: sin BYPASSRLS, no propietario, sin acceso a tablas de auth). Todo dato de tenant
   se toca con `withTenant` (`set_config('app.tenant_id', …, true)` por transacción). Sin contexto → 0 filas.
2. **Migraciones SQL a mano + runner propio** (no drizzle-kit): necesitamos RLS, particiones, funciones y roles que
   drizzle-kit no modela. El esquema Drizzle solo aporta tipos; hay que mantenerlo en sync con el SQL.
   El runner usa advisory lock y verifica checksums.
3. **`event` particionada por mes** con partición por defecto. La retención elimina particiones completas
   (`drop_old_event_partitions`); `ensure_event_partitions` las crea por adelantado (mantenimiento cada 6 h y al arrancar).
4. **`audit_log` append-only** (trigger que bloquea UPDATE/DELETE, incluso al propietario).
5. **Permisos = `recurso.acción`**, que coincide con los statements de Better Auth; los roles de la organización
   (`owner/admin/moderator/analyst`) se derivan de `SYSTEM_ROLES`. El frontend recibe permisos efectivos en `/api/me`.
   `system.admin` nunca lo concede un rol de organización: es el flag global `user.is_superadmin`.
6. **Superadmin solo por script** (`scripts/make-superadmin.ts`), no por correo en env: evita que alguien registre antes
   ese correo y escale privilegios.
7. **Roles personalizados** (`role_definition`): ya se resuelven en `requireTenant`/`/api/me`; falta UI y endpoints CRUD (Fase 7).
8. **Heartbeat**: el token se resuelve a tenant con `resolve_heartbeat_token()` (SECURITY DEFINER) porque aún no se conoce el tenant.
9. **IP del cliente**: solo se confía en `X-Forwarded-For` si la conexión directa viene de `TRUSTED_PROXIES`;
   se sobrescribe la cabecera antes de pasarla a Better Auth.
10. **Sesión/bearer**: el token bearer es el token de sesión de Better Auth (14 días con renovación deslizante diaria).
    No hay par access/refresh separado; la rotación diaria cumple el rol de "vida corta con refresh".
11. **Un tenant suspendido** recibe 403 en `/api/t/*`; el superadmin sigue pudiendo entrar.
12. **No hay Docker en la máquina de desarrollo**: los tests y `dev-db.ts` usan `embedded-postgres` (PostgreSQL real 18);
    con `TEST_DATABASE_URL` se usa un servidor externo (así correrá en CI con PostgreSQL 16).

## Pendiente de esta fase
- Verificación de correo y recuperación de contraseña (requiere transporte de correo; ver Fase 7).
- CRUD de roles personalizados.
