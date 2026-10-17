<script lang="ts">
  import { onMount } from "svelte";
  import type { Platform } from "@hivemonitor/client";
  import PlatformBadge from "#lib/components/PlatformBadge.svelte";
  import { t } from "#lib/i18n.ts";
  import { kv } from "#lib/platform.ts";
  import { app } from "#lib/stores/app.svelte.ts";
  import { live } from "#lib/stores/live.svelte.ts";

  let open = $state(false);
  let selected = $state<string | null>(null);
  let host = $state("");

  onMount(async () => {
    host = location.hostname;
    open = (await kv.get("cockpit_preview")) === "1";
  });

  async function toggle() {
    open = !open;
    await kv.set("cockpit_preview", open ? "1" : null);
  }

  // Canales conectados (con o sin directo): sirve para comprobar que cada uno funciona
  const channels = $derived(
    live.connections
      .map((c) => ({
        key: `${c.platform}:${c.channelId}`,
        platform: c.platform as Platform,
        channelId: c.channelId,
        live: c.status === "live",
      }))
      .sort((a, b) => Number(b.live) - Number(a.live)),
  );
  const current = $derived(channels.find((c) => c.key === selected) ?? channels[0] ?? null);

  const links: Record<Platform, (id: string) => string> = {
    twitch: (id) => `https://www.twitch.tv/${encodeURIComponent(id)}`,
    tiktok: (id) => `https://www.tiktok.com/@${encodeURIComponent(id.replace(/^@/, ""))}/live`,
    youtube: (id) => `https://www.youtube.com/@${encodeURIComponent(id)}/live`,
  };
  /** El reproductor oficial de Twitch exige `parent` = dominio de la página que lo incrusta. */
  const twitchSrc = (login: string) =>
    `https://player.twitch.tv/?channel=${encodeURIComponent(login)}&parent=${encodeURIComponent(host)}&muted=true&autoplay=true`;
  const embeddable = $derived(current?.platform === "twitch" && !app.native && host !== "");
</script>

<section class="card" aria-label={t("ck.preview")}>
  <div class="flex items-center justify-between px-4 py-2">
    <h2 class="font-medium">{t("ck.preview")}</h2>
    <button class="btn !py-1 text-xs" onclick={toggle} aria-expanded={open}>{open ? t("ck.previewHide") : t("ck.previewShow")}</button>
  </div>

  {#if open}
    <div class="border-t border-border p-3">
      {#if !current}
        <p class="text-sm text-fg-3">{t("ck.previewNone")}</p>
      {:else}
        {#if channels.length > 1}
          <div class="mb-2 flex flex-wrap gap-2" role="tablist">
            {#each channels as c (c.key)}
              <button
                class="btn !py-1 text-xs {current.key === c.key ? '!border-accent !bg-accent/15' : ''}"
                role="tab"
                aria-selected={current.key === c.key}
                onclick={() => (selected = c.key)}
              >
                <PlatformBadge platform={c.platform} compact />{c.channelId}{c.live ? " ●" : ""}
              </button>
            {/each}
          </div>
        {/if}

        {#if embeddable}
          <div class="aspect-video w-full overflow-hidden rounded-lg bg-black">
            {#key current.key}
              <iframe
                title="{t('ck.preview')}: {current.channelId}"
                src={twitchSrc(current.channelId)}
                class="size-full"
                allowfullscreen
                allow="autoplay; fullscreen"
              ></iframe>
            {/key}
          </div>
          <p class="mt-2 text-xs text-fg-3">{t("ck.previewHint")}</p>
        {:else}
          <p class="mb-3 text-sm text-fg-2">
            {current.platform === "tiktok"
              ? t("ck.previewTiktok")
              : current.platform === "twitch" && app.native
                ? t("ck.previewTauri")
                : t("ck.previewNone")}
          </p>
        {/if}
        <a class="btn w-full" href={links[current.platform](current.channelId)} target="_blank" rel="noopener noreferrer">
          {current.platform === "tiktok" ? t("ck.previewOpenTiktok") : t("ck.previewOpenTwitch")} ↗
        </a>
      {/if}
    </div>
  {/if}
</section>
