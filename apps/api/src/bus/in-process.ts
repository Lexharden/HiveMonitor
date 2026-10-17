import type { BusMessage, EventBus, Unsubscribe } from "@hivemonitor/core";

/** Bus en memoria, aislado por tenant. Un handler que falla no afecta a los demás. */
export class InProcessBus implements EventBus {
  private readonly handlers = new Map<string, Set<(m: BusMessage) => void>>();
  private closed = false;

  constructor(private readonly onError: (err: unknown) => void = () => {}) {}

  publish(message: BusMessage): void {
    if (this.closed) return;
    const set = this.handlers.get(message.tenantId);
    if (!set) return;
    for (const h of [...set]) {
      try {
        h(message);
      } catch (err) {
        this.onError(err);
      }
    }
  }

  subscribe(tenantId: string, handler: (m: BusMessage) => void): Unsubscribe {
    let set = this.handlers.get(tenantId);
    if (!set) this.handlers.set(tenantId, (set = new Set()));
    const mine = set;
    mine.add(handler);
    return () => {
      mine.delete(handler);
      if (mine.size === 0 && this.handlers.get(tenantId) === mine) this.handlers.delete(tenantId);
    };
  }

  subscriberCount(): number {
    let n = 0;
    for (const s of this.handlers.values()) n += s.size;
    return n;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
  }

  ready(): boolean {
    return !this.closed;
  }
}
