import type { EventType } from "@hivemonitor/core";
import type { EventSubNotification } from "./types.ts";

export interface MappedEvent {
  type: EventType;
  payload: unknown;
  actor: { id: string; name: string; avatar: string | null } | null;
  /** Sufijo estable para el id del evento (deduplicación). */
  key: string;
  occurredAt?: Date;
}

const actor = (id: unknown, name: unknown) => (id ? { id: String(id), name: String(name ?? id), avatar: null } : null);

/**
 * Traduce una notificación de EventSub al evento normalizado. Devuelve null para lo que no se
 * muestra o para evitar dobles conteos. `stream.online/offline` los gestiona el adaptador (estado).
 */
export function mapNotification(n: EventSubNotification): MappedEvent | null {
  const e = n.event;
  switch (n.type) {
    case "channel.chat.message":
      return {
        type: "chat",
        key: String(e.message_id ?? n.messageId),
        actor: actor(e.chatter_user_id, e.chatter_user_name ?? e.chatter_user_login),
        payload: {
          message: String(e.message?.text ?? ""),
          badges: Array.isArray(e.badges) ? e.badges.map((b: any) => String(b.set_id)) : [],
          messageId: e.message_id ? String(e.message_id) : undefined,
        },
      };
    case "channel.follow":
      return {
        type: "follow",
        key: n.messageId,
        actor: actor(e.user_id, e.user_name ?? e.user_login),
        payload: {},
        occurredAt: e.followed_at ? new Date(e.followed_at) : undefined,
      };
    case "channel.subscribe":
      // Las suscripciones regaladas llegan una vez por receptor; el evento `subscription.gift` (resumen del
      // regalador) se ignora a propósito para no contar dos veces.
      return {
        type: "subscription",
        key: n.messageId,
        actor: actor(e.user_id, e.user_name ?? e.user_login),
        payload: { tier: tierName(e.tier), gifted: e.is_gift === true },
      };
    case "channel.subscription.message":
      return {
        type: "subscription",
        key: n.messageId,
        actor: actor(e.user_id, e.user_name ?? e.user_login),
        payload: {
          tier: tierName(e.tier),
          gifted: false,
          months: Number.isInteger(e.cumulative_months) && e.cumulative_months > 0 ? e.cumulative_months : undefined,
        },
      };
    case "channel.cheer": {
      const bits = Math.max(0, Math.round(Number(e.bits) || 0));
      if (bits === 0) return null;
      return {
        type: "donation",
        key: n.messageId,
        actor: e.is_anonymous ? null : actor(e.user_id, e.user_name ?? e.user_login),
        // 1 bit = 1 céntimo de USD (precio de compra de referencia)
        payload: { kind: "bits", amountMinor: bits, currency: "BITS", usdMinorEstimate: bits, count: 1, message: e.message ? String(e.message) : undefined },
      };
    }
    case "channel.raid":
      return {
        type: "raid",
        key: n.messageId,
        actor: actor(e.from_broadcaster_user_id, e.from_broadcaster_user_name ?? e.from_broadcaster_user_login),
        payload: { viewers: Math.max(0, Math.round(Number(e.viewers) || 0)), fromChannel: e.from_broadcaster_user_login ? String(e.from_broadcaster_user_login) : undefined },
      };
    default:
      return null;
  }
}

function tierName(tier: unknown): string | undefined {
  return ({ "1000": "tier1", "2000": "tier2", "3000": "tier3" } as Record<string, string>)[String(tier)] ?? (tier ? String(tier) : undefined);
}
