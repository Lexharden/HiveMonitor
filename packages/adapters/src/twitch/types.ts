export interface TwitchCredentials {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms de expiración del access token. */
  expiresAt: number;
  scopes: string[];
  userId: string;
  login: string;
}

/** Alcances que pide la autorización del canal. */
export const TWITCH_SCOPES = [
  "user:read:chat",
  "channel:read:subscriptions",
  "moderator:read:followers",
  "bits:read",
  "moderator:manage:banned_users",
  "moderator:manage:chat_messages",
] as const;

export interface EventSubNotification {
  /** Tipo de suscripción, p. ej. `channel.chat.message`. */
  type: string;
  version: string;
  event: Record<string, any>;
  /** Id único del mensaje (deduplicación de reintentos). */
  messageId: string;
  timestamp?: string;
}

export interface EventSubListener {
  onNotification(n: EventSubNotification): void;
  /** La conexión de transporte se perdió (el adaptador reportará `error` y el supervisor reconectará). */
  onClosed(reason: string): void;
  /** Twitch revocó una suscripción (p. ej. el usuario retiró la autorización). */
  onRevoked(type: string, reason: string): void;
}

export interface EventSubAttachment {
  detach(): Promise<void>;
}

/** Transporte de EventSub: WebSocket (desarrollo) o conduit por webhook (producción). */
export interface EventSubTransport {
  attach(args: { broadcasterId: string; userToken: () => Promise<string>; scopes: string[]; listener: EventSubListener }): Promise<EventSubAttachment>;
}

/** Tokens: renueva y persiste. Implementado por el servidor (cifrado en base de datos). */
export interface TwitchTokenService {
  /** Devuelve credenciales vigentes (renovando si hace falta). Lanza si la autorización fue revocada. */
  ensureFresh(connectionId: string, current: TwitchCredentials): Promise<TwitchCredentials>;
}

/** Suscripciones que se crean por canal. `scope` es el alcance que exige (si falta, se omite sin fallar). */
export interface SubscriptionSpec {
  type: string;
  version: string;
  scope?: string;
  required?: boolean;
  condition(broadcasterId: string): Record<string, string>;
}

export const SUBSCRIPTIONS: SubscriptionSpec[] = [
  { type: "stream.online", version: "1", required: true, condition: (b) => ({ broadcaster_user_id: b }) },
  { type: "stream.offline", version: "1", required: true, condition: (b) => ({ broadcaster_user_id: b }) },
  { type: "channel.chat.message", version: "1", scope: "user:read:chat", condition: (b) => ({ broadcaster_user_id: b, user_id: b }) },
  { type: "channel.follow", version: "2", scope: "moderator:read:followers", condition: (b) => ({ broadcaster_user_id: b, moderator_user_id: b }) },
  { type: "channel.subscribe", version: "1", scope: "channel:read:subscriptions", condition: (b) => ({ broadcaster_user_id: b }) },
  { type: "channel.subscription.message", version: "1", scope: "channel:read:subscriptions", condition: (b) => ({ broadcaster_user_id: b }) },
  { type: "channel.cheer", version: "1", scope: "bits:read", condition: (b) => ({ broadcaster_user_id: b }) },
  { type: "channel.raid", version: "1", condition: (b) => ({ to_broadcaster_user_id: b }) },
];
