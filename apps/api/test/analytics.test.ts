import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { NormalizedEvent } from "@hivemonitor/core";
import { withTenant } from "@hivemonitor/db";
import { Aggregator, donationUsdMinor, toDays } from "../src/ingest/aggregator.ts";
import { totalsOf } from "../src/routes/analytics.ts";
import { createTestEnv, type TestEnv } from "./helpers.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("agregador (unitario)", () => {
  const ev = (type: string, payload: object, at: number, tenantId = "t", platform = "tiktok") =>
    ({
      id: crypto.randomUUID(),
      tenantId,
      platform,
      channelId: "c",
      type,
      occurredAt: new Date(at),
      actor: null,
      payload,
    }) as unknown as NormalizedEvent;

  test("pico, media, mensajes, seguidores y donaciones por hora/plataforma/tenant", () => {
    const a = new Aggregator();
    const t0 = Date.UTC(2026, 0, 1, 10, 5);
    a.add(ev("viewer_count", { viewers: 10 }, t0));
    a.add(ev("viewer_count", { viewers: 30 }, t0 + 1000));
    a.add(ev("chat", { message: "x", badges: [] }, t0));
    a.add(ev("follow", {}, t0));
    a.add(ev("donation", { amountMinor: 100, currency: "TIKTOK_COIN", usdMinorEstimate: 50, kind: "gift", count: 1 }, t0));
    a.add(ev("like", { count: 3 }, t0)); // no se agrega
    a.add(ev("chat", { message: "otra hora", badges: [] }, t0 + HOUR));
    a.add(ev("chat", { message: "otro tenant", badges: [] }, t0, "t2"));
    const d = a.drain();
    expect(d).toHaveLength(3);
    const h = d.find((x) => x.tenantId === "t" && x.hour === Date.UTC(2026, 0, 1, 10))!;
    expect(h).toMatchObject({ peak: 30, viewerSum: 40, viewerSamples: 2, messages: 1, followers: 1, donationsMinor: 50 });
    expect(a.drain()).toHaveLength(0);
  });

  test("restore fusiona sin duplicar ni perder; toDays agrupa horas del mismo día", () => {
    const a = new Aggregator();
    const t0 = Date.UTC(2026, 0, 1, 10);
    a.add(ev("chat", { message: "a", badges: [] }, t0));
    const first = a.drain();
    a.add(ev("chat", { message: "b", badges: [] }, t0));
    a.restore(first);
    expect(a.drain()[0]!.messages).toBe(2);
    a.add(ev("viewer_count", { viewers: 5 }, t0));
    a.add(ev("viewer_count", { viewers: 15 }, t0 + 3 * HOUR));
    a.add(ev("viewer_count", { viewers: 7 }, t0 + DAY));
    const days = toDays(a.drain());
    expect(days.find((d) => d.day === "2026-01-01")).toMatchObject({ peak: 15, viewerSum: 20, viewerSamples: 2 });
    expect(days).toHaveLength(2);
  });

  test("equivalente USD: usa la estimación; USD directo; otras divisas no se convierten", () => {
    expect(donationUsdMinor({ amountMinor: 100, currency: "BITS", usdMinorEstimate: 100 })).toBe(100);
    expect(donationUsdMinor({ amountMinor: 500, currency: "USD" })).toBe(500);
    expect(donationUsdMinor({ amountMinor: 500, currency: "EUR" })).toBe(0);
  });

  test("totalsOf: media ponderada por muestras", () => {
    const t = totalsOf([
      {
        bucket: "x",
        platform: "a",
        viewers_peak: 10,
        viewers_avg: 5,
        viewer_samples: 1,
        donations_minor: 1,
        messages: 1,
        new_followers: 0,
      },
      {
        bucket: "y",
        platform: "a",
        viewers_peak: 40,
        viewers_avg: 20,
        viewer_samples: 3,
        donations_minor: "2",
        messages: 1,
        new_followers: 1,
      },
    ]);
    expect(t).toMatchObject({ peakViewers: 40, avgViewers: 16.3, donationsMinor: 3, messages: 2, newFollowers: 1 });
  });
});

