import type {
  AdapterFactory,
  AdapterHandlers,
  ConnectionStatus,
  EventBus,
  ModerationRequest,
  NormalizedEvent,
  Platform,
  PlatformAdapter,
  StatusChange,
} from "@hivemonitor/core";
import type { Logger } from "../logger.ts";
import { backoffDelay, jitter } from "./backoff.ts";
import type { IngestPipeline } from "./pipeline.ts";

export interface ConnectionSpec {
  id: string;
  tenantId: string;
  platform: Platform;
  channelId: string;
  credentials?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface ConnectionSnapshot {
  id: string;
  tenantId: string;
  platform: Platform;
  channelId: string;
  status: ConnectionStatus;
  detail?: string;
  since: Date;
  attempts: number;
  nextRetryAt?: Date;
  queued: boolean;
}

export interface SupervisorOptions {
  logger: Logger;
  bus: EventBus;
  pipeline: IngestPipeline;
  /** Devuelve la factoría del adaptador para la conexión, o undefined si no se admite. */
  resolveFactory(spec: ConnectionSpec): AdapterFactory | undefined;
  /** Persistencia del estado (best-effort). */
  onStatusChange?(spec: ConnectionSpec, status: ConnectionStatus, detail?: string): Promise<void> | void;
  /** Conexiones simultáneas máximas en fase de connect() por plataforma (p. ej. TikTok → servicio de firma). */
  connectConcurrency?: Partial<Record<Platform, number>>;
  backoff?: { baseMs: number; maxMs: number };
  /** Espera entre comprobaciones cuando el canal está offline. */
  offlineRetryMs?: number;
  random?: () => number;
}

/** Semáforo con cola FIFO. */
class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  get queued() {
    return this.waiters.length;
  }
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiters.push(r));
    else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next(); // el cupo pasa directamente al siguiente
      else this.active--;
    };
  }
}

type RetryKind = "error" | "offline" | "rate_limited";

class ManagedConnection {
  private adapter?: PlatformAdapter;
  private gen = 0;
  private desired = false;
  private timer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private status: ConnectionStatus = "offline";
  private detail?: string;
  private since = new Date();
  private nextRetryAt?: Date;
  private queued = false;

  constructor(
    readonly spec: ConnectionSpec,
    private readonly factory: AdapterFactory,
    private readonly sup: Supervisor,
  ) {}

  snapshot(): ConnectionSnapshot {
    return {
      id: this.spec.id,
      tenantId: this.spec.tenantId,
      platform: this.spec.platform,
      channelId: this.spec.channelId,
      status: this.status,
      detail: this.detail,
      since: this.since,
      attempts: this.attempts,
      nextRetryAt: this.nextRetryAt,
      queued: this.queued,
    };
  }

  start(): void {
    if (this.desired) return;
    this.desired = true;
    void this.attempt();
  }

  async stop(): Promise<void> {
    this.desired = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRetryAt = undefined;
    const adapter = this.adapter;
    this.adapter = undefined;
    try {
      await adapter?.disconnect();
    } catch (err) {
      this.sup.o.logger.warn({ err, id: this.spec.id }, "error al desconectar");
    }
    this.gen++; // ignora cualquier evento tardío del adaptador
    this.sup.o.pipeline.closeSession(this.spec.tenantId, this.spec.platform, this.spec.channelId);
    this.setStatus("offline", "desconectado");
  }

  async moderate(req: ModerationRequest): Promise<void> {
    if (!this.adapter?.moderate) throw new Error("moderation_not_supported");
    await this.adapter.moderate(req);
  }

  private setStatus(status: ConnectionStatus, detail?: string): void {
    if (status === this.status && detail === this.detail) return;
    const changed = status !== this.status;
    this.status = status;
    this.detail = detail;
    if (changed) this.since = new Date();
    const change: StatusChange = { status, at: new Date(), detail };
    void this.sup.o.bus.publish({ kind: "status", tenantId: this.spec.tenantId, platform: this.spec.platform, channelId: this.spec.channelId, change });
    if (changed) {
      this.sup.notifyStatus(this.spec, status, detail);
      Promise.resolve(this.sup.o.onStatusChange?.(this.spec, status, detail)).catch((err) =>
        this.sup.o.logger.warn({ err, id: this.spec.id }, "no se pudo guardar el estado de la conexión"),
      );
    }
  }

