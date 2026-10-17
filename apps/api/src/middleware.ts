import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { getConnInfo } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import { resolvePermissions, type Permission } from "@hivemonitor/core";
import { schema, withTenant } from "@hivemonitor/db";
import { isProd } from "./config.ts";
import type { AppDeps, AppEnv } from "./context.ts";
import { httpCounters } from "./metrics.ts";
import { clientIp } from "./net.ts";

/** Id de petición + IP real (respetando TRUSTED_PROXIES) + log de acceso. */
export function requestContext(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let remote: string | undefined;
    try {
      remote = getConnInfo(c).remote.address;
    } catch {
      remote = undefined; // p. ej. app.request() en tests
    }
    const ip = clientIp(remote, c.req.header("x-forwarded-for"), deps.config.TRUSTED_PROXIES);
    c.set("ip", ip);
    c.set("requestId", c.req.header("x-request-id")?.slice(0, 64) ?? crypto.randomUUID());
    c.header("x-request-id", c.get("requestId"));
    const start = performance.now();
    await next();
    httpCounters.observe(c.req.method, c.res.status);
    if (c.req.path !== "/healthz") {
      deps.logger.info(
        {
          id: c.get("requestId"),
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          ms: Math.round(performance.now() - start),
          ip,
        },
        "request",
      );
    }
  };
}

/** Política CSP de la app. `scriptHashes`: hashes de los scripts en línea del index.html. */
export function buildCsp(deps: Pick<AppDeps, "config">, scriptHashes: string[] = []): string {
  const d = {
    "default-src": ["'self'"],
    "script-src": ["'self'", ...scriptHashes],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "https:"],
    "connect-src": ["'self'", ...deps.config.CORS_ORIGINS],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "object-src": ["'none'"],
    "worker-src": ["'self'"],
    "manifest-src": ["'self'"],
  };
  return Object.entries(d)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

/** Cabeceras de seguridad. No pisa una CSP ya fijada por el handler (la del SPA lleva hashes). */
export function securityHeaders(deps: AppDeps): MiddlewareHandler {
  const csp = buildCsp(deps);
  const hsts = isProd(deps.config) || deps.config.BASE_URL.startsWith("https://");
  return async (c, next) => {
    await next();
    const h = c.res.headers;
    if (!h.has("content-security-policy")) h.set("content-security-policy", csp);
    h.set("x-content-type-options", "nosniff");
    h.set("x-frame-options", "DENY");
    h.set("referrer-policy", "strict-origin-when-cross-origin");
    h.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (hsts) h.set("strict-transport-security", "max-age=63072000; includeSubDomains");
  };
}

export function corsMiddleware(deps: AppDeps): MiddlewareHandler {
  const allowed = new Set([deps.config.BASE_URL, ...deps.config.CORS_ORIGINS]);
  return cors({
    origin: (origin) => (allowed.has(origin) ? origin : null),
    credentials: true,
    allowHeaders: ["Authorization", "Content-Type", "X-Request-Id"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: ["set-auth-token", "x-request-id"],
    maxAge: 600,
  });
}

/** Ventana deslizante en memoria por IP. Suficiente para un solo proceso. */
export function rateLimit(limit: number, windowMs = 60_000): MiddlewareHandler<AppEnv> {
  const hits = new Map<string, number[]>();
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, v] of hits) if (!v.some((t) => t > cutoff)) hits.delete(k);
  }, windowMs);
  sweep.unref?.();
  return async (c, next) => {
    const now = Date.now();
    const key = c.get("ip");
    const arr = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
    if (arr.length >= limit) {
      c.header("Retry-After", String(Math.ceil(windowMs / 1000)));
      return c.json({ error: "rate_limited" }, 429);
    }
    arr.push(now);
    hits.set(key, arr);
    await next();
  };
}

/**
 * Defensa CSRF para peticiones que cambian estado y llevan cookies de sesión:
 * el Origin debe estar en la lista permitida. Las peticiones con bearer no
 * dependen de cookies y no necesitan esta comprobación.
 */
