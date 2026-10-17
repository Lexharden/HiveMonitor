import {
  type AdapterContext,
  type AdapterFactory,
  type AdapterHandlers,
  type ConnectionStatus,
  type EventType,
  type ModerationRequest,
  type PlatformAdapter,
  parseEvent,
} from "@hivemonitor/core";
import { mapNotification } from "./events.ts";
import { Helix, HelixError } from "./helix.ts";
import type { EventSubAttachment, EventSubNotification, EventSubTransport, TwitchCredentials, TwitchTokenService } from "./types.ts";

export * from "./types.ts";
export { Helix, HelixError } from "./helix.ts";
export { mapNotification } from "./events.ts";
export { createWebSocketTransport, TWITCH_WS_URL } from "./eventsub-ws.ts";
export { subscribeAll, unsubscribeAll } from "./subscribe.ts";

export interface TwitchAdapterOptions {
  helix: Helix;
  transport: EventSubTransport;
  tokens: TwitchTokenService;
  /** Token de aplicación (para consultar el estado del directo sin gastar el token del usuario). */
  appToken: () => Promise<string>;
  /** Intervalo de sondeo de viewers/estado. Por defecto 60 s. */
  pollMs?: number;
}

class TwitchAdapter implements PlatformAdapter {
  readonly platform = "twitch" as const;
  private state: ConnectionStatus = "offline";
  private creds?: TwitchCredentials;
  private attachment?: EventSubAttachment;
  private poll?: ReturnType<typeof setInterval>;
  private live = false;
  private stopped = false;
  private seq = 0;

  constructor(
    private readonly ctx: AdapterContext,
    private readonly h: AdapterHandlers,
    private readonly o: TwitchAdapterOptions,
  ) {}

  status() {
    return this.state;
  }

  private setStatus(status: ConnectionStatus, detail?: string, passive?: boolean) {
    this.state = status;
    this.h.onStatus({ status, at: new Date(), detail, passive });
  }

  private emit(
    type: EventType,
    payload: unknown,
    actor: { id: string; name: string; avatar: string | null } | null,
    key: string,
    occurredAt?: Date,
  ) {
    try {
      this.h.onEvent(
        parseEvent({
          id: `tw_${this.ctx.channelId}_${key}`,
          tenantId: this.ctx.tenantId,
          platform: "twitch",
          channelId: this.ctx.channelId,
          type,
          occurredAt: occurredAt ?? new Date(),
          actor,
          payload,
        }),
      );
    } catch {
      /* evento malformado: se ignora */
    }
  }

  /** Token de usuario vigente (renueva y persiste a través del servicio de tokens). */
  private async userToken(): Promise<string> {
    this.creds = await this.o.tokens.ensureFresh(this.ctx.connectionId ?? this.ctx.channelId, this.creds!);
    return this.creds.accessToken;
  }

  async connect(): Promise<void> {
    this.stopped = false;
    this.setStatus("connecting");
    const c = this.ctx.credentials as Partial<TwitchCredentials> | undefined;
    if (!c?.accessToken || !c.refreshToken || !c.userId) {
      this.setStatus("error", "el canal no está autorizado: vuelve a conectar Twitch");
      return;
    }
    this.creds = c as TwitchCredentials;

    try {
      await this.userToken();
    } catch (err) {
      this.setStatus("error", `autorización de Twitch no válida: ${(err as Error).message}`.slice(0, 200));
      return;
    }

    try {
      this.attachment = await this.o.transport.attach({
        broadcasterId: this.creds.userId,
        userToken: () => this.userToken(),
        scopes: this.creds.scopes,
        listener: {
          onNotification: (n) => void this.onNotification(n),
          onClosed: (reason) => !this.stopped && this.setStatus("error", reason),
          onRevoked: (type, reason) => {
            if (this.stopped) return;
            const revoked = /authorization_revoked|user_removed/.test(reason);
            this.setStatus("error", revoked ? "autorización de Twitch revocada" : `suscripción ${type} revocada (${reason})`);
          },
        },
      });
    } catch (err) {
      this.attachment = undefined;
      const status = err instanceof HelixError ? err.status : 0;
      this.setStatus(
        "error",
        status === 401 || status === 403 ? "Twitch rechazó la autorización" : String((err as Error).message).slice(0, 200),
      );
      return;
    }

    await this.refreshStream();
    this.poll = setInterval(() => void this.refreshStream(), this.o.pollMs ?? 60_000);
    this.poll.unref?.();
  }

