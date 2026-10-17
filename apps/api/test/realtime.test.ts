import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { websocket } from "hono/bun";
import { schema, withTenant } from "@hivemonitor/db";
import { BASE_URL, createTestEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let server: ReturnType<typeof Bun.serve>;
let owner: string;
let analyst: string;
let moderator: string;
let org: string;
let otherOwner: string;
let otherOrg: string;

const proto = (token: string) => `bearer.${Buffer.from(token).toString("base64url")}`;
/** Bun admite cabeceras en el constructor (el tipo estándar no las declara). */
const WS = WebSocket as unknown as new (url: string, protocols: string[], opts: object) => WebSocket;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Sse {
  messages: { event: string; data: any; id?: string }[];
  close(): void;
  waitFor(pred: (m: { event: string; data: any }) => boolean, ms?: number): Promise<void>;
}

async function openSse(token: string, tenantId: string): Promise<Sse> {
  const res = await env.call(token, "GET", `/api/t/${tenantId}/stream`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const messages: Sse["messages"] = [];
  let buf = "";
  let closed = false;
  void (async () => {
    while (!closed) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      buf += dec.decode(value);
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m: { event: string; data: any; id?: string } = { event: "message", data: null };
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) m.event = line.slice(6).trim();
          else if (line.startsWith("data:"))
            m.data = (() => {
              try {
                return JSON.parse(line.slice(5));
              } catch {
                return line.slice(5).trim();
              }
            })();
          else if (line.startsWith("id:")) m.id = line.slice(3).trim();
        }
        messages.push(m);
      }
    }
  })();
  return {
    messages,
    close() {
      closed = true;
      void reader.cancel().catch(() => {});
    },
    async waitFor(pred, ms = 5000) {
      const t = Date.now();
      while (!messages.some(pred)) {
        if (Date.now() - t > ms)
          throw new Error(`timeout; recibidos: ${messages.map((m) => m.event + ":" + (m.data?.type ?? "")).join(",")}`);
        await sleep(20);
      }
    },
  };
}

async function invite(role: string, email: string, token: string) {
  const res = await env.call(owner, "POST", "/api/auth/organization/invite-member", { email, role, organizationId: org });
  const id = ((await res.json()) as { id: string }).id;
  expect((await env.call(token, "POST", "/api/auth/organization/accept-invitation", { invitationId: id })).status).toBe(200);
}

beforeAll(async () => {
  env = await createTestEnv();
  server = Bun.serve({ port: 0, fetch: env.http.fetch, websocket });
  owner = await env.signUp("o@rt.dev");
  otherOwner = await env.signUp("o2@rt.dev");
  org = ((await (await env.call(owner, "POST", "/api/auth/organization/create", { name: "RT", slug: "rt" })).json()) as { id: string }).id;
  otherOrg = (
    (await (await env.call(otherOwner, "POST", "/api/auth/organization/create", { name: "RT2", slug: "rt2" })).json()) as { id: string }
  ).id;
  analyst = await env.signUp("an@rt.dev");
  moderator = await env.signUp("mo@rt.dev");
  await invite("analyst", "an@rt.dev", analyst);
  await invite("moderator", "mo@rt.dev", moderator);
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  await env?.stop();
});

describe("conexiones", () => {
  test("solo quien tiene integrations.manage puede crear conexiones", async () => {
    const body = { platform: "tiktok", channelId: "x", config: { mode: "mock" } };
    expect((await env.call(analyst, "POST", `/api/t/${org}/connections`, body)).status).toBe(403);
    expect((await env.call(moderator, "POST", `/api/t/${org}/connections`, body)).status).toBe(403);
  });
  test("YouTube real devuelve 501 y el modo mock está permitido en test", async () => {
    expect((await env.call(owner, "POST", `/api/t/${org}/connections`, { platform: "youtube", channelId: "yt" })).status).toBe(501);
  });
  test("body inválido → 400", async () => {
    expect((await env.call(owner, "POST", `/api/t/${org}/connections`, { platform: "myspace", channelId: "" })).status).toBe(400);
  });
});

