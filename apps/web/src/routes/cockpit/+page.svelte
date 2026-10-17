<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { page } from "$app/state";
  import ActivityFeed from "#lib/components/cockpit/ActivityFeed.svelte";
  import ChatFeed from "#lib/components/cockpit/ChatFeed.svelte";
  import GoalBar from "#lib/components/cockpit/GoalBar.svelte";
  import LivePreview from "#lib/components/cockpit/LivePreview.svelte";
  import Moments from "#lib/components/cockpit/Moments.svelte";
  import Momentum from "#lib/components/cockpit/Momentum.svelte";
  import StatusBar from "#lib/components/cockpit/StatusBar.svelte";
  import TopDonors from "#lib/components/cockpit/TopDonors.svelte";
  import Icon from "#lib/components/Icon.svelte";
  import ViewersChart from "#lib/components/ViewersChart.svelte";
  import { t } from "#lib/i18n.ts";
  import { kv } from "#lib/platform.ts";
  import { app } from "#lib/stores/app.svelte.ts";
  import { live } from "#lib/stores/live.svelte.ts";
  import { createWakeLock, wakeLockSupported } from "#lib/wakelock.ts";

  type Tab = "chat" | "activity" | "data";

  // Compacto: panel estrecho (p. ej. un dock del navegador) o pantallas pequeñas. `?compact=1` lo activa de entrada.
  let compact = $state(page.url.searchParams.get("compact") === "1");
  let tab = $state<Tab>("chat");
  let awake = $state(false);
  let fullscreen = $state(false);
  let flash = $state<{ ok: boolean; text: string } | null>(null);
  const wake = createWakeLock();

  const canMark = $derived(app.can("chat.moderate"));
  const TABS: { id: Tab; label: "ck.tabChat" | "ck.tabActivity" | "ck.tabData" }[] = [
    { id: "chat", label: "ck.tabChat" },
    { id: "activity", label: "ck.tabActivity" },
    { id: "data", label: "ck.tabData" },
  ];

  onMount(async () => {
    compact = compact || (await kv.get("cockpit_compact")) === "1";
    // La pantalla encendida se recuerda: en una tablet fija suele querer siempre
    if ((await kv.get("cockpit_awake")) === "1" && wakeLockSupported()) awake = await wake.enable();
    document.addEventListener("fullscreenchange", onFs);
  });
  onDestroy(() => {
    void wake.disable();
    if (typeof document !== "undefined") document.removeEventListener("fullscreenchange", onFs);
  });

  const onFs = () => (fullscreen = document.fullscreenElement !== null);

  async function toggleAwake() {
    if (awake) {
      await wake.disable();
      awake = false;
    } else awake = await wake.enable();
    await kv.set("cockpit_awake", awake ? "1" : null);
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      /* el navegador puede negarlo (iOS Safari) */
    }
  }

  async function toggleCompact() {
    compact = !compact;
    await kv.set("cockpit_compact", compact ? "1" : null);
  }

  async function mark() {
    const ok = await live.mark();
    flash = { ok, text: ok ? t("ck.marked") : t("ck.markFail") };
    setTimeout(() => (flash = null), 2000);
  }

  const btn = "btn !px-3 !py-2";
  const pressed = (on: boolean) => (on ? "!border-accent !bg-accent/15" : "");
</script>

<svelte:head><title>{t("nav.cockpit")} · HiveMonitor</title></svelte:head>

<div class="relative flex h-dvh flex-col gap-3 overflow-hidden p-3 {compact ? 'gap-2 p-2' : ''}">
  <StatusBar {compact}>
    {#snippet controls()}
      {#if canMark}
        <button class="btn btn-primary !px-3 !py-2" onclick={mark} title={t("ck.mark")} aria-label={t("ck.mark")}
          ><Icon name="flag" class="size-5" /><span class="hidden sm:inline">{t("ck.mark")}</span></button
        >
      {/if}
      <button
        class="{btn} {pressed(live.muted)}"
        onclick={() => live.setMuted(!live.muted)}
        aria-pressed={live.muted}
        title={live.muted ? t("ck.unmute") : t("ck.mute")}
        aria-label={live.muted ? t("ck.unmute") : t("ck.mute")}
      >
        <Icon name={live.muted ? "bellOff" : "bell"} class="size-5" />
      </button>
      {#if wakeLockSupported()}
        <button
          class="{btn} {pressed(awake)}"
          onclick={toggleAwake}
          aria-pressed={awake}
          title={awake ? t("ck.awakeOn") : t("ck.awake")}
          aria-label={t("ck.awake")}><Icon name="sun2" class="size-5" /></button
        >
      {/if}
      <button
        class="{btn} {pressed(fullscreen)}"
        onclick={toggleFullscreen}
        aria-pressed={fullscreen}
        title={t("ck.fullscreen")}
        aria-label={t("ck.fullscreen")}><Icon name="full" class="size-5" /></button
      >
      <button
        class="{btn} {pressed(compact)}"
        onclick={toggleCompact}
        aria-pressed={compact}
        title={t("ck.compact")}
        aria-label={t("ck.compact")}
      >
        <span class="text-xs font-bold">{compact ? "▤" : "▦"}</span>
      </button>
      <a class={btn} href="/" title={t("ck.exit")} aria-label={t("ck.exit")}><Icon name="out" class="size-5" /></a>
    {/snippet}
  </StatusBar>

  {#if flash}
    <p
      class="fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-lg border border-border bg-surface-2 px-4 py-2 text-sm shadow-lg {flash.ok
        ? 'text-good'
        : 'text-bad'}"
      role="status"
    >
      {flash.text}
    </p>
  {/if}

  <!-- Pestañas: solo en pantallas estrechas (tablet vertical, móvil). Desde `lg` se ve todo a la vez. -->
  <div class="grid grid-cols-3 gap-2 lg:hidden" role="tablist">
    {#each TABS as tb (tb.id)}
      <button
        class="btn {tab === tb.id ? '!border-accent !bg-accent/15' : ''}"
        role="tab"
        aria-selected={tab === tb.id}
        onclick={() => (tab = tb.id)}>{t(tb.label)}</button
      >
    {/each}
  </div>

  <div
    class="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] {compact
      ? ''
      : 'xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1.15fr)_minmax(0,0.8fr)]'}"
  >
    <!-- Datos -->
    <div class="min-h-0 flex-col gap-3 overflow-y-auto {tab === 'data' ? 'flex' : 'hidden'} lg:flex">
      {#if !compact}
        <section class="card p-4">
          <h2 class="mb-2 font-medium">{t("dash.viewersOverTime")}</h2>
          <ViewersChart history={live.history} now={live.now} rangeMs={30 * 60_000} height={220} />
        </section>
      {/if}
      {#if !compact}<LivePreview />{/if}
      <Momentum />
      <GoalBar />
      {#if !compact}<TopDonors />{/if}
      <Moments />
    </div>

    <!-- Chat y actividad. En pantallas estrechas son pestañas; en `lg` van apilados a la derecha; en `xl` son columnas propias. -->
    <div class="contents min-h-0 lg:flex lg:flex-col lg:gap-3 {compact ? '' : 'xl:contents'}">
      <div class="min-h-0 flex-col gap-3 {tab === 'chat' ? 'flex' : 'hidden'} lg:flex lg:flex-1">
        <ChatFeed {compact} />
      </div>
      <div class="min-h-0 flex-col gap-3 {tab === 'activity' ? 'flex' : 'hidden'} lg:flex lg:flex-1">
        <ActivityFeed {compact} />
        {#if compact}<TopDonors />{/if}
      </div>
    </div>
  </div>
</div>
