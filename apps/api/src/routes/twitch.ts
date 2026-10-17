import { and, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { TWITCH_SCOPES, type TwitchCredentials } from "@hivemonitor/adapters";
import { schema, withTenant } from "@hivemonitor/db";
import { audit } from "../audit.ts";
import type { AppDeps, AppEnv } from "../context.ts";
import { loadTenantAccess, requireTenant } from "../middleware.ts";
import { verifyTwitchSignature } from "../twitch/conduit.ts";
import { authorizeUrl, exchangeCode, signState, verifyState } from "../twitch/oauth.ts";

const DEFAULT_MAX_CONNECTIONS = 5;

const page = (title: string, body: string) =>
  `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font-family:system-ui,sans-serif;background:#0f1115;color:#f0efec;display:grid;place-items:center;min-height:100vh;margin:0"><main style="text-align:center;padding:24px"><h1 style="font-size:20px">${title}</h1><p style="color:#c3c2b7">${body}</p></main></body></html>`;

/** Webhook de EventSub (fuera de /api: sin CORS ni limitador por IP; la autenticidad la da la firma HMAC). */
export function twitchWebhookRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  r.post("/eventsub", async (c) => {
    const t = deps.twitch;
    if (!t?.conduit) return c.text("not found", 404);
    const raw = await c.req.text();
    if (raw.length > 1_000_000) return c.text("too large", 413);
    const headers = {
      messageId: c.req.header("twitch-eventsub-message-id") ?? null,
      timestamp: c.req.header("twitch-eventsub-message-timestamp") ?? null,
      signature: c.req.header("twitch-eventsub-message-signature") ?? null,
    };
    if (!verifyTwitchSignature(t.eventSubSecret, headers, raw)) return c.text("forbidden", 403);

    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.text("bad request", 400);
    }
    const type = c.req.header("twitch-eventsub-message-type");
    if (type === "webhook_callback_verification") return c.text(String(body.challenge ?? ""), 200);

    // Twitch reintenta si no recibe 2xx rápido: los repetidos se confirman sin reprocesar
    if (!t.conduit.firstTime(headers.messageId!)) return c.body(null, 204);
    if (type === "notification") {
      t.conduit.deliver(String(body.subscription?.type), String(body.subscription?.version ?? "1"), body.event ?? {}, headers.messageId!, headers.timestamp ?? undefined);
    } else if (type === "revocation") {
      t.conduit.revoke({ type: String(body.subscription?.type), status: String(body.subscription?.status), condition: body.subscription?.condition });
      deps.logger.warn({ type: body.subscription?.type, status: body.subscription?.status }, "Twitch revocó una suscripción");
    }
    return c.body(null, 204);
  });
  return r;
}

/** Inicio del flujo OAuth (requiere sesión y permiso en el tenant). */
export function twitchTenantRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  r.post("/integrations/twitch/authorize", requireTenant(deps, "integrations.manage"), async (c) => {
    if (!deps.twitch) return c.json({ error: "twitch_not_configured" }, 501);
    const body = z.object({ client: z.enum(["web", "native"]).default("web") }).safeParse(await c.req.json().catch(() => ({})));
    const t = c.get("tenant");
    const state = signState(deps.config.BETTER_AUTH_SECRET, { tenantId: t.tenantId, userId: t.userId, client: body.success ? body.data.client : "web" });
    return c.json({ url: authorizeUrl(deps.twitch.oauth, state), redirectUri: deps.twitch.oauth.redirectUri });
  });
  return r;
}

