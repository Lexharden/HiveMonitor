import { schema, withTenant, type Database } from "@hivemonitor/db";
import { isNull, sql } from "drizzle-orm";
import { Aggregator, toDays, type HourDelta } from "./aggregator.ts";
import type { EventBus, NormalizedEvent, Platform } from "@hivemonitor/core";
import type { Logger } from "../logger.ts";

export interface SessionCounters {
  messages: number;
  likes: number;
  shares: number;
  followers: number;
  subscriptions: number;
  /** Donaciones acumuladas por moneda (unidad menor). */
  donations: Record<string, number>;
}

interface Session {
  id: string;
  tenantId: string;
  platform: Platform;
  channelId: string;
  title?: string;
  startedAt: Date;
  endedAt?: Date;
  viewers: number;
  peak: number;
  counters: SessionCounters;
  lastEventAt: number;
  dirty: boolean;
}

export interface LiveChannelState {
  platform: Platform;
  channelId: string;
  sessionId: string;
  startedAt: Date;
  viewers: number;
  peakViewers: number;
  counters: SessionCounters;
}

export interface PipelineOptions {
  appDb: Database;
  bus: EventBus;
  logger: Logger;
  /** Eventos recientes en memoria por tenant (relleno al conectar SSE). */
  recentSize?: number;
  flushMs?: number;
  maxBatch?: number;
  /** Máximo de eventos pendientes de persistir; se descartan los más antiguos al superarlo. */
  maxPending?: number;
  /** Intervalo mínimo entre `viewer_count` persistidos por canal. */
  viewerSampleMs?: number;
  /** Una sesión sin eventos durante este tiempo se da por terminada. */
  sessionIdleMs?: number;
}

const key = (t: string, p: string, c: string) => `${t}|${p}|${c}`;

/**
 * Punto único de entrada de eventos normalizados: publica al bus, mantiene el buffer de
 * recientes y las sesiones de directo, y persiste en lotes (una transacción por tenant).
 */
