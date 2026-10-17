import { z } from "zod";

export const ALERT_TYPES = ["donation_over", "viewers_drop", "platform_disconnect", "heartbeat_lost"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_CHANNELS = ["panel", "native", "webhook"] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

/** Parámetros por tipo de alerta (con valores por defecto razonables). */
export const paramSchemas = {
  donation_over: z.object({
    /** Umbral en dólares (equivalente USD de la donación). */
    thresholdUsd: z.number().positive().max(1_000_000),
    cooldownSec: z.number().int().min(0).max(3600).default(5),
  }),
  viewers_drop: z.object({
    dropPercent: z.number().min(10).max(95).default(50),
    windowMin: z.number().int().min(1).max(60).default(10),
    /** No alertar si en la ventana nunca hubo al menos tantos espectadores. */
    minViewers: z.number().int().min(1).max(1_000_000).default(20),
    cooldownSec: z.number().int().min(0).max(86_400).default(900),
  }),
  platform_disconnect: z.object({
    /** Espera antes de avisar (las reconexiones rápidas no molestan). */
    graceSec: z.number().int().min(0).max(600).default(30),
    cooldownSec: z.number().int().min(0).max(86_400).default(300),
  }),
  heartbeat_lost: z.object({
    /** Fuente concreta; vacío = cualquiera. */
    source: z.string().max(64).optional(),
    afterSec: z.number().int().min(30).max(3600).default(120),
    cooldownSec: z.number().int().min(0).max(86_400).default(600),
  }),
} satisfies Record<AlertType, z.ZodType>;

export type AlertParams<T extends AlertType> = z.infer<(typeof paramSchemas)[T]>;

/** Valida y normaliza los parámetros según el tipo. Devuelve null si no son válidos. */
export function parseParams(type: AlertType, params: unknown): Record<string, unknown> | null {
  const r = paramSchemas[type].safeParse(params ?? {});
  return r.success ? (r.data as Record<string, unknown>) : null;
}

/**
 * Los webhooks salientes solo pueden apuntar a Discord: evita que un tenant use el servidor para
 * hacer peticiones a redes internas (SSRF) y es lo que pide el producto.
 */
export function isAllowedWebhookUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    u.port === "" &&
    !u.username &&
    !u.password &&
    /^(ptb\.|canary\.)?discord(app)?\.com$/.test(u.hostname) &&
    /^\/api\/webhooks\/\d+\/[\w-]+\/?$/.test(u.pathname)
  );
}