  private handlers(gen: number): AdapterHandlers {
    return {
      onEvent: (event: NormalizedEvent) => {
        if (gen !== this.gen) return;
        // Defensa en profundidad: un adaptador nunca puede emitir fuera de su tenant/canal.
        if (event.tenantId !== this.spec.tenantId || event.platform !== this.spec.platform || event.channelId !== this.spec.channelId) {
          this.sup.o.logger.error({ id: this.spec.id, got: event.tenantId }, "evento con tenant/canal inesperado: descartado");
          return;
        }
        this.sup.o.pipeline.handleEvent(event);
      },
      onStatus: (change: StatusChange) => {
        if (gen !== this.gen) return;
        this.onAdapterStatus(change);
      },
    };
  }

  private onAdapterStatus(change: StatusChange): void {
    if (change.status === "live") {
      this.attempts = 0;
      this.nextRetryAt = undefined;
      this.setStatus("live", change.detail);
      return;
    }
    if (change.status === "connecting") {
      this.setStatus("connecting", change.detail);
      return;
    }
    this.setStatus(change.status, change.detail);
    if (!this.desired) return;
    if (change.status === "offline") {
      if (change.passive) this.sup.o.pipeline.closeSession(this.spec.tenantId, this.spec.platform, this.spec.channelId);
      else this.scheduleRetry("offline");
    }
    else if (change.status === "error") this.scheduleRetry("error");
    else if (change.status === "rate_limited") {
      this.sup.noteRateLimit(this.spec.platform, change.retryInMs ?? 60_000);
      this.scheduleRetry("rate_limited", change.retryInMs);
    }
  }

  private async attempt(): Promise<void> {
    if (!this.desired) return;
    this.timer = undefined;
    this.nextRetryAt = undefined;
    const gen = ++this.gen;
    this.setStatus("connecting");
    const sem = this.sup.semaphore(this.spec.platform);
    let release: (() => void) | undefined;
    try {
      if (sem) {
        this.queued = true;
        this.setStatus("connecting", "en cola de conexión");
        release = await sem.acquire();
        this.queued = false;
        if (!this.desired || gen !== this.gen) return;
        const wait = this.sup.cooldownLeft(this.spec.platform);
        if (wait > 0) {
          this.setStatus("rate_limited", "en espera por el límite global del servicio");
          await new Promise((r) => setTimeout(r, wait + Math.floor(Math.random() * 500)));
          if (!this.desired || gen !== this.gen) return;
        }
        this.setStatus("connecting");
      }
      const adapter = this.factory({ ...this.spec, connectionId: this.spec.id }, this.handlers(gen));
      this.adapter = adapter;
      await adapter.connect();
    } catch (err) {
      if (gen !== this.gen || !this.desired) return;
      this.sup.o.logger.warn({ err: (err as Error).message, id: this.spec.id, platform: this.spec.platform }, "falló la conexión");
      this.setStatus("error", (err as Error).message.slice(0, 200));
      this.scheduleRetry("error");
    } finally {
      this.queued = false;
      release?.();
    }
  }

  private scheduleRetry(kind: RetryKind, hintMs?: number): void {
    if (!this.desired || this.timer) return;
    const old = this.adapter;
    this.adapter = undefined;
    void old?.disconnect().catch(() => {});
    const { backoff, offlineRetryMs, random } = this.sup.o;
    const b = backoff ?? { baseMs: 2_000, maxMs: 5 * 60_000 };
    let delay: number;
    if (kind === "offline") {
      delay = jitter(offlineRetryMs ?? 60_000, 0.2, random);
      this.sup.o.pipeline.closeSession(this.spec.tenantId, this.spec.platform, this.spec.channelId);
    } else {
      this.attempts++;
      delay = backoffDelay(this.attempts, { ...b, random });
      if (kind === "rate_limited" && hintMs) delay = Math.max(delay, hintMs);
    }
    this.nextRetryAt = new Date(Date.now() + delay);
    this.timer = setTimeout(() => void this.attempt(), delay);
    this.timer.unref?.();
  }
}