export class IngestPipeline {
  private readonly recentByTenant = new Map<string, NormalizedEvent[]>();
  private readonly sessions = new Map<string, Session>();
  private readonly lastViewerSample = new Map<string, number>();
  private readonly agg = new Aggregator();
  private readonly taps = new Set<(e: NormalizedEvent) => void>();
  private pending: NormalizedEvent[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private flushing: Promise<void> = Promise.resolve();
  private readonly o: Required<Omit<PipelineOptions, "appDb" | "bus" | "logger">> & Pick<PipelineOptions, "appDb" | "bus" | "logger">;

  constructor(opts: PipelineOptions) {
    this.o = {
      recentSize: 200,
      flushMs: 1000,
      maxBatch: 500,
      maxPending: 20_000,
      viewerSampleMs: 30_000,
      sessionIdleMs: 10 * 60_000,
      ...opts,
    };
    this.timer = setInterval(() => void this.flush(), this.o.flushMs);
    this.timer.unref?.();
  }

  /** Cierra las sesiones que quedaron abiertas por un apagado anterior. */
  static async closeOrphans(adminDb: Database): Promise<number> {
    const rows = await adminDb
      .update(schema.streamSession)
      .set({ endedAt: sql`now()` })
      .where(isNull(schema.streamSession.endedAt))
      .returning({ id: schema.streamSession.id });
    return rows.length;
  }

  /** Observador de todos los eventos (motor de alertas). Un fallo del observador nunca afecta al flujo. */
  addTap(fn: (e: NormalizedEvent) => void): () => void {
    this.taps.add(fn);
    return () => this.taps.delete(fn);
  }

  handleEvent(event: NormalizedEvent): void {
    try {
      this.track(event);
      for (const tap of this.taps) {
        try {
          tap(event);
        } catch (err) {
          this.o.logger.error({ err }, "observador de eventos falló");
        }
      }
      const ring = this.recentByTenant.get(event.tenantId) ?? [];
      ring.push(event);
      if (ring.length > this.o.recentSize) ring.shift();
      this.recentByTenant.set(event.tenantId, ring);

      void this.o.bus.publish({ kind: "event", tenantId: event.tenantId, event });
      if (this.shouldPersist(event)) {
        this.pending.push(event);
        if (this.pending.length > this.o.maxPending) {
          const drop = this.pending.length - this.o.maxPending;
          this.pending.splice(0, drop);
          this.o.logger.warn({ dropped: drop }, "cola de persistencia saturada: se descartan eventos antiguos");
        }
        if (this.pending.length >= this.o.maxBatch) void this.flush();
      }
    } catch (err) {
      this.o.logger.error({ err, tenantId: event.tenantId, type: event.type }, "fallo procesando evento");
    }
  }

  private shouldPersist(e: NormalizedEvent): boolean {
    if (e.type !== "viewer_count") return true;
    const k = key(e.tenantId, e.platform, e.channelId);
    const last = this.lastViewerSample.get(k) ?? 0;
    if (e.occurredAt.getTime() - last < this.o.viewerSampleMs) return false;
    this.lastViewerSample.set(k, e.occurredAt.getTime());
    return true;
  }

  /** Mantiene la sesión de directo y los contadores a partir del flujo de eventos. */
  private track(e: NormalizedEvent): void {
    this.agg.add(e);
    const k = key(e.tenantId, e.platform, e.channelId);
    let s = this.sessions.get(k);
    if (e.type === "stream_end") {
      if (s) this.endSession(k, s);
      return;
    }
    if (!s) {
      s = {
        id: crypto.randomUUID(),
        tenantId: e.tenantId,
        platform: e.platform,
        channelId: e.channelId,
        startedAt: e.occurredAt,
        viewers: 0,
        peak: 0,
        counters: { messages: 0, likes: 0, shares: 0, followers: 0, subscriptions: 0, donations: {} },
        lastEventAt: Date.now(),
        dirty: true,
      };
      this.sessions.set(k, s);
    }
    s.lastEventAt = Date.now();
    s.dirty = true;
    switch (e.type) {
      case "stream_start":
        if (e.payload.title) s.title = e.payload.title;
        break;
      case "viewer_count":
        s.viewers = e.payload.viewers;
        s.peak = Math.max(s.peak, e.payload.viewers);
        break;
      case "chat":
        s.counters.messages++;
        break;
      case "like":
        s.counters.likes += e.payload.count;
        break;
      case "share":
        s.counters.shares++;
        break;
      case "follow":
        s.counters.followers++;
        break;
      case "subscription":
        s.counters.subscriptions++;
        break;
      case "donation":
        s.counters.donations[e.payload.currency] = (s.counters.donations[e.payload.currency] ?? 0) + e.payload.amountMinor;
        break;
    }
  }

  private endSession(k: string, s: Session, at = new Date()): void {
    s.endedAt = at;
    s.dirty = true;
    this.finished.push(s);
    this.sessions.delete(k);
  }
  private finished: Session[] = [];

  /** El canal dejó de estar en directo (offline sostenido): cierra su sesión. */
  closeSession(tenantId: string, platform: string, channelId: string): void {
    const k = key(tenantId, platform, channelId);
    const s = this.sessions.get(k);
    if (s) this.endSession(k, s);
  }

  /** Estado en vivo (viewers, contadores) de los canales de un tenant. */
  liveState(tenantId: string): LiveChannelState[] {
    const out: LiveChannelState[] = [];
    for (const s of this.sessions.values()) {
      if (s.tenantId !== tenantId) continue;
      out.push({
        platform: s.platform,
        channelId: s.channelId,
        sessionId: s.id,
        startedAt: s.startedAt,
        viewers: s.viewers,
        peakViewers: s.peak,
        counters: s.counters,
      });
    }
    return out;
  }

  recent(tenantId: string): NormalizedEvent[] {
    return [...(this.recentByTenant.get(tenantId) ?? [])];
  }

  /** Persiste lo pendiente. Las llamadas se serializan; un fallo reencola el lote. */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.doFlush()).catch(() => {});
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const now = Date.now();
    for (const [k, s] of this.sessions) {
      if (now - s.lastEventAt > this.o.sessionIdleMs) this.endSession(k, s, new Date(s.lastEventAt));
    }
    const batch = this.pending;
    this.pending = [];
    const stats = this.agg.drain();
    const sessions = [...this.sessions.values(), ...this.finished].filter((s) => s.dirty);
    const finished = this.finished;
    this.finished = [];
    if (batch.length === 0 && sessions.length === 0 && stats.length === 0) return;