/** Retorno de Twitch tras autorizar. Público: la identidad viaja en el `state` firmado, de un solo uso y con caducidad. */
export function twitchCallbackRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  r.get("/twitch/callback", async (c) => {
    const twitch = deps.twitch;
    const state = verifyState(deps.config.BETTER_AUTH_SECRET, c.req.query("state") ?? "");
    if (!twitch || !state) return c.html(page("Enlace no válido", "Vuelve a HiveMonitor e inténtalo de nuevo."), 400);

    const done = (ok: boolean, code = "") =>
      state.client === "native"
        ? c.html(ok ? page("Twitch conectado", "Ya puedes volver a la aplicación de HiveMonitor.") : page("No se pudo conectar Twitch", "Vuelve a la aplicación e inténtalo de nuevo."))
        : c.redirect(`${deps.config.BASE_URL}/integrations?${ok ? "twitch=ok" : `twitch=error&reason=${encodeURIComponent(code)}`}`);

    if (c.req.query("error")) return done(false, c.req.query("error") === "access_denied" ? "denied" : "error");
    const code = c.req.query("code");
    if (!code) return done(false, "error");

    try {
      // El usuario debe seguir teniendo permiso (el state solo prueba que lo tuvo al iniciar)
      const access = await loadTenantAccess(deps, state.tenantId, { id: state.userId, isSuperadmin: false });
      if (!access || access.suspended || !access.permissions.has("integrations.manage")) return done(false, "forbidden");

      const tokens = await exchangeCode(twitch.oauth, code);
      const me = await twitch.helix.getUser(tokens.accessToken);
      if (!me) return done(false, "error");
      const missing = TWITCH_SCOPES.filter((s) => !tokens.scopes.includes(s));
      if (missing.includes("user:read:chat")) return done(false, "scopes"); // sin chat el canal no sirve

      const creds: TwitchCredentials = { ...tokens, userId: me.id, login: me.login };
      const blob = deps.encryptor.encrypt(JSON.stringify(creds));

      const existing = await withTenant(deps.appDb, state.tenantId, (tx) =>
        tx
          .select()
          .from(schema.platformConnection)
          .where(and(eq(schema.platformConnection.platform, "twitch"), eq(schema.platformConnection.channelId, me.login))),
      );
      let id: string;
      if (existing[0]) {
        id = existing[0].id;
        await withTenant(deps.appDb, state.tenantId, (tx) =>
          tx
            .update(schema.platformConnection)
            .set({ credentialsEnc: blob, keyVersion: deps.encryptor.keyVersion, enabled: true, channelName: me.display_name, lastError: null, config: { broadcasterId: me.id }, updatedAt: new Date() })
            .where(eq(schema.platformConnection.id, id)),
        );
      } else {
        const [settings] = await deps.adminDb.select({ limits: schema.tenantSettings.limits }).from(schema.tenantSettings).where(eq(schema.tenantSettings.tenantId, state.tenantId));
        const max = Number((settings?.limits as { maxConnections?: number } | undefined)?.maxConnections ?? DEFAULT_MAX_CONNECTIONS);
        const [{ n } = { n: 0 }] = await withTenant(deps.appDb, state.tenantId, (tx) => tx.select({ n: count() }).from(schema.platformConnection));
        if (n >= max) return done(false, "limit");
        id = crypto.randomUUID();
        await withTenant(deps.appDb, state.tenantId, (tx) =>
          tx.insert(schema.platformConnection).values({
            id,
            tenantId: state.tenantId,
            platform: "twitch",
            channelId: me.login,
            channelName: me.display_name,
            config: { broadcasterId: me.id },
            credentialsEnc: blob,
            keyVersion: deps.encryptor.keyVersion,
            enabled: true,
          }),
        );
      }
      await audit(deps.appDb, {
        tenantId: state.tenantId,
        actorUserId: state.userId,
        action: existing[0] ? "connection.reauthorize" : "connection.create",
        target: id,
        meta: { platform: "twitch", channel: me.login, missingScopes: missing },
        ip: c.get("ip"),
      });
      const [row] = await withTenant(deps.appDb, state.tenantId, (tx) => tx.select().from(schema.platformConnection).where(eq(schema.platformConnection.id, id)));
      if (row) await deps.ingest.startConnection(row);
      return done(true);
    } catch (err) {
      deps.logger.error({ err: (err as Error).message }, "falló el callback de Twitch");
      return done(false, "error");
    }
  });
  return r;
}
