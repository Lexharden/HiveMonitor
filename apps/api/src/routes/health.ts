import { Hono } from "hono";
import type { AppDeps, AppEnv } from "../context.ts";

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
  return r;
}
