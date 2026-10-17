import { eq } from "drizzle-orm";
import type { AlertPayload, ConnectionStatus, EventBus, NormalizedEvent } from "@hivemonitor/core";
import { schema, withTenant, type Database } from "@hivemonitor/db";
import type { Encryptor } from "../crypto.ts";
import type { IngestPipeline } from "../ingest/pipeline.ts";
import { donationUsdMinor } from "../ingest/aggregator.ts";
import type { ConnectionSpec, Supervisor } from "../ingest/supervisor.ts";
import type { Logger } from "../logger.ts";
import { isAllowedWebhookUrl, type AlertType } from "./rules.ts";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface Rule {
  id: string;
  type: AlertType;
  name: string;
  params: Record<string, any>;
  channels: string[];
  webhookUrlEnc: Uint8Array | null;
}

interface Sample {
  t: number;
  v: number;
}

const RULES_TTL_MS = 30_000;

export interface AlertEngineOptions {
  appDb: Database;
  bus: EventBus;
  encryptor: Encryptor;
  logger: Logger;
  fetch?: FetchLike;
  now?: () => number;
}

/**
 * Evalúa las reglas de alertas de cada tenant sobre el flujo de eventos y los cambios de estado.
 * Entrega: panel (alert_event + SSE), nativa (el cliente Tauri la muestra) y webhook de Discord.
 */
export class AlertEngine {
  private readonly cache = new Map<string, { at: number; rules: Rule[] }>();
  private readonly loading = new Map<string, Promise<Rule[]>>();
  private readonly viewers = new Map<string, Sample[]>();
  private readonly lastFired = new Map<string, number>();
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly heartbeats = new Map<string, { at: number; alerted: boolean }>();
  private readonly unsub: (() => void)[] = [];
  private sweep?: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private readonly f: FetchLike;

  constructor(private readonly o: AlertEngineOptions) {
    this.now = o.now ?? Date.now;
    this.f = o.fetch ?? ((i, n) => fetch(i, n));
  }

  attach(pipeline: IngestPipeline, supervisor: Supervisor): void {
    this.unsub.push(pipeline.addTap((e) => void this.onEvent(e)));
    this.unsub.push(supervisor.addStatusListener((spec, status) => void this.onStatus(spec, status)));
    this.sweep = setInterval(() => void this.checkHeartbeats(), 30_000);
    this.sweep.unref?.();
  }

  close(): void {
    for (const u of this.unsub) u();
    this.unsub.length = 0;
    if (this.sweep) clearInterval(this.sweep);
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
  }

