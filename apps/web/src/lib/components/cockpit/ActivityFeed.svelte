<script lang="ts">
  import type { NormalizedEvent } from "@hivemonitor/client";
  import PlatformBadge from "#lib/components/PlatformBadge.svelte";
  import { fmtMoney, fmtNumber, fmtTime } from "#lib/format.ts";
  import { t } from "#lib/i18n.ts";
  import { live } from "#lib/stores/live.svelte.ts";

  let { compact = false }: { compact?: boolean } = $props();

  const SHOWN = new Set(["donation", "follow", "subscription", "raid", "share", "moderation"]);
  const feed = $derived(
    live.events
      .filter((e) => SHOWN.has(e.type))
      .slice(-40)
      .reverse(),
  );

  const ICON: Record<string, string> = { donation: "🎁", follow: "➕", subscription: "⭐", raid: "🚀", share: "↗", moderation: "🛡" };

  function text(e: NormalizedEvent): string {
    switch (e.type) {
      case "donation":
        return t("events.donated", {
          what: `${e.payload.count > 1 ? `${e.payload.count}× ` : ""}${e.payload.giftName ?? ""} (${fmtMoney(e.payload.amountMinor, e.payload.currency)})`.trim(),
        });
      case "follow":
        return t("events.followed");
      case "subscription":
        return t("events.subscribed");
      case "raid":
        return t("events.raided", { n: fmtNumber(e.payload.viewers) });
      case "share":
        return t("events.shared");
      case "moderation":
        return t("events.moderated", { action: e.payload.action });
      default:
        return "";
    }
  }
</script>

<section class="card flex min-h-0 flex-1 flex-col" aria-label={t("ck.activity")}>
  <h2 class="border-b border-border px-4 py-2 font-medium">{t("ck.activity")}</h2>
  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if feed.length === 0}<p class="p-6 text-center text-sm text-fg-3">{t("ck.activityEmpty")}</p>{/if}
    {#each feed as e (e.id)}
      <div class="flex items-start gap-2 border-b border-border/60 px-3 py-2 last:border-0 {compact ? 'text-xs' : 'text-sm'}">
        <span class="mt-0.5 w-5 shrink-0 text-center" aria-hidden="true">{ICON[e.type]}</span>
        <p class="min-w-0 flex-1 leading-snug {e.type === 'donation' ? 'text-good' : 'text-fg-2'}">
          {#if e.actor}<span class="font-semibold text-fg">{e.actor.name}</span>{/if}
          {text(e)}
        </p>
        <span class="flex shrink-0 flex-col items-end gap-1"
          ><PlatformBadge platform={e.platform} compact /><span class="text-[11px] text-fg-3 tabular-nums"
            >{fmtTime(e.occurredAt).slice(0, 5)}</span
          ></span
        >
      </div>
    {/each}
  </div>
</section>
