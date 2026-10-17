<script lang="ts">
  import type { Snippet } from "svelte";
  import { t } from "#lib/i18n.ts";

  let { title, children }: { title: string; children: Snippet } = $props();
</script>

<main class="grid min-h-screen place-items-center p-4">
  <div class="w-full max-w-md">
    <div class="mb-6 text-center">
      <img src="/icons/icon-256.png" alt="" class="mx-auto mb-3 size-14 rounded-xl" />
      <h1 class="text-2xl font-semibold tracking-tight">{t("app.name")}</h1>
      <p class="mt-1 text-sm text-fg-3">{title}</p>
    </div>
    <div class="card p-6">{@render children()}</div>
  </div>
</main>
