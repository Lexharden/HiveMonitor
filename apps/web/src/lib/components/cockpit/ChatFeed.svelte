<script lang="ts">
  import { tick } from "svelte";
  import type { NormalizedEvent } from "@hivemonitor/client";
  import PlatformBadge from "#lib/components/PlatformBadge.svelte";
  import { fmtTime } from "#lib/format.ts";
  import { isImportant, type HighlightKind } from "#lib/highlight.ts";
  import { t, type MessageKey } from "#lib/i18n.ts";
  import { createModerator, type ModAction } from "#lib/moderation.ts";
  import { app } from "#lib/stores/app.svelte.ts";
  import { live } from "#lib/stores/live.svelte.ts";

  type Chat = Extract<NormalizedEvent, { type: "chat" }>;

  let { compact = false }: { compact?: boolean } = $props();

  let box: HTMLElement | undefined = $state();
  let atBottom = $state(true);
  let unseen = $state(0);
  let lastLen = 0;
  let onlyImportant = $state(false);
  let openId = $state<string | null>(null);
  let toast = $state<{ ok: boolean; text: string } | null>(null);

  const canModerate = $derived(app.can("chat.moderate"));
  const messages = $derived((live.chat as Chat[]).filter((m) => !onlyImportant || isImportant(live.chatHl[m.id] ?? [])));

  // Estilo por la categoría más importante; siempre con texto, nunca solo color
  const STYLE: Record<HighlightKind, string> = {
    donor: "border-l-good bg-good/10",
    mention: "border-l-accent bg-accent/10",
    question: "border-l-warn bg-warn/10",
    mod: "border-l-fg-3",
    sub: "border-l-fg-3",
    first: "border-l-border",
  };
  const PILL: Record<HighlightKind, string> = {
    donor: "bg-good/20 text-good",
    mention: "bg-accent/20 text-accent",
    question: "bg-warn/20 text-warn",
    mod: "bg-surface-2 text-fg-2",
    sub: "bg-surface-2 text-fg-2",
    first: "bg-surface-2 text-fg-3",
  };

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

  const moderator = $derived(
    app.org
      ? createModerator(
          app.client,
          app.org.id,
          (m) => live.connections.find((c) => c.platform === m.platform && c.channelId === m.channelId)?.id,
        )
      : null,
  );

  async function moderate(m: Chat, action: ModAction) {
    const ok = (await moderator?.(m, action)) ?? false;
    toast = { ok, text: ok ? t("chat.modOk") : t("chat.modFail") };
    openId = null;
    setTimeout(() => (toast = null), 2500);
  }
</script>

<section class="card relative flex min-h-0 flex-1 flex-col" aria-label={t("ck.chat")}>
  <div class="flex items-center justify-between border-b border-border px-4 py-2">
    <h2 class="font-medium">{t("ck.chat")}</h2>
    <label class="flex items-center gap-2 text-xs text-fg-2">
      <input type="checkbox" class="size-4 accent-[var(--accent)]" bind:checked={onlyImportant} />{t("ck.onlyImportant")}
    </label>
  </div>

  <div bind:this={box} onscroll={onScroll} class="min-h-0 flex-1 overflow-y-auto p-2" role="log" aria-live="off">
    {#if messages.length === 0}<p class="p-6 text-center text-sm text-fg-3">{t("ck.chatEmpty")}</p>{/if}
    {#each messages as m (m.id)}
      {@const kinds = live.chatHl[m.id] ?? []}
      <div
        class="mb-0.5 rounded-md border-l-4 {kinds.length ? STYLE[kinds[0]!] : 'border-l-transparent'} {compact
          ? 'text-sm'
          : 'text-[15px]'}"
      >
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div
          class="flex items-start gap-2 px-2 py-1.5 {canModerate ? 'cursor-pointer' : ''}"
          onclick={() => canModerate && (openId = openId === m.id ? null : m.id)}
        >
          <span class="mt-1 shrink-0"><PlatformBadge platform={m.platform} compact /></span>
          <p class="min-w-0 flex-1 break-words leading-snug">
            {#each kinds.slice(0, 2) as k (k)}<span class="mr-1.5 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase {PILL[k]}"
                >{t(`ck.hl.${k}` as MessageKey)}</span
              >{/each}
            <span class="font-semibold">{m.actor?.name ?? "—"}</span>
            <span class="text-fg-2">{m.payload.message}</span>
          </p>
          <span class="mt-0.5 shrink-0 text-xs text-fg-3 tabular-nums">{fmtTime(m.occurredAt).slice(0, 5)}</span>
        </div>
        {#if openId === m.id}
          <div class="flex flex-wrap gap-2 px-2 pb-2">
            <button class="btn !py-1 text-xs" onclick={() => moderate(m, "timeout")}>{t("chat.timeout")}</button>
            <button class="btn !py-1 text-xs" onclick={() => moderate(m, "delete")}>{t("chat.delete")}</button>
            <button class="btn btn-danger !py-1 text-xs" onclick={() => moderate(m, "ban")}>{t("chat.ban")}</button>
          </div>
        {/if}
      </div>
    {/each}
  </div>

  {#if unseen > 0}
    <button class="btn btn-primary absolute bottom-3 left-1/2 -translate-x-1/2 shadow-lg" onclick={toBottom}
      >{t("chat.paused", { n: unseen })} · {t("chat.resume")}</button
    >
  {/if}
  {#if toast}<p
      class="absolute right-3 top-12 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm {toast.ok ? 'text-good' : 'text-bad'}"
      role="status"
    >
      {toast.text}
    </p>{/if}
</section>
