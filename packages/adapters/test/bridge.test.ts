import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { NormalizedEvent, StatusChange } from "@hivemonitor/core";
import { createBridgeClientFactory, createTikTokAdapterFactory } from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Proceso falso: el test escribe líneas en `stdout` y decide cuándo "muere". */
function fakeProc() {
  const p = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    killed: false,
    kill() {
      p.killed = true;
      setTimeout(() => p.emit("close", null), 0);
      return true;
    },
  });
  return p;
}

function setup() {
  const proc = fakeProc();
  const spawned: { cmd: string; args: string[] }[] = [];
  const events: NormalizedEvent[] = [];
  const statuses: StatusChange[] = [];
  const adapter = createTikTokAdapterFactory({
    clientFactory: createBridgeClientFactory({
      bridgePath: "/ruta/tiktok-bridge",
      maxRetries: 2,
      proxy: "socks5://p:1",
      spawn: (cmd, args) => (spawned.push({ cmd, args }), proc as never),
    }),
  })({ tenantId: "t1", platform: "tiktok", channelId: "@streamer" }, { onEvent: (e) => events.push(e), onStatus: (s) => statuses.push(s) });
  const send = (o: object) => proc.stdout.write(JSON.stringify(o) + "\n");
  return { proc, spawned, events, statuses, adapter, send };
}

const user = { id: "42", name: "Ana", handle: "ana", avatar: "https://img/a.png" };

describe("puente de TikTok (piratetok-live-rs)", () => {
  test("lanza el puente con el usuario sin @ y las opciones; conecta al recibir 'connected'", async () => {
    const s = setup();
    const connecting = s.adapter.connect();
    await sleep(5);
    s.send({ t: "connected", roomId: "123" });
    await connecting;
    expect(s.spawned[0]).toEqual({ cmd: "/ruta/tiktok-bridge", args: ["streamer", "--max-retries", "2", "--proxy", "socks5://p:1"] });
    expect(s.statuses.map((x) => x.status)).toEqual(["connecting", "live"]);
    await s.adapter.disconnect();
  });

  test("traduce chat, regalo (racha ya agregada), likes, follow, share y viewers a eventos normalizados", async () => {
    const s = setup();
    const c = s.adapter.connect();
    await sleep(5);
    s.send({ t: "connected", roomId: "1" });
    await c;
    s.send({ t: "chat", id: "m1", user, text: "hola" });
    s.send({ t: "gift", id: "g1", user, name: "Rose", count: 3, diamonds: 15 });
    s.send({ t: "like", id: "l1", user, count: 7 });
    s.send({ t: "follow", id: "f1", user });
    s.send({ t: "share", id: "s1", user });
    s.send({ t: "viewers", count: 250 });
    proc_noise(s);
    await sleep(30);

    const byType = (t: string) => s.events.filter((e) => e.type === t);
    expect(byType("chat")[0]).toMatchObject({
      actor: { id: "42", name: "Ana", avatar: "https://img/a.png" },
      payload: { message: "hola", messageId: "m1" },
    });
    const gift = byType("donation")[0]!;
    expect(gift.type === "donation" && gift.payload).toMatchObject({
      giftName: "Rose",
      count: 3,
      amountMinor: 15,
      currency: "TIKTOK_COIN",
    });
    expect(byType("like")[0]).toMatchObject({ payload: { count: 7 } });
    expect(byType("follow")).toHaveLength(1);
    expect(byType("share")).toHaveLength(1);
    expect(byType("viewer_count")[0]).toMatchObject({ payload: { viewers: 250 } });
    await s.adapter.disconnect();
  });

  test("errores de arranque: sin directo → offline; usuario inexistente y bloqueo → estados correctos", async () => {
    for (const [kind, expected] of [
      ["offline", "offline"],
      ["not_found", "error"],
      ["blocked", "rate_limited"],
    ] as const) {
      const s = setup();
      const c = s.adapter.connect();
      await sleep(5);
      s.send({ t: "error", kind, message: "x" });
      s.proc.emit("close", kind === "offline" ? 10 : 1);
      await c;
      expect(s.statuses.at(-1)?.status).toBe(expected);
    }
  });

  test("el código de salida también se traduce si el puente muere sin mensaje", async () => {
    const s = setup();
    const c = s.adapter.connect();
    await sleep(5);
    s.proc.emit("close", 12);
    await c;
    expect(s.statuses.at(-1)).toMatchObject({ status: "rate_limited" });
  });

  test("caída del proceso tras conectar → error; fin de directo → stream_end + offline sin error", async () => {
    const a = setup();
    const c1 = a.adapter.connect();
    await sleep(5);
    a.send({ t: "connected", roomId: "1" });
    await c1;
    a.proc.emit("close", 20);
    expect(a.statuses.at(-1)?.status).toBe("error");

    const b = setup();
    const c2 = b.adapter.connect();
    await sleep(5);
    b.send({ t: "connected", roomId: "1" });
    await c2;
    b.send({ t: "ended" });
    await sleep(20);
    b.proc.emit("close", 0);
    expect(b.events.map((e) => e.type)).toContain("stream_end");
    expect(b.statuses.at(-1)?.status).toBe("offline");
  });

  test("disconnect() cierra stdin, mata el proceso y no lo trata como caída", async () => {
    const s = setup();
    const c = s.adapter.connect();
    await sleep(5);
    s.send({ t: "connected", roomId: "1" });
    await c;
    let stdinClosed = false;
    s.proc.stdin.on("finish", () => (stdinClosed = true));
    await s.adapter.disconnect();
    expect(s.proc.killed).toBe(true);
    expect(stdinClosed).toBe(true);
    expect(s.statuses.filter((x) => x.status === "error")).toHaveLength(0);
  });

  test("binario inexistente → error claro, sin colgarse", async () => {
    const events: StatusChange[] = [];
    const adapter = createTikTokAdapterFactory({ clientFactory: createBridgeClientFactory({ bridgePath: "/no/existe/tiktok-bridge" }) })(
      { tenantId: "t", platform: "tiktok", channelId: "x" },
      { onEvent: () => {}, onStatus: (s) => events.push(s) },
    );
    await adapter.connect();
    expect(events.at(-1)).toMatchObject({ status: "error" });
    expect(events.at(-1)?.detail).toContain("tiktok-bridge");
  });
});

/** Línea que no es JSON: se ignora. */
function proc_noise(s: ReturnType<typeof setup>) {
  s.proc.stdout.write("esto no es json\n");
}

// Extremo a extremo con el binario real y TikTok real (solo si está compilado): un usuario inexistente
// debe terminar en error sin colgar. No requiere que haya ningún directo activo.
const exe = join(
  import.meta.dir,
  "../../../apps/tiktok-bridge/target/release",
  process.platform === "win32" ? "tiktok-bridge.exe" : "tiktok-bridge",
);
describe.skipIf(!existsSync(exe))("puente real (binario compilado)", () => {
  test("usuario inexistente → InvalidUniqueId → estado error", async () => {
    const statuses: StatusChange[] = [];
    const adapter = createTikTokAdapterFactory({ clientFactory: createBridgeClientFactory({ bridgePath: exe }) })(
      { tenantId: "t", platform: "tiktok", channelId: "usuario_que_no_existe_zzqq_998877" },
      { onEvent: () => {}, onStatus: (s) => statuses.push(s) },
    );
    await adapter.connect();
    expect(statuses.at(-1)?.status).toBe("error");
    await adapter.disconnect();
  }, 30_000);
});
