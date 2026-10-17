import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { BusMessage, NormalizedEvent } from "@hivemonitor/core";
import { schema, withTenant } from "@hivemonitor/db";
import { isAllowedWebhookUrl } from "../src/alerts/rules.ts";
import { sha256Hex } from "../src/crypto.ts";
import { createTestEnv, type TestEnv } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DISCORD = "https://discord.com/api/webhooks/123456789012345678/abc-DEF_123";

const discordCalls: { url: string; body: any }[] = [];
const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  discordCalls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
  return new Response(null, { status: 204 });
};

let env: TestEnv;
let owner: string;
let admin: string;
let analyst: string;
let moderator: string;
let org: string;
let otherOwner: string;
let otherOrg: string;
const bus: BusMessage[] = [];

const mk = (type: string, payload: object, extra: Partial<NormalizedEvent> = {}, tenantId = org) =>
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

async function invite(role: string, email: string, token: string) {
  const res = await env.call(owner, "POST", "/api/auth/organization/invite-member", { email, role, organizationId: org });
  expect(res.status).toBe(200);
  const id = ((await res.json()) as { id: string }).id;
  expect((await env.call(token, "POST", "/api/auth/organization/accept-invitation", { invitationId: id })).status).toBe(200);
}
const t = (tok: string, method: string, path: string, body?: unknown) => env.call(tok, method, `/api/t/${org}${path}`, body);
const rule = (over: object = {}) => ({
  type: "donation_over",
  name: "Donación grande",
  params: { thresholdUsd: 5 },
  channels: ["panel", "webhook"],
  webhookUrl: DISCORD,
  ...over,
});
const userId = async (email: string) => (await env.admin.db.select().from(schema.user).where(eq(schema.user.email, email)))[0]!.id;

beforeAll(async () => {
  env = await createTestEnv({}, undefined, fakeFetch);
  owner = await env.signUp("o@p7.dev");
  otherOwner = await env.signUp("o2@p7.dev");
  org = ((await (await env.call(owner, "POST", "/api/auth/organization/create", { name: "P7", slug: "p7" })).json()) as { id: string }).id;
  otherOrg = (
    (await (await env.call(otherOwner, "POST", "/api/auth/organization/create", { name: "P7b", slug: "p7b" })).json()) as { id: string }
  ).id;
  admin = await env.signUp("ad@p7.dev");
  analyst = await env.signUp("an@p7.dev");
  moderator = await env.signUp("mo@p7.dev");
  await invite("admin", "ad@p7.dev", admin);
  await invite("analyst", "an@p7.dev", analyst);
  await invite("moderator", "mo@p7.dev", moderator);
  env.deps.bus.subscribe(org, (m) => void bus.push(m));
}, 180_000);

afterAll(async () => {
  await env?.stop();
});

describe("webhooks de alertas: solo Discord", () => {
  test("lista blanca de URL (anti SSRF)", () => {
    expect(isAllowedWebhookUrl(DISCORD)).toBe(true);
    expect(isAllowedWebhookUrl("https://ptb.discord.com/api/webhooks/1/x")).toBe(true);
    for (const bad of [
      "http://discord.com/api/webhooks/1/x",
      "https://evil.com/api/webhooks/1/x",
      "https://discord.com.evil.com/api/webhooks/1/x",
      "https://discord.com@evil.com/api/webhooks/1/x",
      "https://discord.com:8443/api/webhooks/1/x",
      "https://discord.com/other",
      "http://169.254.169.254/latest",
      "ftp://discord.com/api/webhooks/1/x",
      "no-es-url",
    ]) {
      expect(isAllowedWebhookUrl(bad)).toBe(false);
    }
  });
});