describe("flujo completo con adaptador mock", () => {
  let connId: string;
  let sse: Sse;
  let sseAnalyst: Sse;
  let sseOther: Sse;

  test("crear conexión mock la inicia y llega por SSE (solo al tenant correcto)", async () => {
    sse = await openSse(owner, org);
    sseAnalyst = await openSse(analyst, org);
    sseOther = await openSse(otherOwner, otherOrg);
    await sse.waitFor((m) => m.event === "snapshot");

    const res = await env.call(owner, "POST", `/api/t/${org}/connections`, {
      platform: "tiktok",
      channelId: "streamer1",
      config: { mode: "mock", intervalMs: 30, seed: 5 },
    });
    expect(res.status).toBe(201);
    connId = ((await res.json()) as { id: string }).id;

    await sse.waitFor((m) => m.event === "status" && m.data.status === "live");
    await sse.waitFor((m) => m.event === "event" && m.data.type === "chat");
    await sse.waitFor((m) => m.event === "event" && m.data.type === "viewer_count");
    // el otro tenant no recibe nada de este
    await sleep(100);
    expect(sseOther.messages.filter((m) => m.event === "event" || m.event === "status")).toHaveLength(0);
  });

  test("el SSE filtra por permisos: el analista no recibe chat", async () => {
    await sseAnalyst.waitFor((m) => m.event === "event" && m.data.type === "viewer_count");
    await sleep(300);
    const types = new Set(sseAnalyst.messages.filter((m) => m.event === "event").map((m) => m.data.type));
    expect(types.has("chat")).toBe(false);
    expect(types.has("viewer_count")).toBe(true);
    const full = new Set(sse.messages.filter((m) => m.event === "event").map((m) => m.data.type));
    expect(full.has("chat")).toBe(true);
  });

  test("un cliente nuevo recibe snapshot con eventos recientes filtrados", async () => {
    const late = await openSse(analyst, org);
    await late.waitFor((m) => m.event === "snapshot");
    const snap = late.messages.find((m) => m.event === "snapshot")!.data;
    expect(snap.recent.length).toBeGreaterThan(0);
    expect(snap.recent.every((e: any) => e.type !== "chat")).toBe(true);
    expect(snap.permissions).not.toContain("chat.view");
    late.close();
  });

  test("/live expone sesión, viewers y contadores", async () => {
    const live = (await (await env.call(owner, "GET", `/api/t/${org}/live`)).json()) as any;
    expect(live.channels).toHaveLength(1);
    expect(live.channels[0].counters.messages).toBeGreaterThan(0);
    expect(live.channels[0].peakViewers).toBeGreaterThan(0);
    expect(live.connections[0].status).toBe("live");
    // el otro tenant no ve nada
    const other = (await (await env.call(otherOwner, "GET", `/api/t/${otherOrg}/live`)).json()) as any;
    expect(other.channels).toHaveLength(0);
  });

  test("los eventos se persisten en lotes bajo RLS y con su sesión", async () => {
    await env.deps.ingest.pipeline.flush();
    const rows = await withTenant(env.app.db, org, (tx) => tx.select().from(schema.event));
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.every((r) => r.tenantId === org)).toBe(true);
    expect(rows.some((r) => r.type === "chat" && r.sessionId)).toBe(true);
    const sessions = await withTenant(env.app.db, org, (tx) => tx.select().from(schema.streamSession));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.endedAt).toBeNull();
    expect(await withTenant(env.app.db, otherOrg, (tx) => tx.select().from(schema.event))).toHaveLength(0);
  });

  test("el estado de la conexión se guarda en la base de datos", async () => {
    await sleep(50);
    const [row] = await withTenant(env.app.db, org, (tx) =>
      tx.select().from(schema.platformConnection).where(eq(schema.platformConnection.id, connId)),
    );
    expect(row?.status).toBe("live");
  });

  test("WebSocket: moderación autenticada con subprotocolo bearer, permisos y auditoría", async () => {
    const url = `ws://127.0.0.1:${server.port}/api/t/${org}/ws`;
    const open = (token: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WS(url, [proto(token)], { headers: { origin: BASE_URL } });
        ws.onopen = () => resolve(ws);
        ws.onerror = () => reject(new Error("ws error"));
      });
    const request = (ws: WebSocket, msg: object) =>
      new Promise<any>((resolve) => {
        ws.onmessage = (e) => resolve(JSON.parse(String(e.data)));
        ws.send(JSON.stringify(msg));
      });

    const modWs = await open(moderator);
    const ok = await request(modWs, {
      type: "moderate",
      id: "1",
      connectionId: connId,
      action: "timeout",
      targetId: "u_bruno",
      durationSec: 60,
      reason: "spam",
    });
    expect(ok).toEqual({ type: "ack", id: "1", ok: true });
    await sse.waitFor((m) => m.event === "event" && m.data.type === "moderation" && m.data.payload.action === "timeout");
    modWs.close();

    const anWs = await open(analyst);
    const denied = await request(anWs, { type: "moderate", id: "2", connectionId: connId, action: "ban", targetId: "x" });
    expect(denied.ok).toBe(false);
    expect(denied.error).toBe("forbidden");
    const bad = await request(anWs, { type: "moderate", nonsense: true });
    expect(bad.error).toBe("invalid_message");
    anWs.close();

    const audit = await env.admin.db.select().from(schema.auditLog).where(eq(schema.auditLog.tenantId, org));
    expect(audit.map((a) => a.action)).toContain("moderation.timeout");
    expect(audit.map((a) => a.action)).not.toContain("moderation.ban");
  });

  test("WebSocket: sin token o de otro tenant se rechaza; origen ajeno bloqueado", async () => {
    const url = `ws://127.0.0.1:${server.port}/api/t/${org}/ws`;
    const attempt = (protocols: string[], origin = BASE_URL) =>
      new Promise<"open" | "rejected">((resolve) => {
        const ws = new WS(url, protocols, { headers: { origin } });
        ws.onopen = () => (ws.close(), resolve("open"));
        ws.onerror = () => resolve("rejected");
        ws.onclose = () => resolve("rejected");
      });
    expect(await attempt([])).toBe("rejected");
    expect(await attempt([proto(otherOwner)])).toBe("rejected");
    // Cross-Site WebSocket Hijacking: upgrade con Origin ajeno y credenciales válidas
    const evil = await env.http.request(`/api/t/${org}/ws`, {
      headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-protocol": proto(owner), origin: "https://evil.example" },
    });
    expect(evil.status).toBe(403);
  });

  test("desconectar detiene el flujo y cierra la sesión", async () => {
    expect((await env.call(analyst, "POST", `/api/t/${org}/connections/${connId}/disconnect`)).status).toBe(403);
    expect((await env.call(owner, "POST", `/api/t/${org}/connections/${connId}/disconnect`)).status).toBe(200);
    await sse.waitFor((m) => m.event === "event" && m.data.type === "stream_end");
    await env.deps.ingest.pipeline.flush();
    const [s] = await withTenant(env.app.db, org, (tx) => tx.select().from(schema.streamSession));
    expect(s?.endedAt).not.toBeNull();
    expect((s?.stats as { messages: number }).messages).toBeGreaterThan(0);
    const before = sse.messages.length;
    await sleep(200);
    expect(sse.messages.filter((m) => m.event === "event").length).toBeLessThanOrEqual(before);
    sse.close();
    sseAnalyst.close();
    sseOther.close();
  });

  test("no se puede tocar la conexión de otro tenant", async () => {
    expect((await env.call(otherOwner, "POST", `/api/t/${otherOrg}/connections/${connId}/connect`)).status).toBe(404);
    expect((await env.call(otherOwner, "DELETE", `/api/t/${otherOrg}/connections/${connId}`)).status).toBe(404);
    expect((await env.call(owner, "DELETE", `/api/t/${org}/connections/${connId}`)).status).toBe(200);
  });
});

