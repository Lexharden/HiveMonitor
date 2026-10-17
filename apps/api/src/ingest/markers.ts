import type { EventBus, MarkerPayload, NormalizedEvent } from "@hivemonitor/core";
import { schema, withTenant, type Database } from "@hivemonitor/db";
import type { Logger } from "../logger.ts";
import { donationUsdMinor } from "./aggregator.ts";

export interface MarkerOptions {
  appDb: Database;
  bus: EventBus;
  logger: Logger;
  /** Donación (USD) a partir de la cual se marca el momento. */
  bigDonationUsd?: number;
  now?: () => number;
}

interface Sample {
  t: number;
  v: number;
}

const SPIKE_WINDOW_MS = 3 * 60_000;
const SPIKE_COOLDOWN_MS = 5 * 60_000;
const SPIKE_RATIO = 1.25;
const SPIKE_MIN_DELTA = 10;

/**
 * Detecta momentos destacados del directo y los guarda (y publica) como marcadores:
 * raids, donaciones grandes y picos bruscos de espectadores. Observa el pipeline como un tap más.
 */
export class MarkerDetector {
  private readonly samples = new Map<string, Sample[]>();
  private readonly lastSpike = new Map<string, number>();
  private readonly bigDonationMinor: number;
  private readonly now: () => number;

  constructor(private readonly o: MarkerOptions) {
    this.bigDonationMinor = Math.round((o.bigDonationUsd ?? 10) * 100);
    this.now = o.now ?? Date.now;
  }

  /** Para enganchar con `pipeline.addTap(detector.tap)`. */
  readonly tap = (e: NormalizedEvent): void => {
    const marker = this.detect(e);
    if (marker) void this.save(e.tenantId, marker).catch((err) => this.o.logger.error({ err }, "no se pudo guardar el marcador"));
  };

  private detect(e: NormalizedEvent): Omit<MarkerPayload, "id" | "at"> | null {
    const where = { platform: e.platform, channelId: e.channelId };
    switch (e.type) {
      case "raid":
        return {
          kind: "raid",
          label: `Raid de ${e.payload.fromChannel ?? e.actor?.name ?? "otro canal"} (${e.payload.viewers})`,
          ...where,
        };
      case "donation": {
        const usd = donationUsdMinor(e.payload);
        if (usd < this.bigDonationMinor) return null;
        return { kind: "donation", label: `${e.actor?.name ?? "Alguien"} · ≈ $${(usd / 100).toFixed(2)}`, ...where };
      }
      case "viewer_count":
        return this.detectSpike(e);
      default:
        return null;
    }
  }

  private detectSpike(e: Extract<NormalizedEvent, { type: "viewer_count" }>): Omit<MarkerPayload, "id" | "at"> | null {
    const key = `${e.tenantId}|${e.platform}|${e.channelId}`;
    const t = e.occurredAt.getTime();
    const arr = this.samples.get(key) ?? [];
    const base = arr.filter((s) => s.t >= t - SPIKE_WINDOW_MS);
    arr.push({ t, v: e.payload.viewers });
    this.samples.set(
      key,
      arr.filter((s) => s.t >= t - SPIKE_WINDOW_MS),
    );
    if (base.length < 3) return null; // sin referencia suficiente (inicio del directo)

    const floor = Math.min(...base.map((s) => s.v));
    const delta = e.payload.viewers - floor;
    if (delta < SPIKE_MIN_DELTA || e.payload.viewers < floor * SPIKE_RATIO) return null;
    if (this.now() - (this.lastSpike.get(key) ?? 0) < SPIKE_COOLDOWN_MS) return null;
    this.lastSpike.set(key, this.now());
    return {
      kind: "viewers_spike",
      label: `Pico de espectadores: +${delta} (${floor} → ${e.payload.viewers})`,
      platform: e.platform,
      channelId: e.channelId,
    };
  }

  /** Marcador manual (botón del cockpit) o detectado. */
  async save(
    tenantId: string,
    m: Omit<MarkerPayload, "id" | "at">,
    createdBy: string | null = null,
    at = new Date(this.now()),
  ): Promise<MarkerPayload> {
    const marker: MarkerPayload = { id: crypto.randomUUID(), at: at.toISOString(), ...m };
    await withTenant(this.o.appDb, tenantId, (tx) =>
      tx.insert(schema.streamMarker).values({
        id: marker.id,
        tenantId,
        at,
        kind: marker.kind,
        label: marker.label,
        platform: marker.platform ?? null,
        channelId: marker.channelId ?? null,
        createdBy,
      }),
    );
    void this.o.bus.publish({ kind: "marker", tenantId, marker });
    return marker;
  }
}
