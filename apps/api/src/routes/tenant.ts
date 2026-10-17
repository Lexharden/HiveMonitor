import { desc } from "drizzle-orm";
import { Hono } from "hono";
import { schema, withTenant } from "@hivemonitor/db";
import type { AppDeps, AppEnv } from "../context.ts";
import { requireTenant } from "../middleware.ts";

/** Rutas dependientes del tenant: `/api/t/:tenantId/...` (requireUser ya aplicado). */
export function tenantRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();

  r.get("/connections", requireTenant(deps, "stream.view"), async (c) => {
    const { tenantId } = c.get("tenant");
    const rows = await withTenant(deps.appDb, tenantId, (tx) =>
      tx
        .select({
          id: schema.platformConnection.id,
          platform: schema.platformConnection.platform,
          channelId: schema.platformConnection.channelId,
          channelName: schema.platformConnection.channelName,
          status: schema.platformConnection.status,
          enabled: schema.platformConnection.enabled,
          lastError: schema.platformConnection.lastError,
          updatedAt: schema.platformConnection.updatedAt,
        })
        .from(schema.platformConnection),
    );
    return c.json({ connections: rows });
  });

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
