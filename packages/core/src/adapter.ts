import type { ConnectionStatus, NormalizedEvent, Platform } from "./events.ts";

export interface StatusChange {
  status: ConnectionStatus;
  at: Date;
  /** Mensaje seguro (sin secretos) para mostrar en el panel. */
  detail?: string;
  /** Para `rate_limited` o reintentos: ms hasta el próximo intento. */
  retryInMs?: number;
}

export interface AdapterContext {
  tenantId: string;
  platform: Platform;
  channelId: string;
  /** Credenciales ya descifradas; el adaptador nunca las loguea. */
  credentials?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface AdapterHandlers {
  onEvent(event: NormalizedEvent): void;
  onStatus(change: StatusChange): void;
}

export interface ModerationRequest {
  action: "ban" | "timeout" | "delete" | "unban";
  targetId?: string;
  messageId?: string;
  durationSec?: number;
  reason?: string;
}

/** Contrato común que implementa cada plataforma. */
export interface PlatformAdapter {
  readonly platform: Platform;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  status(): ConnectionStatus;
  /** Solo donde la API de la plataforma lo permita. */
  moderate?(request: ModerationRequest): Promise<void>;
}

export type AdapterFactory = (ctx: AdapterContext, handlers: AdapterHandlers) => PlatformAdapter;

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} no está implementado`);
    this.name = "NotImplementedError";
  }
}
