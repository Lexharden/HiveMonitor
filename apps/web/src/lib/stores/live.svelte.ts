import type {
  AlertPayload,
  Client,
  ConnectionStatus,
  Goal,
  HeartbeatSource,
  LiveChannel,
  MarkerPayload,
  NormalizedEvent,
  Platform,
  RuntimeConnection,
  StreamMessage,
} from "@hivemonitor/client";
import { bumpDonor, usdOf } from "#lib/donors.ts";
import { classify, type HighlightKind } from "#lib/highlight.ts";
import { kv } from "#lib/platform.ts";

export interface ViewerPoint {
  t: number;
  v: number;
}

const MAX_EVENTS = 300;
const MAX_CHAT = 500;
const MAX_MARKERS = 100;
const HISTORY_MS = 3 * 60 * 60_000;
/** Mínimo entre puntos de la gráfica por plataforma (evita crecer sin límite). */
const POINT_GAP_MS = 5_000;
const STAMP_WINDOW_MS = 10 * 60_000;
const MUTE_KEY = "alerts_muted";

/** Tipos de evento de los que se calcula el ritmo (por minuto). */
export type RateKind = "chat" | "like" | "follow" | "donation" | "share" | "subscription";

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
  /** Momentos marcados (manuales y detectados), el más reciente primero. */
  markers = $state<MarkerPayload[]>([]);
  /** Meta de donaciones configurada (el progreso sale de las donaciones de la sesión). */
  goal = $state<Goal | null>(null);
  /** Silencia avisos en pantalla y notificaciones nativas mientras transmites (solo en este dispositivo). */
  muted = $state(false);
  /** Reloj para duraciones; se actualiza cada segundo. */
  now = $state(Date.now());
  /** Resaltado de cada mensaje de chat (por id), calculado al llegar. */
  chatHl = $state<Record<string, HighlightKind[]>>({});

  private stream?: { close(): void };
  private clock?: ReturnType<typeof setInterval>;
  private client?: Client;
  private orgId?: string;
  private listeners = new Set<(e: NormalizedEvent) => void>();
  private alertListeners = new Set<(a: AlertPayload) => void>();
  private stamps: Record<string, { t: number; n: number }[]> = {};
  private donorIds = new Set<string>();
  private chatters = new Set<string>();

  constructor() {
    void kv.get(MUTE_KEY).then((v) => (this.muted = v === "1"));
  }

  async setMuted(v: boolean) {
    this.muted = v;
    if (v) this.toasts = [];
    await kv.set(MUTE_KEY, v ? "1" : null);
  }

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
    const api = client.tenant(orgId);
    void api.heartbeat
      .sources()
      .then((r) => {
        if (this.orgId !== orgId) return;
        for (const s of r.sources) this.heartbeats[s.source] = s;
      })
      .catch(() => {});
    void api.markers
      .list(12)
      .then((r) => {
        if (this.orgId === orgId) this.markers = r.markers.slice(0, MAX_MARKERS);
      })
      .catch(() => {});
    void api.goal
      .get()
      .then((r) => {
        if (this.orgId === orgId) this.goal = r.goal;
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
    this.markers = [];
    this.goal = null;
    this.chatHl = {};
    this.stamps = {};
    this.donorIds = new Set();
    this.chatters = new Set();
    this.link = "connecting";
  }

  private handle(m: StreamMessage) {
    switch (m.type) {
      case "state":
        this.link = m.state;
        break;
      case "alert": {
        if (!this.muted && m.data.channels.includes("panel")) this.toasts = [m.data, ...this.toasts].slice(0, 5);
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
      case "marker":
        if (!this.markers.some((x) => x.id === m.data.id)) this.markers = [m.data, ...this.markers].slice(0, MAX_MARKERS);
        break;
      case "snapshot": {
        this.connections = m.data.connections;
        this.channels = m.data.channels;
        this.events = [];
        this.chat = [];
        this.chatHl = {};
        this.history = {};
        this.donorIds = new Set(this.channels.flatMap((c) => (c.topDonors ?? []).map((d) => d.id)));
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

  /** Nombres de los canales conectados (minúsculas), para detectar menciones. */
  private channelNames(): string[] {
    return this.connections.map((c) => c.channelId.toLowerCase());
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
      const uid = e.actor?.id ?? null;
      const isFirst = uid !== null && !this.chatters.has(uid);
      if (uid) this.chatters.add(uid);
      const kinds = classify(
        { userId: uid, text: e.payload.message, badges: e.payload.badges },
        { donorIds: this.donorIds, isFirst, channelNames: this.channelNames() },
      );
      if (kinds.length) this.chatHl[e.id] = kinds;
      this.chat.push(e);
      if (this.chat.length > MAX_CHAT) {
        for (const old of this.chat.splice(0, this.chat.length - MAX_CHAT)) delete this.chatHl[old.id];
      }
    } else {
      this.events.push(e);
      if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    if (e.type === "donation" && e.actor) this.donorIds.add(e.actor.id);
    if (!fresh) return;

    this.stamp(e);
    // Contadores de la sesión en curso derivados del flujo (el snapshot trae el valor inicial)
    const ch = this.channels.find((c) => c.platform === e.platform && c.channelId === e.channelId);
    if (ch) {
      const k = ch.counters;
      if (e.type === "chat") k.messages++;
      else if (e.type === "like") k.likes += e.payload.count;
      else if (e.type === "share") k.shares++;
      else if (e.type === "follow") k.followers++;
      else if (e.type === "subscription") k.subscriptions++;
      else if (e.type === "donation") {
        k.donations[e.payload.currency] = (k.donations[e.payload.currency] ?? 0) + e.payload.amountMinor;
        k.donationsUsdMinor = (k.donationsUsdMinor ?? 0) + usdOf(e.payload);
        if (e.actor) ch.topDonors = bumpDonor(ch.topDonors ?? [], e.actor, e.payload);
      }
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

  // --- Ritmo del directo ----------------------------------------------------------
  private stamp(e: NormalizedEvent) {
    let kind: RateKind | null = null;
    let n = 1;
    switch (e.type) {
      case "chat":
      case "follow":
      case "share":
      case "subscription":
      case "donation":
        kind = e.type;
        break;
      case "like":
        kind = "like";
        n = e.payload.count;
        break;
    }
    if (!kind) return;
    const arr = (this.stamps[kind] ??= []);
    const t = Date.now();
    arr.push({ t, n });
    while (arr.length && arr[0]!.t < t - STAMP_WINDOW_MS) arr.shift();
  }

  /** Eventos por minuto en la última ventana (por defecto 60 s). Depende de `now`, así que se actualiza cada segundo. */
  rate(kind: RateKind, windowMs = 60_000, offsetMs = 0): number {
    const end = this.now - offsetMs;
    const start = end - windowMs;
    let sum = 0;
    for (const s of this.stamps[kind] ?? []) if (s.t > start && s.t <= end) sum += s.n;
    return Math.round((sum * 60_000) / windowMs);
  }

  /** Serie para el sparkline: `buckets` intervalos de `bucketMs`, del más antiguo al más reciente. */
  series(kind: RateKind, buckets = 30, bucketMs = 10_000): number[] {
    const out = new Array<number>(buckets).fill(0);
    const end = this.now;
    for (const s of this.stamps[kind] ?? []) {
      const idx = buckets - 1 - Math.floor((end - s.t) / bucketMs);
      if (idx >= 0 && idx < buckets) out[idx]! += s.n;
    }
    return out;
  }

  /** Variación de viewers de una plataforma respecto a hace `agoMs` (null si no hay referencia). */
  viewerDelta(platform: Platform, agoMs = 5 * 60_000): number | null {
    const arr = this.history[platform];
    if (!arr?.length) return null;
    const last = arr[arr.length - 1]!;
    const target = last.t - agoMs;
    const ref = [...arr].reverse().find((p) => p.t <= target) ?? (arr[0]!.t < last.t - 30_000 ? arr[0] : undefined);
    return ref ? last.v - ref.v : null;
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

  // --- Acciones del cockpit -------------------------------------------------------------
  async mark(label?: string): Promise<boolean> {
    if (!this.client || !this.orgId) return false;
    try {
      const { marker } = await this.client.tenant(this.orgId).markers.create(label);
      if (!this.markers.some((x) => x.id === marker.id)) this.markers = [marker, ...this.markers].slice(0, MAX_MARKERS);
      return true;
    } catch {
      return false;
    }
  }

  async removeMarker(id: string): Promise<void> {
    if (!this.client || !this.orgId) return;
    await this.client.tenant(this.orgId).markers.remove(id);
    this.markers = this.markers.filter((m) => m.id !== id);
  }

  async saveGoal(goal: Goal | null): Promise<void> {
    if (!this.client || !this.orgId) return;
    this.goal = (await this.client.tenant(this.orgId).goal.set(goal)).goal;
  }
}

export const live = new LiveState();
