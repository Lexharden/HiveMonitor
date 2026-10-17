import { and, count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { schema, withTenant } from "@hivemonitor/db";
import { ALERT_CHANNELS, ALERT_TYPES, isAllowedWebhookUrl, parseParams } from "../alerts/rules.ts";
import { audit } from "../audit.ts";
import type { AppDeps, AppEnv } from "../context.ts";
import { requireTenant } from "../middleware.ts";

const MAX_RULES = 20;

const base = {
  name: z.string().trim().min(1).max(80),
  channels: z.array(z.enum(ALERT_CHANNELS)).min(1).max(3),
  webhookUrl: z.string().max(300).nullable().optional(),
};
const createSchema = z.object({ type: z.enum(ALERT_TYPES), params: z.record(z.string(), z.unknown()).default({}), ...base });
const patchSchema = z.object({ params: z.record(z.string(), z.unknown()).optional(), enabled: z.boolean().optional(), name: base.name.optional(), channels: base.channels.optional(), webhookUrl: base.webhookUrl }).strict();

const publicRule = (r: typeof schema.alertRule.$inferSelect) => ({
  id: r.id,
  type: r.type,
  name: r.name,
  params: r.params,
  channels: r.channels,
  enabled: r.enabled,
  // La URL del webhook nunca sale del servidor
  hasWebhook: r.webhookUrlEnc !== null,
  createdAt: r.createdAt,
});

export function alertRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const manage = requireTenant(deps, "alerts.manage");

  r.get("/alerts/rules", manage, async (c) => {
    const { tenantId } = c.get("tenant");
    const rows = await withTenant(deps.appDb, tenantId, (tx) => tx.select().from(schema.alertRule).orderBy(schema.alertRule.createdAt));
    return c.json({ rules: rows.map(publicRule) });
  });

  r.post("/alerts/rules", manage, async (c) => {
    const t = c.get("tenant");
    const body = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_body", issues: body.error.issues }, 400);
    const b = body.data;
    const params = parseParams(b.type, b.params);
    if (!params) return c.json({ error: "invalid_params" }, 400);
    if (b.channels.includes("webhook") && !(b.webhookUrl && isAllowedWebhookUrl(b.webhookUrl))) return c.json({ error: "invalid_webhook" }, 400);

    const [{ n } = { n: 0 }] = await withTenant(deps.appDb, t.tenantId, (tx) => tx.select({ n: count() }).from(schema.alertRule));
    if (n >= MAX_RULES) return c.json({ error: "rule_limit_reached", max: MAX_RULES }, 409);

    const id = crypto.randomUUID();
    await withTenant(deps.appDb, t.tenantId, (tx) =>
      tx.insert(schema.alertRule).values({
        id,
        tenantId: t.tenantId,
        type: b.type,
        name: b.name,
        params,
        channels: b.channels,
        webhookUrlEnc: b.channels.includes("webhook") && b.webhookUrl ? deps.encryptor.encrypt(b.webhookUrl) : null,
      }),
    );
    deps.alerts.invalidate(t.tenantId);
    await audit(deps.appDb, { tenantId: t.tenantId, actorUserId: t.userId, action: "alert.create", target: id, meta: { type: b.type, channels: b.channels }, ip: c.get("ip") });
    return c.json({ id }, 201);
  });

  r.patch("/alerts/rules/:id", manage, async (c) => {
    const t = c.get("tenant");
    const id = c.req.param("id");
    const body = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_body", issues: body.error.issues }, 400);
    const [cur] = await withTenant(deps.appDb, t.tenantId, (tx) => tx.select().from(schema.alertRule).where(eq(schema.alertRule.id, id)));
    if (!cur) return c.json({ error: "not_found" }, 404);
    const b = body.data;

    const set: Partial<typeof schema.alertRule.$inferInsert> = {};
    if (b.name !== undefined) set.name = b.name;
    if (b.enabled !== undefined) set.enabled = b.enabled;
    if (b.params !== undefined) {
      const params = parseParams(cur.type as (typeof ALERT_TYPES)[number], b.params);
      if (!params) return c.json({ error: "invalid_params" }, 400);
      set.params = params;
    }
    const channels = b.channels ?? cur.channels;
    if (b.channels !== undefined) set.channels = b.channels;
    if (b.webhookUrl !== undefined) {
      if (b.webhookUrl === null) set.webhookUrlEnc = null;
      else if (!isAllowedWebhookUrl(b.webhookUrl)) return c.json({ error: "invalid_webhook" }, 400);
      else set.webhookUrlEnc = deps.encryptor.encrypt(b.webhookUrl);
    }
    if (channels.includes("webhook") && (set.webhookUrlEnc === undefined ? cur.webhookUrlEnc : set.webhookUrlEnc) === null) return c.json({ error: "invalid_webhook" }, 400);
    if (!channels.includes("webhook")) set.webhookUrlEnc = null;

    if (Object.keys(set).length) {
      await withTenant(deps.appDb, t.tenantId, (tx) => tx.update(schema.alertRule).set(set).where(eq(schema.alertRule.id, id)));
    }
    deps.alerts.invalidate(t.tenantId);
    await audit(deps.appDb, { tenantId: t.tenantId, actorUserId: t.userId, action: "alert.update", target: id, meta: { fields: Object.keys(b) }, ip: c.get("ip") });
    return c.json({ ok: true });
  });

  r.delete("/alerts/rules/:id", manage, async (c) => {
    const t = c.get("tenant");
    const id = c.req.param("id");
    const rows = await withTenant(deps.appDb, t.tenantId, (tx) => tx.delete(schema.alertRule).where(eq(schema.alertRule.id, id)).returning({ id: schema.alertRule.id }));
    if (!rows.length) return c.json({ error: "not_found" }, 404);
    deps.alerts.invalidate(t.tenantId);
    await audit(deps.appDb, { tenantId: t.tenantId, actorUserId: t.userId, action: "alert.delete", target: id, ip: c.get("ip") });
    return c.json({ ok: true });
  });

  /** Dispara una alerta de prueba por todos los canales de la regla. */
  r.post("/alerts/rules/:id/test", manage, async (c) => {
    const t = c.get("tenant");
    const [rule] = await withTenant(deps.appDb, t.tenantId, (tx) => tx.select().from(schema.alertRule).where(eq(schema.alertRule.id, c.req.param("id"))));
    if (!rule) return c.json({ error: "not_found" }, 404);
    const alert = await deps.alerts.fire(t.tenantId, { id: rule.id, type: rule.type as never, name: rule.name, channels: rule.channels, webhookUrlEnc: rule.webhookUrlEnc }, "Alerta de prueba de HiveMonitor", { test: true });
    return c.json({ alert });
  });

  /** Historial de alertas disparadas (visible para quien ve el stream). */
  r.get("/alerts/events", requireTenant(deps, "stream.view"), async (c) => {
    const { tenantId } = c.get("tenant");
    const limit = Math.min(Number(c.req.query("limit") ?? 30) || 30, 100);
    const rows = await withTenant(deps.appDb, tenantId, (tx) => tx.select().from(schema.alertEvent).orderBy(desc(schema.alertEvent.firedAt)).limit(limit));
    return c.json({ events: rows.map((e) => ({ id: e.id, ruleId: e.ruleId, firedAt: e.firedAt, ...(e.data as object) })) });
  });

  void and;
  return r;
}
