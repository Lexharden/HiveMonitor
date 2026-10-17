const nf = new Intl.NumberFormat("es");
export const fmtNumber = (n: number) => nf.format(n);

export function fmtCompact(n: number): string {
  return new Intl.NumberFormat("es", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** 3725 s → "1:02:05" */
export function fmtDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(ss).padStart(2, "0")}`;
}

export const fmtTime = (d: Date | string | number) =>
  new Date(d).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * Importe en unidad menor → texto. Las monedas del sistema (gemas de TikTok, bits) se muestran
 * como cantidades enteras; las fiat en su moneda.
 */
export function fmtMoney(amountMinor: number, currency: string): string {
  if (currency === "TIKTOK_COIN") return `${fmtNumber(amountMinor)} monedas`;
  if (currency === "BITS") return `${fmtNumber(amountMinor)} bits`;
  try {
    return new Intl.NumberFormat("es", { style: "currency", currency }).format(amountMinor / 100);
  } catch {
    return `${amountMinor / 100} ${currency}`;
  }
}
