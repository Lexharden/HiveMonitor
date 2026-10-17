<script lang="ts">
  import { fmtNumber, fmtUsd } from "#lib/format.ts";
  import { t } from "#lib/i18n.ts";
  import { live } from "#lib/stores/live.svelte.ts";
  import Sparkline from "./Sparkline.svelte";

  const chatNow = $derived(live.rate("chat"));
  const chatPrev = $derived(live.rate("chat", 60_000, 60_000));
  const likesNow = $derived(live.rate("like"));
  const likesPrev = $derived(live.rate("like", 60_000, 60_000));
  const chatSeries = $derived(live.series("chat"));
  const likeSeries = $derived(live.series("like"));
  const followers = $derived(live.channels.reduce((n, c) => n + c.counters.followers, 0));
  const donatedUsd = $derived(live.channels.reduce((n, c) => n + (c.counters.donationsUsdMinor ?? 0), 0));

  /** Chat «calentándose» o «enfriándose» respecto al minuto anterior (con tolerancia para no parpadear). */
  const trend = (now: number, prev: number) => (now > prev * 1.15 + 1 ? "▲" : now < prev * 0.85 - 1 ? "▼" : "▬");
  const trendClass = (s: string) => (s === "▲" ? "text-good" : s === "▼" ? "text-warn" : "text-fg-3");
</script>

<section class="card p-4" aria-label={t("ck.rhythm")}>
  <h2 class="mb-3 text-sm font-medium text-fg-2">{t("ck.rhythm")}</h2>
  <div class="grid grid-cols-2 gap-x-4 gap-y-3">
    <div>
      <p class="flex items-baseline gap-1.5">
        <span class="text-3xl font-bold tabular-nums">{fmtNumber(chatNow)}</span><span
          class={trendClass(trend(chatNow, chatPrev))}
          aria-hidden="true">{trend(chatNow, chatPrev)}</span
        >
      </p>
      <p class="text-xs text-fg-3">{t("ck.msgPerMin")}</p>
      <Sparkline values={chatSeries} color="var(--series-1)" />
    </div>
    <div>
      <p class="flex items-baseline gap-1.5">
        <span class="text-3xl font-bold tabular-nums">{fmtNumber(likesNow)}</span><span
          class={trendClass(trend(likesNow, likesPrev))}
          aria-hidden="true">{trend(likesNow, likesPrev)}</span
        >
      </p>
      <p class="text-xs text-fg-3">{t("ck.likesPerMin")}</p>
      <Sparkline values={likeSeries} color="var(--series-2)" />
    </div>
    <div>
      <p class="text-2xl font-semibold tabular-nums">+{fmtNumber(followers)}</p>
      <p class="text-xs text-fg-3">{t("ck.followersSession")}</p>
    </div>
    <div>
      <p class="text-2xl font-semibold tabular-nums">{fmtUsd(donatedUsd)}</p>
      <p class="text-xs text-fg-3">{t("ck.donatedSession")}</p>
    </div>
  </div>
</section>
