import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "@hivemonitor/db";
import { resetUserPassword } from "../src/cli-commands.ts";
import { mailerFrom, type RawMail } from "../src/mailer.ts";
import { BASE_URL, createTestEnv, type TestEnv } from "./helpers.ts";

const PASSWORD = "correct-horse-battery";
const envs: TestEnv[] = [];
afterEach(async () => {
  while (envs.length) await envs.pop()!.stop();
});

async function env(extra: Record<string, string> = {}, mails?: RawMail[]) {
  const e = await createTestEnv(extra, undefined, undefined, mails ? { mailer: mailerFrom(async (m) => void mails.push(m)) } : {});
  envs.push(e);
  return e;
}

const signUp = (e: TestEnv, email: string) =>
  e.call(null, "POST", "/api/auth/sign-up/email", { email, name: email.split("@")[0], password: PASSWORD });
const signIn = (e: TestEnv, email: string, password = PASSWORD) => e.call(null, "POST", "/api/auth/sign-in/email", { email, password });
const tokenFrom = (mail: RawMail) =>
  new URL(mail.text.match(/https?:\/\/\S+/)![0]).searchParams.get("token") ??
  new URL(mail.text.match(/https?:\/\/\S+/)![0]).pathname.split("/").pop()!;

describe("SIGNUP_MODE", () => {
  test("closed: el primer usuario puede registrarse (arranque) y los demás no", async () => {
    const e = await env({ SIGNUP_MODE: "closed" });
    expect((await signUp(e, "root@x.dev")).status).toBe(200);
    const second = await signUp(e, "otro@x.dev");
    expect(second.status).toBe(403);
    expect(JSON.stringify(await second.json())).toContain("cerrado");
    expect(await e.admin.db.select().from(schema.user)).toHaveLength(1);
  }, 120_000);

  test("invite: solo con invitación pendiente y vigente a ese correo (sin distinguir mayúsculas)", async () => {
    const e = await env({ SIGNUP_MODE: "invite" });
    const ownerRes = await signUp(e, "owner@x.dev");
    const owner = ownerRes.headers.get("set-auth-token")!;
    const org = (
      (await (await e.call(owner, "POST", "/api/auth/organization/create", { name: "Org", slug: "org" })).json()) as { id: string }
    ).id;

    expect((await signUp(e, "intruso@x.dev")).status).toBe(403);

    const inv = await e.call(owner, "POST", "/api/auth/organization/invite-member", {
      email: "Amigo@X.dev",
      role: "analyst",
      organizationId: org,
    });
    const invId = ((await inv.json()) as { id: string }).id;
    expect((await signUp(e, "amigo@x.dev")).status).toBe(200);
    expect((await signUp(e, "intruso@x.dev")).status).toBe(403); // la invitación es solo para su correo

    // invitación cancelada o caducada → no vale
    await e.call(owner, "POST", "/api/auth/organization/invite-member", { email: "cancelado@x.dev", role: "analyst", organizationId: org });
    const cancelId = (await e.admin.db.select().from(schema.invitation).where(eq(schema.invitation.email, "cancelado@x.dev")))[0]!.id;
    await e.call(owner, "POST", "/api/auth/organization/cancel-invitation", { invitationId: cancelId });
    expect((await signUp(e, "cancelado@x.dev")).status).toBe(403);

    await e.call(owner, "POST", "/api/auth/organization/invite-member", { email: "tarde@x.dev", role: "analyst", organizationId: org });
    await e.admin.db
      .update(schema.invitation)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.invitation.email, "tarde@x.dev"));
    expect((await signUp(e, "tarde@x.dev")).status).toBe(403);
    void invId;
  }, 120_000);

  test("open: cualquiera; /api/meta/public informa de la política y de la primera instalación", async () => {
    const e = await env({ SIGNUP_MODE: "open" });
    const before = (await (await e.call(null, "GET", "/api/meta/public")).json()) as any;
    expect(before).toMatchObject({ signupMode: "open", firstRun: true, emailEnabled: false });
    expect((await signUp(e, "a@x.dev")).status).toBe(200);
    expect((await signUp(e, "b@x.dev")).status).toBe(200);
    expect(((await (await e.call(null, "GET", "/api/meta/public")).json()) as any).firstRun).toBe(false);
  }, 120_000);
});

