<script lang="ts">
  import { ApiError, type AlertEventRow, type AlertRule, type AlertType } from "@hivemonitor/client";
  import Icon from "#lib/components/Icon.svelte";
  import { fmtDateTime } from "#lib/format.ts";
  import { t, type MessageKey } from "#lib/i18n.ts";
  import { app } from "#lib/stores/app.svelte.ts";

  const TYPES: AlertType[] = ["donation_over", "viewers_drop", "platform_disconnect", "heartbeat_lost"];
  const CHANNELS = ["panel", "native", "webhook"] as const;

  let rules = $state<AlertRule[]>([]);
  let events = $state<AlertEventRow[]>([]);
  let loaded = $state(false);
  let error = $state("");
  let info = $state("");
  let busy = $state(false);

  // Formulario
  let type = $state<AlertType>("donation_over");
  let name = $state("");
  let channels = $state<string[]>(["panel"]);
  let webhookUrl = $state("");
  let p = $state<Record<string, string>>({
    thresholdUsd: "10",
    dropPercent: "50",
    windowMin: "10",
    minViewers: "20",
    graceSec: "30",
    source: "",
    afterSec: "120",
  });

  const api = $derived(app.org ? app.client.tenant(app.org.id).alerts : null);
  const allowed = $derived(app.can("alerts.manage"));

  async function load() {
    if (!api) return;
    const [r, e] = await Promise.all([api.rules(), api.events(20)]);
    rules = r.rules;
    events = e.events;
    loaded = true;
  }
  $effect(() => {
    void app.org?.id;
    if (allowed) void load();
  });

  function paramsFor(ty: AlertType): Record<string, unknown> {
    const n = (k: string) => Number(p[k]);
    switch (ty) {
      case "donation_over":
        return { thresholdUsd: n("thresholdUsd") };
      case "viewers_drop":
        return { dropPercent: n("dropPercent"), windowMin: n("windowMin"), minViewers: n("minViewers") };
      case "platform_disconnect":
        return { graceSec: n("graceSec") };
      case "heartbeat_lost":
        return { afterSec: n("afterSec"), ...(p.source.trim() ? { source: p.source.trim() } : {}) };
    }
  }

  const fail = (err: unknown) => {
    if (err instanceof ApiError) return err.code === "rule_limit_reached" ? t("alerts.limit") : t("alerts.invalid");
    return t("common.error");
  };

  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (!api) return;
    error = info = "";
    busy = true;
    try {
      await api.create({
        type,
        name: name.trim() || t(`alerts.type.${type}` as MessageKey),
        params: paramsFor(type),
        channels,
        webhookUrl: channels.includes("webhook") ? webhookUrl : null,
      });
      name = webhookUrl = "";
      await load();
    } catch (err) {
      error = fail(err);
    } finally {
      busy = false;
    }
  }

  async function act(fn: () => Promise<unknown>, ok = "") {
    error = info = "";
    try {
      await fn();
      info = ok;
      await load();
    } catch (err) {
      error = fail(err);
    }
  }

  const toggleChannel = (c: string) => (channels = channels.includes(c) ? channels.filter((x) => x !== c) : [...channels, c]);
  const summary = (r: AlertRule) =>
    Object.entries(r.params)
      .filter(([k, v]) => k !== "cooldownSec" && v !== undefined)
      .map(([k, v]) => `${k}: ${v}`)
      .join(" · ");
</script>

<svelte:head><title>{t("alerts.title")} · HiveMonitor</title></svelte:head>

<h1 class="mb-6 text-2xl font-semibold tracking-tight">{t("alerts.title")}</h1>

