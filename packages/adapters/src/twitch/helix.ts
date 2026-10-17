export class HelixError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `Helix ${status}`);
    this.name = "HelixError";
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HelixOptions {
  clientId: string;
  fetch?: FetchLike;
  baseUrl?: string;
  /** Espera máxima ante un 429 (ms). */
  maxRateLimitWaitMs?: number;
}

export interface RequestOptions {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  token: string;
}

/** Cliente mínimo de la API Helix de Twitch con gestión de límites de tasa. */
export class Helix {
  private readonly f: FetchLike;
  private readonly base: string;
  constructor(private readonly o: HelixOptions) {
    this.f = o.fetch ?? ((input, init) => fetch(input, init));
    this.base = o.baseUrl ?? "https://api.twitch.tv/helix";
  }

  async request<T = any>(path: string, r: RequestOptions, retried = false): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(r.query ?? {})) {
      if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, x);
      else if (v !== undefined) url.searchParams.set(k, v);
    }
    const res = await this.f(url, {
      method: r.method ?? "GET",
      headers: {
        authorization: `Bearer ${r.token}`,
        "client-id": this.o.clientId,
        ...(r.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: r.body !== undefined ? JSON.stringify(r.body) : undefined,
    });
    if (res.status === 429 && !retried) {
      // `Ratelimit-Reset` es epoch en segundos; se espera hasta entonces (con tope)
      const reset = Number(res.headers.get("ratelimit-reset"));
      const wait = Number.isFinite(reset) && reset > 0 ? reset * 1000 - Date.now() : 1000;
      await new Promise((ok) => setTimeout(ok, Math.min(Math.max(wait, 200), this.o.maxRateLimitWaitMs ?? 15_000)));
      return this.request<T>(path, r, true);
    }
    const text = await res.text();
    const body = text ? safeJson(text) : null;
    if (!res.ok) throw new HelixError(res.status, body, `Helix ${res.status}: ${(body as any)?.message ?? res.statusText}`);
    return body as T;
  }

  async getUser(token: string, login?: string): Promise<{ id: string; login: string; display_name: string; profile_image_url?: string } | null> {
    const r = await this.request<{ data: any[] }>("/users", { token, query: { login } });
    return r.data[0] ?? null;
  }

  /** Streams en directo de los usuarios dados (máx. 100). Los que no están en directo no aparecen. */
  async getStreams(token: string, userIds: string[]): Promise<{ user_id: string; viewer_count: number; title: string; started_at: string }[]> {
    if (!userIds.length) return [];
    const r = await this.request<{ data: any[] }>("/streams", { token, query: { user_id: userIds, first: "100" } });
    return r.data;
  }

  banUser(token: string, p: { broadcasterId: string; moderatorId: string; userId: string; durationSec?: number; reason?: string }) {
    return this.request("/moderation/bans", {
      token,
      method: "POST",
      query: { broadcaster_id: p.broadcasterId, moderator_id: p.moderatorId },
      body: { data: { user_id: p.userId, ...(p.durationSec ? { duration: p.durationSec } : {}), ...(p.reason ? { reason: p.reason } : {}) } },
    });
  }

  unbanUser(token: string, p: { broadcasterId: string; moderatorId: string; userId: string }) {
    return this.request("/moderation/bans", {
      token,
      method: "DELETE",
      query: { broadcaster_id: p.broadcasterId, moderator_id: p.moderatorId, user_id: p.userId },
    });
  }

  deleteMessage(token: string, p: { broadcasterId: string; moderatorId: string; messageId: string }) {
    return this.request("/moderation/chat", {
      token,
      method: "DELETE",
      query: { broadcaster_id: p.broadcasterId, moderator_id: p.moderatorId, message_id: p.messageId },
    });
  }

  createSubscription(token: string, body: { type: string; version: string; condition: Record<string, string>; transport: Record<string, string> }) {
    return this.request<{ data: { id: string }[] }>("/eventsub/subscriptions", { token, method: "POST", body });
  }

  deleteSubscription(token: string, id: string) {
    return this.request("/eventsub/subscriptions", { token, method: "DELETE", query: { id } });
  }

  // --- Conduits (requieren token de aplicación) ---
  listConduits(token: string) {
    return this.request<{ data: { id: string; shard_count: number }[] }>("/eventsub/conduits", { token });
  }
  createConduit(token: string, shardCount = 1) {
    return this.request<{ data: { id: string; shard_count: number }[] }>("/eventsub/conduits", { token, method: "POST", body: { shard_count: shardCount } });
  }
  updateShards(token: string, conduitId: string, shards: { id: string; transport: Record<string, string> }[]) {
    return this.request<{ data: any[]; errors?: any[] }>("/eventsub/conduits/shards", { token, method: "PATCH", body: { conduit_id: conduitId, shards } });
  }
  listShards(token: string, conduitId: string) {
    return this.request<{ data: { id: string; status: string }[] }>("/eventsub/conduits/shards", { token, query: { conduit_id: conduitId } });
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
