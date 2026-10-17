import type {
  AlertPayload,
  Client,
  ConnectionStatus,
  HeartbeatSource,
  LiveChannel,
  NormalizedEvent,
  Platform,
  RuntimeConnection,
  StreamMessage,
} from "@hivemonitor/client";

export interface ViewerPoint {
  t: number;
  v: number;
}

const MAX_EVENTS = 300;
const MAX_CHAT = 500;
const HISTORY_MS = 3 * 60 * 60_000;
/** Mínimo entre puntos de la gráfica por plataforma (evita crecer sin límite). */
const POINT_GAP_MS = 5_000;

/** Estado en tiempo real de la organización activa, alimentado por el SSE del servidor. */
class LiveState {
  link = $state<"connecting" | "open" | "closed">("connecting");
  connections = $state<RuntimeConnection[]>([]);
  channels = $state<LiveChannel[]>([]);
  events = $state<NormalizedEvent[]>([]);
  chat = $state<NormalizedEvent[]>([]);
  history = $state<Record<string, ViewerPoint[]>>({});
  /** Alertas recientes (avisos en pantalla). */
  toasts = $state<AlertPayload[]>([]);
  /** Último latido por fuente (apps del ecosistema, OBS…). */
  heartbeats = $state<Record<string, HeartbeatSource>>({});
  /** Reloj para duraciones; se actualiza cada segundo. */
  now = $state(Date.now());

  private stream?: { close(): void };
  private clock?: ReturnType<typeof setInterval>;
  private client?: Client;
  private orgId?: string;
  private listeners = new Set<(e: NormalizedEvent) => void>();
  private alertListeners = new Set<(a: AlertPayload) => void>();

  /** Suscripción a eventos nuevos (p. ej. notificaciones nativas). Devuelve la baja. */
  onEvent(fn: (e: NormalizedEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Suscripción a alertas nuevas (notificaciones nativas). Devuelve la baja. */
  onAlert(fn: (a: AlertPayload) => void): () => void {
    this.alertListeners.add(fn);
    return () => this.alertListeners.delete(fn);
  }

  dismissToast(id: string) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  start(client: Client, orgId: string) {
    if (this.orgId === orgId && this.stream) return;
    this.stop();
    this.client = client;
    this.orgId = orgId;
    this.reset();
    this.clock = setInterval(() => (this.now = Date.now()), 1000);
    this.stream = client.tenant(orgId).stream((m) => this.handle(m));
    void client
      .tenant(orgId)
      .heartbeat.sources()
      .then((r) => {
        if (this.orgId !== orgId) return;
        for (const s of r.sources) this.heartbeats[s.source] = s;
      })
      .catch(() => {});
  }

  stop() {
    this.stream?.close();
    this.stream = undefined;
    if (this.clock) clearInterval(this.clock);
    this.clock = undefined;
    this.orgId = undefined;
    this.reset();
  }

  private reset() {
    this.connections = [];
    this.channels = [];
    this.events = [];
    this.chat = [];
    this.history = {};
    this.toasts = [];
    this.heartbeats = {};
    this.link = "connecting";
  }

  private handle(m: StreamMessage) {
    switch (m.type) {
      case "state":
        this.link = m.state;
        break;
      case "alert": {
        if (m.data.channels.includes("panel")) this.toasts = [m.data, ...this.toasts].slice(0, 5);
        for (const fn of this.alertListeners) {
          try {
            fn(m.data);
          } catch {
            /* un oyente roto no afecta al resto */
          }
        }
        break;
      }
      case "heartbeat":
        this.heartbeats[m.data.source] = { source: m.data.source, at: m.data.at, metrics: m.data.metrics };
        break;
      case "snapshot": {
        this.connections = m.data.connections;
        this.channels = m.data.channels;
        this.events = [];
        this.chat = [];
        this.history = {};
        for (const e of m.data.recent) this.ingest({ ...e, occurredAt: new Date(e.occurredAt) } as NormalizedEvent, false);
        break;
      }
      case "event":
        this.ingest(m.data, true);
        break;
      case "status": {
        const { platform, channelId, status, detail, at } = m.data;
        const i = this.connections.findIndex((c) => c.platform === platform && c.channelId === channelId);
        if (i >= 0) this.connections[i] = { ...this.connections[i]!, status, detail, since: at };
        else void this.refreshLive();
        if (status === "offline") this.channels = this.channels.filter((c) => !(c.platform === platform && c.channelId === channelId));
        break;
      }
    }
  }

  private ingest(e: NormalizedEvent, fresh: boolean) {
    if (e.type === "viewer_count") {
      this.pushViewer(e.platform, e.occurredAt.getTime(), e.payload.viewers);
      const ch = this.channels.find((c) => c.platform === e.platform && c.channelId === e.channelId);
      if (ch) {
        ch.viewers = e.payload.viewers;
        ch.peakViewers = Math.max(ch.peakViewers, e.payload.viewers);
      }
    } else if (e.type === "chat") {
      this.chat.push(e);
      if (this.chat.length > MAX_CHAT) this.chat.splice(0, this.chat.length - MAX_CHAT);
    } else {
      this.events.push(e);
      if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    if (!fresh) return;

    // Contadores de la sesión en curso derivados del flujo (el snapshot trae el valor inicial)
    const ch = this.channels.find((c) => c.platform === e.platform && c.channelId === e.channelId);
    if (ch) {
      const k = ch.counters;
      if (e.type === "chat") k.messages++;
      else if (e.type === "like") k.likes += e.payload.count;
      else if (e.type === "share") k.shares++;
      else if (e.type === "follow") k.followers++;
      else if (e.type === "subscription") k.subscriptions++;
      else if (e.type === "donation") k.donations[e.payload.currency] = (k.donations[e.payload.currency] ?? 0) + e.payload.amountMinor;
    }
    if (e.type === "stream_start" || (e.type !== "stream_end" && !ch)) void this.refreshLive();
    if (e.type === "stream_end") this.channels = this.channels.filter((c) => !(c.platform === e.platform && c.channelId === e.channelId));
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* un oyente roto no afecta al resto */
      }
    }
  }

  private pushViewer(platform: Platform, t: number, v: number) {
    const arr = (this.history[platform] ??= []);
    const last = arr[arr.length - 1];
    if (last && t - last.t < POINT_GAP_MS) {
      last.v = v;
      return;
    }
    arr.push({ t, v });
    const cutoff = t - HISTORY_MS;
    while (arr.length && arr[0]!.t < cutoff) arr.shift();
  }

  private refreshing = false;
  async refreshLive() {
    if (this.refreshing || !this.client || !this.orgId) return;
    this.refreshing = true;
    try {
      const live = await this.client.tenant(this.orgId).live();
      this.channels = live.channels;
      this.connections = live.connections;
    } catch {
      /* se reintentará con el siguiente evento */
    } finally {
      this.refreshing = false;
    }
  }

  statusOf(platform: Platform): ConnectionStatus | null {
    const conns = this.connections.filter((c) => c.platform === platform);
    if (!conns.length) return null;
    for (const s of ["live", "connecting", "rate_limited", "error", "offline"] as const) if (conns.some((c) => c.status === s)) return s;
    return "offline";
  }
}

export const live = new LiveState();
