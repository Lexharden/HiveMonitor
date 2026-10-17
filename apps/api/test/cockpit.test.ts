import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { BusMessage, NormalizedEvent } from "@hivemonitor/core";
import { schema, withTenant } from "@hivemonitor/db";
import { createTestEnv, type TestEnv } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let env: TestEnv;
let owner: string;
let admin: string;
let moderator: string;
let analyst: string;
let other: string;
let org: string;
let otherOrg: string;
const bus: BusMessage[] = [];

const ev = (type: string, payload: object, extra: Partial<NormalizedEvent> = {}, tenantId = org) =>
  ({
    id: crypto.randomUUID(),
    tenantId,
    platform: "tiktok",
    channelId: "chan",
    type,
    occurredAt: new Date(),
    actor: { id: "u1", name: "Ana" },
    payload,
    ...extra,
  }) as unknown as NormalizedEvent;
const t = (tok: string, method: string, path: string, body?: unknown) => env.call(tok, method, `/api/t/${org}${path}`, body);
const markers = async () => withTenant(env.app.db, org, (tx) => tx.select().from(schema.streamMarker).orderBy(schema.streamMarker.at));

async function invite(role: string, email: string, token: string) {
  const res = await env.call(owner, "POST", "/api/auth/organization/invite-member", { email, role, organizationId: org });
  const id = ((await res.json()) as { id: string }).id;
  await env.call(token, "POST", "/api/auth/organization/accept-invitation", { invitationId: id });
}

beforeAll(async () => {
  env = await createTestEnv({ MARKER_BIG_DONATION_USD: "10" });
  owner = await env.signUp("o@ck.dev");
  other = await env.signUp("o2@ck.dev");
  org = ((await (await env.call(owner, "POST", "/api/auth/organization/create", { name: "CK", slug: "ck" })).json()) as { id: string }).id;
  otherOrg = (
    (await (await env.call(other, "POST", "/api/auth/organization/create", { name: "CK2", slug: "ck2" })).json()) as { id: string }
  ).id;
  admin = await env.signUp("ad@ck.dev");
  moderator = await env.signUp("mo@ck.dev");
  analyst = await env.signUp("an@ck.dev");
  await invite("admin", "ad@ck.dev", admin);
  await invite("moderator", "mo@ck.dev", moderator);
  await invite("analyst", "an@ck.dev", analyst);
  env.deps.bus.subscribe(org, (m) => void bus.push(m));
}, 180_000);

afterAll(async () => {
  await env?.stop();
});

describe("marcadores automáticos", () => {
  test("un raid se marca con su origen y número de espectadores", async () => {
    const p = env.deps.ingest.pipeline;
    p.handleEvent(ev("raid", { viewers: 42, fromChannel: "otro_canal" }));
    await sleep(80);
    const m = (await markers()).find((x) => x.kind === "raid");
    expect(m?.label).toContain("otro_canal");
    expect(m?.label).toContain("42");
    const live = bus.filter((b) => b.kind === "marker");
    expect(live).toHaveLength(1); // también se publica en tiempo real
  });

  test("solo las donaciones grandes (≥ umbral en USD) se marcan", async () => {
    const don = (usd: number) =>
      ev("donation", { kind: "gift", amountMinor: usd, currency: "TIKTOK_COIN", usdMinorEstimate: usd, count: 1 });
    env.deps.ingest.pipeline.handleEvent(don(500)); // $5: no
    env.deps.ingest.pipeline.handleEvent(don(2500)); // $25: sí
    await sleep(80);
    const ds = (await markers()).filter((x) => x.kind === "donation");
    expect(ds).toHaveLength(1);
    expect(ds[0]!.label).toContain("$25.00");
  });

  test("un pico brusco de espectadores se marca una vez (cooldown) y el crecimiento normal no", async () => {
    const p = env.deps.ingest.pipeline;
    const vc = (viewers: number, channelId: string) => ev("viewer_count", { viewers }, { channelId });
    // crecimiento suave: no es pico
    for (const v of [100, 104, 108, 112, 116]) p.handleEvent(vc(v, "suave"));
    // base estable y salto
    for (const v of [100, 101, 99, 100]) p.handleEvent(vc(v, "pico"));
    p.handleEvent(vc(180, "pico"));
    p.handleEvent(vc(260, "pico")); // dentro del cooldown
    await sleep(120);
    const spikes = (await markers()).filter((x) => x.kind === "viewers_spike");
    expect(spikes).toHaveLength(1);
    expect(spikes[0]).toMatchObject({ channelId: "pico", platform: "tiktok" });
    expect(spikes[0]!.label).toContain("+81");
  });
});

