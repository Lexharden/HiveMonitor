<script lang="ts">
  import { fmtUsd } from "#lib/format.ts";
  import { t } from "#lib/i18n.ts";
  import { app } from "#lib/stores/app.svelte.ts";
  import { live } from "#lib/stores/live.svelte.ts";

  let editing = $state(false);
  let title = $state("");
  let target = $state("");
  let error = $state("");

  const canEdit = $derived(app.can("alerts.manage"));
  const donated = $derived(live.channels.reduce((n, c) => n + (c.counters.donationsUsdMinor ?? 0), 0) / 100);
  const pct = $derived(live.goal ? Math.min(100, (donated / live.goal.targetUsd) * 100) : 0);
  const reached = $derived(live.goal !== null && donated >= live.goal.targetUsd);

  function edit() {
    title = live.goal?.title ?? "";
    target = live.goal ? String(live.goal.targetUsd) : "";
    error = "";
    editing = true;
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    try {
      await live.saveGoal({ title: title.trim(), targetUsd: Number(target) });
      editing = false;
    } catch {
      error = t("common.error");
    }
  }

  async function clear() {
    await live.saveGoal(null).catch(() => {});
    editing = false;
  }
</script>

<section class="card p-4" aria-label={t("ck.goal")}>
  {#if editing}
    <form class="space-y-2" onsubmit={save}>
      <input class="input" required maxlength="60" placeholder={t("ck.goalTitle")} bind:value={title} aria-label={t("ck.goalTitle")} />
      <input
        class="input"
        type="number"
        min="1"
        step="any"
        required
        placeholder={t("ck.goalTarget")}
        bind:value={target}
        aria-label={t("ck.goalTarget")}
      />
      {#if error}<p class="text-xs text-bad" role="alert">{error}</p>{/if}
      <div class="flex gap-2">
        <button class="btn btn-primary flex-1">{t("common.save")}</button>
        <button type="button" class="btn" onclick={() => (editing = false)}>{t("common.cancel")}</button>
        {#if live.goal}<button type="button" class="btn" onclick={clear}>{t("ck.goalClear")}</button>{/if}
      </div>
    </form>
  {:else if live.goal}
    <div class="mb-2 flex items-baseline justify-between gap-2">
      <h2 class="min-w-0 truncate text-sm font-medium text-fg-2">{t("ck.goal")}: <span class="text-fg">{live.goal.title}</span></h2>
      {#if canEdit}<button class="text-xs text-fg-3 hover:underline" onclick={edit}>{t("common.edit")}</button>{/if}
    </div>
    <div
      class="h-4 overflow-hidden rounded-full bg-surface-2"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={Math.round(pct)}
      aria-label={live.goal.title}
    >
      <div class="h-full rounded-full {reached ? 'bg-good' : 'bg-accent'} transition-all duration-700" style:width="{pct}%"></div>
    </div>
    <p class="mt-1.5 flex justify-between text-sm tabular-nums">
      <span class="font-semibold">{fmtUsd(donated * 100)}</span><span class="text-fg-3"
        >{reached ? t("ck.goalReached") : `${Math.round(pct)}% · ${fmtUsd(live.goal.targetUsd * 100)}`}</span
      >
    </p>
  {:else}
    <div class="flex items-center justify-between gap-2">
      <p class="text-sm text-fg-3">{t("ck.goalNone")}</p>
      {#if canEdit}<button class="btn !py-1 text-xs" onclick={edit}>{t("ck.goalSet")}</button>{/if}
    </div>
  {/if}
</section>
