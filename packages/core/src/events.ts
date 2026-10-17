import { z } from "zod";

export const PLATFORMS = ["tiktok", "twitch", "youtube"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const EVENT_TYPES = [
  "chat",
  "donation",
  "follow",
  "subscription",
  "raid",
  "like",
  "share",
  "viewer_count",
  "stream_start",
  "stream_end",
  "moderation",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const actorSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatar: z.string().nullable().optional(),
});

/** Monto en unidad menor de la moneda (centavos). Gemas de TikTok: currency `TIKTOK_COIN`. */
const money = z.object({
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().min(1).max(16),
  /** Estimación en USD (unidad menor) cuando la moneda no es fiat. */
  usdMinorEstimate: z.number().int().nonnegative().optional(),
});

export const payloadSchemas = {
  chat: z.object({ message: z.string(), badges: z.array(z.string()).default([]), messageId: z.string().optional() }),
  donation: money.extend({
    kind: z.enum(["gift", "bits", "super_chat", "tip"]),
    giftName: z.string().optional(),
    count: z.number().int().positive().default(1),
    message: z.string().optional(),
  }),
  follow: z.object({}),
  subscription: z.object({
    tier: z.string().optional(),
    months: z.number().int().positive().optional(),
    gifted: z.boolean().default(false),
  }),
  raid: z.object({ viewers: z.number().int().nonnegative(), fromChannel: z.string().optional() }),
  like: z.object({ count: z.number().int().positive().default(1) }),
  share: z.object({}),
  viewer_count: z.object({ viewers: z.number().int().nonnegative() }),
  stream_start: z.object({ title: z.string().optional() }),
  stream_end: z.object({ durationSec: z.number().int().nonnegative().optional() }),
  moderation: z.object({
    action: z.enum(["ban", "timeout", "delete", "unban"]),
    targetId: z.string().optional(),
    reason: z.string().optional(),
    durationSec: z.number().int().positive().optional(),
  }),
} satisfies Record<EventType, z.ZodType>;

const baseShape = {
  id: z.string(),
  tenantId: z.string(),
  platform: z.enum(PLATFORMS),
  channelId: z.string(),
  occurredAt: z.coerce.date(),
  actor: actorSchema.nullable(),
  raw: z.unknown().optional(),
};

type PayloadOf<T extends EventType> = z.infer<(typeof payloadSchemas)[T]>;

export type EventOf<T extends EventType> = {
  id: string;
  tenantId: string;
  platform: Platform;
  channelId: string;
  type: T;
  occurredAt: Date;
  actor: z.infer<typeof actorSchema> | null;
  payload: PayloadOf<T>;
  raw?: unknown;
};

/** Contrato central: cualquier evento de plataforma se normaliza a esta unión discriminada por `type`. */
export type NormalizedEvent = { [T in EventType]: EventOf<T> }[EventType];

/** Valida un evento desconocido contra el esquema de su tipo. Lanza ZodError si no es válido. */
export function parseEvent(input: unknown): NormalizedEvent {
  const type = (input as { type?: unknown } | null)?.type;
  if (typeof type !== "string" || !(EVENT_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Tipo de evento desconocido: ${String(type)}`);
  }
  const t = type as EventType;
  return z.object({ ...baseShape, type: z.literal(t), payload: payloadSchemas[t] }).parse(input) as NormalizedEvent;
}

export const CONNECTION_STATUSES = ["connecting", "live", "offline", "error", "rate_limited"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** Permiso necesario para ver cada tipo de evento (filtrado de SSE por permisos del usuario). */
export const EVENT_PERMISSION: Record<EventType, "chat.view" | "events.view" | "stream.view"> = {
  chat: "chat.view",
  donation: "events.view",
  follow: "events.view",
  subscription: "events.view",
  raid: "events.view",
  like: "events.view",
  share: "events.view",
  moderation: "events.view",
  viewer_count: "stream.view",
  stream_start: "stream.view",
  stream_end: "stream.view",
};
