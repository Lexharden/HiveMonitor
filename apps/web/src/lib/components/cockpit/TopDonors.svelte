<script lang="ts">
  import { SvelteMap } from "svelte/reactivity";
  import { fmtMoney, fmtUsd } from "#lib/format.ts";
  import { t } from "#lib/i18n.ts";
  import { live } from "#lib/stores/live.svelte.ts";

  interface Row {
    id: string;
    name: string;
    usdMinor: number;
    byCurrency: Record<string, number>;
  }

  // Multistream: el mismo donador puede aparecer en varias plataformas; se suman
  const rows = $derived.by(() => {
    const m = new SvelteMap<string, Row>();
    for (const c of live.channels)
      for (const d of c.topDonors ?? []) {
        const r = m.get(d.id) ?? { id: d.id, name: d.name, usdMinor: 0, byCurrency: {} };
        r.usdMinor += d.usdMinor;
        for (const [cur, v] of Object.entries(d.byCurrency)) r.byCurrency[cur] = (r.byCurrency[cur] ?? 0) + v;
        m.set(d.id, r);
      }
    const total = (r: Row) => Object.values(r.byCurrency).reduce((n, v) => n + v, 0);
    return [...m.values()].sort((a, b) => b.usdMinor - a.usdMinor || total(b) - total(a)).slice(0, 5);
  });

  const amount = (r: Row) =>
    Object.entries(r.byCurrency)
      .map(([cur, v]) => fmtMoney(v, cur))
      .join(" + ");
</script>

<section class="card" aria-label={t("ck.topDonors")}>
  <h2 class="border-b border-border px-4 py-2 font-medium">{t("ck.topDonors")}</h2>
  {#if rows.length === 0}
    <p class="p-4 text-sm text-fg-3">{t("ck.noDonors")}</p>
  {:else}
    <ol>
      {#each rows as r, i (r.id)}
        <li class="flex items-center gap-3 border-b border-border/60 px-4 py-2 last:border-0">
          <span class="w-5 text-center text-sm font-bold {i === 0 ? 'text-warn' : 'text-fg-3'}">{i + 1}</span>
          <span class="min-w-0 flex-1 truncate font-medium">{r.name}</span>
          <span class="text-right text-sm tabular-nums"
            >{amount(r)}{#if r.usdMinor > 0}<span class="block text-xs text-fg-3">≈ {fmtUsd(r.usdMinor)}</span>{/if}</span
          >
        </li>
      {/each}
    </ol>
  {/if}
</section>
