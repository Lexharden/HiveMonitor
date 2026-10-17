import { createHmac } from "node:crypto";
import {
  Helix,
  createTwitchAdapterFactory,
  createWebSocketTransport,
  type EventSubTransport,
} from "@hivemonitor/adapters";
import type { AdapterFactory } from "@hivemonitor/core";
import type { Database } from "@hivemonitor/db";
import type { Config } from "../config.ts";
import type { Encryptor } from "../crypto.ts";
import type { Logger } from "../logger.ts";
import { ConduitTransport } from "./conduit.ts";
import type { TwitchOAuthConfig } from "./oauth.ts";
import { TwitchTokenManager } from "./tokens.ts";

export interface TwitchService {
  mode: "webhook" | "websocket";
  oauth: TwitchOAuthConfig;
  helix: Helix;
  tokens: TwitchTokenManager;
  /** Solo en modo webhook. */
  conduit?: ConduitTransport;
  /** Secreto con el que Twitch firma los webhooks. */
  eventSubSecret: string;
  factory: AdapterFactory;
  stop(): void;
}

/** Modo por defecto: webhook si el servidor es público (https); WebSocket para desarrollo local. */
export function resolveMode(config: Pick<Config, "TWITCH_EVENTSUB_MODE" | "BASE_URL">): "webhook" | "websocket" {
  return config.TWITCH_EVENTSUB_MODE ?? (config.BASE_URL.startsWith("https://") ? "webhook" : "websocket");
}

/** Devuelve null si no hay credenciales de aplicación de Twitch configuradas. */
export function createTwitchService(args: {
  config: Config;
  logger: Logger;
  adminDb: Database;
  encryptor: Encryptor;
  /** Para pruebas: sustituye las llamadas HTTP a Twitch. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}): TwitchService | null {
  const { config, logger } = args;
  if (!config.TWITCH_CLIENT_ID || !config.TWITCH_CLIENT_SECRET) return null;

  const oauth: TwitchOAuthConfig = {
    clientId: config.TWITCH_CLIENT_ID,
    clientSecret: config.TWITCH_CLIENT_SECRET,
    redirectUri: `${config.BASE_URL}/api/integrations/twitch/callback`,
    fetch: args.fetch,
  };
  const helix = new Helix({ clientId: oauth.clientId, fetch: args.fetch });
  const tokens = new TwitchTokenManager({ oauth, adminDb: args.adminDb, encryptor: args.encryptor, logger });
  const mode = resolveMode(config);
  // Secreto derivado si no se configura: estable entre reinicios y distinto de cualquier otro secreto
  const eventSubSecret =
    config.TWITCH_EVENTSUB_SECRET ?? createHmac("sha256", config.BETTER_AUTH_SECRET).update("twitch-eventsub").digest("hex").slice(0, 64);

  let conduit: ConduitTransport | undefined;
  let transport: EventSubTransport;
  let stopMaintenance = () => {};
  if (mode === "webhook") {
    conduit = new ConduitTransport({
      helix,
      appToken: () => tokens.appToken(),
      callbackUrl: `${config.BASE_URL}/webhooks/twitch/eventsub`,
      secret: eventSubSecret,
      logger,
    });
    stopMaintenance = conduit.startMaintenance();
    transport = conduit;
  } else {
    transport = createWebSocketTransport({ helix });
  }
  logger.info({ mode }, "Twitch EventSub");

  return {
    mode,
    oauth,
    helix,
    tokens,
    conduit,
    eventSubSecret,
    factory: createTwitchAdapterFactory({ helix, transport, tokens, appToken: () => tokens.appToken() }),
    stop: stopMaintenance,
  };
}
