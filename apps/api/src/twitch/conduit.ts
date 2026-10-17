import { createHmac, timingSafeEqual } from "node:crypto";
import { subscribeAll, unsubscribeAll, type EventSubAttachment, type EventSubListener, type EventSubTransport, type Helix } from "@hivemonitor/adapters";
import type { Logger } from "../logger.ts";

const MAX_AGE_MS = 10 * 60_000;

export interface SignatureHeaders {
  messageId: string | null;
  timestamp: string | null;
  signature: string | null;
}

/**
 * Verifica la firma HMAC-SHA256 de un webhook de Twitch: `sha256=` + HMAC(secret, id + timestamp + cuerpo)
 * y rechaza mensajes con más de 10 minutos (anti-replay).
 */
export function verifyTwitchSignature(secret: string, h: SignatureHeaders, rawBody: string, now = Date.now()): boolean {
  if (!h.messageId || !h.timestamp || !h.signature) return false;
  const ts = Date.parse(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_AGE_MS) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(h.messageId + h.timestamp + rawBody).digest("hex")}`);
  const given = Buffer.from(h.signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface ConduitOptions {
  helix: Helix;
  appToken: () => Promise<string>;
  /** URL pública del webhook (https). */
  callbackUrl: string;
  secret: string;
  logger: Logger;
}

/**
 * EventSub por webhook con un conduit: Twitch entrega todas las suscripciones de todos los canales
 * a un único endpoint (un shard). Un solo secreto, un solo callback, N canales.
 */
export class ConduitTransport implements EventSubTransport {
  private ready?: Promise<string>;
  private conduitId?: string;
  private readonly listeners = new Map<string, EventSubListener>();
  private readonly seen = new Map<string, number>();

  constructor(private readonly o: ConduitOptions) {}

  /** Garantiza que existe el conduit y que su shard apunta a nuestro webhook. */
  private init(): Promise<string> {
    this.ready ??= (async () => {
      const token = await this.o.appToken();
      const existing = (await this.o.helix.listConduits(token)).data[0];
      const id = existing?.id ?? (await this.o.helix.createConduit(token, 1)).data[0]!.id;
      await this.configureShard(token, id);
      this.conduitId = id;
      this.o.logger.info({ conduit: id }, "conduit de Twitch listo");
      return id;
    })().catch((err) => {
      this.ready = undefined; // reintentar en el próximo attach
      throw err;
    });
    return this.ready;
  }

  private async configureShard(token: string, id: string): Promise<void> {
    const r = await this.o.helix.updateShards(token, id, [
      { id: "0", transport: { method: "webhook", callback: this.o.callbackUrl, secret: this.o.secret } },
    ]);
    if (r.errors?.length) throw new Error(`Twitch rechazó el shard del conduit: ${JSON.stringify(r.errors[0])}`.slice(0, 300));
  }

  /** Comprueba periódicamente el shard y lo reconfigura si Twitch lo deshabilitó (callback caído, etc.). */
  async checkShards(): Promise<void> {
    if (!this.conduitId) return;
    const token = await this.o.appToken();
    const shards = (await this.o.helix.listShards(token, this.conduitId)).data;
    if (shards.some((s) => s.status !== "enabled")) {
      this.o.logger.warn({ shards }, "shard de Twitch no habilitado: se reconfigura");
      await this.configureShard(token, this.conduitId);
    }
  }

  startMaintenance(everyMs = 5 * 60_000): () => void {
    const t = setInterval(() => void this.checkShards().catch((err) => this.o.logger.warn({ err }, "falló la comprobación de shards")), everyMs);
    t.unref?.();
    return () => clearInterval(t);
  }

  async attach({ broadcasterId, scopes, listener }: Parameters<EventSubTransport["attach"]>[0]): Promise<EventSubAttachment> {
    const conduitId = await this.init();
    const token = await this.o.appToken();
    this.listeners.set(broadcasterId, listener);
    let ids: string[] = [];
    try {
      const r = await subscribeAll(this.o.helix, token, { method: "conduit", conduit_id: conduitId }, broadcasterId, scopes);
      ids = r.ids;
      if (r.skipped.length) this.o.logger.info({ broadcasterId, skipped: r.skipped.map((s) => s.type) }, "suscripciones de Twitch omitidas");
    } catch (err) {
      this.listeners.delete(broadcasterId);
      throw err;
    }
    return {
      detach: async () => {
        if (this.listeners.get(broadcasterId) === listener) this.listeners.delete(broadcasterId);
        await unsubscribeAll(this.o.helix, await this.o.appToken().catch(() => token), ids);
      },
    };
  }

  /** Marca un mensaje como visto; false si es un reintento ya procesado. */
  firstTime(messageId: string, now = Date.now()): boolean {
    for (const [k, t] of this.seen) if (now - t > MAX_AGE_MS) this.seen.delete(k);
    if (this.seen.has(messageId)) return false;
    this.seen.set(messageId, now);
    return true;
  }

  private static broadcasterOf(o: Record<string, any> | undefined): string | undefined {
    return o?.broadcaster_user_id ?? o?.to_broadcaster_user_id;
  }

  deliver(type: string, version: string, event: Record<string, any>, messageId: string, timestamp?: string): boolean {
    const l = this.listeners.get(String(ConduitTransport.broadcasterOf(event)));
    if (!l) return false;
    l.onNotification({ type, version, event, messageId, timestamp });
    return true;
  }

  revoke(subscription: { type: string; status: string; condition?: Record<string, any> }): void {
    const l = this.listeners.get(String(ConduitTransport.broadcasterOf(subscription.condition)));
    l?.onRevoked(subscription.type, subscription.status);
    // Si el conduit o el shard se perdieron, se reconstruyen en el próximo attach
    if (/conduit|shard|callback_verification_failed/.test(subscription.status)) this.ready = undefined;
  }
}
