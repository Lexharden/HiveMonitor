import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { TWITCH_SCOPES } from "@hivemonitor/adapters";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class TokenRevokedError extends Error {
  constructor(message = "la autorización de Twitch fue revocada") {
    super(message);
    this.name = "TokenRevokedError";
  }
}

export interface TwitchOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: FetchLike;
  idBase?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

const ID = "https://id.twitch.tv/oauth2";

export function authorizeUrl(c: Pick<TwitchOAuthConfig, "clientId" | "redirectUri" | "idBase">, state: string): string {
  const u = new URL(`${c.idBase ?? ID}/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", c.clientId);
  u.searchParams.set("redirect_uri", c.redirectUri);
  u.searchParams.set("scope", TWITCH_SCOPES.join(" "));
  u.searchParams.set("state", state);
  u.searchParams.set("force_verify", "true"); // el usuario siempre ve qué está autorizando
  return u.toString();
}

async function tokenRequest(c: TwitchOAuthConfig, params: Record<string, string>): Promise<any> {
  const f: FetchLike = c.fetch ?? ((i, n) => fetch(i, n));
  const res = await f(`${c.idBase ?? ID}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...params }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 400/401 con invalid_grant/invalid refresh token: el usuario retiró la autorización
    if (params.grant_type === "refresh_token" && (res.status === 400 || res.status === 401)) throw new TokenRevokedError();
    throw new Error(`Twitch OAuth ${res.status}: ${body.message ?? "error"}`);
  }
  return body;
}

const toSet = (b: any, fallbackRefresh = ""): TokenSet => ({
  accessToken: String(b.access_token),
  refreshToken: String(b.refresh_token ?? fallbackRefresh),
  expiresAt: Date.now() + Number(b.expires_in ?? 3600) * 1000,
  scopes: Array.isArray(b.scope) ? b.scope.map(String) : typeof b.scope === "string" ? b.scope.split(" ") : [],
});

export async function exchangeCode(c: TwitchOAuthConfig, code: string): Promise<TokenSet> {
  return toSet(await tokenRequest(c, { grant_type: "authorization_code", code, redirect_uri: c.redirectUri }));
}

/** Twitch puede o no rotar el refresh token; se conserva el anterior si no llega uno nuevo. */
export async function refreshTokens(c: TwitchOAuthConfig, refreshToken: string, scopes: string[]): Promise<TokenSet> {
  const s = toSet(await tokenRequest(c, { grant_type: "refresh_token", refresh_token: refreshToken }), refreshToken);
  return { ...s, scopes: s.scopes.length ? s.scopes : scopes };
}

export async function fetchAppToken(c: TwitchOAuthConfig): Promise<{ token: string; expiresAt: number }> {
  const b = await tokenRequest(c, { grant_type: "client_credentials" });
  return { token: String(b.access_token), expiresAt: Date.now() + Number(b.expires_in ?? 3600) * 1000 };
}

/** Valida un token (Twitch exige hacerlo cada hora). Devuelve false si ya no vale. */
export async function validateToken(c: Pick<TwitchOAuthConfig, "fetch" | "idBase">, accessToken: string): Promise<boolean> {
  const f: FetchLike = c.fetch ?? ((i, n) => fetch(i, n));
  const res = await f(`${c.idBase ?? ID}/validate`, { headers: { authorization: `OAuth ${accessToken}` } });
  if (res.status === 401) return false;
  return res.ok;
}

// --- state firmado ---------------------------------------------------------------
export interface OAuthState {
  tenantId: string;
  userId: string;
  /** Cliente que inició el flujo: decide qué página se muestra al volver. */
  client: "web" | "native";
  exp: number;
  nonce: string;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signState(secret: string, s: Omit<OAuthState, "exp" | "nonce">, ttlMs = 10 * 60_000): string {
  const payload = b64(JSON.stringify({ ...s, exp: Date.now() + ttlMs, nonce: randomBytes(12).toString("base64url") } satisfies OAuthState));
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

const usedNonces = new Map<string, number>();

/** Verifica firma, caducidad y un solo uso. Devuelve null si no es válido. */
export function verifyState(secret: string, state: string): OAuthState | null {
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let s: OAuthState;
  try {
    s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const now = Date.now();
  if (typeof s.exp !== "number" || s.exp < now) return null;
  for (const [k, e] of usedNonces) if (e < now) usedNonces.delete(k);
  if (usedNonces.has(s.nonce)) return null;
  usedNonces.set(s.nonce, s.exp);
  return s;
}
