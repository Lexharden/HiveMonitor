<script lang="ts">
  let { label, value, hint }: { label: string; value: string; hint?: string } = $props();
</script>

<div class="card p-4">
  <p class="text-xs font-medium text-fg-3">{label}</p>
  <p class="mt-1 text-3xl font-semibold tabular-nums tracking-tight">{value}</p>
  {#if hint}<p class="mt-1 text-xs text-fg-3">{hint}</p>{/if}
</div>
