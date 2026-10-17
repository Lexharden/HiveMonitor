<script lang="ts">
  import type { Platform } from "@hivemonitor/client";
  import { fmtNumber, fmtTime } from "#lib/format.ts";
  import { t } from "#lib/i18n.ts";
  import type { ViewerPoint } from "#lib/stores/live.svelte.ts";

  let {
    history,
    now,
    rangeMs,
    axisFormat = (tm: number) => fmtTime(tm).slice(0, 5),
    tipFormat = fmtTime,
    title = t("dash.viewersOverTime"),
    height = 260,
  }: {
    history: Record<string, ViewerPoint[]>;
    now: number;
    rangeMs: number;
    /** Formato de las etiquetas del eje X y del tooltip (por defecto, hora). */
    axisFormat?: (t: number) => string;
    tipFormat?: (t: number) => string;
    title?: string;
    height?: number;
  } = $props();

  const ORDER: Platform[] = ["tiktok", "twitch", "youtube"];
  const COLOR: Record<Platform, string> = { tiktok: "var(--series-1)", twitch: "var(--series-2)", youtube: "var(--series-3)" };

  const H = $derived(height);
  const M = { top: 12, right: 76, bottom: 26, left: 44 };

  let width = $state(640);
  let showTable = $state(false);
  let hoverT = $state<number | null>(null);

  const t0 = $derived(now - rangeMs);
  const series = $derived(
    ORDER.map((p) => ({ platform: p, points: (history[p] ?? []).filter((pt) => pt.t >= t0) })).filter((s) => s.points.length > 0),
  );

  const yMax = $derived.by(() => {
    const max = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.v)));
    const pow = 10 ** Math.floor(Math.log10(max));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s * 4 >= max) ?? pow * 10;
    return step * 4;
  });
  const yTicks = $derived([0, 1, 2, 3, 4].map((i) => (yMax / 4) * i));

  const innerW = $derived(Math.max(10, width - M.left - M.right));
  const innerH = $derived(H - M.top - M.bottom);
  const x = (t: number) => M.left + ((t - t0) / rangeMs) * innerW;
  const y = (v: number) => M.top + innerH - (v / yMax) * innerH;

  const xTicks = $derived([0, 1, 2, 3].map((i) => t0 + (rangeMs / 3) * i));

  function path(points: ViewerPoint[]): string {
    return points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  }

  /** Último valor conocido de una serie en el instante t. */
  function valueAt(points: ViewerPoint[], tm: number): ViewerPoint | null {
    let found: ViewerPoint | null = null;
    for (const p of points) {
      if (p.t <= tm) found = p;
      else break;
    }
    return found;
  }

  function onMove(e: PointerEvent) {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    hoverT = Math.min(now, Math.max(t0, t0 + ((px - M.left) / innerW) * rangeMs));
  }

  const hover = $derived(
    hoverT === null
      ? null
      : {
          t: hoverT,
          rows: series.map((s) => ({ platform: s.platform, pt: valueAt(s.points, hoverT!) })).filter((r) => r.pt),
        },
  );

  // Etiquetas directas al final de cada línea, separadas para que no se pisen
  const endLabels = $derived.by(() => {
    const items = series
      .map((s) => ({ platform: s.platform, last: s.points[s.points.length - 1]! }))
      .sort((a, b) => y(a.last.v) - y(b.last.v));
    let prev = -Infinity;
    return items.map((it) => {
      const yy = Math.max(y(it.last.v), prev + 14);
      prev = yy;
      return { ...it, ly: yy };
    });
  });

  // Tabla: filas por intervalo regular
  const tableRows = $derived.by(() => {
    const n = 12;
    return Array.from({ length: n }, (_, i) => {
      const tm = now - (rangeMs / (n - 1)) * (n - 1 - i);
      return { tm, values: series.map((s) => valueAt(s.points, tm)?.v ?? null) };
    }).reverse();
  });

  const summary = $derived(
    series.map((s) => `${t(`platform.${s.platform}` as const)}: ${fmtNumber(s.points[s.points.length - 1]!.v)}`).join(", "),
  );
</script>

