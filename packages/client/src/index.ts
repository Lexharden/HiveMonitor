import type { ConnectionStatus, NormalizedEvent, Permission, Platform } from "@hivemonitor/core";

export type { NormalizedEvent, Permission, Platform, ConnectionStatus };

// --- Tipos de la API ---------------------------------------------------------
export interface Me {
  user: { id: string; email: string; name: string; isSuperadmin: boolean };
  organizations: OrgMembership[];
}
export interface OrgMembership {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  role: string;
  suspended: boolean;
  permissions: Permission[];
}
export interface ConnectionInfo {
  id: string;
  platform: Platform;
  channelId: string;
  channelName: string | null;
  status: ConnectionStatus;
  enabled: boolean;
  config: Record<string, unknown>;
  lastError: string | null;
  runtime: { attempts: number; nextRetryAt?: string; queued: boolean; since: string } | null;
}
export interface SessionCounters {
  messages: number;
  likes: number;
  shares: number;
  followers: number;
  subscriptions: number;
  donations: Record<string, number>;
}
export interface LiveChannel {
  platform: Platform;
  channelId: string;
  sessionId: string;
  startedAt: string;
  viewers: number;
  peakViewers: number;
  counters: SessionCounters;
}
export interface RuntimeConnection {
  id: string;
  platform: Platform;
  channelId: string;
  status: ConnectionStatus;
  detail?: string;
  since: string;
  attempts: number;
  nextRetryAt?: string;
  queued: boolean;
}
export interface Snapshot {
  connections: RuntimeConnection[];
  channels: LiveChannel[];
  recent: NormalizedEvent[];
  permissions: Permission[];
}
export type StreamMessage =
  | { type: "snapshot"; data: Snapshot }
  | { type: "event"; data: NormalizedEvent }
  | { type: "status"; data: { platform: Platform; channelId: string; status: ConnectionStatus; at: string; detail?: string } }
  | { type: "state"; state: "connecting" | "open" | "closed" };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body?: unknown,
  ) {
    super(`${status} ${code}`);
    this.name = "ApiError";
  }
}

/** Almacén del token bearer (Tauri: store nativo; web: no se usa, van cookies). */
export interface TokenStore {
  get(): string | null | Promise<string | null>;
  set(token: string | null): void | Promise<void>;
}

export interface ClientOptions {
  /** URL base del servidor; vacío = mismo origen (web). */
  baseUrl?: string | (() => string);
  /** Si se da, se envía `Authorization: Bearer` (cliente Tauri). Si no, se usan cookies. */
  tokenStore?: TokenStore;
  fetch?: typeof fetch;
  onUnauthorized?: () => void;
}

export type Client = ReturnType<typeof createClient>;

