import type { NormalizedEvent } from "./events.ts";
import type { StatusChange } from "./adapter.ts";

export interface AlertPayload {
  id: string;
  ruleId: string | null;
  ruleName: string;
  type: string;
  message: string;
  at: string;
  /** Canales de entrega configurados en la regla: panel, native, webhook. */
  channels: string[];
  data: Record<string, unknown>;
}

export interface HeartbeatPayload {
  source: string;
  at: string;
  metrics: Record<string, unknown>;
}

export interface MarkerPayload {
  id: string;
  at: string;
  kind: "manual" | "raid" | "donation" | "viewers_spike";
  label: string;
  platform?: string | null;
  channelId?: string | null;
}

export type BusMessage =
  | { kind: "event"; tenantId: string; event: NormalizedEvent }
  | { kind: "status"; tenantId: string; platform: string; channelId: string; change: StatusChange }
  | { kind: "alert"; tenantId: string; alert: AlertPayload }
  | { kind: "heartbeat"; tenantId: string; heartbeat: HeartbeatPayload }
  | { kind: "marker"; tenantId: string; marker: MarkerPayload };

export type Unsubscribe = () => void;

/**
 * Bus de eventos abstracto. Implementación inicial in-process; sustituible por
 * Redis Streams o NATS sin tocar productores ni consumidores.
 */
export interface EventBus {
  publish(message: BusMessage): void | Promise<void>;
  /** Suscripción acotada a un tenant: el aislamiento es parte del contrato. */
  subscribe(tenantId: string, handler: (message: BusMessage) => void): Unsubscribe;
  close(): Promise<void>;
  ready(): boolean;
}