{#if !allowed}
  <p class="text-fg-2">{t("alerts.noPermission")}</p>
{:else}
  {#if error}<p class="mb-4 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad" role="alert">{error}</p>{/if}
  {#if info}<p class="mb-4 rounded-lg border border-good/40 bg-good/10 px-3 py-2 text-sm text-good" role="status">{info}</p>{/if}

  <section class="card mb-6 divide-y divide-border">
    <h2 class="px-4 py-3 font-medium">{t("alerts.rules")}</h2>
    {#if loaded && rules.length === 0}<p class="p-8 text-center text-sm text-fg-3">{t("alerts.empty")}</p>{/if}
    {#each rules as r (r.id)}
      <div class="flex flex-wrap items-center gap-3 p-4">
        <div class="min-w-0 flex-1">
          <p class="font-medium">{r.name}</p>
          <p class="text-xs text-fg-3">{t(`alerts.type.${r.type}` as MessageKey)} · {summary(r)}</p>
          <p class="mt-1 text-xs text-fg-2">{r.channels.map((c) => t(`alerts.channel.${c}` as MessageKey)).join(" · ")}</p>
        </div>
        <label class="flex items-center gap-2 text-sm text-fg-2">
          <input
            type="checkbox"
            class="size-4 accent-[var(--accent)]"
            checked={r.enabled}
            onchange={(e) => act(() => api!.update(r.id, { enabled: e.currentTarget.checked }))}
          />
          {t("alerts.enabled")}
        </label>
        <button class="btn" onclick={() => act(() => api!.test(r.id), t("alerts.testSent"))}>{t("alerts.test")}</button>
        <button class="btn" aria-label={t("common.delete")} onclick={() => confirm(t("int.confirmDelete")) && act(() => api!.remove(r.id))}
          ><Icon name="trash" class="size-4" /></button
        >
      </div>
    {/each}
  </section>

  <form class="card mb-6 grid gap-4 p-4 sm:grid-cols-2" onsubmit={create}>
    <h2 class="font-medium sm:col-span-2">{t("alerts.new")}</h2>
    <div>
      <label class="mb-1 block text-sm font-medium" for="a-type">{t("alerts.type")}</label>
      <select id="a-type" class="input" bind:value={type}>
        {#each TYPES as ty (ty)}<option value={ty}>{t(`alerts.type.${ty}` as MessageKey)}</option>{/each}
      </select>
    </div>
    <div>
      <label class="mb-1 block text-sm font-medium" for="a-name">{t("alerts.name")}</label>
      <input id="a-name" class="input" maxlength="80" bind:value={name} placeholder={t(`alerts.type.${type}` as MessageKey)} />
    </div>

    {#if type === "donation_over"}
      <div>
        <label class="mb-1 block text-sm font-medium" for="p1">{t("alerts.threshold")}</label><input
          id="p1"
          class="input"
          type="number"
          min="0.01"
          step="any"
          required
          bind:value={p.thresholdUsd}
        />
      </div>
    {:else if type === "viewers_drop"}
      <div>
        <label class="mb-1 block text-sm font-medium" for="p2">{t("alerts.dropPercent")}</label><input
          id="p2"
          class="input"
          type="number"
          min="10"
          max="95"
          required
          bind:value={p.dropPercent}
        />
      </div>
      <div>
        <label class="mb-1 block text-sm font-medium" for="p3">{t("alerts.windowMin")}</label><input
          id="p3"
          class="input"
          type="number"
          min="1"
          max="60"
          required
          bind:value={p.windowMin}
        />
      </div>
      <div>
        <label class="mb-1 block text-sm font-medium" for="p4">{t("alerts.minViewers")}</label><input
          id="p4"
          class="input"
          type="number"
          min="1"
          required
          bind:value={p.minViewers}
        />
      </div>
    {:else if type === "platform_disconnect"}
      <div>
        <label class="mb-1 block text-sm font-medium" for="p5">{t("alerts.graceSec")}</label><input
          id="p5"
          class="input"
          type="number"
          min="0"
          max="600"
          required
          bind:value={p.graceSec}
        />
      </div>
    {:else}
      <div>
        <label class="mb-1 block text-sm font-medium" for="p6">{t("alerts.source")}</label><input
          id="p6"
          class="input"
          maxlength="64"
          bind:value={p.source}
          placeholder="obs"
        />
      </div>
      <div>
        <label class="mb-1 block text-sm font-medium" for="p7">{t("alerts.afterSec")}</label><input
          id="p7"
          class="input"
          type="number"
          min="30"
          max="3600"
          required
          bind:value={p.afterSec}
        />
      </div>
    {/if}

    <fieldset class="sm:col-span-2">
      <legend class="mb-2 text-sm font-medium">{t("alerts.channels")}</legend>
      <div class="flex flex-wrap gap-4">
        {#each CHANNELS as c (c)}
          <label class="flex items-center gap-2 text-sm text-fg-2"
            ><input
              type="checkbox"
              class="size-4 accent-[var(--accent)]"
              checked={channels.includes(c)}
              onchange={() => toggleChannel(c)}
            />{t(`alerts.channel.${c}` as MessageKey)}</label
          >
        {/each}
      </div>
    </fieldset>

    {#if channels.includes("webhook")}
      <div class="sm:col-span-2">
        <label class="mb-1 block text-sm font-medium" for="a-hook">{t("alerts.webhook")}</label>
        <input
          id="a-hook"
          class="input"
          type="url"
          required
          placeholder="https://discord.com/api/webhooks/…"
          autocomplete="off"
          bind:value={webhookUrl}
        />
        <p class="mt-1 text-xs text-fg-3">{t("alerts.webhookHint")}</p>
      </div>
    {/if}
    <div class="sm:col-span-2">
      <button class="btn btn-primary" disabled={busy || channels.length === 0}><Icon name="plus" class="size-4" />{t("alerts.new")}</button>
    </div>
  </form>

  <section class="card divide-y divide-border">
    <h2 class="px-4 py-3 font-medium">{t("alerts.recent")}</h2>
    {#if events.length === 0}<p class="p-6 text-center text-sm text-fg-3">{t("alerts.noEvents")}</p>{/if}
    {#each events as e (e.id)}
      <div class="flex items-center gap-3 px-4 py-2.5 text-sm">
        <span class="w-28 shrink-0 text-xs text-fg-3 tabular-nums">{fmtDateTime(e.firedAt)}</span>
        <span class="min-w-0 flex-1 truncate">{e.message}</span>
        <span class="shrink-0 text-xs text-fg-3">{e.ruleName}</span>
      </div>
    {/each}
  </section>
{/if}
