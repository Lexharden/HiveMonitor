<script lang="ts">
  import { onMount } from "svelte";
  import { live } from "#lib/stores/live.svelte.ts";

  // Los avisos se retiran solos a los 12 s
  onMount(() => {
    const timer = setInterval(() => {
      const cutoff = Date.now() - 12_000;
      const keep = live.toasts.filter((a) => new Date(a.at).getTime() > cutoff);
      if (keep.length !== live.toasts.length) live.toasts = keep;
    }, 1000);
    return () => clearInterval(timer);
  });
</script>

<div class="pointer-events-none fixed right-4 top-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
  {#each live.toasts as a (a.id)}
    <div class="pointer-events-auto card flex items-start gap-3 border-warn/40 p-3 shadow-lg" role="alert">
      <span class="mt-0.5 text-warn" aria-hidden="true">▲</span>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">{a.ruleName}</p>
        <p class="break-words text-sm text-fg-2">{a.message}</p>
      </div>
      <button class="text-fg-3 hover:text-fg" aria-label="Cerrar" onclick={() => live.dismissToast(a.id)}>✕</button>
    </div>
  {/each}
</div>