export function createClient(opts: ClientOptions = {}) {
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = () => (typeof opts.baseUrl === "function" ? opts.baseUrl() : (opts.baseUrl ?? "")).replace(/\/+$/, "");
  const useBearer = !!opts.tokenStore;

  async function headers(extra?: HeadersInit): Promise<Headers> {
    const h = new Headers(extra);
    if (useBearer) {
      const t = await opts.tokenStore!.get();
      if (t) h.set("authorization", `Bearer ${t}`);
    }
    return h;
  }

  async function raw(path: string, init: RequestInit = {}): Promise<Response> {
    const h = await headers(init.headers);
    if (init.body && !h.has("content-type")) h.set("content-type", "application/json");
    const res = await f(`${base()}${path}`, { ...init, headers: h, credentials: useBearer ? "omit" : "include" });
    const fresh = res.headers.get("set-auth-token");
    if (fresh && useBearer) await opts.tokenStore!.set(fresh);
    return res;
  }

  async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await raw(path, init);
    const text = await res.text();
    const body = text ? safeJson(text) : null;
    if (!res.ok) {
      if (res.status === 401) opts.onUnauthorized?.();
      const code = (body as { error?: string; message?: string } | null)?.error ?? (body as { message?: string } | null)?.message ?? res.statusText;
      throw new ApiError(res.status, String(code), body);
    }
    return body as T;
  }

  const post = <T>(path: string, body?: unknown) => json<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
  const t = (org: string, p: string) => `/api/t/${encodeURIComponent(org)}${p}`;

  return {
    baseUrl: base,

    // --- Autenticación (Better Auth) ---
    auth: {
      signInEmail: (email: string, password: string) => post<unknown>("/api/auth/sign-in/email", { email, password }),
      signUpEmail: (name: string, email: string, password: string) => post<unknown>("/api/auth/sign-up/email", { name, email, password }),
      /** URL del flujo OAuth (redirección completa; en Tauri se abre en el navegador del sistema). */
      async socialSignIn(provider: "twitch" | "google", callbackURL: string) {
        const r = await post<{ url?: string }>("/api/auth/sign-in/social", { provider, callbackURL, disableRedirect: true });
        return r.url ?? null;
      },
      async signOut() {
        try {
          await post("/api/auth/sign-out");
        } finally {
          await opts.tokenStore?.set(null);
        }
      },
    },
    me: () => json<Me>("/api/me"),
    roles: () => json<{ permissions: Permission[]; roles: { key: string; label: string; permissions: Permission[] }[] }>("/api/meta/roles"),

    // --- Organizaciones ---
    orgs: {
      create: (name: string, slug: string) => post<{ id: string }>("/api/auth/organization/create", { name, slug }),
      setActive: (organizationId: string) => post("/api/auth/organization/set-active", { organizationId }),
      acceptInvitation: (invitationId: string) => post("/api/auth/organization/accept-invitation", { invitationId }),
    },

    // --- Tenant ---
    tenant(orgId: string) {
      return {
        connections: () => json<{ connections: ConnectionInfo[] }>(t(orgId, "/connections")),
        createConnection: (body: { platform: Platform; channelId: string; channelName?: string; config?: Record<string, unknown> }) =>
          post<{ id: string }>(t(orgId, "/connections"), body),
        connect: (id: string) => post(t(orgId, `/connections/${id}/connect`)),
        disconnect: (id: string) => post(t(orgId, `/connections/${id}/disconnect`)),
        deleteConnection: (id: string) => json(t(orgId, `/connections/${id}`), { method: "DELETE" }),
        /** Inicia la autorización OAuth de Twitch; devuelve la URL a abrir. */
        twitchAuthorize: (client: "web" | "native") => post<{ url: string }>(t(orgId, "/integrations/twitch/authorize"), { client }),
        live: () => json<{ channels: LiveChannel[]; connections: RuntimeConnection[]; serverTime: string }>(t(orgId, "/live")),
        audit: (limit = 50) => json<{ entries: { id: string; action: string; target: string | null; at: string; actorUserId: string | null; meta: unknown }[] }>(t(orgId, `/audit?limit=${limit}`)),
        stream: (onMessage: (m: StreamMessage) => void) => openStream(orgId, onMessage),
        socket: () => openSocket(orgId),
      };
    },
    admin: {
      tenants: () => json<{ tenants: { id: string; name: string; slug: string; suspended: boolean | null; members: number; limits: unknown; createdAt: string }[] }>("/api/admin/tenants"),
      patchTenant: (id: string, body: { suspended?: boolean; limits?: Record<string, unknown> }) =>
        json(`/api/admin/tenants/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    },
  };

  // --- Tiempo real ---------------------------------------------------------
  /**
   * SSE sobre fetch (permite cabecera Authorization). Reconecta con backoff y devuelve `close()`.
   * Tras cada reconexión llega un nuevo `snapshot`, que el consumidor debe tratar como estado completo.
   */
  function openStream(orgId: string, onMessage: (m: StreamMessage) => void): { close(): void } {
    let stopped = false;
    let ctrl: AbortController | undefined;
    let attempt = 0;

    async function run() {
      while (!stopped) {
        ctrl = new AbortController();
        onMessage({ type: "state", state: "connecting" });
        try {
          const res = await raw(t(orgId, "/stream"), { signal: ctrl.signal, headers: { accept: "text/event-stream" } });
          if (res.status === 401) opts.onUnauthorized?.();
          if (!res.ok || !res.body) throw new ApiError(res.status, res.statusText);
          onMessage({ type: "state", state: "open" });
          attempt = 0;
          for await (const m of parseSse(res.body)) {
            if (m.event === "snapshot") onMessage({ type: "snapshot", data: m.data as Snapshot });
            else if (m.event === "event") onMessage({ type: "event", data: reviveEvent(m.data) });
            else if (m.event === "status") onMessage({ type: "status", data: m.data as never });
          }
        } catch (err) {
          if (stopped || (err as Error).name === "AbortError") break;
          if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
            onMessage({ type: "state", state: "closed" });
            return; // no tiene sentido reintentar
          }
        }
        if (stopped) break;
        onMessage({ type: "state", state: "closed" });
        attempt++;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) * (0.5 + Math.random() / 2);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    void run();
    return {
      close() {
        stopped = true;
        ctrl?.abort();
      },
    };
  }

  /** WebSocket de acciones. Auth por subprotocolo `bearer.<base64url>` (Tauri) o cookie (web). */
  async function openSocket(orgId: string) {
    const url = new URL(t(orgId, "/ws"), base() || (typeof location !== "undefined" ? location.origin : "http://localhost"));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const token = useBearer ? await opts.tokenStore!.get() : null;
    const ws = token ? new WebSocket(url, [`bearer.${b64url(token)}`]) : new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("No se pudo abrir el WebSocket"));
    });
    const pending = new Map<string, (r: { ok: boolean; error?: string }) => void>();
    ws.onmessage = (e) => {
      const m = safeJson(String(e.data)) as { type?: string; id?: string; ok?: boolean; error?: string } | null;
      if (m?.type === "ack" && m.id) pending.get(m.id)?.({ ok: !!m.ok, error: m.error });
    };
    return {
      moderate(req: { connectionId: string; action: "ban" | "timeout" | "delete" | "unban"; targetId?: string; messageId?: string; durationSec?: number; reason?: string }) {
        const id = crypto.randomUUID();
        return new Promise<{ ok: boolean; error?: string }>((resolve) => {
          const timer = setTimeout(() => (pending.delete(id), resolve({ ok: false, error: "timeout" })), 10_000);
          pending.set(id, (r) => (clearTimeout(timer), pending.delete(id), resolve(r)));
          ws.send(JSON.stringify({ type: "moderate", id, ...req }));
        });
      },
      close: () => ws.close(),
    };
  }
}

// --- Utilidades ----------------------------------------------------------------
function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function reviveEvent(e: unknown): NormalizedEvent {
  const ev = e as NormalizedEvent & { occurredAt: string | Date };
  return { ...ev, occurredAt: new Date(ev.occurredAt) } as NormalizedEvent;
}

/** Parser de Server-Sent Events sobre un ReadableStream. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: unknown; id?: string }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = "message";
        let id: string | undefined;
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("id:")) id = line.slice(3).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length || event !== "message") yield { event, data: safeJson(data.join("\n")), id };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
