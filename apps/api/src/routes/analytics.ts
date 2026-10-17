import { and, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { PLATFORMS } from "@hivemonitor/core";
import { schema, withTenant } from "@hivemonitor/db";
import type { AppDeps, AppEnv } from "../context.ts";
import { requireTenant } from "../middleware.ts";

const DAY = 86_400_000;

const rangeQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(7),
  platform: z.enum(PLATFORMS).optional(),
});

interface Row {
  bucket: string | Date;
  platform: string;
  viewers_peak: number;
  viewers_avg: number;
  viewer_samples: number;
  donations_minor: string | number;
  messages: number;
  new_followers: number;
}

export interface Totals {
  peakViewers: number;
  avgViewers: number;
  donationsMinor: number;
  messages: number;
  newFollowers: number;
}

/** Totales de un conjunto de filas: pico = máximo; media ponderada por nº de muestras; el resto suma. */
export function totalsOf(rows: Row[]): Totals {
  let samples = 0;
  let weighted = 0;
  const t: Totals = { peakViewers: 0, avgViewers: 0, donationsMinor: 0, messages: 0, newFollowers: 0 };
  for (const r of rows) {
    t.peakViewers = Math.max(t.peakViewers, r.viewers_peak);
    weighted += r.viewers_avg * r.viewer_samples;
    samples += r.viewer_samples;
    t.donationsMinor += Number(r.donations_minor);
    t.messages += r.messages;
    t.newFollowers += r.new_followers;
  }
  t.avgViewers = samples ? Math.round((weighted / samples) * 10) / 10 : 0;
  return t;
}

