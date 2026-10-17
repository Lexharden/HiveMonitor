import {
  type AdapterContext,
  type AdapterFactory,
  type AdapterHandlers,
  type ConnectionStatus,
  type EventType,
  type NormalizedEvent,
  type PlatformAdapter,
  parseEvent,
} from "@hivemonitor/core";

/**
 * Adaptador de TikTok LIVE. La dependencia `tiktok-live-connector` (no oficial) queda aislada tras
 * `TikTokClientLike`: solo este archivo conoce sus nombres de eventos y errores, de modo que se
 * puede sustituir por otra librería o por el WebSocket de pago de Euler sin tocar el resto.
 */
export interface TikTokClientLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
}

export type TikTokClientFactory = (uniqueId: string, options: { signApiKey?: string }) => Promise<TikTokClientLike> | TikTokClientLike;

export interface TikTokAdapterOptions {
  /** API key del servicio de firma (Euler Stream). Recomendada: sin ella el límite es muy bajo. */
  signApiKey?: string;
  /** Estimación de céntimos de USD por moneda de TikTok (configurable). Por defecto 0,5 ¢. */
  usdCentsPerCoin?: number;
  /** Para pruebas o para sustituir la librería. */
  clientFactory?: TikTokClientFactory;
}

const defaultClientFactory: TikTokClientFactory = async (uniqueId, options) => {
  // Carga perezosa: los despliegues que solo usan el mock no cargan la librería
  const { TikTokLiveConnection } = await import("tiktok-live-connector");
  return new TikTokLiveConnection(uniqueId, { signApiKey: options.signApiKey }) as unknown as TikTokClientLike;
};

type ErrorKind = "offline" | "rate_limited" | "invalid_user" | "other";

/** Clasificación por nombre de clase (se conservan en la librería) para no depender de `instanceof`. */
export function classifyTikTokError(err: unknown): { kind: ErrorKind; retryInMs?: number } {
  for (let e: any = err; e; e = e.cause ?? e.exception) {
    // `name` y nombre de la clase: el minificado puede renombrar una de las dos cosas
    const names = [e?.name, e?.constructor?.name];
    if (names.includes("UserOfflineError")) return { kind: "offline" };
    if (names.includes("InvalidUniqueIdError")) return { kind: "invalid_user" };
    if (names.includes("SignatureRateLimitError")) {
      const retryAfter = Number(e.retryAfter);
      // La librería informa segundos
      return { kind: "rate_limited", retryInMs: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter * 1000) : 60_000 };
    }
    if (typeof e?.message === "string" && /\b429\b|rate.?limit/i.test(e.message)) return { kind: "rate_limited", retryInMs: 60_000 };
  }
  return { kind: "other" };
}

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function actorOf(user: any): { id: string; name: string; avatar: string | null } | null {
  if (!user) return null;
  const id = String(user.userId ?? user.uniqueId ?? "");
  if (!id) return null;
  return {
    id,
    name: String(user.nickname || user.uniqueId || id),
    avatar: user.profilePicture?.urls?.[0] ?? user.profilePicture?.url?.[0] ?? null,
  };
}

class TikTokAdapter implements PlatformAdapter {
  readonly platform = "tiktok" as const;
  private state: ConnectionStatus = "offline";
  private client?: TikTokClientLike;
  private stopping = false;
  private ended = false;
  private seq = 0;
  /** Racha de regalos en curso → evita contar dos veces el mismo regalo. */
  private readonly usdCents: number;

  constructor(
    private readonly ctx: AdapterContext,
    private readonly handlers: AdapterHandlers,
    private readonly opts: TikTokAdapterOptions,
  ) {
    this.usdCents = opts.usdCentsPerCoin ?? 0.5;
  }

  status() {
    return this.state;
  }

  private setStatus(status: ConnectionStatus, detail?: string, retryInMs?: number) {
    this.state = status;
    this.handlers.onStatus({ status, at: new Date(), detail, retryInMs });
  }

  private emit(type: EventType, payload: unknown, actor: ReturnType<typeof actorOf>, id: string, raw?: unknown) {
    let event: NormalizedEvent;
    try {
      event = parseEvent({
        id: `tt_${this.ctx.channelId}_${id}`,
        tenantId: this.ctx.tenantId,
        platform: "tiktok",
        channelId: this.ctx.channelId,
        type,
        occurredAt: new Date(),
        actor,
        payload,
        raw,
      });
    } catch {
      return; // evento malformado de la plataforma: se ignora sin afectar al resto
    }
    this.handlers.onEvent(event);
  }

