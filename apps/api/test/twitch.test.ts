import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import type { TwitchCredentials } from "@hivemonitor/adapters";
import { schema, withTenant } from "@hivemonitor/db";
import { verifyTwitchSignature } from "../src/twitch/conduit.ts";
import { signState, verifyState } from "../src/twitch/oauth.ts";
import { BASE_URL, createTestEnv, type TestEnv } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Twitch falso -------------------------------------------------------------
const twitch = {
  calls: [] as { method: string; url: string; body?: any }[],
  live: false,
  refreshRevoked: false,
  shardErrors: false,
  nextSub: 0,
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

async function fakeTwitch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const method = init?.method ?? "GET";
  const body = init?.body
    ? init.body instanceof URLSearchParams
      ? Object.fromEntries(init.body)
      : JSON.parse(String(init.body))
    : undefined;
  twitch.calls.push({ method, url: url.pathname + url.search, body });

  if (url.host === "id.twitch.tv") {
    if (url.pathname.endsWith("/token")) {
      if (body.grant_type === "authorization_code") {
        return json({
          access_token: "ACCESS1",
          refresh_token: "REFRESH1",
          expires_in: 3600,
          scope: [
            "user:read:chat",
            "channel:read:subscriptions",
            "bits:read",
            "moderator:read:followers",
            "moderator:manage:banned_users",
            "moderator:manage:chat_messages",
          ],
        });
      }
      if (body.grant_type === "client_credentials") return json({ access_token: "APPTOKEN", expires_in: 3600 });
      if (body.grant_type === "refresh_token") {
        if (twitch.refreshRevoked) return json({ message: "Invalid refresh token" }, 400);
        return json({ access_token: "ACCESS2", refresh_token: "REFRESH2", expires_in: 3600, scope: [] });
      }
    }
    if (url.pathname.endsWith("/validate")) return new Response("{}", { status: 200 });
  }
  if (url.host === "api.twitch.tv") {
    const p = url.pathname.replace("/helix", "");
    if (p === "/users") return json({ data: [{ id: "555", login: "mi_canal", display_name: "Mi_Canal" }] });
    if (p === "/streams")
      return json({ data: twitch.live ? [{ user_id: "555", viewer_count: 77, title: "En vivo", started_at: "x" }] : [] });
    if (p === "/eventsub/conduits" && method === "GET") return json({ data: [] });
    if (p === "/eventsub/conduits" && method === "POST") return json({ data: [{ id: "conduit-1", shard_count: 1 }] });
    if (p === "/eventsub/conduits/shards" && method === "PATCH")
      return json({ data: [{ id: "0" }], errors: twitch.shardErrors ? [{ id: "0", message: "callback verification failed" }] : [] });
    if (p === "/eventsub/conduits/shards" && method === "GET") return json({ data: [{ id: "0", status: "enabled" }] });
    if (p === "/eventsub/subscriptions" && method === "POST") return json({ data: [{ id: `sub${twitch.nextSub++}` }] }, 202);
    if (p === "/eventsub/subscriptions" && method === "DELETE") return new Response(null, { status: 204 });
  }
  return json({ message: "no mock" }, 500);
}

// --- Entorno -----------------------------------------------------------------
let env: TestEnv;
let owner: string;
let analyst: string;
let org: string;
let outsider: string;

async function callback(query: string) {
  return env.http.request(`/api/integrations/twitch/callback?${query}`, { redirect: "manual" } as never);
}
const stateFor = (over: Partial<{ tenantId: string; userId: string; client: "web" | "native" }> = {}, userIdOf?: string) =>
  signState(env.deps.config.BETTER_AUTH_SECRET, { tenantId: org, userId: userIdOf ?? "u", client: "web", ...over });

async function userId(email: string) {
  return (await env.admin.db.select().from(schema.user).where(eq(schema.user.email, email)))[0]!.id;
}

function webhook(
  type: "notification" | "webhook_callback_verification" | "revocation",
  payload: object,
  opts: { id?: string; secret?: string; ts?: string } = {},
) {
  const id = opts.id ?? crypto.randomUUID();
  const ts = opts.ts ?? new Date().toISOString();
  const raw = JSON.stringify(payload);
  const sig =
    "sha256=" +
    createHmac("sha256", opts.secret ?? env.deps.twitch!.eventSubSecret)
      .update(id + ts + raw)
      .digest("hex");
  return env.http.request("/webhooks/twitch/eventsub", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "twitch-eventsub-message-id": id,
      "twitch-eventsub-message-timestamp": ts,
      "twitch-eventsub-message-signature": sig,
      "twitch-eventsub-message-type": type,
    },
    body: raw,
  });
}

