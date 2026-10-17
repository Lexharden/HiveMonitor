<script lang="ts">
  import type { Donor, Overview, Platform, SessionSummary } from "@hivemonitor/client";
  import BarChart, { type BarDatum } from "#lib/components/BarChart.svelte";
  import PlatformBadge from "#lib/components/PlatformBadge.svelte";
  import ViewersChart from "#lib/components/ViewersChart.svelte";
  import { fmtDate, fmtDateTime, fmtDuration, fmtMoney, fmtNumber, fmtTime, fmtUsd, pctChange } from "#lib/format.ts";
  import { t, type MessageKey } from "#lib/i18n.ts";
  import { app } from "#lib/stores/app.svelte.ts";

  type Metric = "peak" | "avg" | "messages" | "followers" | "donations";
  const METRICS: { id: Metric; label: MessageKey }[] = [
    { id: "peak", label: "hist.peak" },
    { id: "avg", label: "hist.avg" },
    { id: "messages", label: "hist.messages" },
    { id: "followers", label: "hist.followers" },
    { id: "donations", label: "hist.donations" },
  ];
  const PERIODS = [
    { d: 7, label: "hist.period7" },
    { d: 30, label: "hist.period30" },
    { d: 90, label: "hist.period90" },
  ] as const;

  let days = $state<number>(30);
  let platform = $state<Platform | "all">("all");
  let metric = $state<Metric>("messages");
  let overview = $state<Overview | null>(null);
  let sessions = $state<SessionSummary[]>([]);
  let nextBefore = $state<string | null>(null);
  let donors = $state<Donor[]>([]);
  let loading = $state(true);
  let failed = $state(false);

  const api = $derived(app.org ? app.client.tenant(app.org.id).analytics : null);
  const plat = $derived(platform === "all" ? undefined : platform);

  $effect(() => {
    if (!api) return;
    const d = days;
    const p = plat;
    loading = true;
    failed = false;
    Promise.all([api.overview(d, p), api.sessions({ limit: 15, platform: p }), api.topDonors(d, 10, p)])
      .then(([o, s, dn]) => {
        overview = o;
        sessions = s.sessions;
        nextBefore = s.nextBefore;
        donors = dn.donors;
      })
      .catch(() => (failed = true))
      .finally(() => (loading = false));
  });

  async function more() {
    if (!api || !nextBefore) return;
    const s = await api.sessions({ limit: 15, before: nextBefore, platform: plat });
    sessions = [...sessions, ...s.sessions];
    nextBefore = s.nextBefore;
  }

  const hourly = $derived(overview?.granularity === "hour");
  const axisFmt = $derived((tm: number) => (hourly ? fmtTime(tm).slice(0, 5) : fmtDate(tm)));

  const cards = $derived.by(() => {
    if (!overview) return [];
    const c = overview.totals;
    const p = overview.previous;
    return [
      { label: t("hist.peak"), value: fmtNumber(c.peakViewers), delta: pctChange(c.peakViewers, p.peakViewers) },
      { label: t("hist.avg"), value: fmtNumber(Math.round(c.avgViewers)), delta: pctChange(c.avgViewers, p.avgViewers) },
      { label: t("hist.messages"), value: fmtNumber(c.messages), delta: pctChange(c.messages, p.messages) },
      { label: t("hist.followers"), value: fmtNumber(c.newFollowers), delta: pctChange(c.newFollowers, p.newFollowers) },
      { label: t("hist.donations"), value: fmtUsd(c.donationsMinor), delta: pctChange(c.donationsMinor, p.donationsMinor) },
    ];
  });

  const lineHistory = $derived.by(() => {
    const h: Record<string, { t: number; v: number }[]> = {};
    if (!overview || (metric !== "peak" && metric !== "avg")) return h;
    for (const s of overview.series)
      (h[s.platform] ??= []).push({ t: new Date(s.bucket).getTime(), v: metric === "peak" ? s.viewersPeak : Math.round(s.viewersAvg) });
    return h;
  });

  const bars = $derived.by((): BarDatum[] => {
    if (!overview || metric === "peak" || metric === "avg") return [];
    return overview.series.map((s) => ({
      t: new Date(s.bucket).getTime(),
      platform: s.platform,
      value: metric === "messages" ? s.messages : metric === "followers" ? s.newFollowers : s.donationsMinor / 100,
    }));
  });
  const metricLabel = $derived(t(METRICS.find((m) => m.id === metric)!.label));
  const range = $derived(
    overview ? { now: Date.parse(overview.to), ms: Date.parse(overview.to) - Date.parse(overview.from) } : { now: Date.now(), ms: 1 },
  );
</script>

<svelte:head><title>{t("hist.title")} · HiveMonitor</title></svelte:head>

