import { describe, expect, test } from "bun:test";
import type { AdapterFactory, AdapterHandlers, NormalizedEvent, Platform, StatusChange } from "@hivemonitor/core";
import { InProcessBus } from "../src/bus/in-process.ts";
import { backoffDelay, jitter } from "../src/ingest/backoff.ts";
import { Supervisor, type ConnectionSpec } from "../src/ingest/supervisor.ts";
import type { IngestPipeline } from "../src/ingest/pipeline.ts";
import { createLogger } from "../src/logger.ts";

const logger = createLogger({ LOG_LEVEL: "silent", NODE_ENV: "test" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timeout esperando condición");
    await sleep(5);
  }
}

describe("backoff", () => {
  test("crece de forma exponencial, con tope y jitter acotado", () => {
    const o = { baseMs: 1000, maxMs: 30_000 };
    const lo = (n: number) => backoffDelay(n, { ...o, random: () => 0 });
    const hi = (n: number) => backoffDelay(n, { ...o, random: () => 0.999999 });
    expect(lo(1)).toBe(500);
    expect(hi(1)).toBeLessThanOrEqual(1000);
    expect(lo(3)).toBe(2000);
    expect(hi(20)).toBeLessThanOrEqual(30_000);
    expect(lo(20)).toBe(15_000);
    for (let n = 1; n < 10; n++) expect(hi(n + 1)).toBeGreaterThanOrEqual(hi(n) - 1);
  });
  test("jitter se mantiene en ±ratio", () => {
    expect(jitter(1000, 0.2, () => 0)).toBe(800);
    expect(jitter(1000, 0.2, () => 1)).toBe(1200);
  });
});

function setup(
  factoryFor: (spec: ConnectionSpec) => AdapterFactory | undefined,
  extra: Partial<ConstructorParameters<typeof Supervisor>[0]> = {},
) {
  const events: NormalizedEvent[] = [];
  const closed: string[] = [];
  const statuses: { id: string; status: string }[] = [];
  const bus = new InProcessBus();
  const pipeline = {
    handleEvent: (e: NormalizedEvent) => void events.push(e),
    closeSession: (t: string, p: string, c: string) => void closed.push(`${t}|${p}|${c}`),
  } as unknown as IngestPipeline;
  const sup = new Supervisor({
    logger,
    bus,
    pipeline,
    resolveFactory: factoryFor,
    onStatusChange: (spec, status) => void statuses.push({ id: spec.id, status }),
    backoff: { baseMs: 10, maxMs: 40 },
    offlineRetryMs: 30,
    random: () => 0.5,
    ...extra,
  });
  return { sup, events, closed, statuses, bus };
}

const spec = (id: string, tenantId = "t1", platform: Platform = "tiktok"): ConnectionSpec => ({
  id,
  tenantId,
  platform,
  channelId: `ch_${id}`,
});

function chat(s: ConnectionSpec, over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: crypto.randomUUID(),
    tenantId: s.tenantId,
    platform: s.platform,
    channelId: s.channelId,
    type: "chat",
    occurredAt: new Date(),
    actor: null,
    payload: { message: "hi", badges: [] },
    ...over,
  } as NormalizedEvent;
}

