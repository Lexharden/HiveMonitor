<script lang="ts">
  import { page } from "$app/state";
  import type { SessionDetail } from "@hivemonitor/client";
  import PlatformBadge from "#lib/components/PlatformBadge.svelte";
  import StatCard from "#lib/components/StatCard.svelte";
  import ViewersChart from "#lib/components/ViewersChart.svelte";
  import { fmtDateTime, fmtDuration, fmtMoney, fmtNumber, fmtTime } from "#lib/format.ts";
  import { t, type MessageKey } from "#lib/i18n.ts";
  import { app } from "#lib/stores/app.svelte.ts";

  let detail = $state<SessionDetail | null>(null);
  let error = $state(false);

  $effect(() => {
    if (!app.org) return;
    detail = null;
    error = false;
    app.client
      .tenant(app.org.id)
      .analytics.session(page.params.id!)
      .then((d) => (detail = d))
      .catch(() => (error = true));
  });

  const s = $derived(detail?.session);
  const start = $derived(s ? new Date(s.startedAt).getTime() : 0);
  const end = $derived(s ? (s.endedAt ? new Date(s.endedAt).getTime() : Date.now()) : 0);
  const duration = $derived(Math.max(1, end - start));
  const history = $derived(s && detail ? { [s.platform]: detail.timeline.map((p) => ({ t: p.t, v: p.v })) } : {});
  const avg = $derived(detail && detail.timeline.length ? Math.round(detail.timeline.reduce((n, p) => n + p.v, 0) / detail.timeline.length) : 0);
  const donations = $derived(s ? Object.entries(s.stats.donations ?? {}) : []);
  const typeLabel = (k: string) => (({ chat: "Mensajes", follow: "Seguidores", donation: "Donaciones", like: "Likes", share: "Compartidos", subscription: "Suscripciones", raid: "Raids", moderation: "Moderación", viewer_count: "Muestras de espectadores" }) as Record<string, string>)[k] ?? k;
  void ({} as MessageKey);
</script>

<svelte:head><title>{t("hist.session")} · HiveMonitor</title></svelte:head>

<a class="mb-4 inline-block text-sm text-accent hover:underline" href="/history">← {t("hist.back")}</a>

{#if error}
  <p class="text-bad" role="alert">{t("common.error")}</p>
{:else if !detail || !s}
  <p class="text-fg-3">{t("common.loading")}</p>
{:else}
  <div class="mb-6">
    <div class="flex items-center gap-3"><PlatformBadge platform={s.platform} /><span class="font-medium">{s.channelId}</span></div>
    <h1 class="mt-1 text-2xl font-semibold tracking-tight">{s.title ?? t("hist.session")}</h1>
    <p class="mt-1 text-sm text-fg-3">{fmtDateTime(s.startedAt)}{s.endedAt ? ` – ${fmtDateTime(s.endedAt)}` : ` · ${t("hist.live")}`}</p>
  </div>

  <section class="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
    <StatCard label={t("dash.duration")} value={fmtDuration(duration / 1000)} />
    <StatCard label={t("hist.peak")} value={fmtNumber(s.peakViewers)} hint="{t('hist.avg')}: {fmtNumber(avg)}" />
    <StatCard label={t("hist.messages")} value={fmtNumber(s.stats.messages ?? 0)} />
    <StatCard label={t("hist.followers")} value={fmtNumber(s.stats.followers ?? 0)} hint="{t('dash.likes')}: {fmtNumber(s.stats.likes ?? 0)}" />
  </section>

  <section class="card mb-6 p-4">
    <h2 class="mb-3 font-medium">{t("hist.timeline")}</h2>
    <ViewersChart {history} now={end} rangeMs={duration} title={t("hist.timeline")} axisFormat={(tm) => fmtTime(tm).slice(0, 5)} />
  </section>

  <div class="grid gap-6 md:grid-cols-2">
    <section class="card">
      <h2 class="border-b border-border px-4 py-3 font-medium">{t("hist.topDonors")}</h2>
      {#if donations.length}
        <p class="border-b border-border px-4 py-2 text-sm text-fg-2">{t("dash.donations")}: {donations.map(([cur, v]) => fmtMoney(v, cur)).join(" · ")}</p>
      {/if}
      {#if detail.topDonors.length === 0}
        <p class="p-6 text-center text-sm text-fg-3">{t("hist.noDonors")}</p>
      {:else}
        <ol class="divide-y divide-border">
          {#each detail.topDonors as d, i (d.id + d.currency)}
            <li class="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span class="w-5 text-xs text-fg-3">{i + 1}</span>
              <span class="min-w-0 flex-1 truncate font-medium">{d.name}</span>
              <span class="tabular-nums">{fmtMoney(d.amountMinor, d.currency)}</span>
            </li>
          {/each}
        </ol>
      {/if}
    </section>

    <section class="card">
      <h2 class="border-b border-border px-4 py-3 font-medium">{t("hist.eventsByType")}</h2>
      <dl class="divide-y divide-border">
        {#each Object.entries(detail.eventsByType) as [k, n] (k)}
          <div class="flex justify-between px-4 py-2.5 text-sm"><dt class="text-fg-2">{typeLabel(k)}</dt><dd class="font-medium tabular-nums">{fmtNumber(n)}</dd></div>
        {/each}
      </dl>
    </section>
  </div>
{/if}
