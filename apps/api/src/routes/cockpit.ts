import { and, desc, eq, gte } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { schema, withTenant } from "@hivemonitor/db";
import { audit } from "../audit.ts";
import type { AppDeps, AppEnv } from "../context.ts";
import { requireTenant } from "../middleware.ts";

const GOAL_KEY = "donation_goal";

const goalSchema = z.object({
  title: z.string().trim().min(1).max(60),
  targetUsd: z.number().positive().max(10_000_000),
});

/** Marcadores de momentos y meta de donaciones: los datos propios del cockpit. */
export function cockpitRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();

  /** Momentos recientes (por defecto, de las últimas 12 h). */
  r.get("/markers", requireTenant(deps, "stream.view"), async (c) => {
    const { tenantId } = c.get("tenant");
    const hours = Math.min(Math.max(Number(c.req.query("hours") ?? 12) || 12, 1), 24 * 14);
    const since = new Date(Date.now() - hours * 3_600_000);
    const rows = await withTenant(deps.appDb, tenantId, (tx) =>
      tx.select().from(schema.streamMarker).where(gte(schema.streamMarker.at, since)).orderBy(desc(schema.streamMarker.at)).limit(200),
    );
    return c.json({
      markers: rows.map((m) => ({
        id: m.id,
        at: m.at.toISOString(),
        kind: m.kind,
        label: m.label,
        platform: m.platform,
        channelId: m.channelId,
      })),
    });
  });

  /** «Marcar momento»: el instante queda guardado para recuperar el clip después. */
  r.post("/markers", requireTenant(deps, "chat.moderate"), async (c) => {
    const t = c.get("tenant");
    const body = z.object({ label: z.string().trim().max(80).optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    const marker = await deps.ingest.markers.save(t.tenantId, { kind: "manual", label: body.data.label || "Momento marcado" }, t.userId);
    return c.json({ marker }, 201);
  });

  r.delete("/markers/:id", requireTenant(deps, "chat.moderate"), async (c) => {
    const { tenantId } = c.get("tenant");
    const rows = await withTenant(deps.appDb, tenantId, (tx) =>
      tx
        .delete(schema.streamMarker)
        .where(eq(schema.streamMarker.id, c.req.param("id")))
        .returning({ id: schema.streamMarker.id }),
    );
    return rows.length ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
  });

  /** Meta de donaciones (USD). El progreso lo calcula el cliente con las donaciones de la sesión en curso. */
  r.get("/goal", requireTenant(deps, "stream.view"), async (c) => {
    const { tenantId } = c.get("tenant");
    const [row] = await withTenant(deps.appDb, tenantId, (tx) =>
      tx
        .select()
        .from(schema.tenantPref)
        .where(and(eq(schema.tenantPref.key, GOAL_KEY))),
    );
    const parsed = goalSchema.safeParse(row?.value);
    return c.json({ goal: parsed.success ? parsed.data : null });
  });

  r.put("/goal", requireTenant(deps, "alerts.manage"), async (c) => {
    const t = c.get("tenant");
    const raw = await c.req.json().catch(() => null);
    // `null` quita la meta
    if (raw === null || (raw && typeof raw === "object" && "goal" in raw && raw.goal === null)) {
      await withTenant(deps.appDb, t.tenantId, (tx) => tx.delete(schema.tenantPref).where(eq(schema.tenantPref.key, GOAL_KEY)));
      await audit(deps.appDb, { tenantId: t.tenantId, actorUserId: t.userId, action: "goal.clear", ip: c.get("ip") });
      return c.json({ goal: null });
    }
    const body = goalSchema.safeParse(raw);
    if (!body.success) return c.json({ error: "invalid_body", issues: body.error.issues }, 400);
    await withTenant(deps.appDb, t.tenantId, (tx) =>
      tx
        .insert(schema.tenantPref)
        .values({ tenantId: t.tenantId, key: GOAL_KEY, value: body.data })
        .onConflictDoUpdate({
          target: [schema.tenantPref.tenantId, schema.tenantPref.key],
          set: { value: body.data, updatedAt: new Date() },
        }),
    );
    await audit(deps.appDb, { tenantId: t.tenantId, actorUserId: t.userId, action: "goal.set", meta: body.data, ip: c.get("ip") });
    return c.json({ goal: body.data });
  });

  return r;
}
