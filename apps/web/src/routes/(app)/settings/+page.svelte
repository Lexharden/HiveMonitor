<script lang="ts">
  import { goto } from "$app/navigation";
  import { t } from "#lib/i18n.ts";
  import {
    autostartEnabled,
    autostartSupported,
    notify,
    notifyState,
    requestNotify,
    setAutostart,
    type NotifyState,
  } from "#lib/platform.ts";
  import { app } from "#lib/stores/app.svelte.ts";
  import { onMount } from "svelte";

  let perm = $state<NotifyState>("default");
  let canAutostart = $state(false);
  let autostart = $state(false);
  let error = $state("");

  onMount(async () => {
    perm = await notifyState();
    canAutostart = await autostartSupported();
    if (canAutostart) autostart = await autostartEnabled().catch(() => false);
  });

  async function enableNotifications() {
    perm = await requestNotify();
    if (perm === "granted") void notify("HiveMonitor", t("set.granted"));
  }

  async function toggleAutostart(on: boolean) {
    error = "";
    try {
      await setAutostart(on);
      autostart = on;
    } catch {
      error = t("common.error");
      autostart = !on;
    }
  }

  async function changeServer() {
    await app.logout();
    await goto("/login");
  }
</script>

<svelte:head><title>{t("set.title")} · HiveMonitor</title></svelte:head>

<h1 class="mb-6 text-2xl font-semibold tracking-tight">{t("set.title")}</h1>
{#if error}<p class="mb-4 text-sm text-bad" role="alert">{error}</p>{/if}

<div class="grid max-w-2xl gap-4">
  <section class="card flex items-center justify-between gap-4 p-4">
    <div>
      <h2 class="font-medium">{t("set.appearance")}</h2>
      <p class="text-sm text-fg-3">{t("set.theme")}</p>
    </div>
    <input
      type="checkbox"
      class="size-5 accent-[var(--accent)]"
      role="switch"
      checked={app.theme === "dark"}
      onchange={() => app.toggleTheme()}
      aria-label={t("set.theme")}
    />
  </section>

  <section class="card flex items-center justify-between gap-4 p-4">
    <div>
      <h2 class="font-medium">{t("set.notifications")}</h2>
      <p class="text-sm text-fg-3">{t("set.notificationsHint")}</p>
    </div>
    {#if perm === "granted"}<span class="text-sm text-good">✓ {t("set.granted")}</span>
    {:else if perm === "denied"}<span class="text-sm text-bad">{t("set.denied")}</span>
    {:else if perm === "unsupported"}<span class="text-sm text-fg-3">{t("set.unsupported")}</span>
    {:else}<button class="btn btn-primary" onclick={enableNotifications}>{t("set.enable")}</button>{/if}
  </section>

  {#if canAutostart}
    <section class="card flex items-center justify-between gap-4 p-4">
      <div>
        <h2 class="font-medium">{t("set.autostart")}</h2>
        <p class="text-sm text-fg-3">{t("set.autostartHint")}</p>
      </div>
      <input
        type="checkbox"
        class="size-5 accent-[var(--accent)]"
        role="switch"
        checked={autostart}
        onchange={(e) => toggleAutostart(e.currentTarget.checked)}
        aria-label={t("set.autostart")}
      />
    </section>
  {/if}

  {#if app.native}
    <section class="card flex items-center justify-between gap-4 p-4">
      <div class="min-w-0">
        <h2 class="font-medium">{t("set.server")}</h2>
        <p class="truncate text-sm text-fg-3">{app.serverUrl}</p>
      </div>
      <button class="btn" onclick={changeServer}>{t("common.signOut")}</button>
    </section>
  {/if}
</div>