    const tenants = new Set<string>([...batch.map((e) => e.tenantId), ...sessions.map((s) => s.tenantId), ...stats.map((d) => d.tenantId)]);
    for (const tenantId of tenants) {
      const events = batch.filter((e) => e.tenantId === tenantId);
      const ss = sessions.filter((s) => s.tenantId === tenantId);
      const myStats = stats.filter((d) => d.tenantId === tenantId);
      try {
        await this.writeResilient(tenantId, events, ss, finished);
        for (const s of ss) s.dirty = false;
      } catch (err) {
        // Fallo transitorio (conexión, timeout…): se reintenta en el siguiente ciclo
        this.o.logger.error({ err, tenantId, events: events.length }, "falló la persistencia; se reintentará");
        this.pending.unshift(...events);
        this.finished.push(...finished.filter((f) => f.tenantId === tenantId));
      }
      try {
        if (myStats.length) await this.writeStats(tenantId, myStats);
      } catch (err) {
        // Los deltas son aditivos: se devuelven para el siguiente ciclo (sin duplicar ni perder)
        this.o.logger.error({ err, tenantId }, "falló el volcado de estadísticas; se reintentará");
        this.agg.restore(myStats);
      }
    }
  }

  /** Upsert aditivo en stats_hourly y stats_daily (mismo cálculo de media ponderada). */
  private async writeStats(tenantId: string, hours: HourDelta[]): Promise<void> {
    await withTenant(this.o.appDb, tenantId, async (tx) => {
      for (const h of hours) {
        const avg = h.viewerSamples ? h.viewerSum / h.viewerSamples : 0;
        await tx.execute(sql`insert into stats_hourly (tenant_id, platform, bucket, viewers_peak, viewers_avg, viewer_samples, donations_minor, messages, new_followers)
          values (${h.tenantId}, ${h.platform}, ${new Date(h.hour).toISOString()}::timestamptz, ${h.peak}, ${avg}, ${h.viewerSamples}, ${h.donationsMinor}, ${h.messages}, ${h.followers})
          on conflict (tenant_id, platform, bucket) do update set
            viewers_peak = greatest(stats_hourly.viewers_peak, excluded.viewers_peak),
            viewers_avg = case when stats_hourly.viewer_samples + excluded.viewer_samples = 0 then 0
              else (stats_hourly.viewers_avg * stats_hourly.viewer_samples + excluded.viewers_avg * excluded.viewer_samples) / (stats_hourly.viewer_samples + excluded.viewer_samples) end,
            viewer_samples = stats_hourly.viewer_samples + excluded.viewer_samples,
            donations_minor = stats_hourly.donations_minor + excluded.donations_minor,
            messages = stats_hourly.messages + excluded.messages,
            new_followers = stats_hourly.new_followers + excluded.new_followers`);
      }
      for (const d of toDays(hours)) {
        const avg = d.viewerSamples ? d.viewerSum / d.viewerSamples : 0;
        await tx.execute(sql`insert into stats_daily (tenant_id, platform, bucket, viewers_peak, viewers_avg, viewer_samples, donations_minor, messages, new_followers)
          values (${d.tenantId}, ${d.platform}, ${d.day}::date, ${d.peak}, ${avg}, ${d.viewerSamples}, ${d.donationsMinor}, ${d.messages}, ${d.followers})
          on conflict (tenant_id, platform, bucket) do update set
            viewers_peak = greatest(stats_daily.viewers_peak, excluded.viewers_peak),
            viewers_avg = case when stats_daily.viewer_samples + excluded.viewer_samples = 0 then 0
              else (stats_daily.viewers_avg * stats_daily.viewer_samples + excluded.viewers_avg * excluded.viewer_samples) / (stats_daily.viewer_samples + excluded.viewer_samples) end,
            viewer_samples = stats_daily.viewer_samples + excluded.viewer_samples,
            donations_minor = stats_daily.donations_minor + excluded.donations_minor,
            messages = stats_daily.messages + excluded.messages,
            new_followers = stats_daily.new_followers + excluded.new_followers`);
      }
    });
  }

  /**
   * Escribe el lote; si Postgres rechaza datos concretos (codificación, NUL, integridad) se
   * aísla por bisección y solo se descartan los eventos culpables, nunca el lote entero.
   */
  private async writeResilient(tenantId: string, events: NormalizedEvent[], ss: Session[], finished: Session[]): Promise<void> {
    try {
      await this.writeTx(tenantId, events, ss, finished);
    } catch (err) {
      if (!isDataError(err)) throw err;
      if (events.length <= 1) {
        this.o.logger.error({ err, tenantId, eventId: events[0]?.id, type: events[0]?.type }, "evento rechazado por la base de datos: descartado");
        if (ss.length) await this.writeTx(tenantId, [], ss, finished);
        return;
      }
      const mid = Math.ceil(events.length / 2);
      await this.writeResilient(tenantId, events.slice(0, mid), ss, finished);
      await this.writeResilient(tenantId, events.slice(mid), [], finished);
    }
  }

  private async writeTx(tenantId: string, events: NormalizedEvent[], ss: Session[], finished: Session[]): Promise<void> {
    await withTenant(this.o.appDb, tenantId, async (tx) => {
      for (const s of ss) {
        const stats = s.counters as unknown as Record<string, unknown>;
        await tx
          .insert(schema.streamSession)
          .values({ id: s.id, tenantId: s.tenantId, platform: s.platform, channelId: s.channelId, title: s.title, startedAt: s.startedAt, endedAt: s.endedAt, peakViewers: s.peak, stats })
          .onConflictDoUpdate({ target: schema.streamSession.id, set: { title: s.title, endedAt: s.endedAt, peakViewers: s.peak, stats } });
      }
      for (let i = 0; i < events.length; i += 200) {
        const chunk = events.slice(i, i + 200).map((e) => ({
          id: e.id,
          tenantId: e.tenantId,
          platform: e.platform,
          channelId: e.channelId,
          sessionId:
            this.sessions.get(key(e.tenantId, e.platform, e.channelId))?.id ??
            finished.find((f) => f.tenantId === e.tenantId && f.platform === e.platform && f.channelId === e.channelId)?.id ??
            null,
          type: e.type,
          occurredAt: e.occurredAt,
          actorId: e.actor?.id ?? null,
          actorName: e.actor?.name ?? null,
          amountMinor: e.type === "donation" ? e.payload.amountMinor : null,
          currency: e.type === "donation" ? e.payload.currency : null,
          payload: e.payload as Record<string, unknown>,
          raw: (e.raw as object | undefined) ?? null,
        }));
        await tx.insert(schema.event).values(chunk).onConflictDoNothing();
      }
    });
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }
}

/** Errores de datos de Postgres (clases SQLSTATE 22 y 23): reintentar no los arregla. */
function isDataError(err: unknown): boolean {
  for (let e: any = err; e; e = e.cause) {
    if (typeof e.code === "string" && /^(22|23)/.test(e.code)) return true;
  }
  return false;
}
