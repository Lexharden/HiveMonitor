import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { schema, withTenant } from "@hivemonitor/db";
import { audit } from "../audit.ts";
import type { AppDeps, AppEnv } from "../context.ts";
import { randomToken, sha256Hex } from "../crypto.ts";
import { requireTenant } from "../middleware.ts";

const MAX_BODY = 8 * 1024;
const MAX_TOKENS = 10;
const RETENTION_MS = 24 * 3_600_000;

const bodySchema = z.object({
  source: z
    .string()
    .trim()
    .regex(/^[\w.\- ]{1,64}$/),
  metrics: z
    .record(z.string().max(64), z.union([z.number(), z.string().max(200), z.boolean(), z.null()]))
    .refine((m) => Object.keys(m).length <= 50, "demasiadas métricas")
    .default({}),
});

/** Endpoint público para apps del ecosistema (HiveShock, HiveBuzz, agentes locales con métricas de OBS). */
export function heartbeatIngestRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const hits = new Map<string, number[]>();

  r.post("/", async (c) => {
    const auth = c.req.header("authorization");
    const token = (auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7) : c.req.header("x-heartbeat-token"))?.trim();
    if (!token || !token.startsWith("hm_") || token.length > 100) return c.json({ error: "unauthorized" }, 401);
    const hash = sha256Hex(token);

    // Límite por token (60/min), antes de tocar la base de datos
    const now = Date.now();
    const arr = (hits.get(hash) ?? []).filter((t) => t > now - 60_000);
    if (arr.length >= 60) return c.json({ error: "rate_limited" }, 429);
    arr.push(now);
    hits.set(hash, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => t > now - 60_000)) hits.delete(k);

    // El tenant se resuelve con una función SECURITY DEFINER: aún no hay contexto de tenant
    const res = await deps.appDb.execute(sql`select resolve_heartbeat_token(${hash}) as tenant_id`);
    const tenantId = (res[0] as { tenant_id: string | null } | undefined)?.tenant_id;
    if (!tenantId) return c.json({ error: "unauthorized" }, 401);

    const raw = await c.req.text();
    if (raw.length > MAX_BODY) return c.json({ error: "payload_too_large" }, 413);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const body = bodySchema.safeParse(json);
    if (!body.success) return c.json({ error: "invalid_body" }, 400);

    const [settings] = await deps.adminDb
      .select({ suspended: schema.tenantSettings.suspended })
      .from(schema.tenantSettings)
      .where(eq(schema.tenantSettings.tenantId, tenantId));
    if (settings?.suspended) return c.json({ error: "tenant_suspended" }, 403);

    const { source, metrics } = body.data;
    await withTenant(deps.appDb, tenantId, async (tx) => {
      await tx.insert(schema.heartbeat).values({ id: crypto.randomUUID(), tenantId, source, metrics });
      // Retención acotada por fuente
      await tx
        .delete(schema.heartbeat)
        .where(and(eq(schema.heartbeat.source, source), lt(schema.heartbeat.reportedAt, new Date(Date.now() - RETENTION_MS))));
    });
    deps.alerts.noteHeartbeat(tenantId, source);
    void deps.bus.publish({ kind: "heartbeat", tenantId, heartbeat: { source, at: new Date().toISOString(), metrics } });
    return c.body(null, 204);
  });
  return r;
}

/** Gestión de tokens y consulta del último estado de cada fuente (requiere sesión). */
export function heartbeatTenantRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const manage = requireTenant(deps, "integrations.manage");

  r.get("/heartbeats", requireTenant(deps, "stream.view"), async (c) => {
    const { tenantId } = c.get("tenant");
    const rows = await withTenant(deps.appDb, tenantId, async (tx) => {
      const res = await tx.execute(
        sql`select distinct on (source) source, reported_at, metrics from heartbeat order by source, reported_at desc`,
      );
      return res as unknown as { source: string; reported_at: Date; metrics: Record<string, unknown> }[];
    });
    return c.json({ sources: rows.map((x) => ({ source: x.source, at: new Date(x.reported_at).toISOString(), metrics: x.metrics })) });
  });

  r.get("/heartbeat/tokens", manage, async (c) => {
    const { tenantId } = c.get("tenant");
    const rows = await withTenant(deps.appDb, tenantId, (tx) =>
      tx
        .select({
          id: schema.heartbeatToken.id,
          label: schema.heartbeatToken.label,
          lastUsedAt: schema.heartbeatToken.lastUsedAt,
          createdAt: schema.heartbeatToken.createdAt,
        })
        .from(schema.heartbeatToken)
        .where(isNull(schema.heartbeatToken.revokedAt)),
    );
    return c.json({ tokens: rows });
  });

  /** El token solo se muestra una vez; en base de datos queda únicamente su hash SHA-256. */
  r.post("/heartbeat/tokens", manage, async (c) => {
    const t = c.get("tenant");
    const body = z.object({ label: z.string().trim().min(1).max(60) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    const active = await withTenant(deps.appDb, t.tenantId, (tx) =>
      tx.select({ id: schema.heartbeatToken.id }).from(schema.heartbeatToken).where(isNull(schema.heartbeatToken.revokedAt)),
    );
    if (active.length >= MAX_TOKENS) return c.json({ error: "token_limit_reached", max: MAX_TOKENS }, 409);
    const token = `hm_${randomToken(32)}`;
    const id = crypto.randomUUID();
    await withTenant(deps.appDb, t.tenantId, (tx) =>
      tx.insert(schema.heartbeatToken).values({ id, tenantId: t.tenantId, tokenHash: sha256Hex(token), label: body.data.label }),
    );
    await audit(deps.appDb, {
      tenantId: t.tenantId,
      actorUserId: t.userId,
      action: "heartbeat_token.create",
      target: id,
      meta: { label: body.data.label },
      ip: c.get("ip"),
    });
    return c.json({ id, token }, 201);
  });

  r.delete("/heartbeat/tokens/:id", manage, async (c) => {
    const t = c.get("tenant");
    const id = c.req.param("id");
    const rows = await withTenant(deps.appDb, t.tenantId, (tx) =>
      tx
        .update(schema.heartbeatToken)
        .set({ revokedAt: new Date() })
        .where(and(eq(schema.heartbeatToken.id, id), isNull(schema.heartbeatToken.revokedAt)))
        .returning({ id: schema.heartbeatToken.id }),
    );
    if (!rows.length) return c.json({ error: "not_found" }, 404);
    await audit(deps.appDb, { tenantId: t.tenantId, actorUserId: t.userId, action: "heartbeat_token.revoke", target: id, ip: c.get("ip") });
    return c.json({ ok: true });
  });

  return r;
}
