<script lang="ts">
  import { fmtTime } from "#lib/format.ts";
  import { t, type MessageKey } from "#lib/i18n.ts";
  import { app } from "#lib/stores/app.svelte.ts";
  import { live } from "#lib/stores/live.svelte.ts";

  const ICON = { manual: "🚩", raid: "🚀", donation: "🎁", viewers_spike: "📈" } as const;
  const canDelete = $derived(app.can("chat.moderate"));
  const list = $derived(live.markers.slice(0, 8));
</script>

<section class="card" aria-label={t("ck.moments")}>
  <h2 class="border-b border-border px-4 py-2 font-medium">{t("ck.moments")}</h2>
  {#if list.length === 0}
    <p class="p-4 text-sm text-fg-3">{t("ck.momentsEmpty")}</p>
  {:else}
    <ul>
      {#each list as m (m.id)}
        <li class="flex items-center gap-2 border-b border-border/60 px-4 py-2 text-sm last:border-0">
          <span aria-hidden="true">{ICON[m.kind]}</span>
          <span class="text-xs text-fg-3 tabular-nums">{fmtTime(m.at).slice(0, 5)}</span>
          <span class="min-w-0 flex-1 truncate" title={m.label}
            ><span class="mr-1.5 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold uppercase text-fg-3"
              >{t(`ck.moment.${m.kind}` as MessageKey)}</span
            >{m.label}</span
          >
          {#if canDelete && m.kind === "manual"}<button
              class="text-fg-3 hover:text-bad"
              aria-label={t("common.delete")}
              onclick={() => live.removeMarker(m.id)}>✕</button
            >{/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