export function analyticsRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const guard = requireTenant(deps, "analytics.view");

  /**
   * Serie temporal + totales del periodo y del periodo anterior de igual duración (comparativa).
   * Hasta 3 días: por hora; más: por día (UTC).
   */
  r.get("/analytics/overview", guard, async (c) => {
    const q = rangeQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_query" }, 400);
    const { tenantId } = c.get("tenant");
    const { days, platform } = q.data;
    const granularity = days <= 3 ? "hour" : "day";
    const table = granularity === "hour" ? "stats_hourly" : "stats_daily";

    const to = new Date();
    const from = new Date(to.getTime() - days * DAY);
    const prevFrom = new Date(from.getTime() - days * DAY);
    // En modo día se alinea a la medianoche UTC para no cortar el primer día a la mitad
    const alignedFrom = granularity === "day" ? new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())) : from;
    const alignedPrev = granularity === "day" ? new Date(alignedFrom.getTime() - days * DAY) : prevFrom;

    const rows = await withTenant(deps.appDb, tenantId, async (tx) => {
      const res =
        await tx.execute(sql`select bucket, platform, viewers_peak, viewers_avg, viewer_samples, donations_minor, messages, new_followers
        from ${sql.raw(table)}
        where ${granularity === "hour" ? sql`bucket >= ${alignedPrev.toISOString()}::timestamptz and bucket < ${to.toISOString()}::timestamptz` : sql`bucket >= ${alignedPrev.toISOString().slice(0, 10)}::date and bucket <= ${to.toISOString().slice(0, 10)}::date`} ${platform ? sql`and platform = ${platform}` : sql``}
        order by bucket`);
      return res as unknown as Row[];
    });
    const at = (r: Row) => new Date(r.bucket).getTime();
    const current = rows.filter((x) => at(x) >= alignedFrom.getTime());
    const previous = rows.filter((x) => at(x) < alignedFrom.getTime());

    return c.json({
      granularity,
      from: alignedFrom.toISOString(),
      to: to.toISOString(),
      series: current.map((x) => ({
        bucket: new Date(x.bucket).toISOString(),
        platform: x.platform,
        viewersPeak: x.viewers_peak,
        viewersAvg: Math.round(x.viewers_avg * 10) / 10,
        donationsMinor: Number(x.donations_minor),
        messages: x.messages,
        newFollowers: x.new_followers,
      })),
      totals: totalsOf(current),
      previous: totalsOf(previous),
    });
  });

  r.get("/analytics/sessions", guard, async (c) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        before: z.coerce.date().optional(),
        platform: z.enum(PLATFORMS).optional(),
      })
      .safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_query" }, 400);
    const { tenantId } = c.get("tenant");
    const rows = await withTenant(deps.appDb, tenantId, (tx) =>
      tx
        .select()
        .from(schema.streamSession)
        .where(
          and(
            q.data.before ? lt(schema.streamSession.startedAt, q.data.before) : undefined,
            q.data.platform ? eq(schema.streamSession.platform, q.data.platform) : undefined,
          ),
        )
        .orderBy(desc(schema.streamSession.startedAt))
        .limit(q.data.limit),
    );
    return c.json({
      sessions: rows.map((s) => ({
        id: s.id,
        platform: s.platform,
        channelId: s.channelId,
        title: s.title,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationSec: Math.round(((s.endedAt?.getTime() ?? Date.now()) - s.startedAt.getTime()) / 1000),
        peakViewers: s.peakViewers,
        stats: s.stats,
        live: s.endedAt === null,
      })),
      nextBefore: rows.length === q.data.limit ? rows[rows.length - 1]!.startedAt : null,
    });
  });

  /** Detalle: línea de tiempo de espectadores, conteo por tipo y top donadores de la sesión. */
  r.get("/analytics/sessions/:sid", guard, async (c) => {
    const { tenantId } = c.get("tenant");
    const sid = c.req.param("sid");
    const data = await withTenant(deps.appDb, tenantId, async (tx) => {
      const [s] = await tx.select().from(schema.streamSession).where(eq(schema.streamSession.id, sid)).limit(1);
      if (!s) return null;
      // Acotar por tiempo permite podar particiones de eventos
      const lo = new Date(s.startedAt.getTime() - 60_000);
      const hi = new Date((s.endedAt ?? new Date()).getTime() + 60_000);
      const timeline = (await tx.execute(sql`select occurred_at as t, (payload->>'viewers')::int as v from event
        where session_id = ${sid} and type = 'viewer_count' and occurred_at between ${lo.toISOString()}::timestamptz and ${hi.toISOString()}::timestamptz order by occurred_at`)) as unknown as {
        t: Date;
        v: number;
      }[];
      const byType = (await tx.execute(sql`select type, count(*)::int as n from event
        where session_id = ${sid} and occurred_at between ${lo.toISOString()}::timestamptz and ${hi.toISOString()}::timestamptz group by type`)) as unknown as {
        type: string;
        n: number;
      }[];
      const donors =
        (await tx.execute(sql`select actor_id, max(actor_name) as name, currency, sum(amount_minor)::bigint as amount, count(*)::int as n
        from event where session_id = ${sid} and type = 'donation' and occurred_at between ${lo.toISOString()}::timestamptz and ${hi.toISOString()}::timestamptz and actor_id is not null
        group by actor_id, currency order by amount desc limit 10`)) as unknown as {
          actor_id: string;
          name: string;
          currency: string;
          amount: string;
          n: number;
        }[];
      const markers = await tx
        .select()
        .from(schema.streamMarker)
        .where(and(gte(schema.streamMarker.at, s.startedAt), lte(schema.streamMarker.at, s.endedAt ?? new Date())))
        .orderBy(schema.streamMarker.at);
      return { s, timeline, byType, donors, markers: markers.filter((m) => !m.platform || m.platform === s.platform) };
    });
    if (!data) return c.json({ error: "not_found" }, 404);
    const { s } = data;
    return c.json({
      session: {
        id: s.id,
        platform: s.platform,
        channelId: s.channelId,
        title: s.title,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        peakViewers: s.peakViewers,
        stats: s.stats,
      },
      timeline: data.timeline.map((x) => ({ t: new Date(x.t).getTime(), v: x.v })),
      eventsByType: Object.fromEntries(data.byType.map((x) => [x.type, x.n])),
      markers: data.markers.map((m) => ({ id: m.id, at: m.at.toISOString(), kind: m.kind, label: m.label })),
      topDonors: data.donors.map((d) => ({
        id: d.actor_id,
        name: d.name,
        currency: d.currency,
        amountMinor: Number(d.amount),
        count: d.n,
      })),
    });
  });

  r.get("/analytics/top-donors", guard, async (c) => {
    const q = rangeQuery
      .extend({ days: z.coerce.number().int().min(1).max(365).default(30), limit: z.coerce.number().int().min(1).max(50).default(10) })
      .safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_query" }, 400);
    const { tenantId } = c.get("tenant");
    const from = new Date(Date.now() - q.data.days * DAY);
    const rows = await withTenant(deps.appDb, tenantId, async (tx) => {
      const res = await tx.execute(sql`select actor_id, max(actor_name) as name, currency,
          sum(amount_minor)::bigint as amount, count(*)::int as n,
          coalesce(sum((payload->>'usdMinorEstimate')::bigint), 0)::bigint as usd
        from event
        where type = 'donation' and occurred_at >= ${from.toISOString()}::timestamptz and actor_id is not null ${q.data.platform ? sql`and platform = ${q.data.platform}` : sql``}
        group by actor_id, currency
        order by usd desc, amount desc
        limit ${q.data.limit}`);
      return res as unknown as { actor_id: string; name: string; currency: string; amount: string; n: number; usd: string }[];
    });
    return c.json({
      from: from.toISOString(),
      donors: rows.map((d) => ({
        id: d.actor_id,
        name: d.name,
        currency: d.currency,
        amountMinor: Number(d.amount),
        usdMinorEstimate: Number(d.usd),
        count: d.n,
      })),
    });
  });

  return r;
}