  private nextId = (msgId: unknown) => (msgId ? String(msgId) : `${Date.now()}_${this.seq++}`);

  async connect(): Promise<void> {
    this.stopping = false;
    this.ended = false;
    this.setStatus("connecting");
    const uniqueId = String(this.ctx.channelId).replace(/^@/, "");
    const factory = this.opts.clientFactory ?? defaultClientFactory;

    let client: TikTokClientLike;
    try {
      client = await factory(uniqueId, { signApiKey: this.opts.signApiKey });
    } catch (err) {
      this.setStatus("error", `no se pudo iniciar el cliente: ${(err as Error).message}`.slice(0, 200));
      return;
    }
    this.client = client;
    this.wire(client);

    try {
      await client.connect();
    } catch (err) {
      if (this.stopping) return;
      const c = classifyTikTokError(err);
      this.client = undefined;
      void client.disconnect().catch(() => {});
      if (c.kind === "offline") this.setStatus("offline", "el canal no está en directo");
      else if (c.kind === "rate_limited") this.setStatus("rate_limited", "límite del servicio de firma", c.retryInMs);
      else if (c.kind === "invalid_user") this.setStatus("error", "el usuario de TikTok no es válido");
      else this.setStatus("error", String((err as Error)?.message ?? err).slice(0, 200));
      return; // el estado ya se informó: el supervisor decide el reintento
    }
    this.setStatus("live");
    this.emit("stream_start", {}, null, `start_${Date.now()}`);
  }

  private wire(c: TikTokClientLike) {
    c.on("chat", (d: any) =>
      this.emit(
        "chat",
        { message: String(d.comment ?? ""), badges: [], messageId: d.msgId ? String(d.msgId) : undefined },
        actorOf(d.user),
        this.nextId(d.msgId),
      ),
    );

    c.on("gift", (d: any) => {
      // Los regalos en racha (giftType 1) emiten un evento por incremento y uno final con repeatEnd.
      // Solo se cuenta el final para no sumar de más.
      const streakable = d.giftDetails?.giftType === 1;
      if (streakable && !d.repeatEnd) return;
      const count = Math.max(1, num(d.repeatCount, 1));
      const diamonds = num(d.giftDetails?.diamondCount ?? d.diamondCount);
      const coins = diamonds * count;
      this.emit(
        "donation",
        {
          kind: "gift",
          giftName: d.giftDetails?.giftName ?? d.giftName ?? undefined,
          count,
          amountMinor: Math.round(coins),
          currency: "TIKTOK_COIN",
          usdMinorEstimate: Math.round(coins * this.usdCents),
        },
        actorOf(d.user),
        this.nextId(d.msgId),
      );
    });

    c.on("roomUser", (d: any) => {
      const v = num(d.viewerCount, -1);
      if (v >= 0) this.emit("viewer_count", { viewers: Math.round(v) }, null, this.nextId(undefined));
    });

    c.on("like", (d: any) => {
      const n = Math.round(num(d.likeCount, 1));
      if (n > 0) this.emit("like", { count: n }, actorOf(d.user), this.nextId(d.msgId));
    });

    c.on("follow", (d: any) => this.emit("follow", {}, actorOf(d.user), this.nextId(d.msgId)));
    c.on("share", (d: any) => this.emit("share", {}, actorOf(d.user), this.nextId(d.msgId)));

    c.on("streamEnd", () => {
      this.ended = true;
      this.emit("stream_end", {}, null, `end_${Date.now()}`);
      this.setStatus("offline", "el directo terminó");
    });

    c.on("disconnected", () => {
      if (this.stopping || this.ended) return;
      // Caída inesperada: se informa como error para que el supervisor reconecte con backoff
      this.setStatus("error", "conexión con TikTok interrumpida");
    });

    c.on("error", (e: any) => {
      // Errores no fatales de decodificación, etc.: no cambian el estado
      void e;
    });
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    const c = this.client;
    this.client = undefined;
    if (this.state === "live" && !this.ended) this.emit("stream_end", {}, null, `end_${Date.now()}`);
    this.state = "offline";
    try {
      await c?.disconnect();
    } catch {
      /* ya estaba desconectado */
    }
  }
}

export function createTikTokAdapterFactory(options: TikTokAdapterOptions = {}): AdapterFactory {
  return (ctx, handlers) => new TikTokAdapter(ctx, handlers, options);
}