beforeAll(async () => {
  env = await createTestEnv({ TWITCH_CLIENT_ID: "cid", TWITCH_CLIENT_SECRET: "csecret", TWITCH_EVENTSUB_MODE: "webhook" }, fakeTwitch);
  owner = await env.signUp("o@tw.dev");
  analyst = await env.signUp("an@tw.dev");
  outsider = await env.signUp("out@tw.dev");
  org = ((await (await env.call(owner, "POST", "/api/auth/organization/create", { name: "TW", slug: "tw" })).json()) as { id: string }).id;
  const inv = (
    (await (
      await env.call(owner, "POST", "/api/auth/organization/invite-member", { email: "an@tw.dev", role: "analyst", organizationId: org })
    ).json()) as { id: string }
  ).id;
  await env.call(analyst, "POST", "/api/auth/organization/accept-invitation", { invitationId: inv });
}, 180_000);

afterAll(async () => {
  await env?.stop();
});

describe("firma de webhooks y estado OAuth (unitarios)", () => {
  const secret = "s3cret-s3cret";
  const sign = (id: string, ts: string, body: string) =>
    "sha256=" +
    createHmac("sha256", secret)
      .update(id + ts + body)
      .digest("hex");
  test("firma válida, alterada, ausente y replay", () => {
    const ts = new Date().toISOString();
    expect(verifyTwitchSignature(secret, { messageId: "1", timestamp: ts, signature: sign("1", ts, "{}") }, "{}")).toBe(true);
    expect(verifyTwitchSignature(secret, { messageId: "1", timestamp: ts, signature: sign("1", ts, "{}") }, '{"x":1}')).toBe(false);
    expect(verifyTwitchSignature(secret, { messageId: "1", timestamp: ts, signature: null }, "{}")).toBe(false);
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    expect(verifyTwitchSignature(secret, { messageId: "1", timestamp: old, signature: sign("1", old, "{}") }, "{}")).toBe(false);
  });
  test("state: válido una vez, manipulado, caducado y de otro secreto", () => {
    const s = signState("k", { tenantId: "t", userId: "u", client: "web" });
    expect(verifyState("k", s)?.tenantId).toBe("t");
    expect(verifyState("k", s)).toBeNull(); // un solo uso
    const s2 = signState("k", { tenantId: "t", userId: "u", client: "web" });
    expect(verifyState("otro", s2)).toBeNull();
    const [p, sig] = signState("k", { tenantId: "t", userId: "u", client: "web" }).split(".");
    expect(
      verifyState(
        "k",
        `${Buffer.from(JSON.stringify({ tenantId: "evil", userId: "u", client: "web", exp: Date.now() + 1e6, nonce: "n" })).toString("base64url")}.${sig}`,
      ),
    ).toBeNull();
    void p;
    expect(verifyState("k", signState("k", { tenantId: "t", userId: "u", client: "web" }, -1000))).toBeNull();
    expect(verifyState("k", "basura")).toBeNull();
  });
});