<div class="relative" bind:clientWidth={width}>
  <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
    {#if series.length >= 2}
      <ul class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-2" aria-label="Leyenda">
        {#each series as s (s.platform)}
          <li class="inline-flex items-center gap-1.5">
            <span class="h-0.5 w-4 rounded" style:background={COLOR[s.platform]}></span>{t(`platform.${s.platform}` as const)}
          </li>
        {/each}
      </ul>
    {:else}
      <span></span>
    {/if}
    <button class="text-xs text-fg-3 underline-offset-2 hover:underline" onclick={() => (showTable = !showTable)}>
      {showTable ? t("common.chart") : t("common.table")}
    </button>
  </div>

  {#if series.length === 0}
    <div class="grid place-items-center text-sm text-fg-3" style:height="{H}px">{t("common.none")}</div>
  {:else if showTable}
    <div class="overflow-auto" style:max-height="{H + 20}px">
      <table class="w-full text-left text-sm tabular-nums">
        <thead class="text-xs text-fg-3">
          <tr>
            <th class="py-1 pr-4 font-medium">Hora</th>
            {#each series as s (s.platform)}<th class="py-1 pr-4 font-medium">{t(`platform.${s.platform}` as const)}</th>{/each}
          </tr>
        </thead>
        <tbody>
          {#each tableRows as r (r.tm)}
            <tr class="border-t border-border">
              <td class="py-1 pr-4 text-fg-2">{tipFormat(r.tm)}</td>
              {#each r.values as v, i (i)}<td class="py-1 pr-4">{v === null ? "–" : fmtNumber(v)}</td>{/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <svg
      viewBox="0 0 {width} {H}"
      class="block w-full touch-pan-y select-none"
      style:height="{H}px"
      role="img"
      aria-label="{title}. {summary}"
      onpointermove={onMove}
      onpointerleave={() => (hoverT = null)}
    >
      <!-- rejilla y ejes, recesivos -->
      {#each yTicks as v (v)}
        <line x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)} stroke="var(--grid)" stroke-width="1" />
        <text x={M.left - 8} y={y(v) + 4} text-anchor="end" font-size="11" fill="var(--fg-3)" class="tabular-nums">{fmtNumber(v)}</text>
      {/each}
      {#each xTicks as tm (tm)}
        <text x={x(tm)} y={H - 6} text-anchor={tm === xTicks[0] ? "start" : "middle"} font-size="11" fill="var(--fg-3)"
          >{axisFormat(tm)}</text
        >
      {/each}

      {#each series as s (s.platform)}
        <path d={path(s.points)} fill="none" stroke={COLOR[s.platform]} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      {/each}

      <!-- etiquetas directas -->
      {#each endLabels as l (l.platform)}
        <circle cx={x(l.last.t)} cy={y(l.last.v)} r="4" fill={COLOR[l.platform]} stroke="var(--surface)" stroke-width="2" />
        <text x={width - M.right + 8} y={l.ly + 4} font-size="12" fill="var(--fg-2)">
          {t(`platform.${l.platform}` as const)}
          <tspan class="tabular-nums" font-weight="600" fill="var(--fg)">{fmtNumber(l.last.v)}</tspan>
        </text>
      {/each}

      {#if hover && hover.rows.length}
        <line x1={x(hover.t)} x2={x(hover.t)} y1={M.top} y2={M.top + innerH} stroke="var(--fg-3)" stroke-width="1" stroke-dasharray="3 3" />
        {#each hover.rows as r (r.platform)}
          <circle cx={x(r.pt!.t)} cy={y(r.pt!.v)} r="4.5" fill={COLOR[r.platform]} stroke="var(--surface)" stroke-width="2" />
        {/each}
      {/if}
    </svg>

    {#if hover && hover.rows.length}
      <div
        class="pointer-events-none absolute z-10 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs shadow-lg"
        style:left="{Math.min(Math.max(x(hover.t) + 12, 0), width - 150)}px"
        style:top="40px"
      >
        <p class="mb-1 font-medium text-fg-2">{tipFormat(hover.t)}</p>
        {#each hover.rows as r (r.platform)}
          <p class="flex items-center gap-2">
            <span class="size-2 rounded-sm" style:background={COLOR[r.platform]}></span>
            <span class="text-fg-2">{t(`platform.${r.platform}` as const)}</span>
            <span class="ml-auto pl-4 font-semibold tabular-nums">{fmtNumber(r.pt!.v)}</span>
          </p>
        {/each}
      </div>
    {/if}
  {/if}
</div>