describe("marcadores manuales y consulta", () => {
  test("solo quien puede moderar marca momentos; el analista no", async () => {
    expect((await t(analyst, "POST", "/markers", { label: "x" })).status).toBe(403);
    const res = await t(moderator, "POST", "/markers", { label: "Jugada épica" });
    expect(res.status).toBe(201);
    const { marker } = (await res.json()) as { marker: { id: string; kind: string; label: string } };
    expect(marker).toMatchObject({ kind: "manual", label: "Jugada épica" });
    const [row] = (await markers()).filter((m) => m.id === marker.id);
    expect(row!.createdBy).toBeString();
    // sin texto → etiqueta por defecto
    const def = (await (await t(owner, "POST", "/markers", {})).json()) as any;
    expect(def.marker.label).toBe("Momento marcado");
    expect((await t(owner, "POST", "/markers", { label: "x".repeat(200) })).status).toBe(400);
  });

  test("el listado lo ve cualquiera con stream.view, ordenado del más reciente y limitado por horas", async () => {
    const list = (await (await t(analyst, "GET", "/markers")).json()) as { markers: { at: string; kind: string }[] };
    expect(list.markers.length).toBeGreaterThanOrEqual(5);
    const times = list.markers.map((m) => Date.parse(m.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // un marcador antiguo queda fuera del rango por defecto
    await withTenant(env.app.db, org, (tx) =>
      tx
        .insert(schema.streamMarker)
        .values({ id: "viejo", tenantId: org, at: new Date(Date.now() - 48 * 3_600_000), kind: "manual", label: "viejo" }),
    );
    const recent = (await (await t(analyst, "GET", "/markers")).json()) as any;
    expect(recent.markers.some((m: any) => m.label === "viejo")).toBe(false);
    const wide = (await (await t(analyst, "GET", "/markers?hours=96")).json()) as any;
    expect(wide.markers.some((m: any) => m.label === "viejo")).toBe(true);
  });

  test("borrar: moderador sí, analista no; y no se toca el de otro tenant", async () => {
    const id = ((await (await t(owner, "POST", "/markers", { label: "borrame" })).json()) as any).marker.id;
    expect((await t(analyst, "DELETE", `/markers/${id}`)).status).toBe(403);
    expect((await env.call(other, "DELETE", `/api/t/${otherOrg}/markers/${id}`)).status).toBe(404);
    expect((await t(moderator, "DELETE", `/markers/${id}`)).status).toBe(200);
    expect((await t(moderator, "DELETE", `/markers/${id}`)).status).toBe(404);
  });

  test("aislamiento: otro tenant no ve nuestros marcadores", async () => {
    const mine = (await (await env.call(other, "GET", `/api/t/${otherOrg}/markers?hours=336`)).json()) as any;
    expect(mine.markers).toHaveLength(0);
    expect((await env.call(other, "GET", `/api/t/${org}/markers`)).status).toBe(404);
  });
});

describe("meta de donaciones", () => {
  test("sin meta devuelve null; el owner/admin la fija; moderador y analista no", async () => {
    expect(((await (await t(analyst, "GET", "/goal")).json()) as any).goal).toBeNull();
    expect((await t(moderator, "PUT", "/goal", { title: "Nuevo micro", targetUsd: 100 })).status).toBe(403);
    const res = await t(admin, "PUT", "/goal", { title: "Nuevo micro", targetUsd: 100 });
    expect(res.status).toBe(200);
    expect(((await (await t(analyst, "GET", "/goal")).json()) as any).goal).toEqual({ title: "Nuevo micro", targetUsd: 100 });
    // actualizar reemplaza (upsert)
    await t(owner, "PUT", "/goal", { title: "Cámara", targetUsd: 250.5 });
    expect(((await (await t(analyst, "GET", "/goal")).json()) as any).goal).toEqual({ title: "Cámara", targetUsd: 250.5 });
    const audit = await env.admin.db.select().from(schema.auditLog).where(eq(schema.auditLog.tenantId, org));
    expect(audit.map((a) => a.action)).toContain("goal.set");
  });

  test("validación y borrado; el otro tenant tiene la suya", async () => {
    expect((await t(owner, "PUT", "/goal", { title: "", targetUsd: 5 })).status).toBe(400);
    expect((await t(owner, "PUT", "/goal", { title: "ok", targetUsd: -1 })).status).toBe(400);
    expect((await t(owner, "PUT", "/goal", { title: "ok", targetUsd: "mucho" })).status).toBe(400);
    expect(((await (await env.call(other, "GET", `/api/t/${otherOrg}/goal`)).json()) as any).goal).toBeNull();
    expect((await t(owner, "PUT", "/goal", { goal: null })).status).toBe(200);
    expect(((await (await t(owner, "GET", "/goal")).json()) as any).goal).toBeNull();
  });
});

describe("estado en vivo para el cockpit", () => {
  test("/live incluye el total de donaciones en USD y el top de donadores de la sesión", async () => {
    const p = env.deps.ingest.pipeline;
    const don = (id: string, name: string, usd: number, channelId = "chan") =>
      ev(
        "donation",
        { kind: "gift", amountMinor: usd, currency: "TIKTOK_COIN", usdMinorEstimate: usd, count: 1 },
        { actor: { id, name }, channelId },
      );
    p.handleEvent(ev("stream_start", {}, { channelId: "live1" }));
    p.handleEvent(don("a", "Ana", 300, "live1"));
    p.handleEvent(don("b", "Beto", 900, "live1"));
    p.handleEvent(don("a", "Ana", 400, "live1")); // Ana acumula 700
    p.handleEvent(don("c", "Cami", 100, "live1"));
    const live = (await (await t(analyst, "GET", "/live")).json()) as { channels: any[] };
    const ch = live.channels.find((c) => c.channelId === "live1")!;
    expect(ch.counters.donationsUsdMinor).toBe(1700);
    expect(ch.topDonors.map((d: any) => d.name)).toEqual(["Beto", "Ana", "Cami"]);
    expect(ch.topDonors[1]).toMatchObject({ usdMinor: 700, byCurrency: { TIKTOK_COIN: 700 } });
  });

  test("el detalle de una sesión incluye los marcadores de su ventana de tiempo", async () => {
    const start = new Date(Date.now() - 3_600_000);
    await withTenant(env.app.db, org, async (tx) => {
      await tx.insert(schema.streamSession).values({
        id: "s-ck",
        tenantId: org,
        platform: "tiktok",
        channelId: "x",
        startedAt: start,
        endedAt: new Date(Date.now() - 600_000),
        peakViewers: 5,
      });
      await tx.insert(schema.streamMarker).values([
        { id: "dentro", tenantId: org, at: new Date(Date.now() - 1_800_000), kind: "manual", label: "dentro" },
        { id: "fuera", tenantId: org, at: new Date(Date.now() - 60_000), kind: "manual", label: "fuera" },
        { id: "otra-plat", tenantId: org, at: new Date(Date.now() - 1_700_000), kind: "raid", label: "otra", platform: "twitch" },
      ]);
    });
    const d = (await (await t(analyst, "GET", "/analytics/sessions/s-ck")).json()) as any;
    expect(d.markers.map((m: any) => m.label)).toEqual(["dentro"]);
  });
});
