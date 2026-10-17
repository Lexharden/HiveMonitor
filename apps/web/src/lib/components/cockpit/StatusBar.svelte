<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Platform } from "@hivemonitor/client";
  import PlatformBadge from "#lib/components/PlatformBadge.svelte";
  import StatusBadge from "#lib/components/StatusBadge.svelte";
  import { fmtDuration, fmtNumber } from "#lib/format.ts";
  import { t } from "#lib/i18n.ts";
  import { live } from "#lib/stores/live.svelte.ts";

  let { compact = false, controls }: { compact?: boolean; controls?: Snippet } = $props();

  const STALE_S = 120;
  const platforms = $derived([...new Set(live.connections.map((c) => c.platform))] as Platform[]);
  const isLive = $derived(live.channels.length > 0);
  const elapsed = $derived(isLive ? Math.max(...live.channels.map((c) => (live.now - new Date(c.startedAt).getTime()) / 1000)) : 0);
  const viewersOf = (p: Platform) => live.channels.filter((c) => c.platform === p).reduce((n, c) => n + c.viewers, 0);
  const total = $derived(live.channels.reduce((n, c) => n + c.viewers, 0));
  const sources = $derived(Object.values(live.heartbeats).sort((a, b) => a.source.localeCompare(b.source)));
  const ageS = (iso: string) => Math.max(0, Math.round((live.now - new Date(iso).getTime()) / 1000));
  const num = (v: unknown) => (typeof v === "number" ? v : Number(v));
</script>

<header class="card flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 {compact ? 'text-sm' : ''}">
  <div class="flex items-center gap-3">
    {#if isLive}
      <span class="inline-flex items-center gap-2 rounded-full bg-bad/15 px-3 py-1 text-xs font-bold tracking-wide text-bad"
        ><span class="size-2 animate-pulse rounded-full bg-bad"></span>{t("ck.live")}</span
      >
      <span class="text-2xl font-semibold tabular-nums {compact ? '!text-lg' : ''}">{fmtDuration(elapsed)}</span>
    {:else}
      <span class="rounded-full bg-surface-2 px-3 py-1 text-xs font-bold tracking-wide text-fg-3">{t("ck.offline")}</span>
    {/if}
  </div>

  <div class="flex items-baseline gap-2" title={t("ck.total")}>
    <span class="text-3xl font-bold tabular-nums {compact ? '!text-xl' : ''}">{fmtNumber(total)}</span>
    <span class="text-xs text-fg-3">{t("dash.viewers").toLowerCase()}</span>
  </div>

  <ul class="flex flex-wrap items-center gap-x-5 gap-y-1" aria-label={t("ck.platforms")}>
    {#each platforms as p (p)}
      {@const status = live.statusOf(p)}
      {@const delta = live.viewerDelta(p)}
      <li class="flex items-center gap-2">
        <PlatformBadge platform={p} />
        {#if status}<StatusBadge {status} />{/if}
        <span class="font-semibold tabular-nums">{fmtNumber(viewersOf(p))}</span>
        {#if delta !== null && delta !== 0}
          <span class="text-xs font-medium tabular-nums {delta > 0 ? 'text-good' : 'text-bad'}" title={t("ck.vsAgo")}
            >{delta > 0 ? "▲" : "▼"} {Math.abs(delta)}</span
          >
        {/if}
      </li>
    {/each}
  </ul>

  {#if sources.length}
    <ul class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" aria-label="Apps">
      {#each sources as s (s.source)}
        {@const stale = ageS(s.at) > STALE_S}
        <li class="flex items-center gap-1.5 {stale ? 'text-bad' : 'text-fg-2'}">
          <span aria-hidden="true">{stale ? "✕" : "●"}</span>
          <span class="font-medium uppercase">{s.source === "obs" ? t("ck.obs") : s.source}</span>
          {#if stale}<span>{t("ck.noSignal")}</span>
          {:else if s.metrics.fps !== undefined}
            <span class="tabular-nums">{Math.round(num(s.metrics.fps))} fps</span>
            {#if s.metrics.droppedFrames !== undefined}<span class="tabular-nums {num(s.metrics.droppedFrames) > 0 ? 'text-warn' : ''}"
                >{num(s.metrics.droppedFrames)} drops</span
              >{/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if controls}<div class="ml-auto flex items-center gap-2">{@render controls()}</div>{/if}
</header>
