import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppDeps, AppEnv } from "./context.ts";
import { corsMiddleware, originCheck, rateLimit, requestContext, requireUser, securityHeaders } from "./middleware.ts";
import { adminRoutes } from "./routes/admin.ts";
import { healthRoutes } from "./routes/health.ts";
import { meRoutes } from "./routes/me.ts";
import { tenantRoutes } from "./routes/tenant.ts";

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.use("*", requestContext(deps));
  app.use("*", securityHeaders(deps));
  app.use("/api/*", corsMiddleware(deps));
  app.use("/api/*", rateLimit(deps.config.RATE_LIMIT_PER_MINUTE));
  app.use("/api/*", originCheck(deps));

  app.route("/", healthRoutes(deps));

  // Better Auth. Se sobrescribe X-Forwarded-For con la IP ya validada para que no sea falsificable.
  app.on(["GET", "POST"], "/api/auth/*", (c) => {
    const headers = new Headers(c.req.raw.headers);
    headers.set("x-forwarded-for", c.get("ip"));
    return deps.auth.handler(new Request(c.req.raw, { headers }));
  });

  app.route("/api", meRoutes(deps));
  app.route("/api/admin", adminRoutes(deps));
  const tenant = new Hono<AppEnv>();
  tenant.use("*", requireUser(deps));
  tenant.route("/", tenantRoutes(deps));
  app.route("/api/t/:tenantId", tenant);

  // Frontend estático embebido (SPA con fallback a index.html)
  app.get("*", async (c) => {
    if (c.req.path.startsWith("/api/")) return c.json({ error: "not_found" }, 404);
    const res = await deps.staticHandler?.(c.req.raw);
    return res ?? c.json({ error: "not_found" }, 404);
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message || "error" }, err.status);
    }
    deps.logger.error({ err, id: c.get("requestId") }, "error no controlado");
    return c.json({ error: "internal_error" }, 500);
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}

export type App = ReturnType<typeof createApp>;
