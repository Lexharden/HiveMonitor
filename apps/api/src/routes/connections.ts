import { and, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { PLATFORMS } from "@hivemonitor/core";
import { schema, withTenant } from "@hivemonitor/db";
import { audit } from "../audit.ts";
import type { AppDeps, AppEnv } from "../context.ts";
import { requireTenant } from "../middleware.ts";

const createSchema = z.object({
  platform: z.enum(PLATFORMS),
  channelId: z.string().trim().min(1).max(128),
  channelName: z.string().trim().max(128).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
});

const publicColumns = {
  id: schema.platformConnection.id,
  platform: schema.platformConnection.platform,
  channelId: schema.platformConnection.channelId,
  channelName: schema.platformConnection.channelName,
  status: schema.platformConnection.status,
  enabled: schema.platformConnection.enabled,
  config: schema.platformConnection.config,
  lastError: schema.platformConnection.lastError,
  updatedAt: schema.platformConnection.updatedAt,
};

const DEFAULT_MAX_CONNECTIONS = 5;

export function connectionRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { ingest } = deps;

  const load = (tenantId: string, id: string) =>
    withTenant(deps.appDb, tenantId, (tx) =>
      tx.select().from(schema.platformConnection).where(eq(schema.platformConnection.id, id)).limit(1),
    ).then((rows) => rows[0]);

  /** Conexiones del tenant con su estado en tiempo de ejecución (reintentos, cola). */
  r.get("/connections", requireTenant(deps, "stream.view"), async (c) => {
    const { tenantId } = c.get("tenant");
    const rows = await withTenant(deps.appDb, tenantId, (tx) => tx.select(publicColumns).from(schema.platformConnection));
    return c.json({
      connections: rows.map((row) => {
        const rt = ingest.supervisor.get(row.id);
        return {
          ...row,
          status: rt?.status ?? row.status,
          runtime: rt ? { attempts: rt.attempts, nextRetryAt: rt.nextRetryAt, queued: rt.queued, since: rt.since } : null,
        };
      }),
    });
  });

  r.post("/connections", requireTenant(deps, "integrations.manage"), async (c) => {
    const t = c.get("tenant");
    const body = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_body", issues: body.error.issues }, 400);
    const b = body.data;

    if (b.config.mode === "mock" && !ingest.allowMock) return c.json({ error: "mock_not_allowed" }, 403);
    if (b.platform === "tiktok" && b.config.mode !== "mock") {
      b.channelId = b.channelId.replace(/^@/, "");
      if (!/^[A-Za-z0-9._]{2,64}$/.test(b.channelId)) return c.json({ error: "invalid_channel" }, 400);
    }
    if (b.platform === "twitch" && b.config.mode !== "mock") return c.json({ error: "use_oauth" }, 400);
    if (b.platform === "youtube" && b.config.mode !== "mock") return c.json({ error: "platform_not_available" }, 501);

    const [settings] = await deps.adminDb
      .select({ limits: schema.tenantSettings.limits })
      .from(schema.tenantSettings)
      .where(eq(schema.tenantSettings.tenantId, t.tenantId));
    const max = Number((settings?.limits as { maxConnections?: number } | undefined)?.maxConnections ?? DEFAULT_MAX_CONNECTIONS);
    const [{ n } = { n: 0 }] = await withTenant(deps.appDb, t.tenantId, (tx) => tx.select({ n: count() }).from(schema.platformConnection));
    if (n >= max) return c.json({ error: "connection_limit_reached", max }, 409);

    const id = crypto.randomUUID();
    try {
      await withTenant(deps.appDb, t.tenantId, (tx) =>
        tx.insert(schema.platformConnection).values({
          id,
          tenantId: t.tenantId,
          platform: b.platform,
          channelId: b.channelId,
          channelName: b.channelName,
          config: b.config,
          enabled: true,
          keyVersion: deps.encryptor.keyVersion,
        }),
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505" || /duplicate key|unique/i.test(String((err as Error).message))) {
        return c.json({ error: "already_exists" }, 409);
      }
      throw err;
    }
    await audit(deps.appDb, {
      tenantId: t.tenantId,
      actorUserId: t.userId,
      action: "connection.create",
      target: id,
      meta: { platform: b.platform, channelId: b.channelId },
      ip: c.get("ip"),
    });
    const row = (await load(t.tenantId, id))!;
    await ingest.startConnection(row);
    return c.json({ id }, 201);
  });

  r.post("/connections/:id/connect", requireTenant(deps, "integrations.manage"), async (c) => {
    const t = c.get("tenant");
    const row = await load(t.tenantId, c.req.param("id"));
    if (!row) return c.json({ error: "not_found" }, 404);
    await withTenant(deps.appDb, t.tenantId, (tx) =>
      tx.update(schema.platformConnection).set({ enabled: true }).where(eq(schema.platformConnection.id, row.id)),
    );
    const ok = await ingest.startConnection({ ...row, enabled: true });
    await audit(deps.appDb, { tenantId: t.tenantId, actorUserId: t.userId, action: "connection.connect", target: row.id, ip: c.get("ip") });
    return ok ? c.json({ ok: true }) : c.json({ error: "adapter_not_available" }, 501);
  });

  r.post("/connections/:id/disconnect", requireTenant(deps, "integrations.manage"), async (c) => {
    const t = c.get("tenant");
    const row = await load(t.tenantId, c.req.param("id"));
    if (!row) return c.json({ error: "not_found" }, 404);
    await withTenant(deps.appDb, t.tenantId, (tx) =>
      tx.update(schema.platformConnection).set({ enabled: false }).where(eq(schema.platformConnection.id, row.id)),
    );
    await ingest.stopConnection(row.id);
    await audit(deps.appDb, {
      tenantId: t.tenantId,
      actorUserId: t.userId,
      action: "connection.disconnect",
      target: row.id,
      ip: c.get("ip"),
    });
    return c.json({ ok: true });
  });

  r.delete("/connections/:id", requireTenant(deps, "integrations.manage"), async (c) => {
    const t = c.get("tenant");
    const row = await load(t.tenantId, c.req.param("id"));
    if (!row) return c.json({ error: "not_found" }, 404);
    await ingest.stopConnection(row.id);
    await withTenant(deps.appDb, t.tenantId, (tx) =>
      tx.delete(schema.platformConnection).where(and(eq(schema.platformConnection.id, row.id))),
    );
    await audit(deps.appDb, {
      tenantId: t.tenantId,
      actorUserId: t.userId,
      action: "connection.delete",
      target: row.id,
      meta: { platform: row.platform },
      ip: c.get("ip"),
    });
    return c.json({ ok: true });
  });

  /** Estado en vivo para el dashboard: viewers, duración y contadores de la sesión. */
  r.get("/live", requireTenant(deps, "stream.view"), (c) => {
    const { tenantId } = c.get("tenant");
    return c.json({
      channels: ingest.pipeline.liveState(tenantId),
      connections: ingest.supervisor.list(tenantId),
      serverTime: new Date().toISOString(),
    });
  });

  return r;
}