export function originCheck(deps: AppDeps): MiddlewareHandler {
  const allowed = new Set([deps.config.BASE_URL, ...deps.config.CORS_ORIGINS]);
  return async (c, next) => {
    const m = c.req.method;
    if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
    if (c.req.header("authorization")?.toLowerCase().startsWith("bearer ")) return next();
    if (!c.req.header("cookie")) return next();
    const origin = c.req.header("origin");
    if (!origin || !allowed.has(origin)) return c.json({ error: "origin_not_allowed" }, 403);
    return next();
  };
}

/**
 * Los navegadores no pueden poner cabeceras en un WebSocket: el cliente envía el token como
 * subprotocolo `bearer.<token en base64url>` y aquí se traduce a `Authorization: Bearer`.
 */
export function authHeaders(h: Headers): Headers {
  if (h.get("authorization")) return h;
  const proto = h.get("sec-websocket-protocol");
  const token = proto
    ?.split(",")
    .map((s) => s.trim())
    .find((s) => s.startsWith("bearer."))
    ?.slice("bearer.".length);
  if (!token) return h;
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return h;
  }
  const copy = new Headers(h);
  copy.set("authorization", `Bearer ${decoded}`);
  return copy;
}

/** Cross-Site WebSocket Hijacking: un upgrade con Origin no permitido se rechaza. */
export function wsOriginGuard(deps: AppDeps): MiddlewareHandler {
  const allowed = new Set([deps.config.BASE_URL, ...deps.config.CORS_ORIGINS]);
  return async (c, next) => {
    if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
      const origin = c.req.header("origin");
      if (origin && !allowed.has(origin)) return c.json({ error: "origin_not_allowed" }, 403);
    }
    return next();
  };
}

/** Exige sesión válida y deja el usuario en el contexto. */
export function requireUser(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = await deps.auth.api.getSession({ headers: authHeaders(c.req.raw.headers) });
    if (!session) throw new HTTPException(401, { message: "unauthorized" });
    const u = session.user as typeof session.user & { isSuperadmin?: boolean };
    c.set("user", { id: u.id, email: u.email, name: u.name, isSuperadmin: u.isSuperadmin === true });
    await next();
  };
}

export function requireSuperadmin(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.get("user").isSuperadmin) throw new HTTPException(403, { message: "forbidden" });
    await next();
  };
}

/** Membresía, suspensión y permisos efectivos de un usuario en un tenant (null si no es miembro y no es superadmin). */
export async function loadTenantAccess(
  deps: AppDeps,
  tenantId: string,
  user: { id: string; isSuperadmin: boolean },
): Promise<{ role: string; permissions: ReadonlySet<Permission>; suspended: boolean } | null> {
  const [m] = await deps.adminDb
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, tenantId), eq(schema.member.userId, user.id)))
    .limit(1);
  if (!m && !user.isSuperadmin) return null;
  const [settings] = await deps.adminDb
    .select({ suspended: schema.tenantSettings.suspended })
    .from(schema.tenantSettings)
    .where(eq(schema.tenantSettings.tenantId, tenantId))
    .limit(1);
  const custom = await withTenant(deps.appDb, tenantId, (tx) =>
    tx.select({ key: schema.roleDefinition.key, permissions: schema.roleDefinition.permissions }).from(schema.roleDefinition),
  );
  return {
    role: m?.role ?? "superadmin",
    permissions: resolvePermissions(m?.role ?? "", custom, user.isSuperadmin),
    suspended: settings?.suspended ?? false,
  };
}

/**
 * Resuelve el contexto de tenant de `/api/t/:tenantId/...`: membresía, suspensión
 * y permisos efectivos. Un no-miembro recibe 404 (no se revela la existencia).
 */
export function requireTenant(deps: AppDeps, ...needed: Permission[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get("user");
    const tenantId = c.req.param("tenantId");
    if (!tenantId) throw new HTTPException(400, { message: "tenant requerido" });
    const access = await loadTenantAccess(deps, tenantId, user);
    if (!access) throw new HTTPException(404, { message: "not_found" });
    if (access.suspended && !user.isSuperadmin) throw new HTTPException(403, { message: "tenant_suspended" });
    for (const p of needed) {
      if (!access.permissions.has(p)) throw new HTTPException(403, { message: "forbidden" });
    }
    c.set("tenant", { tenantId, userId: user.id, role: access.role, permissions: access.permissions, isSuperadmin: user.isSuperadmin });
    await next();
  };
}
