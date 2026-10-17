import { describe, expect, test } from "bun:test";
import type { NormalizedEvent, StatusChange } from "@hivemonitor/core";
import {
  Helix,
  HelixError,
  createTwitchAdapterFactory,
  createWebSocketTransport,
  mapNotification,
  subscribeAll,
  type EventSubListener,
  type EventSubTransport,
  type TwitchCredentials,
} from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const note = (type: string, event: Record<string, any>, id = "m1") => ({ type, version: "1", event, messageId: id });

describe("mapeo de notificaciones de Twitch", () => {
  test("chat", () => {
    const m = mapNotification(note("channel.chat.message", { message_id: "x1", chatter_user_id: "9", chatter_user_name: "Ana", message: { text: "hola" }, badges: [{ set_id: "moderator" }] }))!;
    expect(m.type).toBe("chat");
    expect(m.payload).toMatchObject({ message: "hola", badges: ["moderator"], messageId: "x1" });
    expect(m.actor).toMatchObject({ id: "9", name: "Ana" });
  });
  test("cheer → donación en bits; anónimo sin actor; 0 bits ignorado", () => {
    const m = mapNotification(note("channel.cheer", { is_anonymous: true, bits: 500, message: "gg" }))!;
    expect(m.type).toBe("donation");
    expect(m.actor).toBeNull();
    expect(m.payload).toMatchObject({ kind: "bits", amountMinor: 500, currency: "BITS", usdMinorEstimate: 500 });
    expect(mapNotification(note("channel.cheer", { bits: 0 }))).toBeNull();
  });
  test("subs: se cuenta cada receptor; el resumen del regalador se ignora (sin doble conteo)", () => {
    expect(mapNotification(note("channel.subscribe", { user_id: "1", user_name: "A", tier: "1000", is_gift: true }))!.payload).toMatchObject({ tier: "tier1", gifted: true });
    expect(mapNotification(note("channel.subscription.gift", { total: 5 }))).toBeNull();
    expect(mapNotification(note("channel.subscription.message", { user_id: "1", tier: "2000", cumulative_months: 7 }))!.payload).toMatchObject({ tier: "tier2", months: 7 });
  });
  test("raid y follow", () => {
    const r = mapNotification(note("channel.raid", { from_broadcaster_user_id: "5", from_broadcaster_user_login: "otro", from_broadcaster_user_name: "Otro", viewers: 42 }))!;
    expect(r.payload).toMatchObject({ viewers: 42, fromChannel: "otro" });
    const f = mapNotification(note("channel.follow", { user_id: "2", user_name: "B", followed_at: "2026-01-01T00:00:00Z" }))!;
    expect(f.type).toBe("follow");
    expect(f.occurredAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(mapNotification(note("channel.desconocido", {}))).toBeNull();
  });
});

describe("Helix", () => {
  test("reintenta una vez tras 429 respetando Ratelimit-Reset y propaga errores HTTP", async () => {
    let calls = 0;
    const helix = new Helix({
      clientId: "cid",
      fetch: async (_url, init) => {
        calls++;
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
        if (calls === 1) return new Response("{}", { status: 429, headers: { "ratelimit-reset": String(Math.ceil(Date.now() / 1000)) } });
        return new Response(JSON.stringify({ data: [{ id: "1", login: "a", display_name: "A" }] }), { status: 200 });
      },
    });
    const u = await helix.getUser("tok", "a");
    expect(u?.id).toBe("1");
    expect(calls).toBe(2);

    const bad = new Helix({ clientId: "c", fetch: async () => new Response(JSON.stringify({ message: "nope" }), { status: 401 }) });
    await expect(bad.getUser("t")).rejects.toBeInstanceOf(HelixError);
  });

  test("subscribeAll omite las opcionales sin alcance o rechazadas, acepta 409 y falla si una requerida falla", async () => {
    const created: string[] = [];
    const mk = (fail: (type: string) => number | null) =>
      new Helix({
        clientId: "c",
        fetch: async (_u, init) => {
          const body = JSON.parse(String(init?.body));
          const status = fail(body.type);
          if (status) return new Response(JSON.stringify({ message: "x" }), { status });
          created.push(body.type);
          return new Response(JSON.stringify({ data: [{ id: `sub_${body.type}` }] }), { status: 202 });
        },
      });
    const r = await subscribeAll(mk((t) => (t === "channel.cheer" ? 403 : t === "channel.raid" ? 409 : null)), "t", { method: "websocket", session_id: "s" }, "b1", ["user:read:chat"]);
    expect(created).toContain("channel.chat.message");
    expect(created).not.toContain("channel.follow"); // falta alcance
    expect(r.skipped.map((s) => s.type)).toEqual(expect.arrayContaining(["channel.follow", "channel.subscribe", "channel.cheer"]));
    await expect(subscribeAll(mk((t) => (t === "stream.online" ? 500 : null)), "t", {}, "b1", [])).rejects.toBeInstanceOf(HelixError);
  });
});

// --- Adaptador con transporte y Helix falsos ---------------------------------
const creds: TwitchCredentials = { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3_600_000, scopes: ["user:read:chat"], userId: "77", login: "streamer" };

function setup(over: { streams?: () => any[]; attachError?: Error; ensure?: () => Promise<TwitchCredentials> } = {}) {
  const events: NormalizedEvent[] = [];
  const statuses: StatusChange[] = [];
  const calls: any[] = [];
  let listener!: EventSubListener;
  let detached = 0;
  const transport: EventSubTransport = {
    async attach(a) {
      if (over.attachError) throw over.attachError;
      listener = a.listener;
      return { detach: async () => void detached++ };
    },
  };
  const helix = {
    getStreams: async () => (over.streams ? over.streams() : []),
    banUser: async (_t: string, p: any) => void calls.push(["ban", p]),
    unbanUser: async (_t: string, p: any) => void calls.push(["unban", p]),
    deleteMessage: async (_t: string, p: any) => void calls.push(["delete", p]),
  } as unknown as Helix;
  const adapter = createTwitchAdapterFactory({
    helix,
    transport,
    tokens: { ensureFresh: over.ensure ?? (async (_id, c) => c) },
    appToken: async () => "app",
    pollMs: 30,
  })({ tenantId: "t1", platform: "twitch", channelId: "streamer", connectionId: "c1", credentials: creds as any }, { onEvent: (e) => events.push(e), onStatus: (s) => statuses.push(s) });
  return { adapter, events, statuses, calls, fire: (n: any) => listener.onNotification(n), listener: () => listener, detached: () => detached };
}

describe("adaptador de Twitch", () => {
  test("canal sin directo: offline PASIVO (el supervisor no debe reconectar)", async () => {
    const s = setup();
    await s.adapter.connect();
    expect(s.statuses.at(-1)).toMatchObject({ status: "offline", passive: true });
    await s.adapter.disconnect();
  });

  test("canal ya en directo al conectar: live + stream_start + viewers", async () => {
    const s = setup({ streams: () => [{ user_id: "77", viewer_count: 321, title: "Mi directo", started_at: "x" }] });
    await s.adapter.connect();
    expect(s.statuses.at(-1)?.status).toBe("live");
    expect(s.events.map((e) => e.type)).toEqual(["stream_start", "viewer_count"]);
    await s.adapter.disconnect();
    expect(s.events.at(-1)?.type).toBe("stream_end");
    expect(s.detached()).toBe(1);
  });

  test("stream.online pasa a live; los eventos fluyen; stream.offline cierra y vuelve a pasivo", async () => {
    let live = false;
    const s = setup({ streams: () => (live ? [{ user_id: "77", viewer_count: 5, title: "T", started_at: "x" }] : []) });
    await s.adapter.connect();
    live = true;
    await s.fire(note("stream.online", {}, "o1"));
    await sleep(10);
    expect(s.statuses.at(-1)?.status).toBe("live");
    await s.fire(note("channel.chat.message", { message_id: "c1", chatter_user_id: "1", chatter_user_name: "X", message: { text: "yo" } }, "n2"));
    expect(s.events.some((e) => e.type === "chat")).toBe(true);
    live = false;
    await s.fire(note("stream.offline", {}, "o2"));
    expect(s.events.at(-1)?.type).toBe("stream_end");
    expect(s.statuses.at(-1)).toMatchObject({ status: "offline", passive: true });
    await s.adapter.disconnect();
  });

  test("el sondeo corrige un stream.offline perdido", async () => {
    let live = true;
    const s = setup({ streams: () => (live ? [{ user_id: "77", viewer_count: 5, title: "T", started_at: "x" }] : []) });
    await s.adapter.connect();
    expect(s.statuses.at(-1)?.status).toBe("live");
    live = false;
    await sleep(80);
    expect(s.statuses.at(-1)?.status).toBe("offline");
    await s.adapter.disconnect();
  });

  test("pérdida del transporte y revocación se reportan como error (el supervisor reconecta)", async () => {
    const s = setup();
    await s.adapter.connect();
    s.listener().onClosed("conexión EventSub cerrada");
    expect(s.statuses.at(-1)).toMatchObject({ status: "error" });
    s.listener().onRevoked("channel.chat.message", "authorization_revoked");
    expect(s.statuses.at(-1)?.detail).toContain("revocada");
    await s.adapter.disconnect();
  });

  test("sin credenciales o con autorización inválida: error sin lanzar", async () => {
    const a = setup({ ensure: async () => { throw new Error("refresh falló"); } });
    await a.adapter.connect();
    expect(a.statuses.at(-1)?.status).toBe("error");
    const b = setup({ attachError: new HelixError(401, null, "Helix 401") });
    await b.adapter.connect();
    expect(b.statuses.at(-1)).toMatchObject({ status: "error", detail: "Twitch rechazó la autorización" });
  });

  test("moderación: ban/timeout/delete llaman a Helix con el moderador correcto y emiten el evento", async () => {
    const s = setup();
    await s.adapter.connect();
    await s.adapter.moderate!({ action: "timeout", targetId: "9", durationSec: 60, reason: "spam" });
    await s.adapter.moderate!({ action: "delete", messageId: "mm" });
    await s.adapter.moderate!({ action: "ban", targetId: "10" });
    expect(s.calls[0]).toEqual(["ban", { broadcasterId: "77", moderatorId: "77", userId: "9", durationSec: 60, reason: "spam" }]);
    expect(s.calls[1][0]).toBe("delete");
    expect(s.calls[2][1].durationSec).toBeUndefined();
    expect(s.events.filter((e) => e.type === "moderation")).toHaveLength(3);
    await expect(s.adapter.moderate!({ action: "ban" })).rejects.toThrow("target_required");
    await s.adapter.disconnect();
  });
});

// --- Transporte WebSocket con WebSocket falso ----------------------------------
class FakeWs {
  static last: FakeWs;
  static all: FakeWs[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeWs.last = this;
    FakeWs.all.push(this);
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
  push(message_type: string, payload: any = {}, extra: any = {}) {
    this.onmessage?.({ data: JSON.stringify({ metadata: { message_id: crypto.randomUUID(), message_type, ...extra }, payload }) });
  }
}

describe("transporte EventSub por WebSocket", () => {
  const helixOk = () => {
    const subs: any[] = [];
    const helix = new Helix({
      clientId: "c",
      fetch: async (_u, init) => {
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        const body = JSON.parse(String(init?.body));
        subs.push(body);
        return new Response(JSON.stringify({ data: [{ id: `s${subs.length}` }] }), { status: 202 });
      },
    });
    return { helix, subs };
  };

  test("welcome → crea suscripciones con el session_id; entrega notificaciones sin duplicados", async () => {
    FakeWs.all = [];
    const { helix, subs } = helixOk();
    const t = createWebSocketTransport({ helix, WebSocketImpl: FakeWs as never });
    const got: string[] = [];
    const p = t.attach({
      broadcasterId: "77",
      userToken: async () => "ut",
      scopes: ["user:read:chat"],
      listener: { onNotification: (n) => got.push(n.type + ":" + n.messageId), onClosed: () => got.push("closed"), onRevoked: () => {} },
    });
    await sleep(5);
    FakeWs.last.push("session_welcome", { session: { id: "SESS", keepalive_timeout_seconds: 10 } });
    const att = await p;
    expect(subs.every((s) => s.transport.session_id === "SESS" && s.transport.method === "websocket")).toBe(true);
    const dup = { metadata: { message_id: "dup", message_type: "notification", subscription_type: "channel.raid", subscription_version: "1" }, payload: { event: { viewers: 1 } } };
    FakeWs.last.onmessage!({ data: JSON.stringify(dup) });
    FakeWs.last.onmessage!({ data: JSON.stringify(dup) });
    expect(got).toEqual(["channel.raid:dup"]);
    await att.detach();
    expect(FakeWs.last.closed).toBe(true);
    expect(got).not.toContain("closed");
  });

  test("session_reconnect abre la sesión nueva y cierra la vieja sin avisar de caída", async () => {
    FakeWs.all = [];
    const { helix } = helixOk();
    const t = createWebSocketTransport({ helix, WebSocketImpl: FakeWs as never });
    const events: string[] = [];
    const p = t.attach({ broadcasterId: "77", userToken: async () => "ut", scopes: [], listener: { onNotification: () => {}, onClosed: (r) => events.push(r), onRevoked: () => {} } });
    await sleep(5);
    const first = FakeWs.last;
    first.push("session_welcome", { session: { id: "S1", keepalive_timeout_seconds: 10 } });
    const att = await p;
    first.push("session_reconnect", { session: { reconnect_url: "wss://nuevo" } });
    const second = FakeWs.last;
    expect(second.url).toBe("wss://nuevo");
    second.push("session_welcome", { session: { id: "S2" } });
    expect(first.closed).toBe(true);
    expect(events).toEqual([]); // la caída de la sesión vieja es esperada
    await att.detach();
  });

  test("si la conexión se cae, avisa con onClosed; sin welcome a tiempo, attach falla", async () => {
    FakeWs.all = [];
    const { helix } = helixOk();
    const t = createWebSocketTransport({ helix, WebSocketImpl: FakeWs as never, welcomeTimeoutMs: 30 });
    await expect(t.attach({ broadcasterId: "1", userToken: async () => "u", scopes: [], listener: { onNotification: () => {}, onClosed: () => {}, onRevoked: () => {} } })).rejects.toThrow("session_welcome");

    const closed: string[] = [];
    const p = t.attach({ broadcasterId: "1", userToken: async () => "u", scopes: [], listener: { onNotification: () => {}, onClosed: (r) => closed.push(r), onRevoked: () => {} } });
    await sleep(5);
    FakeWs.last.push("session_welcome", { session: { id: "S" } });
    await p;
    FakeWs.last.close();
    expect(closed).toHaveLength(1);
  });
});
