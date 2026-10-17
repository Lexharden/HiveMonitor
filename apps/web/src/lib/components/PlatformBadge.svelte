<script lang="ts">
  import type { Platform } from "@hivemonitor/client";
  import { t } from "#lib/i18n.ts";

  let { platform, compact = false }: { platform: Platform; compact?: boolean } = $props();

  // Color por entidad (no por posición): tiktok=1, twitch=2, youtube=3
  const color: Record<Platform, string> = { tiktok: "var(--series-1)", twitch: "var(--series-2)", youtube: "var(--series-3)" };
  const label = $derived(t(`platform.${platform}` as const));
</script>

<span class="inline-flex items-center gap-1.5 text-xs font-medium text-fg-2" title={label}>
  <span class="size-2.5 rounded-sm" style:background={color[platform]}></span>
  {#if !compact}{label}{:else}<span class="sr-only">{label}</span>{/if}
</span>
