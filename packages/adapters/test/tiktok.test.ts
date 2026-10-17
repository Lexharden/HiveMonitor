import { describe, expect, test } from "bun:test";
import type { NormalizedEvent, StatusChange } from "@hivemonitor/core";
import { classifyTikTokError, createTikTokAdapterFactory, type TikTokClientLike } from "../src/tiktok/index.ts";

class FakeClient implements TikTokClientLike {
  handlers = new Map<string, ((...a: any[]) => void)[]>();
  connectError?: unknown;
  disconnected = 0;
  on(event: string, fn: (...a: any[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  async connect() {
    if (this.connectError) throw this.connectError;
  }
  async disconnect() {
    this.disconnected++;
  }
  fire(event: string, data?: unknown) {
    for (const h of this.handlers.get(event) ?? []) h(data);
  }
}

function setup(client = new FakeClient(), opts: { usdCentsPerCoin?: number } = {}) {
  const events: NormalizedEvent[] = [];
  const statuses: StatusChange[] = [];
  const adapter = createTikTokAdapterFactory({ ...opts, clientFactory: () => client })(
    { tenantId: "t1", platform: "tiktok", channelId: "@streamer" },
    { onEvent: (e) => events.push(e), onStatus: (s) => statuses.push(s) },
  );
  return { client, adapter, events, statuses };
}

const user = { userId: "42", uniqueId: "ana", nickname: "Ana", profilePicture: { urls: ["https://img/a.png"] } };

class UserOfflineError extends Error {}
class SignatureRateLimitError extends Error {
  retryAfter = 30;
}
class InvalidUniqueIdError extends Error {}

describe("adaptador de TikTok", () => {
  test("conecta, emite stream_start y marca live", async () => {
    const { adapter, events, statuses } = setup();
    await adapter.connect();
    expect(statuses.map((s) => s.status)).toEqual(["connecting", "live"]);
    expect(events[0]?.type).toBe("stream_start");
    expect(events[0]?.tenantId).toBe("t1");
  });

  test("normaliza chat con actor y avatar", async () => {
    const { adapter, events, client } = setup();
    await adapter.connect();
    client.fire("chat", { comment: "hola", msgId: "m1", user });
    const e = events.find((x) => x.type === "chat")!;
    expect(e.type === "chat" && e.payload.message).toBe("hola");
    expect(e.actor).toEqual({ id: "42", name: "Ana", avatar: "https://img/a.png" });
    expect(e.id).toBe("tt_@streamer_m1");
  });

  test("regalos: la racha en curso se ignora y solo cuenta el evento final (anti doble conteo)", async () => {
    const { adapter, events, client } = setup(undefined, { usdCentsPerCoin: 1 });
    await adapter.connect();
    const gift = { user, giftDetails: { giftType: 1, giftName: "Rose", diamondCount: 5 } };
    client.fire("gift", { ...gift, repeatCount: 1, repeatEnd: false, msgId: "g1" });
    client.fire("gift", { ...gift, repeatCount: 3, repeatEnd: false, msgId: "g2" });
    expect(events.filter((e) => e.type === "donation")).toHaveLength(0);
    client.fire("gift", { ...gift, repeatCount: 3, repeatEnd: true, msgId: "g3" });
    const d = events.filter((e) => e.type === "donation");
    expect(d).toHaveLength(1);
    const p = d[0]!.type === "donation" ? d[0]!.payload : null;
    expect(p).toMatchObject({ kind: "gift", giftName: "Rose", count: 3, amountMinor: 15, currency: "TIKTOK_COIN", usdMinorEstimate: 15 });
  });

  test("regalos sin racha se cuentan de inmediato", async () => {
    const { adapter, events, client } = setup();
    await adapter.connect();
    client.fire("gift", { user, giftDetails: { giftType: 2, giftName: "Lion", diamondCount: 29999 }, repeatCount: 1, msgId: "g9" });
    const d = events.find((e) => e.type === "donation")!;
    expect(d.type === "donation" && d.payload.amountMinor).toBe(29999);
  });

  test("viewers, likes, follows y shares", async () => {
    const { adapter, events, client } = setup();
    await adapter.connect();
    client.fire("roomUser", { viewerCount: 120 });
    client.fire("like", { likeCount: 7, user });
    client.fire("follow", { user });
    client.fire("share", { user });
    client.fire("roomUser", { viewerCount: "no-es-numero" });
    const types = events.map((e) => e.type);
    expect(types).toEqual(["stream_start", "viewer_count", "like", "follow", "share"]);
    const v = events.find((e) => e.type === "viewer_count")!;
    expect(v.type === "viewer_count" && v.payload.viewers).toBe(120);
  });

  test("un mensaje malformado no rompe el adaptador", async () => {
    const { adapter, events, client } = setup();
    await adapter.connect();
    client.fire("gift", { user, giftDetails: { giftType: 2 }, repeatCount: -5 });
    client.fire("chat", { comment: undefined, user: undefined });
    expect(events.filter((e) => e.type === "chat")).toHaveLength(1);
  });

  test("streamEnd → stream_end y offline; disconnected posterior no es un error", async () => {
    const { adapter, events, statuses, client } = setup();
    await adapter.connect();
    client.fire("streamEnd", {});
    client.fire("disconnected", {});
    expect(events.map((e) => e.type)).toContain("stream_end");
    expect(statuses.at(-1)?.status).toBe("offline");
  });

  test("caída inesperada → error (el supervisor reconecta con backoff)", async () => {
    const { adapter, statuses, client } = setup();
    await adapter.connect();
    client.fire("disconnected", {});
    expect(statuses.at(-1)?.status).toBe("error");
  });

  test("disconnect() emite stream_end y no marca error al cerrar", async () => {
    const { adapter, events, statuses, client } = setup();
    await adapter.connect();
    await adapter.disconnect();
    client.fire("disconnected", {});
    expect(events.at(-1)?.type).toBe("stream_end");
    expect(client.disconnected).toBe(1);
    expect(statuses.at(-1)?.status).toBe("live");
  });

  test("canal offline: estado offline sin lanzar excepción", async () => {
    const client = new FakeClient();
    client.connectError = new UserOfflineError("offline");
    const { adapter, statuses } = setup(client);
    await adapter.connect();
    expect(statuses.at(-1)).toMatchObject({ status: "offline" });
  });

  test("límite de firma: rate_limited con retryInMs en milisegundos", async () => {
    const client = new FakeClient();
    client.connectError = new SignatureRateLimitError("429");
    const { adapter, statuses } = setup(client);
    await adapter.connect();
    expect(statuses.at(-1)).toMatchObject({ status: "rate_limited", retryInMs: 30_000 });
  });

  test("usuario inválido y otros errores", async () => {
    const c1 = new FakeClient();
    c1.connectError = new InvalidUniqueIdError("x");
    const a = setup(c1);
    await a.adapter.connect();
    expect(a.statuses.at(-1)?.status).toBe("error");
    const c2 = new FakeClient();
    c2.connectError = new Error("socket hang up");
    const b = setup(c2);
    await b.adapter.connect();
    expect(b.statuses.at(-1)).toMatchObject({ status: "error", detail: "socket hang up" });
  });

  test("clasificador: detecta 429 por texto y errores anidados", () => {
    expect(classifyTikTokError(new Error("HTTP 429 Too Many")).kind).toBe("rate_limited");
    expect(classifyTikTokError({ cause: new UserOfflineError("x") }).kind).toBe("offline");
    expect(classifyTikTokError(new Error("boom")).kind).toBe("other");
  });
});
