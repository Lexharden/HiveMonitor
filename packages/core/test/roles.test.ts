import { describe, expect, test } from "bun:test";
import { PERMISSIONS, resolvePermissions, SYSTEM_ROLES, parseEvent } from "../src/index.ts";

describe("roles y permisos", () => {
  test("owner tiene todo salvo system.admin", () => {
    const p = resolvePermissions("owner");
    expect(p.has("org.manage")).toBe(true);
    expect(p.has("system.admin")).toBe(false);
  });
  test("admin no tiene org.manage", () => {
    const p = resolvePermissions("admin");
    expect(p.has("org.manage")).toBe(false);
    expect(p.has("members.manage")).toBe(true);
  });
  test("moderador y analista", () => {
    expect([...resolvePermissions("moderator")].sort()).toEqual([...SYSTEM_ROLES.moderator].sort());
    const a = resolvePermissions("analyst");
    expect(a.has("chat.view")).toBe(false);
    expect(a.has("analytics.view")).toBe(true);
  });
  test("rol desconocido no concede nada; superadmin todo", () => {
    expect(resolvePermissions("hacker").size).toBe(0);
    expect(resolvePermissions("hacker", [], true).size).toBe(PERMISSIONS.length);
  });
  test("rol personalizado no puede otorgar system.admin", () => {
    const p = resolvePermissions("custom", [{ key: "custom", permissions: ["chat.view", "system.admin", "nope"] }]);
    expect([...p]).toEqual(["chat.view"]);
  });
});

describe("evento normalizado", () => {
  const base = {
    id: "1",
    tenantId: "t",
    platform: "tiktok",
    channelId: "c",
    occurredAt: "2026-01-01T00:00:00Z",
    actor: { id: "u", name: "n" },
  };
  test("valida donación y aplica defaults", () => {
    const e = parseEvent({ ...base, type: "donation", payload: { kind: "gift", amountMinor: 5, currency: "TIKTOK_COIN" } });
    expect(e.type === "donation" && e.payload.count).toBe(1);
  });
  test("rechaza payload inválido y tipo desconocido", () => {
    expect(() => parseEvent({ ...base, type: "donation", payload: { kind: "gift" } })).toThrow();
    expect(() => parseEvent({ ...base, type: "xyz", payload: {} })).toThrow();
  });
});