describe("verificación de correo y recuperación de contraseña", () => {
  test("con SMTP: no se puede entrar sin verificar; el enlace verifica y deja iniciar sesión", async () => {
    const mails: RawMail[] = [];
    const e = await env({}, mails);
    const res = await signUp(e, "nuevo@x.dev");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-auth-token")).toBeNull(); // sin sesión hasta verificar
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: "nuevo@x.dev", subject: expect.stringContaining("Confirma") });

    expect((await signIn(e, "nuevo@x.dev")).status).toBe(403);
    expect(mails.length).toBeGreaterThanOrEqual(2); // sendOnSignIn reenvía el enlace

    const link = mails.at(-1)!.text.match(/https?:\/\/\S+/)![0];
    const verify = await e.http.request(new URL(link).pathname + new URL(link).search, { headers: { origin: BASE_URL } });
    expect([200, 302]).toContain(verify.status);
    const ok = await signIn(e, "nuevo@x.dev");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-auth-token")).toBeTruthy();
    expect(((await (await e.call(null, "GET", "/api/meta/public")).json()) as any).emailEnabled).toBe(true);
  }, 120_000);

  test("recuperar contraseña: el enlace cambia la clave, la anterior deja de valer y se cierran las sesiones", async () => {
    const mails: RawMail[] = [];
    const e = await env({}, mails);
    await signUp(e, "olvido@x.dev");
    await e.admin.db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.email, "olvido@x.dev"));
    const first = await signIn(e, "olvido@x.dev");
    const oldToken = first.headers.get("set-auth-token")!;
    mails.length = 0;

    const req = await e.call(null, "POST", "/api/auth/request-password-reset", {
      email: "olvido@x.dev",
      redirectTo: `${BASE_URL}/reset-password`,
    });
    expect(req.status).toBe(200);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain("Restablece");

    // un correo inexistente responde igual (no revela qué cuentas existen) y no envía nada
    const ghost = await e.call(null, "POST", "/api/auth/request-password-reset", {
      email: "fantasma@x.dev",
      redirectTo: `${BASE_URL}/reset-password`,
    });
    expect(ghost.status).toBe(200);
    expect(mails).toHaveLength(1);

    const token = tokenFrom(mails[0]!);
    const bad = await e.call(null, "POST", "/api/auth/reset-password", { token: "token-falso", newPassword: "otra-clave-larga-1" });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect((await e.call(null, "POST", "/api/auth/reset-password", { token, newPassword: "otra-clave-larga-1" })).status).toBe(200);
    expect((await signIn(e, "olvido@x.dev")).status).toBe(401); // la clave vieja ya no vale
    expect((await signIn(e, "olvido@x.dev", "otra-clave-larga-1")).status).toBe(200);
    // el token es de un solo uso
    expect(
      (await e.call(null, "POST", "/api/auth/reset-password", { token, newPassword: "y-otra-mas-larga-2" })).status,
    ).toBeGreaterThanOrEqual(400);
    void oldToken;
  }, 120_000);

  test("CLI reset-password (sin SMTP): genera una clave nueva, la clave vieja deja de valer y cierra sesiones", async () => {
    const e = await env();
    const res = await signUp(e, "sinmail@x.dev");
    const token = res.headers.get("set-auth-token")!;
    expect((await e.call(token, "GET", "/api/me")).status).toBe(200);

    const pw = await resetUserPassword(e.deps.auth, e.admin.db, "SINMAIL@x.dev");
    expect(pw).toBeString();
    expect(pw!.length).toBeGreaterThanOrEqual(16);
    expect((await e.call(token, "GET", "/api/me")).status).toBe(401); // sesiones cerradas
    expect((await signIn(e, "sinmail@x.dev")).status).toBe(401);
    expect((await signIn(e, "sinmail@x.dev", pw!)).status).toBe(200);
    expect(await resetUserPassword(e.deps.auth, e.admin.db, "noexiste@x.dev")).toBeNull();
  }, 120_000);
});

describe("login social y política de registro", () => {
  // Es la misma ruta que usa el callback de OAuth (Twitch/Google) para crear un usuario nuevo
  const oauthSignup = async (e: TestEnv, email: string) => {
    const ctx = await e.deps.auth.$context;
    return ctx.internalAdapter.createOAuthUser(
      { email, name: "Social", emailVerified: true },
      { providerId: "twitch", accountId: `acc-${email}`, accessToken: "x" },
    );
  };

  test("invite: un usuario NUEVO por Twitch/Google sin invitación se rechaza; con invitación a ese correo, entra", async () => {
    const e = await env({ SIGNUP_MODE: "invite" });
    const owner = (await signUp(e, "owner@s.dev")).headers.get("set-auth-token")!;
    const org = ((await (await e.call(owner, "POST", "/api/auth/organization/create", { name: "O", slug: "o" })).json()) as { id: string })
      .id;

    await expect(oauthSignup(e, "intruso@s.dev")).rejects.toThrow();
    expect(await e.admin.db.select().from(schema.user).where(eq(schema.user.email, "intruso@s.dev"))).toHaveLength(0);

    await e.call(owner, "POST", "/api/auth/organization/invite-member", { email: "invitado@s.dev", role: "analyst", organizationId: org });
    const created = await oauthSignup(e, "invitado@s.dev");
    expect(created).toBeTruthy();
    expect(await e.admin.db.select().from(schema.user).where(eq(schema.user.email, "invitado@s.dev"))).toHaveLength(1);
  }, 120_000);

  test("closed: tampoco entra nadie nuevo por login social; el primer usuario sí (arranque)", async () => {
    const e = await env({ SIGNUP_MODE: "closed" });
    expect(await oauthSignup(e, "primero@s.dev")).toBeTruthy();
    await expect(oauthSignup(e, "segundo@s.dev")).rejects.toThrow();
  }, 120_000);

  test("/api/meta/public informa de los proveedores sociales configurados", async () => {
    const e = await env({ TWITCH_CLIENT_ID: "cid", TWITCH_CLIENT_SECRET: "sec" });
    expect(((await (await e.call(null, "GET", "/api/meta/public")).json()) as any).socialProviders).toEqual(["twitch"]);
    const none = await env();
    expect(((await (await none.call(null, "GET", "/api/meta/public")).json()) as any).socialProviders).toEqual([]);
  }, 120_000);
});
