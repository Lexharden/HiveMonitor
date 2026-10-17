import type { NormalizedEvent } from "@hivemonitor/core";

/** Acumulado de una hora (UTC) de un canal/plataforma, pendiente de volcar a la base de datos. */
export interface HourDelta {
  tenantId: string;
  platform: string;
  /** Inicio de la hora, epoch ms (UTC). */
  hour: number;
  peak: number;
  viewerSum: number;
  viewerSamples: number;
  /** Donaciones en céntimos de USD (equivalente). */
  donationsMinor: number;
  messages: number;
  followers: number;
}

const HOUR = 3_600_000;

/**
 * Equivalente en USD (unidad menor) de una donación para las estadísticas. Las monedas del sistema
 * (monedas de TikTok, bits) usan su estimación; las fiat solo cuentan si ya son USD (no hay conversión de divisas).
 */
export function donationUsdMinor(p: { amountMinor: number; currency: string; usdMinorEstimate?: number }): number {
  if (p.usdMinorEstimate !== undefined) return p.usdMinorEstimate;
  return p.currency === "USD" ? p.amountMinor : 0;
}

/**
 * Agrega eventos en memoria por hora. Ve TODOS los eventos (también los `viewer_count` que la
 * persistencia muestrea), de modo que pico y media son exactos. Se vuelca por deltas aditivos.
 */
export class Aggregator {
  private deltas = new Map<string, HourDelta>();

  add(e: NormalizedEvent): void {
    if (e.type !== "viewer_count" && e.type !== "chat" && e.type !== "follow" && e.type !== "donation") return;
    const hour = Math.floor(e.occurredAt.getTime() / HOUR) * HOUR;
    const key = `${e.tenantId}|${e.platform}|${hour}`;
    let d = this.deltas.get(key);
    if (!d) {
      d = {
        tenantId: e.tenantId,
        platform: e.platform,
        hour,
        peak: 0,
        viewerSum: 0,
        viewerSamples: 0,
        donationsMinor: 0,
        messages: 0,
        followers: 0,
      };
      this.deltas.set(key, d);
    }
    switch (e.type) {
      case "viewer_count":
        d.peak = Math.max(d.peak, e.payload.viewers);
        d.viewerSum += e.payload.viewers;
        d.viewerSamples++;
        break;
      case "chat":
        d.messages++;
        break;
      case "follow":
        d.followers++;
        break;
      case "donation":
        d.donationsMinor += donationUsdMinor(e.payload);
        break;
    }
  }

  /** Entrega lo acumulado y empieza de cero. */
  drain(): HourDelta[] {
    const out = [...this.deltas.values()];
    this.deltas = new Map();
    return out;
  }

  /** Devuelve deltas no volcados (fallo transitorio) fusionándolos con lo nuevo. */
  restore(ds: HourDelta[]): void {
    for (const d of ds) {
      const key = `${d.tenantId}|${d.platform}|${d.hour}`;
      const cur = this.deltas.get(key);
      if (!cur) this.deltas.set(key, d);
      else {
        cur.peak = Math.max(cur.peak, d.peak);
        cur.viewerSum += d.viewerSum;
        cur.viewerSamples += d.viewerSamples;
        cur.donationsMinor += d.donationsMinor;
        cur.messages += d.messages;
        cur.followers += d.followers;
      }
    }
  }
}

export interface DayDelta extends Omit<HourDelta, "hour"> {
  /** `YYYY-MM-DD` (UTC). */
  day: string;
}

/** Agrupa deltas horarios por día UTC (los acumulados son aditivos, el pico es el máximo). */
export function toDays(hours: HourDelta[]): DayDelta[] {
  const map = new Map<string, DayDelta>();
  for (const h of hours) {
    const day = new Date(h.hour).toISOString().slice(0, 10);
    const key = `${h.tenantId}|${h.platform}|${day}`;
    const d = map.get(key);
    if (!d)
      map.set(key, {
        tenantId: h.tenantId,
        platform: h.platform,
        day,
        peak: h.peak,
        viewerSum: h.viewerSum,
        viewerSamples: h.viewerSamples,
        donationsMinor: h.donationsMinor,
        messages: h.messages,
        followers: h.followers,
      });
    else {
      d.peak = Math.max(d.peak, h.peak);
      d.viewerSum += h.viewerSum;
      d.viewerSamples += h.viewerSamples;
      d.donationsMinor += h.donationsMinor;
      d.messages += h.messages;
      d.followers += h.followers;
    }
  }
  return [...map.values()];
}