/**
 * Administra una conexión por (tenant, plataforma, canal). Cada conexión es independiente:
 * una excepción o un fallo de una nunca se propaga a otras.
 */
export class Supervisor {
  private readonly conns = new Map<string, ManagedConnection>();
  private readonly sems = new Map<Platform, Semaphore>();
  private readonly cooldownUntil = new Map<Platform, number>();
  private readonly statusListeners = new Set<(spec: ConnectionSpec, status: ConnectionStatus, detail?: string) => void>();
  private rateLimitHits = 0;
  constructor(readonly o: SupervisorOptions) {
    for (const [p, n] of Object.entries(o.connectConcurrency ?? {})) {
      if (n && n > 0) this.sems.set(p as Platform, new Semaphore(n));
    }
  }

  /** Observador de cambios de estado de todas las conexiones (alertas). */
  addStatusListener(fn: (spec: ConnectionSpec, status: ConnectionStatus, detail?: string) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  notifyStatus(spec: ConnectionSpec, status: ConnectionStatus, detail?: string): void {
    for (const fn of this.statusListeners) {
      try {
        fn(spec, status, detail);
      } catch (err) {
        this.o.logger.error({ err }, "observador de estado falló");
      }
    }
  }

  semaphore(p: Platform): Semaphore | undefined {
    return this.sems.get(p);
  }

  /**
   * El límite del servicio de firma es global (por API key), no por tenant: ante un rate limit se pausan
   * TODAS las conexiones nuevas de esa plataforma hasta que pase el tiempo indicado.
   */
  noteRateLimit(p: Platform, ms: number): void {
    this.rateLimitHits++;
    this.cooldownUntil.set(p, Math.max(this.cooldownUntil.get(p) ?? 0, Date.now() + ms));
  }

  cooldownLeft(p: Platform): number {
    return Math.max(0, (this.cooldownUntil.get(p) ?? 0) - Date.now());
  }

  /** Inicia (o reinicia) la conexión. Devuelve false si no hay adaptador para ella. */
  async start(spec: ConnectionSpec): Promise<boolean> {
    const factory = this.o.resolveFactory(spec);
    if (!factory) return false;
    await this.stop(spec.id);
    const c = new ManagedConnection(spec, factory, this);
    this.conns.set(spec.id, c);
    c.start();
    return true;
  }

  async stop(id: string): Promise<void> {
    const c = this.conns.get(id);
    if (!c) return;
    this.conns.delete(id);
    await c.stop();
  }

  get(id: string): ConnectionSnapshot | undefined {
    return this.conns.get(id)?.snapshot();
  }

  list(tenantId?: string): ConnectionSnapshot[] {
    return [...this.conns.values()].filter((c) => !tenantId || c.spec.tenantId === tenantId).map((c) => c.snapshot());
  }

  /** Para los tests y la vista superadmin. */
  stats() {
    const byStatus: Record<string, number> = {};
    for (const c of this.conns.values()) byStatus[c.snapshot().status] = (byStatus[c.snapshot().status] ?? 0) + 1;
    const cooldown: Record<string, number> = {};
    for (const p of this.cooldownUntil.keys()) if (this.cooldownLeft(p) > 0) cooldown[p] = this.cooldownLeft(p);
    return { total: this.conns.size, byStatus, queued: [...this.sems.values()].reduce((n, s) => n + s.queued, 0), rateLimitHits: this.rateLimitHits, cooldownMs: cooldown };
  }

  async moderate(id: string, tenantId: string, req: ModerationRequest): Promise<void> {
    const c = this.conns.get(id);
    if (!c || c.spec.tenantId !== tenantId) throw new Error("connection_not_found");
    await c.moderate(req);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.conns.keys()].map((id) => this.stop(id)));
  }
}
