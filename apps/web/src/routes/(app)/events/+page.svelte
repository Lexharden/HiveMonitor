<script lang="ts">
  import type { NormalizedEvent, Platform } from "@hivemonitor/client";
  import PlatformBadge from "#lib/components/PlatformBadge.svelte";
  import { fmtMoney, fmtNumber, fmtTime } from "#lib/format.ts";
  import { t, type MessageKey } from "#lib/i18n.ts";
  import { live } from "#lib/stores/live.svelte.ts";

  const TYPES = ["donation", "follow", "subscription", "raid", "like", "share", "moderation"] as const;
  type FeedType = (typeof TYPES)[number];
  const PLATFORMS: Platform[] = ["tiktok", "twitch", "youtube"];

  let types = $state<Set<FeedType>>(new Set(TYPES));
  let platform = $state<Platform | "all">("all");

  function toggle(ty: FeedType) {
    const next = new Set(types);
    if (next.has(ty)) next.delete(ty);
    else next.add(ty);
    types = next;
  }

  const feed = $derived(
    live.events
      .filter((e) => (TYPES as readonly string[]).includes(e.type) && types.has(e.type as FeedType) && (platform === "all" || e.platform === platform))
      .slice(-150)
      .reverse(),
  );

  function describe(e: NormalizedEvent): string {
    switch (e.type) {
      case "donation":
        return t("events.donated", { what: `${e.payload.count > 1 ? `${e.payload.count}× ` : ""}${e.payload.giftName ?? ""} (${fmtMoney(e.payload.amountMinor, e.payload.currency)})`.trim() });
      case "follow":
        return t("events.followed");
      case "subscription":
        return t("events.subscribed");
      case "raid":
        return t("events.raided", { n: fmtNumber(e.payload.viewers) });
      case "like":
        return t("events.liked", { n: e.payload.count });
      case "share":
        return t("events.shared");
      case "moderation":
        return t("events.moderated", { action: e.payload.action });
      default:
        return "";
    }
  }
  const accent = (ty: string) => (ty === "donation" ? "text-good" : ty === "moderation" ? "text-warn" : "text-fg-2");
</script>

<svelte:head><title>{t("events.title")} · HiveMonitor</title></svelte:head>

<h1 class="mb-4 text-2xl font-semibold tracking-tight">{t("events.title")}</h1>

<div class="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Filtros">
  {#each TYPES as ty (ty)}
    <button class="rounded-full border px-3 py-1 text-xs font-medium {types.has(ty) ? 'border-accent bg-accent/15 text-fg' : 'border-border text-fg-3'}" aria-pressed={types.has(ty)} onclick={() => toggle(ty)}>
      {t(`events.type.${ty}` as MessageKey)}
    </button>
  {/each}
  <select class="input !w-auto" bind:value={platform} aria-label={t("int.platform")}>
    <option value="all">{t("common.all")}</option>
    {#each PLATFORMS as p (p)}<option value={p}>{t(`platform.${p}` as MessageKey)}</option>{/each}
  </select>
</div>

<div class="card divide-y divide-border">
  {#if feed.length === 0}
    <p class="p-8 text-center text-sm text-fg-3">{t("events.empty")}</p>
  {/if}
  {#each feed as e (e.id)}
    <div class="flex items-center gap-3 px-4 py-2.5 text-sm">
      <span class="w-16 shrink-0 text-xs text-fg-3 tabular-nums">{fmtTime(e.occurredAt)}</span>
      <PlatformBadge platform={e.platform} compact />
      <p class="min-w-0 flex-1 truncate {accent(e.type)}">
        {#if e.actor}<span class="font-semibold text-fg">{e.actor.name}</span>{/if}
        {describe(e)}
      </p>
    </div>
  {/each}
</div>
