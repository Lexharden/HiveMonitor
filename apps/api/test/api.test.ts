import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema, withTenant } from "@hivemonitor/db";
import { createTestEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let ownerA: string;
let ownerB: string;
let orgA: string;
let orgB: string;

async function createOrg(token: string, name: string, slug: string): Promise<string> {
  const res = await env.call(token, "POST", "/api/auth/organization/create", { name, slug });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

beforeAll(async () => {
  env = await createTestEnv();
  ownerA = await env.signUp("owner-a@test.dev");
  ownerB = await env.signUp("owner-b@test.dev");
  orgA = await createOrg(ownerA, "Org A", "org-a");
  orgB = await createOrg(ownerB, "Org B", "org-b");
  await withTenant(env.app.db, orgA, (tx) =>
    tx.insert(schema.platformConnection).values({ id: "ca", tenantId: orgA, platform: "tiktok", channelId: "chan_a" }),
  );
  await withTenant(env.app.db, orgB, (tx) =>
    tx.insert(schema.platformConnection).values({ id: "cb", tenantId: orgB, platform: "twitch", channelId: "chan_b" }),
  );
}, 180_000);

afterAll(async () => {
  await env?.stop();
});

describe("salud", () => {
  test("healthz y readyz", async () => {
    expect((await env.call(null, "GET", "/healthz")).status).toBe(200);
    const r = await env.call(null, "GET", "/readyz");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { checks: { db: boolean } }).checks.db).toBe(true);
  });
  test("cabeceras de seguridad", async () => {
    const r = await env.call(null, "GET", "/healthz");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("autenticación", () => {
  test("sin token no hay acceso", async () => {
    expect((await env.call(null, "GET", "/api/me")).status).toBe(401);
    expect((await env.call(null, "GET", `/api/t/${orgA}/connections`)).status).toBe(401);
  });
  test("el creador de la organización es owner con sus permisos", async () => {
    const me = (await (await env.call(ownerA, "GET", "/api/me")).json()) as {
      organizations: { id: string; role: string; permissions: string[] }[];
    };
    expect(me.organizations).toHaveLength(1);
    const o = me.organizations[0]!;
    expect(o.role).toBe("owner");
    expect(o.permissions).toContain("org.manage");
    expect(o.permissions).not.toContain("system.admin");
  });
  test("la creación de la organización genera tenant_settings y auditoría", async () => {
    const [s] = await env.admin.db.select().from(schema.tenantSettings).where(eq(schema.tenantSettings.tenantId, orgA));
    expect(s?.suspended).toBe(false);
    const audit = await env.admin.db.select().from(schema.auditLog).where(eq(schema.auditLog.tenantId, orgA));
    expect(audit.map((a) => a.action)).toContain("org.create");
  });
  test("el usuario no puede autoasignarse superadmin al registrarse", async () => {
    const res = await env.call(null, "POST", "/api/auth/sign-up/email", {
      email: "sneaky@test.dev",
      name: "s",
      password: "correct-horse-battery",
      isSuperadmin: true,
    });
    const token = res.headers.get("set-auth-token")!;
    const me = (await (await env.call(token, "GET", "/api/me")).json()) as { user: { isSuperadmin: boolean } };
    expect(me.user.isSuperadmin).toBe(false);
    expect((await env.call(token, "GET", "/api/admin/tenants")).status).toBe(403);
  });
});

describe("aislamiento por HTTP", () => {
  test("cada owner ve solo las conexiones de su tenant", async () => {
    const a = (await (await env.call(ownerA, "GET", `/api/t/${orgA}/connections`)).json()) as {
      connections: { id: string }[];
    };
    expect(a.connections.map((c) => c.id)).toEqual(["ca"]);
  });
  test("un usuario no puede acceder a un tenant ajeno (404, sin revelar existencia)", async () => {
    expect((await env.call(ownerA, "GET", `/api/t/${orgB}/connections`)).status).toBe(404);
    expect((await env.call(ownerA, "GET", `/api/t/${orgB}/audit`)).status).toBe(404);
    expect((await env.call(ownerA, "GET", `/api/t/inexistente/connections`)).status).toBe(404);
  });
});

describe("roles y permisos", () => {
  let analystToken: string;
  let modToken: string;

  async function invite(role: string, email: string, token: string) {
    const res = await env.call(ownerA, "POST", "/api/auth/organization/invite-member", {
      email,
      role,
      organizationId: orgA,
    });
    expect(res.status).toBe(200);
    const id = ((await res.json()) as { id: string }).id;
    const acc = await env.call(token, "POST", "/api/auth/organization/accept-invitation", { invitationId: id });
    expect(acc.status).toBe(200);
  }

  test("invitar con rol y aceptar", async () => {
    analystToken = await env.signUp("analyst@test.dev");
    modToken = await env.signUp("mod@test.dev");
    await invite("analyst", "analyst@test.dev", analystToken);
    await invite("moderator", "mod@test.dev", modToken);
    expect(env.invitations.map((i) => i.role).sort()).toEqual(["analyst", "moderator"]);
  });

  test("el analista ve el stream pero no la auditoría", async () => {
    expect((await env.call(analystToken, "GET", `/api/t/${orgA}/connections`)).status).toBe(200);
    expect((await env.call(analystToken, "GET", `/api/t/${orgA}/audit`)).status).toBe(403);
  });

  test("el moderador no puede gestionar miembros; /api/me expone permisos, no solo el rol", async () => {
    expect((await env.call(modToken, "GET", `/api/t/${orgA}/audit`)).status).toBe(403);
    const me = (await (await env.call(modToken, "GET", "/api/me")).json()) as {
      organizations: { permissions: string[] }[];
    };
    const perms = me.organizations[0]!.permissions;
    expect(perms).toContain("chat.moderate");
    expect(perms).not.toContain("analytics.view");
  });

  test("el analista no puede invitar miembros ni borrar la organización", async () => {
    const inv = await env.call(analystToken, "POST", "/api/auth/organization/invite-member", {
      email: "x@test.dev",
      role: "admin",
      organizationId: orgA,
    });
    expect(inv.status).toBeGreaterThanOrEqual(400);
    const del = await env.call(analystToken, "POST", "/api/auth/organization/delete", { organizationId: orgA });
    expect(del.status).toBeGreaterThanOrEqual(400);
  });

  test("un rol personalizado del tenant se aplica y no puede dar system.admin", async () => {
    await withTenant(env.app.db, orgA, (tx) =>
      tx.insert(schema.roleDefinition).values({
        id: "r1",
        tenantId: orgA,
        key: "viewer-audit",
        name: "Auditor",
        permissions: ["stream.view", "members.manage", "system.admin"],
      }),
    );
    await env.admin.db
      .update(schema.member)
      .set({ role: "viewer-audit" })
      .where(eq(schema.member.userId, (await env.admin.db.select().from(schema.user).where(eq(schema.user.email, "analyst@test.dev")))[0]!.id));
    expect((await env.call(analystToken, "GET", `/api/t/${orgA}/audit`)).status).toBe(200);
    const me = (await (await env.call(analystToken, "GET", "/api/me")).json()) as {
      organizations: { permissions: string[] }[];
    };
    expect(me.organizations[0]!.permissions).not.toContain("system.admin");
  });
});

describe("superadmin", () => {
  test("lista tenants y puede suspender; el suspendido queda bloqueado", async () => {
    const adminToken = await env.signUp("root@test.dev");
    await env.admin.db.update(schema.user).set({ isSuperadmin: true }).where(eq(schema.user.email, "root@test.dev"));

    const list = (await (await env.call(adminToken, "GET", "/api/admin/tenants")).json()) as { tenants: { id: string }[] };
    expect(list.tenants.map((t) => t.id).sort()).toEqual([orgA, orgB].sort());

    expect((await env.call(ownerB, "GET", `/api/t/${orgB}/connections`)).status).toBe(200);
    expect((await env.call(adminToken, "PATCH", `/api/admin/tenants/${orgB}`, { suspended: true })).status).toBe(200);
    expect((await env.call(ownerB, "GET", `/api/t/${orgB}/connections`)).status).toBe(403);
    // el superadmin sigue pudiendo entrar
    expect((await env.call(adminToken, "GET", `/api/t/${orgB}/connections`)).status).toBe(200);

    const audit = await env.admin.db.select().from(schema.auditLog).where(eq(schema.auditLog.tenantId, orgB));
    expect(audit.map((a) => a.action)).toContain("tenant.admin_update");
  });

  test("un owner normal no accede a la vista superadmin", async () => {
    expect((await env.call(ownerA, "GET", "/api/admin/tenants")).status).toBe(403);
  });
});

describe("CSRF y CORS", () => {
  test("una petición con cookie y origen no permitido se rechaza", async () => {
    const res = await env.http.request("/api/admin/tenants/x", {
      method: "PATCH",
      headers: { cookie: "better-auth.session_token=abc", origin: "https://evil.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });
  test("CORS permite el origen de Tauri configurado y no otros", async () => {
    const ok = await env.http.request("/api/meta/roles", { headers: { origin: "http://tauri.localhost" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost");
    const bad = await env.http.request("/api/meta/roles", { headers: { origin: "https://evil.example" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });
});