describe("autorización OAuth", () => {
  test("solo quien tiene integrations.manage obtiene la URL; no-miembros 404", async () => {
    expect((await env.call(analyst, "POST", `/api/t/${org}/integrations/twitch/authorize`, {})).status).toBe(403);
    expect((await env.call(outsider, "POST", `/api/t/${org}/integrations/twitch/authorize`, {})).status).toBe(404);
    const r = await env.call(owner, "POST", `/api/t/${org}/integrations/twitch/authorize`, { client: "web" });
    expect(r.status).toBe(200);
    const { url, redirectUri } = (await r.json()) as { url: string; redirectUri: string };
    const u = new URL(url);
    expect(u.host).toBe("id.twitch.tv");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("scope")).toContain("user:read:chat");
    expect(u.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(redirectUri).toBe(`${BASE_URL}/api/integrations/twitch/callback`);
    expect(verifyState(env.deps.config.BETTER_AUTH_SECRET, u.searchParams.get("state")!)?.tenantId).toBe(org);
  });

  test("conectar Twitch directamente (sin OAuth) está prohibido", async () => {
    expect((await env.call(owner, "POST", `/api/t/${org}/connections`, { platform: "twitch", channelId: "x" })).status).toBe(400);
  });

  test("callback: state inválido o reutilizado → 400, nada se crea", async () => {
    expect((await callback("code=abc&state=falso")).status).toBe(400);
    const st = stateFor({}, await userId("o@tw.dev"));
    twitch.calls.length = 0;
    const first = await callback(`code=abc&state=${encodeURIComponent(st)}`);
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toContain("twitch=ok");
    const again = await callback(`code=abc&state=${encodeURIComponent(st)}`);
    expect(again.status).toBe(400);
  });

  test("callback correcto: crea la conexión con tokens CIFRADOS, la inicia y suscribe vía conduit", async () => {
    const rows = await withTenant(env.app.db, org, (tx) => tx.select().from(schema.platformConnection));
    expect(rows).toHaveLength(1);
    const c = rows[0]!;
    expect(c).toMatchObject({ platform: "twitch", channelId: "mi_canal", enabled: true });
    // el blob no contiene el token en claro y se descifra con la clave del servidor
    expect(Buffer.from(c.credentialsEnc!).includes(Buffer.from("ACCESS1"))).toBe(false);
    const creds = JSON.parse(env.deps.encryptor.decrypt(c.credentialsEnc!)) as TwitchCredentials;
    expect(creds).toMatchObject({ accessToken: "ACCESS1", refreshToken: "REFRESH1", userId: "555", login: "mi_canal" });
    await sleep(100);
    const subTypes = twitch.calls.filter((x) => x.url.includes("/eventsub/subscriptions") && x.method === "POST").map((x) => x.body.type);
    expect(subTypes).toEqual(
      expect.arrayContaining(["stream.online", "channel.chat.message", "channel.follow", "channel.cheer", "channel.raid"]),
    );
    expect(twitch.calls.find((x) => x.url.includes("/eventsub/subscriptions"))!.body.transport).toEqual({
      method: "conduit",
      conduit_id: "conduit-1",
    });
    const shard = twitch.calls.find((x) => x.method === "PATCH")!;
    expect(shard.body.shards[0].transport).toMatchObject({ method: "webhook", callback: `${BASE_URL}/webhooks/twitch/eventsub` });
    // token sin enviar en claro a nada que no sea Twitch; auditoría registrada
    const audit = await env.admin.db.select().from(schema.auditLog).where(eq(schema.auditLog.tenantId, org));
    expect(audit.map((a) => a.action)).toContain("connection.create");
    expect(env.deps.ingest.supervisor.list(org)[0]?.status).toBe("offline"); // sin directo: pasivo
  });

  test("callback: quien perdió el permiso, o un usuario ajeno, no puede conectar", async () => {
    const analystId = await userId("an@tw.dev");
    const r = await callback(`code=abc&state=${encodeURIComponent(stateFor({}, analystId))}`);
    expect(r.headers.get("location")).toContain("reason=forbidden");
    const outId = await userId("out@tw.dev");
    expect((await callback(`code=abc&state=${encodeURIComponent(stateFor({}, outId))}`)).headers.get("location")).toContain("twitch=error");
  });

  test("cliente nativo recibe una página HTML en vez de redirección; acceso denegado se informa", async () => {
    const st = stateFor({ client: "native" }, await userId("o@tw.dev"));
    const r = await callback(`error=access_denied&state=${encodeURIComponent(st)}`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("No se pudo conectar");
  });
});

describe("webhook de EventSub", () => {
  test("firma inválida → 403; verificación devuelve el challenge en texto plano", async () => {
    expect((await webhook("notification", { event: {} }, { secret: "otro-secreto-123" })).status).toBe(403);
    const r = await webhook("webhook_callback_verification", { challenge: "pogchamp-123" });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("pogchamp-123");
    expect((await webhook("notification", {}, { ts: new Date(Date.now() - 20 * 60_000).toISOString() })).status).toBe(403);
  });

  test("notificaciones llegan al tenant correcto, los reintentos no duplican", async () => {
    const seen: string[] = [];
    env.deps.bus.subscribe(org, (m) => m.kind === "event" && seen.push(m.event.type));
    const chat = {
      subscription: { type: "channel.chat.message", version: "1" },
      event: { broadcaster_user_id: "555", message_id: "mm1", chatter_user_id: "9", chatter_user_name: "Fan", message: { text: "hola" } },
    };
    const id = crypto.randomUUID();
    expect((await webhook("notification", chat, { id })).status).toBe(204);
    expect((await webhook("notification", chat, { id })).status).toBe(204); // reintento de Twitch
    await webhook("notification", {
      subscription: { type: "channel.cheer", version: "1" },
      event: { broadcaster_user_id: "555", user_id: "3", user_name: "Rico", bits: 100 },
    });
    await webhook("notification", {
      subscription: { type: "channel.raid", version: "1" },
      event: { to_broadcaster_user_id: "555", from_broadcaster_user_login: "otro", from_broadcaster_user_id: "8", viewers: 12 },
    });
    // broadcaster desconocido: se acepta (2xx) pero no llega a nadie
    await webhook("notification", {
      subscription: { type: "channel.chat.message", version: "1" },
      event: { broadcaster_user_id: "999", message_id: "x", message: { text: "x" } },
    });
    await sleep(30);
    expect(seen.filter((t) => t === "chat")).toHaveLength(1);
    expect(seen).toEqual(expect.arrayContaining(["donation", "raid"]));
  });

  test("stream.online consulta Helix y pasa a live; stream.offline vuelve a pasivo", async () => {
    twitch.live = true;
    await webhook("notification", { subscription: { type: "stream.online", version: "1" }, event: { broadcaster_user_id: "555" } });
    await sleep(50);
    expect(env.deps.ingest.supervisor.list(org)[0]?.status).toBe("live");
    twitch.live = false;
    await webhook("notification", { subscription: { type: "stream.offline", version: "1" }, event: { broadcaster_user_id: "555" } });
    await sleep(30);
    expect(env.deps.ingest.supervisor.list(org)[0]?.status).toBe("offline");
  });

  test("revocation por retiro de autorización marca error", async () => {
    await webhook("revocation", {
      subscription: { type: "channel.chat.message", status: "authorization_revoked", condition: { broadcaster_user_id: "555" } },
    });
    await sleep(30);
    const c = env.deps.ingest.supervisor.list(org)[0]!;
    expect(["error", "connecting"]).toContain(c.status);
  });
});

describe("tokens: renovación y revocación", () => {
  test("renueva antes de expirar, persiste cifrado y deduplica renovaciones simultáneas", async () => {
    const [row] = await withTenant(env.app.db, org, (tx) => tx.select().from(schema.platformConnection));
    const cur = JSON.parse(env.deps.encryptor.decrypt(row!.credentialsEnc!)) as TwitchCredentials;
    twitch.calls.length = 0;
    const expired = { ...cur, expiresAt: Date.now() + 1000 };
    const [a, b] = await Promise.all([
      env.deps.twitch!.tokens.ensureFresh(row!.id, expired),
      env.deps.twitch!.tokens.ensureFresh(row!.id, expired),
    ]);
    expect(a.accessToken).toBe("ACCESS2");
    expect(b.accessToken).toBe("ACCESS2");
    expect(twitch.calls.filter((x) => x.body?.grant_type === "refresh_token")).toHaveLength(1);
    const [after] = await withTenant(env.app.db, org, (tx) =>
      tx.select().from(schema.platformConnection).where(eq(schema.platformConnection.id, row!.id)),
    );
    expect(JSON.parse(env.deps.encryptor.decrypt(after!.credentialsEnc!))).toMatchObject({
      accessToken: "ACCESS2",
      refreshToken: "REFRESH2",
      userId: "555",
    });
  });

  test("si el usuario revocó la autorización, la conexión se deshabilita (sin bucle de reintentos)", async () => {
    const [row] = await withTenant(env.app.db, org, (tx) => tx.select().from(schema.platformConnection));
    const cur = JSON.parse(env.deps.encryptor.decrypt(row!.credentialsEnc!)) as TwitchCredentials;
    twitch.refreshRevoked = true;
    await expect(env.deps.twitch!.tokens.ensureFresh(row!.id, { ...cur, expiresAt: 0 })).rejects.toThrow("revocada");
    const [after] = await withTenant(env.app.db, org, (tx) =>
      tx.select().from(schema.platformConnection).where(eq(schema.platformConnection.id, row!.id)),
    );
    expect(after).toMatchObject({ enabled: false, status: "error" });
    expect(after!.lastError).toContain("revocada");
    twitch.refreshRevoked = false;
  });
});