describe("límites y suspensión", () => {
  test("límite de conexiones por tenant", async () => {
    await env.admin.db
      .update(schema.tenantSettings)
      .set({ limits: { maxConnections: 1 } })
      .where(eq(schema.tenantSettings.tenantId, otherOrg));
    const mk = (id: string) =>
      env.call(otherOwner, "POST", `/api/t/${otherOrg}/connections`, {
        platform: "twitch",
        channelId: id,
        config: { mode: "mock", intervalMs: 500 },
      });
    expect((await mk("a")).status).toBe(201);
    expect((await mk("b")).status).toBe(409);
    expect((await mk("a")).status).toBe(409);
  });

  test("suspender un tenant detiene sus conexiones", async () => {
    expect(env.deps.ingest.supervisor.list(otherOrg).length).toBe(1);
    const root = await env.signUp("root@rt.dev");
    await env.admin.db.update(schema.user).set({ isSuperadmin: true }).where(eq(schema.user.email, "root@rt.dev"));
    expect((await env.call(root, "PATCH", `/api/admin/tenants/${otherOrg}`, { suspended: true })).status).toBe(200);
    expect(env.deps.ingest.supervisor.list(otherOrg).length).toBe(0);
    expect((await env.call(root, "PATCH", `/api/admin/tenants/${otherOrg}`, { suspended: false })).status).toBe(200);
    await sleep(50);
    expect(env.deps.ingest.supervisor.list(otherOrg).length).toBe(1);
  });
});

describe("resiliencia de la persistencia", () => {
  test("un evento que Postgres rechaza (NUL en texto) se descarta sin perder el resto del lote", async () => {
    const mk = (id: string, message: string) => ({
      id,
      tenantId: org,
      platform: "tiktok" as const,
      channelId: "poison",
      type: "chat" as const,
      occurredAt: new Date(),
      actor: null,
      payload: { message, badges: [] },
    });
    const p = env.deps.ingest.pipeline;
    p.handleEvent(mk("ok1", "hola"));
    p.handleEvent(mk("bad", "mal\u0000caracter"));
    p.handleEvent(mk("ok2", "adiós"));
    await p.flush();
    await p.flush(); // si el lote hubiera quedado reencolado, seguiría fallando
    const ids = (
      await withTenant(env.app.db, org, (tx) =>
        tx.select({ id: schema.event.id }).from(schema.event).where(eq(schema.event.channelId, "poison")),
      )
    ).map((r) => r.id);
    expect(ids.sort()).toEqual(["ok1", "ok2"]);
  });
});
