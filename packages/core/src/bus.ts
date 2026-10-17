import type { NormalizedEvent } from "./events.ts";
import type { StatusChange } from "./adapter.ts";

export type BusMessage =
  | { kind: "event"; tenantId: string; event: NormalizedEvent }
  | { kind: "status"; tenantId: string; platform: string; channelId: string; change: StatusChange };

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
