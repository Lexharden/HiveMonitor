import { Hono } from "hono";
import type { AppDeps, AppEnv } from "../context.ts";
import { bearerMatches, renderMetrics } from "../metrics.ts";

export function healthRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  r.get("/healthz", (c) => c.json({ status: "ok" }));
  r.get("/readyz", async (c) => {
    const checks = { db: false, bus: deps.bus.ready() };
    try {
      await deps.ping();
      checks.db = true;
    } catch (err) {
      deps.logger.warn({ err }, "readyz: base de datos no disponible");
    }
    const ok = checks.db && checks.bus;
    return c.json({ status: ok ? "ready" : "unavailable", checks }, ok ? 200 : 503);
  });
  /** Prometheus. Desactivado (404) si no hay METRICS_TOKEN; con él, exige `Authorization: Bearer`. */
  r.get("/metrics", (c) => {
    const token = deps.config.METRICS_TOKEN;
    if (!token) return c.json({ error: "not_found" }, 404);
    if (!bearerMatches(c.req.header("authorization"), token)) return c.json({ error: "unauthorized" }, 401);
    return c.text(renderMetrics(deps), 200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
  });
  return r;
}
