import { desc } from "drizzle-orm";
import { Hono } from "hono";
import { schema, withTenant } from "@hivemonitor/db";
import type { AppDeps, AppEnv } from "../context.ts";
import { connectionRoutes } from "./connections.ts";
import { realtimeRoutes } from "./realtime.ts";
import { requireTenant } from "../middleware.ts";

/** Rutas dependientes del tenant: `/api/t/:tenantId/...` (requireUser ya aplicado). */
export function tenantRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  r.route("/", connectionRoutes(deps));
  r.route("/", realtimeRoutes(deps));

  r.get("/audit", requireTenant(deps, "members.manage"), async (c) => {
    const { tenantId } = c.get("tenant");
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
    const rows = await withTenant(deps.appDb, tenantId, (tx) =>
      tx.select().from(schema.auditLog).orderBy(desc(schema.auditLog.at)).limit(limit),
    );
    return c.json({ entries: rows });
  });

  return r;
}
