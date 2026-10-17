import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createEncryptor, parseKey } from "../src/crypto.ts";
import { clientIp, ipInList } from "../src/net.ts";
import { InProcessBus } from "../src/bus/in-process.ts";
import { loadConfig } from "../src/config.ts";

describe("cifrado AES-256-GCM", () => {
  const k1 = randomBytes(32);
  const enc = createEncryptor(new Map([[1, k1]]));
  test("ida y vuelta", () => {
    const blob = enc.encrypt("secreto ñ 🔐");
    expect(enc.decrypt(blob)).toBe("secreto ñ 🔐");
  });
  test("nonce aleatorio: dos cifrados del mismo texto difieren", () => {
    expect(Buffer.from(enc.encrypt("a")).equals(Buffer.from(enc.encrypt("a")))).toBe(false);
  });
  test("detecta manipulación", () => {
    const blob = Buffer.from(enc.encrypt("hola"));
    blob[blob.length - 1]! ^= 1;
    expect(() => enc.decrypt(blob)).toThrow();
  });
  test("rotación: datos viejos se leen con su versión de clave", () => {
    const old = enc.encrypt("viejo");
    const rotated = createEncryptor(
      new Map([
        [1, k1],
        [2, randomBytes(32)],
      ]),
    );
    expect(rotated.keyVersion).toBe(2);
    expect(rotated.decrypt(old)).toBe("viejo");
  });
  test("rechaza claves de longitud incorrecta", () => {
    expect(() => parseKey(Buffer.alloc(16).toString("base64"))).toThrow();
  });
});

describe("IP de cliente y proxies de confianza", () => {
  const trusted = ["10.0.0.0/8", "127.0.0.1"];
  test("CIDR e IPs exactas", () => {
    expect(ipInList("10.2.3.4", trusted)).toBe(true);
    expect(ipInList("::ffff:127.0.0.1", trusted)).toBe(true);
    expect(ipInList("11.0.0.1", trusted)).toBe(false);
  });
  test("ignora X-Forwarded-For si la conexión no viene de un proxy de confianza", () => {
    expect(clientIp("8.8.8.8", "1.2.3.4", trusted)).toBe("8.8.8.8");
  });
  test("toma la primera IP no confiable de derecha a izquierda (anti-spoof)", () => {
    expect(clientIp("10.0.0.5", "6.6.6.6, 203.0.113.9, 10.0.0.2", trusted)).toBe("203.0.113.9");
  });
});

describe("bus en proceso", () => {
  const msg = (tenantId: string) =>
    ({ kind: "status", tenantId, platform: "tiktok", channelId: "c", change: { status: "live", at: new Date() } }) as const;
  test("entrega solo al tenant suscrito y un handler roto no afecta a otros", () => {
    const errors: unknown[] = [];
    const bus = new InProcessBus((e) => errors.push(e));
    const a: string[] = [];
    const b: string[] = [];
    bus.subscribe("A", () => {
      throw new Error("boom");
    });
    bus.subscribe("A", (m) => a.push(m.tenantId));
    bus.subscribe("B", (m) => b.push(m.tenantId));
    bus.publish(msg("A"));
    expect(a).toEqual(["A"]);
    expect(b).toEqual([]);
    expect(errors).toHaveLength(1);
  });
  test("unsubscribe", () => {
    const bus = new InProcessBus();
    let n = 0;
    const off = bus.subscribe("A", () => n++);
    bus.publish(msg("A"));
    off();
    bus.publish(msg("A"));
    expect(n).toBe(1);
    expect(bus.subscriberCount()).toBe(0);
  });
});

describe("configuración", () => {
  const base = { DATABASE_URL: "postgres://x", BETTER_AUTH_SECRET: "x".repeat(32), ENCRYPTION_KEY: "k" };
  test("defaults y listas CSV", () => {
    const c = loadConfig({ ...base, CORS_ORIGINS: "http://a, http://b ,", AUTO_MIGRATE: "false" });
    expect(c.PORT).toBe(3000);
    expect(c.CORS_ORIGINS).toEqual(["http://a", "http://b"]);
    expect(c.TRUSTED_PROXIES).toEqual([]);
    expect(c.AUTO_MIGRATE).toBe(false);
  });
  test("falla con mensaje claro si falta algo obligatorio", () => {
    expect(() => loadConfig({ DATABASE_URL: "x" })).toThrow(/BETTER_AUTH_SECRET/);
  });
});