describe("reglas de alertas (API)", () => {
  test("solo alerts.manage gestiona reglas", async () => {
    expect((await t(moderator, "GET", "/alerts/rules")).status).toBe(403);
    expect((await t(analyst, "POST", "/alerts/rules", rule())).status).toBe(403);
    expect((await t(admin, "GET", "/alerts/rules")).status).toBe(200);
  });

  test("validaciones: tipo, parámetros, webhook y canales", async () => {
    expect((await t(owner, "POST", "/alerts/rules", rule({ type: "magia" }))).status).toBe(400);
    expect((await t(owner, "POST", "/alerts/rules", rule({ params: { thresholdUsd: -3 } }))).status).toBe(400);
    expect((await t(owner, "POST", "/alerts/rules", rule({ webhookUrl: "https://evil.com/api/webhooks/1/x" }))).status).toBe(400);
    expect((await t(owner, "POST", "/alerts/rules", rule({ webhookUrl: null }))).status).toBe(400);
    expect((await t(owner, "POST", "/alerts/rules", rule({ channels: [] }))).status).toBe(400);
    expect((await t(owner, "POST", "/alerts/rules", rule({ channels: ["sms"] }))).status).toBe(400);
  });

  test("crear: la URL del webhook se guarda cifrada y nunca se devuelve", async () => {
    const res = await t(owner, "POST", "/alerts/rules", rule());
    expect(res.status).toBe(201);
    const list = (await (await t(owner, "GET", "/alerts/rules")).json()) as { rules: any[] };
    expect(list.rules).toHaveLength(1);
    expect(list.rules[0]).toMatchObject({ type: "donation_over", hasWebhook: true });
    expect(JSON.stringify(list)).not.toContain("discord.com");
    const [row] = await withTenant(env.app.db, org, (tx) => tx.select().from(schema.alertRule));
    expect(Buffer.from(row!.webhookUrlEnc!).includes(Buffer.from("discord"))).toBe(false);
    expect(env.deps.encryptor.decrypt(row!.webhookUrlEnc!)).toBe(DISCORD);
    const audit = await env.admin.db.select().from(schema.auditLog).where(eq(schema.auditLog.tenantId, org));
    expect(audit.map((a) => a.action)).toContain("alert.create");
  });

  test("editar, quitar el canal webhook y borrar", async () => {
    const id = (await withTenant(env.app.db, org, (tx) => tx.select().from(schema.alertRule)))[0]!.id;
    expect((await t(owner, "PATCH", `/alerts/rules/${id}`, { params: { thresholdUsd: 0 } })).status).toBe(400);
    expect((await t(owner, "PATCH", `/alerts/rules/${id}`, { webhookUrl: "http://x" })).status).toBe(400);
    expect((await t(owner, "PATCH", `/alerts/rules/${id}`, { channels: ["panel"] })).status).toBe(200);
    const [row] = await withTenant(env.app.db, org, (tx) => tx.select().from(schema.alertRule));
    expect(row!.webhookUrlEnc).toBeNull();
    expect((await t(owner, "PATCH", `/alerts/rules/${id}`, { channels: ["panel", "webhook"] })).status).toBe(400); // webhook sin URL
    expect((await t(owner, "PATCH", `/alerts/rules/${id}`, { channels: ["panel", "webhook"], webhookUrl: DISCORD })).status).toBe(200);
    expect((await t(owner, "PATCH", "/alerts/rules/nada", { enabled: false })).status).toBe(404);
    // otro tenant no puede tocarla
    expect((await env.call(otherOwner, "DELETE", `/api/t/${otherOrg}/alerts/rules/${id}`)).status).toBe(404);
    expect(await withTenant(env.app.db, org, (tx) => tx.select().from(schema.alertRule))).toHaveLength(1);
  });
});

