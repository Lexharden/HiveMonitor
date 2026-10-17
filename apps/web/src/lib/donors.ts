import type { TopDonor } from "@hivemonitor/client";

/** Equivalente en USD (céntimos) de una donación, igual que en el servidor: estimación, o el importe si ya es USD. */
export const usdOf = (p: { amountMinor: number; currency: string; usdMinorEstimate?: number }) =>
  p.usdMinorEstimate ?? (p.currency === "USD" ? p.amountMinor : 0);

/** Suma una donación al top de donadores del canal (se mantienen 5). */
export function bumpDonor(
  list: TopDonor[],
  actor: { id: string; name: string },
  p: { amountMinor: number; currency: string; usdMinorEstimate?: number },
): TopDonor[] {
  const next = list.map((d) => ({ ...d, byCurrency: { ...d.byCurrency } }));
  let d = next.find((x) => x.id === actor.id);
  if (!d) next.push((d = { id: actor.id, name: actor.name, usdMinor: 0, byCurrency: {} }));
  d.name = actor.name;
  d.usdMinor += usdOf(p);
  d.byCurrency[p.currency] = (d.byCurrency[p.currency] ?? 0) + p.amountMinor;
  const total = (x: TopDonor) => Object.values(x.byCurrency).reduce((n, v) => n + v, 0);
  return next.sort((a, b) => b.usdMinor - a.usdMinor || total(b) - total(a)).slice(0, 5);
}
