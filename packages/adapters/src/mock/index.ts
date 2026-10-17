import {
  type AdapterContext,
  type AdapterFactory,
  type AdapterHandlers,
  type ConnectionStatus,
  type EventType,
  type ModerationRequest,
  type NormalizedEvent,
  type PlatformAdapter,
  parseEvent,
} from "@hivemonitor/core";

/** Evento grabado: se reproduce con `offsetMs` relativo al inicio de la sesión. */
export interface RecordedEvent {
  offsetMs: number;
  type: EventType;
  actor?: { id: string; name: string; avatar?: string | null } | null;
  payload: unknown;
}

export interface MockConfig {
  /** `synthetic` genera tráfico aleatorio reproducible; `replay` reproduce `events`. */
  mode?: "synthetic" | "replay";
  seed?: number;
  /** Intervalo del generador sintético (ms). */
  intervalMs?: number;
  /** Velocidad de reproducción (2 = el doble de rápido). */
  speed?: number;
  loop?: boolean;
  events?: RecordedEvent[];
  /** Simula que el canal no está en directo: connect() termina en `offline`. */
  offline?: boolean;
  /** Simula un fallo de conexión (lanza en connect()). */
  failConnect?: boolean;
  /** Número de intentos que fallan antes de conectar bien (para probar reconexión). */
  failFirst?: number;
}

/** PRNG determinista (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ["ana", "bruno", "carla", "dani", "eva", "fer", "gus", "hana", "ivo", "juli"];
const MESSAGES = ["hola!", "qué buen directo", "jajaja", "GG", "saludos desde México", "🔥🔥", "primera vez aquí", "clip eso"];
const GIFTS = ["Rose", "Heart", "Galaxy", "Lion"];

/** Dataset de ejemplo para el modo replay (≈ 40 s de directo). */
export function sampleSession(): RecordedEvent[] {
  const out: RecordedEvent[] = [{ offsetMs: 0, type: "stream_start", payload: { title: "Directo de ejemplo" } }];
  let viewers = 20;
  for (let i = 1; i <= 20; i++) {
    const t = i * 2000;
    viewers += i % 5 === 0 ? -3 : 4;
    out.push({ offsetMs: t, type: "viewer_count", payload: { viewers } });
    const name = NAMES[i % NAMES.length]!;
    out.push({ offsetMs: t + 300, type: "chat", actor: { id: `u_${name}`, name }, payload: { message: MESSAGES[i % MESSAGES.length]!, badges: [] } });
    if (i % 6 === 0) out.push({ offsetMs: t + 600, type: "follow", actor: { id: `u_${name}`, name }, payload: {} });
    if (i % 8 === 0) {
      out.push({
        offsetMs: t + 900,
        type: "donation",
        actor: { id: `u_${name}`, name },
        payload: { kind: "gift", giftName: GIFTS[i % GIFTS.length], count: 1, amountMinor: 100 * i, currency: "TIKTOK_COIN", usdMinorEstimate: i * 1 },
      });
    }
  }
  out.push({ offsetMs: 42_000, type: "stream_end", payload: { durationSec: 42 } });
  return out;
}

class MockAdapter implements PlatformAdapter {
  readonly platform;
  private state: ConnectionStatus = "offline";
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private interval?: ReturnType<typeof setInterval>;
  private seq = 0;
  private viewers = 25;
  private readonly rand: () => number;
  private readonly cfg: MockConfig;
  private attempts = 0;
  private live = false;

  constructor(
    private readonly ctx: AdapterContext,
    private readonly handlers: AdapterHandlers,
  ) {
    this.platform = ctx.platform;
    this.cfg = (ctx.config ?? {}) as MockConfig;
    this.rand = rng(this.cfg.seed ?? 1);
  }

  status() {
    return this.state;
  }

  private setStatus(status: ConnectionStatus, detail?: string) {
    this.state = status;
    this.handlers.onStatus({ status, at: new Date(), detail });
  }

  private emit(type: EventType, payload: unknown, actor: RecordedEvent["actor"] = null) {
    const event: NormalizedEvent = parseEvent({
      id: `mock_${this.ctx.tenantId}_${this.ctx.channelId}_${Date.now()}_${this.seq++}`,
      tenantId: this.ctx.tenantId,
      platform: this.platform,
      channelId: this.ctx.channelId,
      type,
      occurredAt: new Date(),
      actor,
      payload,
    });
    this.handlers.onEvent(event);
  }

  async connect() {
    this.setStatus("connecting");
    this.attempts++;
    if (this.cfg.failConnect || (this.cfg.failFirst && this.attempts <= this.cfg.failFirst)) {
      this.setStatus("error", "fallo simulado");
      throw new Error("fallo de conexión simulado");
    }
    if (this.cfg.offline) {
      this.setStatus("offline", "el canal no está en directo");
      return;
    }
    this.live = true;
    this.setStatus("live");
    if (this.cfg.mode === "replay") this.startReplay();
    else this.startSynthetic();
  }

  async disconnect() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    if (this.live) {
      this.live = false;
      this.emit("stream_end", {});
    }
    this.state = "offline";
  }

  async moderate(req: ModerationRequest) {
    this.emit("moderation", { action: req.action, targetId: req.targetId, reason: req.reason, durationSec: req.durationSec });
  }

  private startReplay() {
    const events = this.cfg.events ?? sampleSession();
    const speed = Math.max(this.cfg.speed ?? 1, 0.01);
    const last = Math.max(...events.map((e) => e.offsetMs), 0);
    const play = () => {
      for (const e of events) {
        const t = setTimeout(() => {
          this.timers.delete(t);
          if (!this.live) return;
          this.emit(e.type, e.payload, e.actor ?? null);
        }, e.offsetMs / speed);
        this.timers.add(t);
      }
      const end = setTimeout(() => {
        this.timers.delete(end);
        if (!this.live) return;
        if (this.cfg.loop) play();
        else {
          this.live = false;
          this.setStatus("offline", "fin de la grabación");
        }
      }, last / speed + 5);
      this.timers.add(end);
    };
    play();
  }

  private startSynthetic() {
    this.emit("stream_start", { title: "Directo simulado" });
    this.interval = setInterval(() => this.tick(), this.cfg.intervalMs ?? 1000);
  }

  private tick() {
    const r = this.rand();
    const name = NAMES[Math.floor(this.rand() * NAMES.length)]!;
    const actor = { id: `u_${name}`, name };
    this.viewers = Math.max(0, this.viewers + Math.round((this.rand() - 0.45) * 6));
    this.emit("viewer_count", { viewers: this.viewers });
    if (r < 0.7) this.emit("chat", { message: MESSAGES[Math.floor(this.rand() * MESSAGES.length)]!, badges: [] }, actor);
    else if (r < 0.8) this.emit("like", { count: 1 + Math.floor(this.rand() * 10) }, actor);
    else if (r < 0.88) this.emit("follow", {}, actor);
    else if (r < 0.95) {
      this.emit(
        "donation",
        { kind: "gift", giftName: GIFTS[Math.floor(this.rand() * GIFTS.length)], count: 1, amountMinor: 100 * (1 + Math.floor(this.rand() * 20)), currency: "TIKTOK_COIN" },
        actor,
      );
    } else this.emit("share", {}, actor);
  }
}

export const mockAdapterFactory: AdapterFactory = (ctx, handlers) => new MockAdapter(ctx, handlers);
