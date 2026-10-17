<script lang="ts">
  import type { Platform } from "@hivemonitor/client";
  import { fmtNumber } from "#lib/format.ts";
  import { t } from "#lib/i18n.ts";

  export interface BarDatum {
    /** Inicio del intervalo (epoch ms). */
    t: number;
    platform: Platform;
    value: number;
  }

  let {
    data,
    label,
    format = fmtNumber,
    axisFormat,
    title,
  }: {
    data: BarDatum[];
    label: string;
    format?: (n: number) => string;
    axisFormat: (t: number) => string;
    title: string;
  } = $props();

  const ORDER: Platform[] = ["tiktok", "twitch", "youtube"];
  const COLOR: Record<Platform, string> = { tiktok: "var(--series-1)", twitch: "var(--series-2)", youtube: "var(--series-3)" };

  const H = 240;
  const M = { top: 12, right: 12, bottom: 28, left: 52 };
  const GAP = 2; // separación entre segmentos apilados (color de la superficie)
  const R = 4; // radio del extremo del dato

  let width = $state(640);
  let showTable = $state(false);
  let hover = $state<number | null>(null);

  const platforms = $derived(ORDER.filter((p) => data.some((d) => d.platform === p && d.value > 0)));
  const buckets = $derived([...new Set(data.map((d) => d.t))].sort((a, b) => a - b));
  const stacks = $derived(
    buckets.map((tm) => {
      let acc = 0;
      const segs = platforms.map((p) => {
        const v = data.filter((d) => d.t === tm && d.platform === p).reduce((n, d) => n + d.value, 0);
        const seg = { platform: p, value: v, from: acc, to: acc + v };
        acc += v;
        return seg;
      });
      return { t: tm, total: acc, segs };
    }),
  );

  const yMax = $derived.by(() => {
    const max = Math.max(1, ...stacks.map((s) => s.total));
    const pow = 10 ** Math.floor(Math.log10(max));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s * 4 >= max) ?? pow * 10;
    return step * 4;
  });
  const yTicks = $derived([0, 1, 2, 3, 4].map((i) => (yMax / 4) * i));
  const innerW = $derived(Math.max(10, width - M.left - M.right));
  const innerH = H - M.top - M.bottom;
  const y = (v: number) => M.top + innerH - (v / yMax) * innerH;
  const slot = $derived(innerW / Math.max(1, buckets.length));
  const barW = $derived(Math.max(2, Math.min(40, slot * 0.7)));
  const cx = (i: number) => M.left + slot * i + slot / 2;

  /** Rectángulo con las esquinas superiores redondeadas (el dato "sale" de la base). */
  function topRounded(x: number, y0: number, w: number, h: number, round: boolean): string {
    const r = round ? Math.min(R, h, w / 2) : 0;
    return `M${x},${y0 + h} V${y0 + r} Q${x},${y0} ${x + r},${y0} H${x + w - r} Q${x + w},${y0} ${x + w},${y0 + r} V${y0 + h} Z`;
  }

  const labelEvery = $derived(Math.max(1, Math.ceil(buckets.length / Math.max(2, Math.floor(innerW / 70)))));
  const hovered = $derived(hover === null ? null : stacks[hover]);

  function onMove(e: PointerEvent) {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const i = Math.floor((px - M.left) / slot);
    hover = i >= 0 && i < buckets.length ? i : null;
  }
</script>

<div class="relative" bind:clientWidth={width}>
  <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
    {#if platforms.length >= 2}
      <ul class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-2" aria-label="Leyenda">
        {#each platforms as p (p)}
          <li class="inline-flex items-center gap-1.5">
            <span class="size-2.5 rounded-sm" style:background={COLOR[p]}></span>{t(`platform.${p}` as const)}
          </li>
        {/each}
      </ul>
    {:else}<span></span>{/if}
    <button class="text-xs text-fg-3 underline-offset-2 hover:underline" onclick={() => (showTable = !showTable)}
      >{showTable ? t("common.chart") : t("common.table")}</button
    >
  </div>

  {#if stacks.length === 0 || platforms.length === 0}
    <div class="grid place-items-center text-sm text-fg-3" style:height="{H}px">{t("common.none")}</div>
  {:else if showTable}
    <div class="overflow-auto" style:max-height="{H + 20}px">
      <table class="w-full text-left text-sm tabular-nums">
        <thead class="text-xs text-fg-3">
          <tr>
            <th class="py-1 pr-4 font-medium">Fecha</th>
            {#each platforms as p (p)}<th class="py-1 pr-4 font-medium">{t(`platform.${p}` as const)}</th>{/each}
            <th class="py-1 font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {#each [...stacks].reverse() as s (s.t)}
            <tr class="border-t border-border">
              <td class="py-1 pr-4 text-fg-2">{axisFormat(s.t)}</td>
              {#each s.segs as g (g.platform)}<td class="py-1 pr-4">{format(g.value)}</td>{/each}
              <td class="py-1 font-medium">{format(s.total)}</td>
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
      aria-label="{title}. {label}"
      onpointermove={onMove}
      onpointerleave={() => (hover = null)}
    >
      {#each yTicks as v (v)}
        <line x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
        <text x={M.left - 8} y={y(v) + 4} text-anchor="end" font-size="11" fill="var(--fg-3)" class="tabular-nums">{format(v)}</text>
      {/each}

      {#each stacks as s, i (s.t)}
        {@const lastIdx = s.segs.findLastIndex((g) => g.value > 0)}
        {#each s.segs as g, gi (g.platform)}
          {#if g.value > 0}
            {@const top = y(g.to)}
            {@const h = Math.max(1, y(g.from) - top - (gi === 0 ? 0 : GAP))}
            <path
              d={topRounded(cx(i) - barW / 2, top, barW, h, gi === lastIdx)}
              fill={COLOR[g.platform]}
              opacity={hover === null || hover === i ? 1 : 0.55}
            />
          {/if}
        {/each}
        {#if i % labelEvery === 0}
          <text x={cx(i)} y={H - 8} text-anchor="middle" font-size="11" fill="var(--fg-3)">{axisFormat(s.t)}</text>
        {/if}
      {/each}
    </svg>

    {#if hovered}
      <div
        class="pointer-events-none absolute z-10 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs shadow-lg"
        style:left="{Math.min(Math.max(cx(hover!) + 12, 0), width - 160)}px"
        style:top="40px"
      >
        <p class="mb-1 font-medium text-fg-2">{axisFormat(hovered.t)} · {label}</p>
        {#each hovered.segs.filter((g) => g.value > 0) as g (g.platform)}
          <p class="flex items-center gap-2">
            <span class="size-2 rounded-sm" style:background={COLOR[g.platform]}></span>
            <span class="text-fg-2">{t(`platform.${g.platform}` as const)}</span>
            <span class="ml-auto pl-4 font-semibold tabular-nums">{format(g.value)}</span>
          </p>
        {/each}
        {#if hovered.segs.filter((g) => g.value > 0).length > 1}
          <p class="mt-1 flex border-t border-border pt-1 font-semibold">
            <span class="text-fg-2">Total</span><span class="ml-auto tabular-nums">{format(hovered.total)}</span>
          </p>
        {/if}
      </div>
    {/if}
  {/if}
</div>