describe("analíticas (integración)", () => {
  let env: TestEnv;
  let owner: string;
  let moderator: string;
  let analyst: string;
  let other: string;
  let org: string;
  let otherOrg: string;

  const mk = (
    tenantId: string,
    type: string,
    payload: object,
    at: number,
    actor: { id: string; name: string } | null = null,
    channelId = "chan",
  ) =>
    ({
      id: crypto.randomUUID(),
      tenantId,
      platform: "tiktok",
      channelId,
      type,
      occurredAt: new Date(at),
      actor,
      payload,
    }) as unknown as NormalizedEvent;

  beforeAll(async () => {
    env = await createTestEnv();
    owner = await env.signUp("o@an.dev");
    other = await env.signUp("o2@an.dev");
    org = ((await (await env.call(owner, "POST", "/api/auth/organization/create", { name: "AN", slug: "an" })).json()) as { id: string })
      .id;
    otherOrg = (
      (await (await env.call(other, "POST", "/api/auth/organization/create", { name: "AN2", slug: "an2" })).json()) as { id: string }
    ).id;
    moderator = await env.signUp("m@an.dev");
    analyst = await env.signUp("a@an.dev");
    for (const [role, email, tok] of [
      ["moderator", "m@an.dev", moderator],
      ["analyst", "a@an.dev", analyst],
    ] as const) {
      const id = (
        (await (await env.call(owner, "POST", "/api/auth/organization/invite-member", { email, role, organizationId: org })).json()) as {
          id: string;
        }
      ).id;
      await env.call(tok, "POST", "/api/auth/organization/accept-invitation", { invitationId: id });
    }

    const p = env.deps.ingest.pipeline;
    const now = Date.now();
    const start = now - 3 * HOUR;
    const u1 = { id: "u1", name: "Ana" };
    const u2 = { id: "u2", name: "Beto" };
    p.handleEvent(mk(org, "stream_start", { title: "Mi directo" }, start));
    p.handleEvent(mk(org, "viewer_count", { viewers: 10 }, start + 1000));
    p.handleEvent(mk(org, "viewer_count", { viewers: 30 }, start + HOUR));
    p.handleEvent(mk(org, "viewer_count", { viewers: 20 }, start + 2 * HOUR));
    for (let i = 0; i < 5; i++) p.handleEvent(mk(org, "chat", { message: `m${i}`, badges: [] }, start + 2000 + i, u1));
    p.handleEvent(mk(org, "follow", {}, start + 3000, u1));
    p.handleEvent(mk(org, "follow", {}, start + 3001, u2));
    p.handleEvent(
      mk(org, "donation", { kind: "gift", amountMinor: 100, currency: "TIKTOK_COIN", usdMinorEstimate: 50, count: 1 }, start + 4000, u1),
    );
    p.handleEvent(
      mk(org, "donation", { kind: "gift", amountMinor: 50, currency: "TIKTOK_COIN", usdMinorEstimate: 25, count: 1 }, start + 5000, u1),
    );
    p.handleEvent(
      mk(org, "donation", { kind: "gift", amountMinor: 200, currency: "TIKTOK_COIN", usdMinorEstimate: 100, count: 1 }, start + 6000, u2),
    );
    p.handleEvent(mk(org, "stream_end", {}, start + 2 * HOUR + 5000));
    // periodo anterior (hace 10 días): 2 mensajes
    p.handleEvent(mk(org, "chat", { message: "viejo", badges: [] }, now - 10 * DAY, u1, "canal-viejo"));
    p.handleEvent(mk(org, "chat", { message: "viejo2", badges: [] }, now - 10 * DAY + 5, u1, "canal-viejo"));
    await p.flush();
  }, 180_000);

  afterAll(async () => {
    await env?.stop();
  });

  const get = async (token: string, path: string) => await env.call(token, "GET", `/api/t/${org}${path}`);

  test("las estadísticas por hora se calculan bien y el volcado posterior es aditivo", async () => {
    const rows = (await withTenant(env.app.db, org, (tx) =>
      tx.execute(sql`select * from stats_hourly order by bucket`),
    )) as unknown as any[];
    const first = rows.find((r) => r.viewer_samples === 1 && r.viewers_peak === 10 && r.messages === 5);
    expect(first).toBeDefined();
    expect(first.new_followers).toBe(2);
    expect(Number(first.donations_minor)).toBe(175);

    // segundo volcado en la misma hora: media ponderada y pico máximo
    const hour = new Date(first.bucket).getTime();
    const p = env.deps.ingest.pipeline;
    p.handleEvent(mk(org, "viewer_count", { viewers: 60 }, hour + 1000, null, "chan2"));
    p.handleEvent(mk(org, "viewer_count", { viewers: 20 }, hour + 2000, null, "chan2"));
    await p.flush();
    const [after] = (await withTenant(env.app.db, org, (tx) =>
      tx.execute(sql`select * from stats_hourly where bucket = ${new Date(hour).toISOString()}::timestamptz`),
    )) as unknown as any[];
    expect(after.viewers_peak).toBe(60);
    expect(after.viewer_samples).toBe(3);
    expect(after.viewers_avg).toBeCloseTo((10 + 60 + 20) / 3, 1);
    expect(after.messages).toBe(5); // no se duplicó
  });

  test("overview: serie diaria, totales y periodo anterior", async () => {
    const r = (await (await get(analyst, "/analytics/overview?days=7")).json()) as any;
    expect(r.granularity).toBe("day");
    expect(r.totals.messages).toBe(5);
    expect(r.totals.newFollowers).toBe(2);
    expect(r.totals.donationsMinor).toBe(175);
    expect(r.totals.peakViewers).toBe(60);
    expect(r.previous.messages).toBe(2);
    expect(r.series.length).toBeGreaterThan(0);
    const hourly = (await (await get(analyst, "/analytics/overview?days=1")).json()) as any;
    expect(hourly.granularity).toBe("hour");
    expect(hourly.totals.messages).toBe(5);
    expect((await get(analyst, "/analytics/overview?days=0")).status).toBe(400);
    expect((await get(analyst, "/analytics/overview?days=7&platform=twitch")).status).toBe(200);
  });

  test("sesiones: listado, detalle con línea de tiempo y top donadores de la sesión", async () => {
    const list = (await (await get(analyst, "/analytics/sessions?platform=tiktok&limit=50")).json()) as any;
    const s = list.sessions.find((x: any) => x.channelId === "chan");
    expect(list.sessions.length).toBeGreaterThanOrEqual(1);
    expect(s).toMatchObject({ platform: "tiktok", channelId: "chan", title: "Mi directo", peakViewers: 30, live: false });
    expect(s.stats.messages).toBe(5);
    expect(s.durationSec).toBeGreaterThan(7000);

    const d = (await (await get(analyst, `/analytics/sessions/${s.id}`)).json()) as any;
    expect(d.timeline.map((x: any) => x.v)).toEqual([10, 30, 20]);
    expect(d.eventsByType).toMatchObject({ chat: 5, follow: 2, donation: 3 });
    expect(d.topDonors[0]).toMatchObject({ id: "u2", amountMinor: 200 });
    expect(d.topDonors.find((x: any) => x.id === "u1")).toMatchObject({ amountMinor: 150, count: 2 });
    expect((await get(analyst, "/analytics/sessions/inexistente")).status).toBe(404);
  });

  test("top donadores ordenados por equivalente USD", async () => {
    const r = (await (await get(analyst, "/analytics/top-donors?days=30&limit=5")).json()) as any;
    expect(r.donors.map((x: any) => x.id)).toEqual(["u2", "u1"]);
    expect(r.donors[0]).toMatchObject({ name: "Beto", usdMinorEstimate: 100, count: 1 });
    expect(r.donors[1]).toMatchObject({ usdMinorEstimate: 75, count: 2 });
  });

  test("permisos y aislamiento: el moderador no accede; otro tenant ve vacío", async () => {
    expect((await get(moderator, "/analytics/overview")).status).toBe(403);
    expect((await get(moderator, "/analytics/sessions")).status).toBe(403);
    expect((await get(owner, "/analytics/top-donors")).status).toBe(200);
    const mine = (await (await env.call(other, "GET", `/api/t/${otherOrg}/analytics/overview?days=30`)).json()) as any;
    expect(mine.totals.messages).toBe(0);
    expect(mine.series).toHaveLength(0);
    expect(((await (await env.call(other, "GET", `/api/t/${otherOrg}/analytics/sessions`)).json()) as any).sessions).toHaveLength(0);
    expect((await env.call(other, "GET", `/api/t/${org}/analytics/overview`)).status).toBe(404);
  });
});