describe("supervisor", () => {
  test("reintenta con backoff hasta conectar y resetea los intentos", async () => {
    let calls = 0;
    const { sup } = setup(() => (ctx, h) => ({
      platform: ctx.platform,
      status: () => "live",
      async connect() {
        calls++;
        if (calls < 4) {
          h.onStatus({ status: "error", at: new Date(), detail: "boom" });
          throw new Error("boom");
        }
        h.onStatus({ status: "live", at: new Date() });
      },
      async disconnect() {},
    }));
    await sup.start(spec("a"));
    await until(() => sup.get("a")?.status === "live");
    expect(calls).toBe(4);
    expect(sup.get("a")?.attempts).toBe(0);
    await sup.shutdown();
  });

  test("el fallo de una conexión no afecta a otra (aislamiento)", async () => {
    const { sup, events } = setup((s) => (ctx, h) => ({
      platform: ctx.platform,
      status: () => "live",
      async connect() {
        if (s.id === "bad") {
          throw new Error("siempre falla");
        }
        h.onStatus({ status: "live", at: new Date() });
        h.onEvent(chat(s));
      },
      async disconnect() {},
    }));
    await sup.start(spec("bad", "t1"));
    await sup.start(spec("good", "t2"));
    await until(() => sup.get("good")?.status === "live");
    await sleep(60);
    expect(events.filter((e) => e.tenantId === "t2").length).toBeGreaterThan(0);
    expect(sup.get("bad")?.status).not.toBe("live");
    await sup.shutdown();
  });

  test("una excepción síncrona del adaptador (factory) tampoco tumba al supervisor", async () => {
    const { sup } = setup((s) => (ctx, h) => {
      if (s.id === "x") throw new Error("factory rota");
      return {
        platform: ctx.platform,
        status: () => "live",
        async connect() {
          h.onStatus({ status: "live", at: new Date() });
        },
        async disconnect() {},
      };
    });
    await sup.start(spec("x"));
    await sup.start(spec("y"));
    await until(() => sup.get("y")?.status === "live");
    await until(() => sup.get("x")?.status === "error");
    await sup.shutdown();
  });

  test("descarta eventos con tenant o canal ajeno", async () => {
    const { sup, events } = setup(() => (ctx, h) => ({
      platform: ctx.platform,
      status: () => "live",
      async connect() {
        h.onStatus({ status: "live", at: new Date() });
        h.onEvent(chat(spec("a"), { tenantId: "OTRO" }));
        h.onEvent(chat(spec("a"), { channelId: "otro" }));
        h.onEvent(chat(spec("a")));
      },
      async disconnect() {},
    }));
    await sup.start(spec("a"));
    await until(() => events.length >= 1);
    await sleep(20);
    expect(events).toHaveLength(1);
    expect(events[0]!.tenantId).toBe("t1");
    await sup.shutdown();
  });

  test("offline: reintenta periódicamente sin contar como fallo y cierra la sesión", async () => {
    let calls = 0;
    const { sup, closed } = setup(() => (ctx, h) => ({
      platform: ctx.platform,
      status: () => "offline",
      async connect() {
        calls++;
        h.onStatus({ status: "offline", at: new Date(), detail: "no está en directo" });
      },
      async disconnect() {},
    }));
    await sup.start(spec("o"));
    await until(() => calls >= 3);
    expect(sup.get("o")?.attempts).toBe(0);
    expect(closed.length).toBeGreaterThan(0);
    await sup.shutdown();
  });

  test("rate_limited respeta el retardo indicado por el adaptador", async () => {
    const times: number[] = [];
    const { sup } = setup(() => (ctx, h) => ({
      platform: ctx.platform,
      status: () => "rate_limited",
      async connect() {
        times.push(Date.now());
        h.onStatus({ status: "rate_limited", at: new Date(), retryInMs: 120 });
      },
      async disconnect() {},
    }));
    await sup.start(spec("r"));
    await until(() => times.length >= 2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(110);
    expect(sup.get("r")?.status).toBe("rate_limited");
    await sup.shutdown();
  });

  test("rate limit global: una conexión limitada pausa las nuevas de la misma plataforma", async () => {
    const starts: Record<string, number> = {};
    const { sup } = setup(
      (s) => (ctx, h) => ({
        platform: ctx.platform,
        status: () => "live",
        async connect() {
          starts[s.id] = Date.now();
          if (s.id === "limited") h.onStatus({ status: "rate_limited", at: new Date(), retryInMs: 200 });
          else h.onStatus({ status: "live", at: new Date() });
        },
        async disconnect() {},
      }),
      { connectConcurrency: { tiktok: 1 } },
    );
    await sup.start(spec("limited", "t1"));
    await until(() => sup.stats().rateLimitHits === 1);
    const t0 = Date.now();
    await sup.start(spec("other", "t2"));
    await until(() => sup.get("other")?.status === "live");
    expect(starts.other! - t0).toBeGreaterThanOrEqual(120);
    expect(sup.stats().rateLimitHits).toBeGreaterThanOrEqual(1);
    await sup.shutdown();
  });

  test("concurrencia de connect() limitada por plataforma, con cola", async () => {
    let active = 0;
    let maxActive = 0;
    const { sup } = setup(
      () => (ctx, h) => ({
        platform: ctx.platform,
        status: () => "live",
        async connect() {
          active++;
          maxActive = Math.max(maxActive, active);
          await sleep(40);
          active--;
          h.onStatus({ status: "live", at: new Date() });
        },
        async disconnect() {},
      }),
      { connectConcurrency: { tiktok: 2 } },
    );
    for (let i = 0; i < 6; i++) await sup.start(spec(`c${i}`, `t${i}`));
    await sleep(10);
    expect(sup.stats().queued).toBeGreaterThan(0);
    await until(() => [0, 1, 2, 3, 4, 5].every((i) => sup.get(`c${i}`)?.status === "live"));
    expect(maxActive).toBe(2);
    await sup.shutdown();
  });

  test("stop cancela reintentos pendientes y desconecta", async () => {
    let calls = 0;
    let disconnected = 0;
    const { sup } = setup(() => (ctx) => ({
      platform: ctx.platform,
      status: () => "error",
      async connect() {
        calls++;
        throw new Error("x");
      },
      async disconnect() {
        disconnected++;
      },
    }));
    await sup.start(spec("s"));
    await until(() => calls >= 2);
    await sup.stop("s");
    const n = calls;
    await sleep(120);
    expect(calls).toBe(n);
    expect(disconnected).toBeGreaterThan(0);
    expect(sup.get("s")).toBeUndefined();
  });

  test("ignora eventos tardíos de un adaptador ya reemplazado", async () => {
    const handlersByAttempt: AdapterHandlers[] = [];
    const { sup, events } = setup(() => (ctx, h) => {
      handlersByAttempt.push(h);
      return {
        platform: ctx.platform,
        status: () => "live",
        async connect() {
          h.onStatus({ status: "live", at: new Date() });
        },
        async disconnect() {},
      };
    });
    await sup.start(spec("g"));
    await until(() => sup.get("g")?.status === "live");
    await sup.start(spec("g")); // reinicio: el adaptador viejo queda obsoleto
    await until(() => handlersByAttempt.length === 2);
    handlersByAttempt[0]!.onEvent(chat(spec("g")));
    handlersByAttempt[1]!.onEvent(chat(spec("g")));
    expect(events).toHaveLength(1);
    await sup.shutdown();
  });

  test("sin factoría para la conexión devuelve false", async () => {
    const { sup } = setup(() => undefined);
    expect(await sup.start(spec("n"))).toBe(false);
  });

  test("publica cambios de estado en el bus del tenant", async () => {
    const { sup, bus } = setup(() => (ctx, h) => ({
      platform: ctx.platform,
      status: () => "live",
      async connect() {
        h.onStatus({ status: "live", at: new Date() } satisfies StatusChange);
      },
      async disconnect() {},
    }));
    const seen: string[] = [];
    bus.subscribe("t1", (m) => m.kind === "status" && seen.push(m.change.status));
    const other: string[] = [];
    bus.subscribe("t2", (m) => other.push(m.kind));
    await sup.start(spec("b"));
    await until(() => seen.includes("live"));
    expect(seen[0]).toBe("connecting");
    expect(other).toEqual([]);
    await sup.shutdown();
  });
});
