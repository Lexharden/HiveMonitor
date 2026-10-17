import { z } from "zod";

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const csv = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  /** Conexión propietaria: migraciones y tareas cruzadas entre tenants. */
  DATABASE_URL: z.string().min(1),
  /** Conexión con el rol hive_app (sujeto a RLS). Si falta se usa DATABASE_URL y se avisa. */
  DATABASE_APP_URL: z.string().min(1).optional(),
  DATABASE_APP_PASSWORD: z.string().min(8).optional(),
  AUTO_MIGRATE: bool.default(true),

  /**
   * Quién puede crear cuenta: `open` (cualquiera), `invite` (solo con invitación a ese correo; por defecto) o `closed`.
   * El primer usuario de una instalación nueva siempre puede registrarse.
   */
  SIGNUP_MODE: z.enum(["open", "invite", "closed"]).default("invite"),

  /** URL pública del servidor (p. ej. https://hivemonitor.yafel.dev). */
  BASE_URL: z.string().url().default("http://localhost:3000"),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET debe tener al menos 32 caracteres"),
  /** 32 bytes en base64 (openssl rand -base64 32). */
  ENCRYPTION_KEY: z.string().min(1),
  CORS_ORIGINS: csv,
  /** IPs/CIDR de proxies de confianza cuyo X-Forwarded-* se respeta. */
  TRUSTED_PROXIES: csv,

  TWITCH_CLIENT_ID: z.string().optional(),
  TWITCH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  /** `webhook` (conduit, requiere URL pública https) o `websocket` (desarrollo local). Por defecto según BASE_URL. */
  TWITCH_EVENTSUB_MODE: z.enum(["webhook", "websocket"]).optional(),
  /** Secreto de firma de webhooks (10-100 caracteres). Si falta se deriva de BETTER_AUTH_SECRET. */
  TWITCH_EVENTSUB_SECRET: z.string().min(10).max(100).optional(),
  /** Servidor SMTP para invitaciones por correo, p. ej. smtps://usuario:clave@smtp.ejemplo.com. Opcional. */
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).default(60),
  METRICS_TOKEN: z.string().min(16).optional(),
  /** Permite conexiones `mode: mock` (desarrollo/demos). Por defecto solo fuera de producción. */
  ALLOW_MOCK_ADAPTERS: bool.optional(),
  /** Conexiones simultáneas en fase de connect() para TikTok (servicio de firma externo). */
  TIKTOK_MAX_CONCURRENCY: z.coerce.number().int().min(1).default(2),
  /**
   * Cliente de TikTok: `bridge` (por defecto; Rust + piratetok-live-rs, gratis, sin API key) o `connector`
   * (tiktok-live-connector; necesita el servicio de firma de Euler Stream).
   */
  TIKTOK_PROVIDER: z.enum(["bridge", "connector"]).default("bridge"),
  /** Ruta del ejecutable tiktok-bridge. Por defecto, junto al ejecutable de HiveMonitor o en el PATH. */
  TIKTOK_BRIDGE_PATH: z.string().optional(),
  /** Proxy opcional para las conexiones del puente (http, https, socks5). */
  TIKTOK_PROXY: z.string().optional(),
  /** API key del servicio de firma (solo con TIKTOK_PROVIDER=connector). */
  TIKTOK_SIGN_API_KEY: z.string().optional(),
  /** Céntimos de USD estimados por moneda de TikTok (para el equivalente en las estadísticas). */
  TIKTOK_USD_CENTS_PER_COIN: z.coerce.number().min(0).default(0.5),
  RECONNECT_BASE_MS: z.coerce.number().int().min(1).default(2000),
  RECONNECT_MAX_MS: z.coerce.number().int().min(1).default(300000),
  OFFLINE_RETRY_MS: z.coerce.number().int().min(1).default(60000),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Configuración inválida:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

export const isProd = (c: Config) => c.NODE_ENV === "production";
