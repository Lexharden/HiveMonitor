<script lang="ts">
  import { ApiError, type ConnectionInfo, type Platform } from "@hivemonitor/client";
  import Icon from "#lib/components/Icon.svelte";
  import PlatformBadge from "#lib/components/PlatformBadge.svelte";
  import StatusBadge from "#lib/components/StatusBadge.svelte";
  import { t, type MessageKey } from "#lib/i18n.ts";
  import { app } from "#lib/stores/app.svelte.ts";
  import { live } from "#lib/stores/live.svelte.ts";

  let conns = $state<ConnectionInfo[]>([]);
  let loaded = $state(false);
  let platform = $state<Platform>("tiktok");
  let channel = $state("");
  let demo = $state(false);
  let error = $state("");
  let busy = $state(false);

  const api = $derived(app.org ? app.client.tenant(app.org.id) : null);
  const allowed = $derived(app.can("integrations.manage"));

  async function load() {
    if (!api) return;
    conns = (await api.connections()).connections;
    loaded = true;
  }
  $effect(() => {
    void app.org?.id;
    void load();
  });
  // Los cambios de estado llegan por SSE: se reflejan sin recargar
  $effect(() => {
    for (const rc of live.connections) {
      const c = conns.find((x) => x.id === rc.id);
      if (c && c.status !== rc.status) c.status = rc.status;
    }
  });

  const msg = (err: unknown): string => {
    if (!(err instanceof ApiError)) return t("common.error");
    return (
      ({ connection_limit_reached: t("int.limit"), already_exists: t("int.exists"), platform_not_available: t("int.notAvailable"), adapter_not_available: t("int.notAvailable"), mock_not_allowed: t("int.mockNotAllowed") } as Record<string, string>)[err.code] ??
      t("common.error")
    );
  };

  async function add(e: SubmitEvent) {
    e.preventDefault();
    if (!api) return;
    error = "";
    busy = true;
    try {
      await api.createConnection({ platform, channelId: channel.trim().replace(/^@/, ""), config: demo ? { mode: "mock" } : {} });
      channel = "";
      await load();
    } catch (err) {
      error = msg(err);
    } finally {
      busy = false;
    }
  }

  async function act(fn: () => Promise<unknown>) {
    error = "";
    try {
      await fn();
      await load();
    } catch (err) {
      error = msg(err);
    }
  }
</script>

<svelte:head><title>{t("int.title")} · HiveMonitor</title></svelte:head>

<h1 class="mb-6 text-2xl font-semibold tracking-tight">{t("int.title")}</h1>

{#if !allowed}
  <p class="text-fg-2">{t("int.noPermission")}</p>
{:else}
  {#if error}<p class="mb-4 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad" role="alert">{error}</p>{/if}

  <div class="card mb-6 divide-y divide-border">
    {#if loaded && conns.length === 0}<p class="p-8 text-center text-sm text-fg-3">{t("int.empty")}</p>{/if}
    {#each conns as c (c.id)}
      <div class="flex flex-wrap items-center gap-3 p-4">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-3"><PlatformBadge platform={c.platform} /><StatusBadge status={c.status} queued={c.runtime?.queued} /></div>
          <p class="mt-1 truncate font-medium">{c.channelName ?? c.channelId}{#if c.config.mode === "mock"}<span class="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-fg-3">demo</span>{/if}</p>
          {#if c.lastError}<p class="mt-0.5 truncate text-xs text-bad">{c.lastError}</p>{/if}
        </div>
        {#if c.enabled}
          <button class="btn" onclick={() => act(() => api!.disconnect(c.id))}>{t("common.disconnect")}</button>
        {:else}
          <button class="btn btn-primary" onclick={() => act(() => api!.connect(c.id))}>{t("common.connect")}</button>
        {/if}
        <button class="btn" aria-label={t("common.delete")} onclick={() => confirm(t("int.confirmDelete")) && act(() => api!.deleteConnection(c.id))}>
          <Icon name="trash" class="size-4" />
        </button>
      </div>
    {/each}
  </div>

  <form class="card grid gap-4 p-4 sm:grid-cols-[10rem_1fr_auto] sm:items-end" onsubmit={add}>
    <div>
      <label class="mb-1 block text-sm font-medium" for="plat">{t("int.platform")}</label>
      <select id="plat" class="input" bind:value={platform}>
        <option value="tiktok">{t("platform.tiktok")}</option>
        <option value="twitch">{t("platform.twitch")}</option>
        <option value="youtube">{t("platform.youtube")}</option>
      </select>
    </div>
    <div>
      <label class="mb-1 block text-sm font-medium" for="chan">{t("int.channel")}</label>
      <input id="chan" class="input" required maxlength="128" placeholder="@usuario" bind:value={channel} />
    </div>
    <button class="btn btn-primary" disabled={busy || !channel}><Icon name="plus" class="size-4" />{t("int.add")}</button>
    <label class="flex items-center gap-2 text-sm text-fg-2 sm:col-span-3">
      <input type="checkbox" bind:checked={demo} class="size-4 accent-[var(--accent)]" />
      {t("int.demo")}
    </label>
  </form>
{/if}