  /** Las rutas llaman a esto al crear/editar/borrar reglas. */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
    this.loading.delete(tenantId);
  }

  private rules(tenantId: string): Promise<Rule[]> {
    const hit = this.cache.get(tenantId);
    if (hit && this.now() - hit.at < RULES_TTL_MS) return Promise.resolve(hit.rules);
    // Las llamadas simultáneas comparten una sola consulta
    let p = this.loading.get(tenantId);
    if (!p) {
      p = withTenant(this.o.appDb, tenantId, (tx) => tx.select().from(schema.alertRule).where(eq(schema.alertRule.enabled, true)))
        .then((rows) => {
          const rules = rows.map((r) => ({
            id: r.id,
            type: r.type as AlertType,
            name: r.name,
            params: r.params,
            channels: r.channels,
            webhookUrlEnc: r.webhookUrlEnc,
          }));
          this.cache.set(tenantId, { at: this.now(), rules });
          return rules;
        })
        .finally(() => this.loading.delete(tenantId));
      this.loading.set(tenantId, p);
    }
    return p;
  }

  private cooldownOk(key: string, sec: number): boolean {
    const last = this.lastFired.get(key) ?? 0;
    if (this.now() - last < sec * 1000) return false;
    this.lastFired.set(key, this.now());
    return true;
  }

  // --- Eventos -----------------------------------------------------------------
  async onEvent(e: NormalizedEvent): Promise<void> {
    if (e.type !== "donation" && e.type !== "viewer_count") return;
    // La muestra se registra de forma síncrona (antes de cualquier await) para conservar el orden de llegada
    if (e.type === "viewer_count") this.recordViewer(e);
    try {
      const rules = await this.rules(e.tenantId);
      if (e.type === "donation") {
        const usd = donationUsdMinor(e.payload);
        for (const r of rules.filter((x) => x.type === "donation_over")) {
          if (usd >= r.params.thresholdUsd * 100 && this.cooldownOk(`${r.id}|${e.channelId}`, r.params.cooldownSec ?? 5)) {
            const who = e.actor?.name ?? "Alguien";
            await this.fire(e.tenantId, r, `${who} envió una donación de ≈ $${(usd / 100).toFixed(2)} en ${e.platform}`, {
              platform: e.platform,
              channelId: e.channelId,
              usdMinor: usd,
              actor: e.actor?.name ?? null,
            });
          }
        }
      } else {
        await this.checkViewerDrop(e, rules);
      }
    } catch (err) {
      this.o.logger.error({ err, tenantId: e.tenantId }, "falló la evaluación de alertas");
    }
  }

  private recordViewer(e: Extract<NormalizedEvent, { type: "viewer_count" }>): void {
    const key = `${e.tenantId}|${e.platform}|${e.channelId}`;
    const t = e.occurredAt.getTime();
    const arr = this.viewers.get(key) ?? [];
    arr.push({ t, v: e.payload.viewers });
    const maxWindow = 60 * 60_000;
    while (arr.length && arr[0]!.t < t - maxWindow) arr.shift();
    this.viewers.set(key, arr);
  }

  private async checkViewerDrop(e: Extract<NormalizedEvent, { type: "viewer_count" }>, rules: Rule[]): Promise<void> {
    const key = `${e.tenantId}|${e.platform}|${e.channelId}`;
    const t = e.occurredAt.getTime();
    const arr = this.viewers.get(key) ?? [];

    for (const r of rules.filter((x) => x.type === "viewers_drop")) {
      // Solo las muestras hasta este instante (la evaluación puede ocurrir después de que lleguen otras)
      const win = arr.filter((s) => s.t >= t - r.params.windowMin * 60_000 && s.t <= t);
      const peak = Math.max(0, ...win.map((s) => s.v));
      if (peak < r.params.minViewers) continue;
      const drop = ((peak - e.payload.viewers) / peak) * 100;
      if (drop >= r.params.dropPercent && this.cooldownOk(`${r.id}|${key}`, r.params.cooldownSec ?? 900)) {
        await this.fire(
          e.tenantId,
          r,
          `Los espectadores de ${e.channelId} (${e.platform}) cayeron un ${Math.round(drop)}%: de ${peak} a ${e.payload.viewers}`,
          {
            platform: e.platform,
            channelId: e.channelId,
            from: peak,
            to: e.payload.viewers,
          },
        );
      }
    }
  }

  // --- Estado de conexiones -------------------------------------------------------
  private async onStatus(spec: ConnectionSpec, status: ConnectionStatus): Promise<void> {
    const key = `${spec.tenantId}|${spec.id}`;
    // Si se recupera (o se apaga a propósito) dentro del margen, se cancela el aviso pendiente
    const pending = this.graceTimers.get(key);
    if (pending && (status === "live" || status === "connecting")) {
      clearTimeout(pending);
      this.graceTimers.delete(key);
    }
    if (status !== "error" && status !== "rate_limited") return;
    try {
      const rules = (await this.rules(spec.tenantId)).filter((r) => r.type === "platform_disconnect");
      for (const r of rules) {
        if (this.graceTimers.has(key)) continue;
        const timer = setTimeout(
          () => {
            this.graceTimers.delete(key);
            if (this.cooldownOk(`${r.id}|${spec.id}`, r.params.cooldownSec ?? 300)) {
              void this.fire(spec.tenantId, r, `${spec.channelId} (${spec.platform}) perdió la conexión`, {
                platform: spec.platform,
                channelId: spec.channelId,
                status,
              }).catch((err) => this.o.logger.error({ err }, "falló el envío de la alerta"));
            }
          },
          (r.params.graceSec ?? 30) * 1000,
        );
        timer.unref?.();
        this.graceTimers.set(key, timer);
      }
    } catch (err) {
      this.o.logger.error({ err }, "falló la evaluación de alertas de estado");
    }
  }

  // --- Heartbeat --------------------------------------------------------------------
  noteHeartbeat(tenantId: string, source: string): void {
    this.heartbeats.set(`${tenantId}|${source}`, { at: this.now(), alerted: false });
  }

  async checkHeartbeats(): Promise<void> {
    for (const [key, hb] of this.heartbeats) {
      if (hb.alerted) continue;
      const [tenantId, source] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
      const rules = (await this.rules(tenantId)).filter(
        (r) => r.type === "heartbeat_lost" && (!r.params.source || r.params.source === source),
      );
      for (const r of rules) {
        if (this.now() - hb.at > r.params.afterSec * 1000 && this.cooldownOk(`${r.id}|${source}`, r.params.cooldownSec ?? 600)) {
          hb.alerted = true; // una sola vez por silencio; se rearma con el siguiente latido
          await this.fire(tenantId, r, `Sin señal de «${source}» desde hace más de ${r.params.afterSec} s`, {
            source,
            lastSeen: new Date(hb.at).toISOString(),
          });
        }
      }
    }
  }

  // --- Entrega ------------------------------------------------------------------------
  async fire(
    tenantId: string,
    rule: Pick<Rule, "id" | "type" | "name" | "channels" | "webhookUrlEnc">,
    message: string,
    data: Record<string, unknown>,
  ): Promise<AlertPayload> {
    const alert: AlertPayload = {
      id: crypto.randomUUID(),
      ruleId: rule.id,
      ruleName: rule.name,
      type: rule.type,
      message,
      at: new Date(this.now()).toISOString(),
      channels: rule.channels,
      data,
    };
    await withTenant(this.o.appDb, tenantId, (tx) =>
      tx.insert(schema.alertEvent).values({
        id: alert.id,
        tenantId,
        ruleId: rule.id,
        data: { message, type: rule.type, ruleName: rule.name, channels: rule.channels, ...data },
      }),
    );
    if (rule.channels.includes("panel") || rule.channels.includes("native")) {
      void this.o.bus.publish({ kind: "alert", tenantId, alert });
    }
    if (rule.channels.includes("webhook") && rule.webhookUrlEnc) {
      void this.sendDiscord(rule.webhookUrlEnc, alert).catch((err) =>
        this.o.logger.warn({ err: (err as Error).message, rule: rule.id }, "falló el webhook de Discord"),
      );
    }
    return alert;
  }

  /** Envía a Discord con tiempo límite; la URL se revalida al enviar (defensa en profundidad). */
  async sendDiscord(enc: Uint8Array, alert: AlertPayload): Promise<void> {
    const url = this.o.encryptor.decrypt(enc);
    if (!isAllowedWebhookUrl(url)) throw new Error("URL de webhook no permitida");
    const res = await this.f(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "HiveMonitor",
        allowed_mentions: { parse: [] }, // un texto de usuario nunca debe mencionar a @everyone
        embeds: [
          {
            title: alert.ruleName,
            description: alert.message.slice(0, 1800),
            color: alert.type === "donation_over" ? 0x4cc38a : 0xe0a93a,
            timestamp: alert.at,
          },
        ],
      }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`Discord respondió ${res.status}`);
  }
}