<div class="mb-6 flex flex-wrap items-center justify-between gap-3">
  <h1 class="text-2xl font-semibold tracking-tight">{t("hist.title")}</h1>
  <div class="flex flex-wrap items-center gap-2">
    <div class="inline-flex rounded-lg border border-border p-0.5" role="group" aria-label="Periodo">
      {#each PERIODS as p (p.d)}
        <button
          class="rounded-md px-3 py-1 text-xs font-medium {days === p.d ? 'bg-surface-2 text-fg' : 'text-fg-3'}"
          aria-pressed={days === p.d}
          onclick={() => (days = p.d)}>{t(p.label)}</button
        >
      {/each}
    </div>
    <select class="input !w-auto" bind:value={platform} aria-label={t("int.platform")}>
      <option value="all">{t("common.all")}</option>
      <option value="tiktok">{t("platform.tiktok")}</option>
      <option value="twitch">{t("platform.twitch")}</option>
      <option value="youtube">{t("platform.youtube")}</option>
    </select>
  </div>
</div>

{#if failed}
  <p class="text-bad" role="alert">{t("common.error")}</p>
{:else if loading && !overview}
  <p class="text-fg-3">{t("common.loading")}</p>
{:else if overview}
  <section class="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5" aria-label="Resumen">
    {#each cards as c (c.label)}
      <div class="card p-4">
        <p class="text-xs font-medium text-fg-3">{c.label}</p>
        <p class="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{c.value}</p>
        <p class="mt-1 text-xs text-fg-3 tabular-nums">
          {#if c.delta === null}
            <span>{t("hist.vsPrev")}: –</span>
          {:else}
            <span class={c.delta > 0 ? "text-good" : c.delta < 0 ? "text-bad" : ""}
              >{c.delta > 0 ? "▲" : c.delta < 0 ? "▼" : "■"} {Math.abs(c.delta)}%</span
            >
            {t("hist.vsPrev")}
          {/if}
        </p>
      </div>
    {/each}
  </section>

  <section class="card mb-6 p-4">
    <div class="mb-3 flex flex-wrap gap-2" role="group" aria-label="Métrica">
      {#each METRICS as m (m.id)}
        <button
          class="rounded-full border px-3 py-1 text-xs font-medium {metric === m.id
            ? 'border-accent bg-accent/15 text-fg'
            : 'border-border text-fg-3'}"
          aria-pressed={metric === m.id}
          onclick={() => (metric = m.id)}>{t(m.label)}</button
        >
      {/each}
    </div>
    {#if metric === "peak" || metric === "avg"}
      <ViewersChart
        history={lineHistory}
        now={range.now}
        rangeMs={range.ms}
        axisFormat={axisFmt}
        tipFormat={(tm) => (hourly ? fmtDateTime(tm) : fmtDate(tm))}
        title={metricLabel}
      />
    {:else}
      <BarChart
        data={bars}
        label={metricLabel}
        axisFormat={axisFmt}
        title={metricLabel}
        format={metric === "donations" ? (n) => fmtUsd(n * 100) : undefined}
      />
    {/if}
  </section>

  <div class="grid gap-6 lg:grid-cols-3">
    <section class="card lg:col-span-2">
      <h2 class="border-b border-border px-4 py-3 font-medium">{t("hist.sessions")}</h2>
      {#if sessions.length === 0}
        <p class="p-8 text-center text-sm text-fg-3">{t("hist.noSessions")}</p>
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead class="text-xs text-fg-3">
              <tr>
                <th class="px-4 py-2 font-medium">Inicio</th>
                <th class="px-2 py-2 font-medium">Canal</th>
                <th class="px-2 py-2 font-medium">Duración</th>
                <th class="px-2 py-2 text-right font-medium">Pico</th>
                <th class="px-4 py-2 text-right font-medium">Mensajes</th>
              </tr>
            </thead>
            <tbody>
              {#each sessions as s (s.id)}
                <tr class="border-t border-border hover:bg-surface-2">
                  <td class="px-4 py-2 whitespace-nowrap"
                    ><a class="text-accent hover:underline" href="/history/{s.id}">{fmtDateTime(s.startedAt)}</a>{#if s.live}<span
                        class="ml-2 text-xs text-good">● {t("hist.live")}</span
                      >{/if}</td
                  >
                  <td class="px-2 py-2"><span class="mr-2"><PlatformBadge platform={s.platform} compact /></span>{s.channelId}</td>
                  <td class="px-2 py-2 tabular-nums">{fmtDuration(s.durationSec)}</td>
                  <td class="px-2 py-2 text-right tabular-nums">{fmtNumber(s.peakViewers)}</td>
                  <td class="px-4 py-2 text-right tabular-nums">{fmtNumber(s.stats.messages ?? 0)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if nextBefore}<div class="border-t border-border p-3 text-center">
            <button class="btn" onclick={more}>{t("hist.loadMore")}</button>
          </div>{/if}
      {/if}
    </section>

    <section class="card">
      <h2 class="border-b border-border px-4 py-3 font-medium">{t("hist.topDonors")}</h2>
      {#if donors.length === 0}
        <p class="p-8 text-center text-sm text-fg-3">{t("hist.noDonors")}</p>
      {:else}
        <ol class="divide-y divide-border">
          {#each donors as d, i (d.id + d.currency)}
            <li class="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span class="w-5 text-xs text-fg-3 tabular-nums">{i + 1}</span>
              <span class="min-w-0 flex-1 truncate font-medium">{d.name}</span>
              <span class="text-right tabular-nums"
                >{fmtMoney(d.amountMinor, d.currency)}<span class="block text-xs text-fg-3">≈ {fmtUsd(d.usdMinorEstimate)}</span></span
              >
            </li>
          {/each}
        </ol>
        <p class="border-t border-border px-4 py-2 text-xs text-fg-3">{t("hist.usdNote")}</p>
      {/if}
    </section>
  </div>
{/if}
