<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { app } from "#lib/stores/app.svelte.ts";
  import { t } from "#lib/i18n.ts";

  let { children } = $props();

  onMount(() => void app.init());
</script>

{#if app.ready}
  {@render children()}
{:else}
  <div class="grid min-h-screen place-items-center text-sm text-fg-3">{t("common.loading")}</div>
{/if}