describe("motor de alertas", () => {
  test("donación sobre el umbral: alert_event, bus y Discord (sin menciones); bajo el umbral nada; cooldown", async () => {
    bus.length = 0;
    discordCalls.length = 0;
    const don = (usd: number) =>
      mk("donation", { kind: "gift", amountMinor: usd, currency: "TIKTOK_COIN", usdMinorEstimate: usd, count: 1 });
    env.deps.ingest.pipeline.handleEvent(don(300)); // $3: no alcanza
    await sleep(60);
    expect(bus.filter((m) => m.kind === "alert")).toHaveLength(0);
    env.deps.ingest.pipeline.handleEvent(don(1000)); // $10
    env.deps.ingest.pipeline.handleEvent(don(2000)); // dentro del cooldown (5 s)
    await sleep(150);
    const alerts = bus.filter((m) => m.kind === "alert");
    expect(alerts).toHaveLength(1);
    expect((alerts[0] as any).alert).toMatchObject({ type: "donation_over", ruleName: "Donación grande" });
    expect((alerts[0] as any).alert.message).toContain("$10.00");
    expect(discordCalls).toHaveLength(1);
    expect(discordCalls[0]!.url).toBe(DISCORD);
    expect(discordCalls[0]!.body.allowed_mentions).toEqual({ parse: [] });
    expect(discordCalls[0]!.body.embeds[0].description).toContain("Ana");
    const rows = await withTenant(env.app.db, org, (tx) => tx.select().from(schema.alertEvent));
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test("las alertas se ven por SSE-bus solo en su tenant y en el historial con stream.view", async () => {
    const mine = (await (await t(analyst, "GET", "/alerts/events")).json()) as { events: any[] };
    expect(mine.events[0]).toMatchObject({ type: "donation_over" });
    const other = (await (await env.call(otherOwner, "GET", `/api/t/${otherOrg}/alerts/events`)).json()) as { events: any[] };
    expect(other.events).toHaveLength(0);
  });

  test("caída de viewers: dispara una vez (cooldown) y respeta el mínimo de espectadores", async () => {
    const id = (
      (await (
        await t(owner, "POST", "/alerts/rules", {
          type: "viewers_drop",
          name: "Caída",
          params: { dropPercent: 50, windowMin: 10, minViewers: 50 },
          channels: ["panel"],
        })
      ).json()) as { id: string }
    ).id;
    bus.length = 0;
    const vc = (viewers: number, channelId: string) => mk("viewer_count", { viewers }, { channelId });
    const p = env.deps.ingest.pipeline;
    // canal pequeño: nunca llegó al mínimo → no alerta aunque caiga
    p.handleEvent(vc(30, "chico"));
    p.handleEvent(vc(5, "chico"));
    // canal grande: 200 → 80 (-60%)
    p.handleEvent(vc(200, "grande"));
    p.handleEvent(vc(150, "grande"));
    await sleep(60);
    expect(bus.filter((m) => m.kind === "alert")).toHaveLength(0);
    p.handleEvent(vc(80, "grande"));
    p.handleEvent(vc(60, "grande")); // cooldown
    await sleep(100);
    const a = bus.filter((m) => m.kind === "alert") as any[];
    expect(a).toHaveLength(1);
    expect(a[0].alert.data).toMatchObject({ from: 200, to: 80, channelId: "grande" });
    await t(owner, "DELETE", `/alerts/rules/${id}`);
  });

  test("desconexión de plataforma: avisa pasado el margen y se cancela si se recupera", async () => {
    const id = (
      (await (
        await t(owner, "POST", "/alerts/rules", {
          type: "platform_disconnect",
          name: "Caída plataforma",
          params: { graceSec: 1, cooldownSec: 0 },
          channels: ["panel"],
        })
      ).json()) as { id: string }
    ).id;
    bus.length = 0;
    const spec = { id: "conn1", tenantId: org, platform: "tiktok" as const, channelId: "streamer" };
    env.deps.ingest.supervisor.notifyStatus(spec, "error");
    await sleep(150);
    env.deps.ingest.supervisor.notifyStatus(spec, "live"); // se recuperó dentro del margen
    await sleep(1300);
    expect(bus.filter((m) => m.kind === "alert")).toHaveLength(0);

    env.deps.ingest.supervisor.notifyStatus(spec, "error");
    await sleep(1400);
    const a = bus.filter((m) => m.kind === "alert") as any[];
    expect(a).toHaveLength(1);
    expect(a[0].alert.message).toContain("streamer");
    await t(owner, "DELETE", `/alerts/rules/${id}`);
  });

  test("heartbeat perdido: avisa una vez por silencio y se rearma con el siguiente latido", async () => {
    const id = (
      (await (
        await t(owner, "POST", "/alerts/rules", {
          type: "heartbeat_lost",
          name: "OBS sin señal",
          params: { source: "obs", afterSec: 30, cooldownSec: 0 },
          channels: ["panel"],
        })
      ).json()) as { id: string }
    ).id;
    bus.length = 0;
    const engine = env.deps.alerts as any;
    engine.noteHeartbeat(org, "obs");
    engine.heartbeats.get(`${org}|obs`).at = Date.now() - 120_000; // simula 2 min de silencio
    engine.noteHeartbeat(org, "otro-origen");
    engine.heartbeats.get(`${org}|otro-origen`).at = Date.now() - 120_000; // no coincide con la regla
    await engine.checkHeartbeats();
    await engine.checkHeartbeats(); // no repite
    await sleep(60);
    const a = bus.filter((m) => m.kind === "alert") as any[];
    expect(a).toHaveLength(1);
    expect(a[0].alert.data.source).toBe("obs");
    engine.noteHeartbeat(org, "obs");
    expect(engine.heartbeats.get(`${org}|obs`).alerted).toBe(false);
    await t(owner, "DELETE", `/alerts/rules/${id}`);
  });

  test("webhook de prueba por API y rechazo de URLs no permitidas al enviar", async () => {
    discordCalls.length = 0;
    const ruleId = (await withTenant(env.app.db, org, (tx) => tx.select().from(schema.alertRule)))[0]!.id;
    const r = await t(owner, "POST", `/alerts/rules/${ruleId}/test`);
    expect(r.status).toBe(200);
    await sleep(100);
    expect(discordCalls.some((c) => c.body.embeds[0].description.includes("prueba"))).toBe(true);
    const enc = env.deps.encryptor.encrypt("http://169.254.169.254/latest/meta-data");
    await expect(
      env.deps.alerts.sendDiscord(enc, {
        id: "x",
        ruleId: null,
        ruleName: "n",
        type: "t",
        message: "m",
        at: new Date().toISOString(),
        channels: [],
        data: {},
      }),
    ).rejects.toThrow("no permitida");
  });
});

describe("heartbeat externo", () => {
  let token: string;
  let tokenId: string;
  const hb = (tok: string | null, body: unknown, headers: Record<string, string> = {}) =>
    env.http.request("/api/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  test("solo integrations.manage crea tokens; se muestra una vez y se guarda solo el hash", async () => {
    expect((await t(analyst, "POST", "/heartbeat/tokens", { label: "x" })).status).toBe(403);
    const res = await t(owner, "POST", "/heartbeat/tokens", { label: "OBS del estudio" });
    expect(res.status).toBe(201);
    ({ token, id: tokenId } = (await res.json()) as { token: string; id: string });
    expect(token.startsWith("hm_")).toBe(true);
    const [row] = await withTenant(env.app.db, org, (tx) => tx.select().from(schema.heartbeatToken));
    expect(row!.tokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);
    const list = (await (await t(owner, "GET", "/heartbeat/tokens")).json()) as { tokens: any[] };
    expect(JSON.stringify(list)).not.toContain(token);
    expect(list.tokens[0].label).toBe("OBS del estudio");
  });

  test("latido válido → 204, se guarda, llega por el bus y aparece en /heartbeats", async () => {
    bus.length = 0;
    const r = await hb(token, { source: "obs", metrics: { fps: 59.9, droppedFrames: 3, scene: "Juego", streaming: true } });
    expect(r.status).toBe(204);
    await sleep(30);
    expect(bus.find((m) => m.kind === "heartbeat")).toBeDefined();
    const list = (await (await t(analyst, "GET", "/heartbeats")).json()) as { sources: any[] };
    expect(list.sources[0]).toMatchObject({ source: "obs", metrics: { fps: 59.9, scene: "Juego" } });
    // el token alternativo por cabecera también vale
    expect((await hb(null, { source: "hiveshock" }, { "x-heartbeat-token": token })).status).toBe(204);
    const [tok] = await withTenant(env.app.db, org, (tx) => tx.select().from(schema.heartbeatToken));
    expect(tok!.lastUsedAt).not.toBeNull();
  });

  test("rechaza token ausente/inválido, cuerpo inválido, demasiado grande y métricas anidadas", async () => {
    expect((await hb(null, { source: "obs" })).status).toBe(401);
    expect((await hb("hm_inventado", { source: "obs" })).status).toBe(401);
    expect((await hb("sin-prefijo", { source: "obs" })).status).toBe(401);
    expect((await hb(token, "{no json")).status).toBe(400);
    expect((await hb(token, { source: "con/barra" })).status).toBe(400);
    expect((await hb(token, { source: "obs", metrics: { anidado: { a: 1 } } })).status).toBe(400);
    expect((await hb(token, { source: "obs", metrics: { grande: "x".repeat(9000) } })).status).toBe(413);
  });

  test("aislamiento: el tenant ajeno no ve los latidos; límite de tasa por token; revocación", async () => {
    const other = (await (await env.call(otherOwner, "GET", `/api/t/${otherOrg}/heartbeats`)).json()) as { sources: any[] };
    expect(other.sources).toHaveLength(0);

    const created = (await (await t(owner, "POST", "/heartbeat/tokens", { label: "ráfaga" })).json()) as { token: string; id: string };
    let limited = 0;
    for (let i = 0; i < 65; i++) if ((await hb(created.token, { source: "burst" })).status === 429) limited++;
    expect(limited).toBeGreaterThanOrEqual(4);

    expect((await t(owner, "DELETE", `/heartbeat/tokens/${tokenId}`)).status).toBe(200);
    expect((await hb(token, { source: "obs" })).status).toBe(401);
    expect((await env.call(otherOwner, "DELETE", `/api/t/${otherOrg}/heartbeat/tokens/${created.id}`)).status).toBe(404);
  });

  test("un tenant suspendido no puede reportar", async () => {
    const t2 = (await (await t(owner, "POST", "/heartbeat/tokens", { label: "susp" })).json()) as { token: string };
    await env.admin.db.update(schema.tenantSettings).set({ suspended: true }).where(eq(schema.tenantSettings.tenantId, org));
    expect((await hb(t2.token, { source: "obs" })).status).toBe(403);
    await env.admin.db.update(schema.tenantSettings).set({ suspended: false }).where(eq(schema.tenantSettings.tenantId, org));
  });
});

describe("miembros, invitaciones y auditoría", () => {
  const actions = async () =>
    (await env.admin.db.select().from(schema.auditLog).where(eq(schema.auditLog.tenantId, org))).map((a) => ({
      action: a.action,
      actor: a.actorUserId,
      meta: a.meta as any,
    }));

  test("listado de miembros: solo members.manage; incluye invitaciones pendientes con enlace", async () => {
    expect((await t(analyst, "GET", "/members")).status).toBe(403);
    expect((await t(moderator, "GET", "/members")).status).toBe(403);
    await env.call(owner, "POST", "/api/auth/organization/invite-member", {
      email: "nuevo@p7.dev",
      role: "moderator",
      organizationId: org,
    });
    const res = (await (await t(admin, "GET", "/members")).json()) as any;
    expect(res.members.map((m: any) => m.role).sort()).toEqual(["admin", "analyst", "moderator", "owner"]);
    expect(res.members.find((m: any) => m.role === "owner").email).toBe("o@p7.dev");
    const inv = res.invitations.find((i: any) => i.email === "nuevo@p7.dev");
    expect(inv.link).toMatch(/\/accept-invitation\/.+/);
    expect(res.emailEnabled).toBe(false);
  });

  test("la auditoría registra invitaciones y aceptaciones con su actor", async () => {
    const a = await actions();
    const ownerId = await userId("o@p7.dev");
    expect(a.find((x) => x.action === "invitation.create" && x.meta.email === "ad@p7.dev")?.actor).toBe(ownerId);
    const accepted = a.find((x) => x.action === "invitation.accept" && x.meta.email === "an@p7.dev");
    expect(accepted?.actor).toBe(await userId("an@p7.dev"));
  });

  test("cambio de rol: un admin puede, un analista no; queda auditado con actor, antes y después", async () => {
    const members = ((await (await t(owner, "GET", "/members")).json()) as any).members;
    const modMember = members.find((m: any) => m.email === "mo@p7.dev");
    const analystAttempt = await env.call(analyst, "POST", "/api/auth/organization/update-member-role", {
      memberId: modMember.id,
      role: "admin",
      organizationId: org,
    });
    expect(analystAttempt.status).toBeGreaterThanOrEqual(400);

    const ok = await env.call(admin, "POST", "/api/auth/organization/update-member-role", {
      memberId: modMember.id,
      role: "analyst",
      organizationId: org,
    });
    expect(ok.status).toBe(200);
    const entry = (await actions()).find((x) => x.action === "member.role_change");
    expect(entry).toBeDefined();
    expect(entry!.actor).toBe(await userId("ad@p7.dev"));
    expect(entry!.meta).toMatchObject({ member: "mo@p7.dev", from: "moderator", to: "analyst" });
    // vuelve a moderador para no afectar el resto
    await env.call(admin, "POST", "/api/auth/organization/update-member-role", {
      memberId: modMember.id,
      role: "moderator",
      organizationId: org,
    });
  });

  test("un admin no puede tocar al propietario ni asignar el rol owner", async () => {
    const members = ((await (await t(owner, "GET", "/members")).json()) as any).members;
    const ownerMember = members.find((m: any) => m.role === "owner");
    const anMember = members.find((m: any) => m.email === "an@p7.dev");
    const demote = await env.call(admin, "POST", "/api/auth/organization/update-member-role", {
      memberId: ownerMember.id,
      role: "analyst",
      organizationId: org,
    });
    expect(demote.status).toBeGreaterThanOrEqual(400);
    const promote = await env.call(admin, "POST", "/api/auth/organization/update-member-role", {
      memberId: anMember.id,
      role: "owner",
      organizationId: org,
    });
    expect(promote.status).toBeGreaterThanOrEqual(400);
    const remove = await env.call(admin, "POST", "/api/auth/organization/remove-member", {
      memberIdOrEmail: ownerMember.id,
      organizationId: org,
    });
    expect(remove.status).toBeGreaterThanOrEqual(400);
    const del = await env.call(admin, "POST", "/api/auth/organization/delete", { organizationId: org });
    expect(del.status).toBeGreaterThanOrEqual(400);
    const after = ((await (await t(owner, "GET", "/members")).json()) as any).members;
    expect(after.find((m: any) => m.id === ownerMember.id).role).toBe("owner");
    expect(after.find((m: any) => m.id === anMember.id).role).toBe("analyst");
  });

  test("expulsar un miembro queda auditado", async () => {
    const extra = await env.signUp("extra@p7.dev");
    await invite("analyst", "extra@p7.dev", extra);
    const member = ((await (await t(owner, "GET", "/members")).json()) as any).members.find((m: any) => m.email === "extra@p7.dev");
    expect(
      (await env.call(admin, "POST", "/api/auth/organization/remove-member", { memberIdOrEmail: member.id, organizationId: org })).status,
    ).toBe(200);
    const e = (await actions()).find((x) => x.action === "member.remove");
    expect(e?.meta).toMatchObject({ member: "extra@p7.dev", role: "analyst" });
    expect(e?.actor).toBe(await userId("ad@p7.dev"));
    expect((await env.call(extra, "GET", `/api/t/${org}/connections`)).status).toBe(404); // ya no pertenece
  });

  test("transferir la propiedad: solo el owner; el antiguo pasa a admin; queda auditado", async () => {
    const members = ((await (await t(owner, "GET", "/members")).json()) as any).members;
    const adminMember = members.find((m: any) => m.email === "ad@p7.dev");
    expect((await t(admin, "POST", "/members/transfer-ownership", { memberId: adminMember.id })).status).toBe(403);
    expect((await t(owner, "POST", "/members/transfer-ownership", { memberId: "inexistente" })).status).toBe(404);
    expect(
      (await t(owner, "POST", "/members/transfer-ownership", { memberId: members.find((m: any) => m.role === "owner").id })).status,
    ).toBe(400);
    expect((await t(owner, "POST", "/members/transfer-ownership", { memberId: adminMember.id })).status).toBe(200);
    const after = ((await (await t(admin, "GET", "/members")).json()) as any).members;
    expect(after.find((m: any) => m.email === "ad@p7.dev").role).toBe("owner");
    expect(after.find((m: any) => m.email === "o@p7.dev").role).toBe("admin");
    expect((await actions()).some((x) => x.action === "org.transfer_ownership")).toBe(true);
    // el nuevo owner ya tiene org.manage; el antiguo no
    const me = (await (await env.call(owner, "GET", "/api/me")).json()) as any;
    expect(me.organizations.find((o: any) => o.id === org).permissions).not.toContain("org.manage");
  });
});

describe("vista superadmin", () => {
  test("solo el superadmin ve tenants (con conexiones) y el estado del sistema", async () => {
    expect((await env.call(owner, "GET", "/api/admin/system")).status).toBe(403);
    const root = await env.signUp("root@p7.dev");
    await env.admin.db.update(schema.user).set({ isSuperadmin: true }).where(eq(schema.user.email, "root@p7.dev"));
    const sys = (await (await env.call(root, "GET", "/api/admin/system")).json()) as any;
    expect(sys.memory.rssMb).toBeGreaterThan(0);
    expect(sys.connections).toMatchObject({ total: expect.any(Number), rateLimitHits: expect.any(Number) });
    expect(Array.isArray(sys.errors)).toBe(true);
    const tenants = (await (await env.call(root, "GET", "/api/admin/tenants")).json()) as any;
    expect(tenants.tenants.find((x: any) => x.id === org)).toMatchObject({ connections: expect.any(Number), live: expect.any(Number) });
  });
});
