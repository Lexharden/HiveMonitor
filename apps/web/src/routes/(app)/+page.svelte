<script lang="ts">
  import type { Platform } from "@hivemonitor/client";
  import PlatformBadge from "#lib/components/PlatformBadge.svelte";
  import StatCard from "#lib/components/StatCard.svelte";
  import StatusBadge from "#lib/components/StatusBadge.svelte";
  import ViewersChart from "#lib/components/ViewersChart.svelte";
  import { fmtDuration, fmtMoney, fmtNumber } from "#lib/format.ts";
  import { t } from "#lib/i18n.ts";
  import { app } from "#lib/stores/app.svelte.ts";
  import { live } from "#lib/stores/live.svelte.ts";

  const RANGES = [
    { label: "dash.range15", ms: 15 * 60_000 },
    { label: "dash.range60", ms: 60 * 60_000 },
    { label: "dash.range180", ms: 180 * 60_000 },
  ] as const;
  let range = $state<number>(RANGES[0].ms);

  const totalViewers = $derived(live.channels.reduce((n, c) => n + c.viewers, 0));
  const peak = $derived(live.channels.reduce((n, c) => Math.max(n, c.peakViewers), 0));
  const longest = $derived(
    live.channels.length ? Math.max(...live.channels.map((c) => (live.now - new Date(c.startedAt).getTime()) / 1000)) : 0,
  );
  const sum = (k: "messages" | "followers" | "likes") => live.channels.reduce((n, c) => n + c.counters[k], 0);
  const donations = $derived.by(() => {
    const byCur: Record<string, number> = {};
    for (const c of live.channels) for (const [cur, v] of Object.entries(c.counters.donations)) byCur[cur] = (byCur[cur] ?? 0) + v;
    return Object.entries(byCur);
  });

  const platforms = $derived([...new Set(live.connections.map((c) => c.platform))] as Platform[]);
  const retryIn = (iso?: string) => (iso ? Math.max(0, Math.round((new Date(iso).getTime() - live.now) / 1000)) : null);
</script>

<svelte:head><title>{t("dash.title")} · HiveMonitor</title></svelte:head>

<h1 class="mb-6 text-2xl font-semibold tracking-tight">{t("dash.title")}</h1>

{#if live.connections.length === 0}
  <div class="card p-8 text-center">
    <p class="text-fg-2">{t("dash.noConnections")}</p>
    {#if app.can("integrations.manage")}
      <a class="btn btn-primary mt-4" href="/integrations">{t("dash.goIntegrations")}</a>
    {/if}
  </div>
{:else}
  <section aria-label={t("dash.platforms")} class="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    {#each live.connections as c (c.id)}
      {@const ch = live.channels.find((x) => x.platform === c.platform && x.channelId === c.channelId)}
      <div class="card p-4">
        <div class="flex items-center justify-between">
          <PlatformBadge platform={c.platform} />
          <StatusBadge status={c.status} queued={c.queued} />
        </div>
        <p class="mt-2 truncate font-medium">{c.channelId}</p>
        {#if ch}
          <p class="mt-1 text-sm text-fg-2 tabular-nums">{fmtNumber(ch.viewers)} · {fmtDuration((live.now - new Date(ch.startedAt).getTime()) / 1000)}</p>
        {:else if (c.status === "error" || c.status === "rate_limited" || c.status === "offline") && retryIn(c.nextRetryAt) !== null}
          <p class="mt-1 text-xs text-fg-3">{c.detail ? `${c.detail} · ` : ""}{t("status.retryIn", { s: retryIn(c.nextRetryAt)! })}</p>
        {:else}
          <p class="mt-1 text-xs text-fg-3">{c.detail ?? t("dash.offline")}</p>
        {/if}
      </div>
    {/each}
  </section>

  <section class="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
    <StatCard label={t("dash.viewers")} value={fmtNumber(totalViewers)} hint="{t('dash.peak')}: {fmtNumber(peak)}" />
    <StatCard label={t("dash.duration")} value={live.channels.length ? fmtDuration(longest) : "–"} />
    <StatCard label={t("dash.messages")} value={fmtNumber(sum("messages"))} />
    <StatCard label={t("dash.followers")} value={fmtNumber(sum("followers"))} hint="{t('dash.likes')}: {fmtNumber(sum('likes'))}" />
  </section>

  {#if donations.length}
    <p class="mb-6 text-sm text-fg-2">
      <span class="font-medium text-fg">{t("dash.donations")}:</span>
      {donations.map(([cur, v]) => fmtMoney(v, cur)).join(" · ")}
    </p>
  {/if}

  <section class="card p-4">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 class="font-medium">{t("dash.viewersOverTime")}</h2>
      <div class="inline-flex rounded-lg border border-border p-0.5" role="group" aria-label="Rango">
        {#each RANGES as r (r.ms)}
          <button class="rounded-md px-3 py-1 text-xs font-medium {range === r.ms ? 'bg-surface-2 text-fg' : 'text-fg-3'}" aria-pressed={range === r.ms} onclick={() => (range = r.ms)}>
            {t(r.label)}
          </button>
        {/each}
      </div>
    </div>
    <ViewersChart history={live.history} now={live.now} rangeMs={range} />
  </section>
{/if}
