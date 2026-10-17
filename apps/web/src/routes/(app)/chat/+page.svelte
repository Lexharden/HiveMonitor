<script lang="ts">
  import { tick } from "svelte";
  import PlatformBadge from "#lib/components/PlatformBadge.svelte";
  import { fmtTime } from "#lib/format.ts";
  import { t } from "#lib/i18n.ts";
  import { app } from "#lib/stores/app.svelte.ts";
  import { live } from "#lib/stores/live.svelte.ts";
  import type { Client, NormalizedEvent } from "@hivemonitor/client";

  let box: HTMLElement | undefined = $state();
  let atBottom = $state(true);
  let unseen = $state(0);
  let lastLen = 0;
  let toast = $state<{ ok: boolean; text: string } | null>(null);
  type Socket = Awaited<ReturnType<ReturnType<Client["tenant"]>["socket"]>>;
  let socket: Promise<Socket> | null = null;

  const canModerate = $derived(app.can("chat.moderate"));
  const messages = $derived(live.chat as Extract<NormalizedEvent, { type: "chat" }>[]);

  function onScroll() {
    if (!box) return;
    atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    if (atBottom) unseen = 0;
  }

  $effect(() => {
    const n = messages.length;
    const added = Math.max(0, n - lastLen);
    lastLen = n;
    if (!box || added === 0) return;
    if (atBottom) void tick().then(() => box && (box.scrollTop = box.scrollHeight));
    else unseen += added;
  });

  function toBottom() {
    if (box) box.scrollTop = box.scrollHeight;
    unseen = 0;
  }

  async function moderate(m: Extract<NormalizedEvent, { type: "chat" }>, action: "timeout" | "ban" | "delete") {
    const conn = live.connections.find((c) => c.platform === m.platform && c.channelId === m.channelId);
    if (!conn || !app.org) return;
    try {
      socket ??= app.client.tenant(app.org.id).socket();
      const ws = await socket;
      const r = await ws.moderate({
        connectionId: conn.id,
        action,
        targetId: m.actor?.id,
        messageId: m.payload.messageId,
        durationSec: action === "timeout" ? 600 : undefined,
      });
      toast = { ok: r.ok, text: r.ok ? t("chat.modOk") : t("chat.modFail") };
    } catch {
      socket = null;
      toast = { ok: false, text: t("chat.modFail") };
    }
    setTimeout(() => (toast = null), 3000);
  }
</script>

<svelte:head><title>{t("chat.title")} · HiveMonitor</title></svelte:head>

<h1 class="mb-4 text-2xl font-semibold tracking-tight">{t("chat.title")}</h1>

{#if !app.can("chat.view")}
  <p class="text-fg-2">{t("chat.noPermission")}</p>
{:else}
  <div class="card relative">
    <div bind:this={box} onscroll={onScroll} class="h-[calc(100dvh-11rem)] min-h-80 overflow-y-auto p-2" role="log" aria-live="off" aria-label={t("chat.title")}>
      {#if messages.length === 0}
        <p class="p-6 text-center text-sm text-fg-3">{t("chat.empty")}</p>
      {/if}
      {#each messages as m (m.id)}
        <div class="group flex items-start gap-2 rounded-md px-2 py-1 hover:bg-surface-2">
          <span class="mt-1 shrink-0"><PlatformBadge platform={m.platform} compact /></span>
          <span class="mt-0.5 shrink-0 text-xs text-fg-3 tabular-nums">{fmtTime(m.occurredAt)}</span>
          <p class="min-w-0 flex-1 break-words text-sm">
            <span class="font-semibold text-fg">{m.actor?.name ?? "—"}</span>
            <span class="text-fg-2">{m.payload.message}</span>
          </p>
          {#if canModerate}
            <span class="flex shrink-0 gap-1 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
              <button class="btn !px-2 !py-0.5 text-xs" onclick={() => moderate(m, "timeout")}>{t("chat.timeout")}</button>
              <button class="btn !px-2 !py-0.5 text-xs" onclick={() => moderate(m, "delete")}>{t("chat.delete")}</button>
              <button class="btn btn-danger !px-2 !py-0.5 text-xs" onclick={() => moderate(m, "ban")}>{t("chat.ban")}</button>
            </span>
          {/if}
        </div>
      {/each}
    </div>

    {#if unseen > 0}
      <button class="btn btn-primary absolute bottom-3 left-1/2 -translate-x-1/2 shadow-lg" onclick={toBottom}>
        {t("chat.paused", { n: unseen })} · {t("chat.resume")}
      </button>
    {/if}
    {#if toast}
      <p class="absolute right-3 top-3 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm {toast.ok ? 'text-good' : 'text-bad'}" role="status">{toast.text}</p>
    {/if}
  </div>
{/if}