  /** Estado real del directo + viewers (también corrige pérdidas de `stream.online/offline`). */
  private async refreshStream(): Promise<void> {
    if (this.stopped || !this.creds) return;
    try {
      const [s] = await this.o.helix.getStreams(await this.o.appToken(), [this.creds.userId]);
      if (this.stopped) return;
      if (s) {
        this.goLive(s.title);
        this.emit("viewer_count", { viewers: s.viewer_count }, null, `vc_${Date.now()}_${this.seq++}`);
      } else this.goOffline();
    } catch {
      if (!this.live && this.state === "connecting") this.setStatus("offline", "canal sin directo", true);
    }
  }

  private goLive(title?: string) {
    if (this.live) return;
    this.live = true;
    this.setStatus("live");
    this.emit("stream_start", { title }, null, `start_${Date.now()}`);
  }

  private goOffline() {
    if (this.live) {
      this.live = false;
      this.emit("stream_end", {}, null, `end_${Date.now()}`);
    }
    // Pasivo: seguimos suscritos y avisamos cuando vuelva a estar en directo
    this.setStatus("offline", "canal sin directo", true);
  }

  private async onNotification(n: EventSubNotification): Promise<void> {
    if (this.stopped) return;
    if (n.type === "stream.online") {
      await this.refreshStream();
      if (!this.live) this.goLive();
      return;
    }
    if (n.type === "stream.offline") return this.goOffline();
    // Aunque no haya `stream.online` registrado (conexión a mitad de directo) los eventos fluyen
    const m = mapNotification(n);
    if (m) this.emit(m.type, m.payload, m.actor, m.key, m.occurredAt);
  }

  async moderate(req: ModerationRequest): Promise<void> {
    if (!this.creds) throw new Error("not_connected");
    const token = await this.userToken();
    const base = { broadcasterId: this.creds.userId, moderatorId: this.creds.userId };
    const { helix } = this.o;
    switch (req.action) {
      case "ban":
        if (!req.targetId) throw new Error("target_required");
        await helix.banUser(token, { ...base, userId: req.targetId, reason: req.reason });
        break;
      case "timeout":
        if (!req.targetId) throw new Error("target_required");
        await helix.banUser(token, {
          ...base,
          userId: req.targetId,
          durationSec: Math.min(req.durationSec ?? 600, 1_209_600),
          reason: req.reason,
        });
        break;
      case "unban":
        if (!req.targetId) throw new Error("target_required");
        await helix.unbanUser(token, { ...base, userId: req.targetId });
        break;
      case "delete":
        if (!req.messageId) throw new Error("message_required");
        await helix.deleteMessage(token, { ...base, messageId: req.messageId });
        break;
    }
    this.emit(
      "moderation",
      { action: req.action, targetId: req.targetId, reason: req.reason, durationSec: req.durationSec },
      null,
      `mod_${Date.now()}_${this.seq++}`,
    );
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    const a = this.attachment;
    this.attachment = undefined;
    if (this.live) {
      this.live = false;
      this.emit("stream_end", {}, null, `end_${Date.now()}`);
    }
    this.state = "offline";
    await a?.detach().catch(() => {});
  }
}

export function createTwitchAdapterFactory(options: TwitchAdapterOptions): AdapterFactory {
  return (ctx, handlers) => new TwitchAdapter(ctx, handlers, options);
}
