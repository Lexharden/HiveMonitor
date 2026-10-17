<script lang="ts">
  import { ApiError, type AuditEntry, type InvitationRow, type MemberRow } from "@hivemonitor/client";
  import { fmtDateTime } from "#lib/format.ts";
  import { t, type MessageKey } from "#lib/i18n.ts";
  import { app } from "#lib/stores/app.svelte.ts";

  const ASSIGNABLE = ["admin", "moderator", "analyst"] as const;
  const roleLabel = (r: string) => (["owner", "admin", "moderator", "analyst"].includes(r) ? t(`role.${r}` as MessageKey) : r);

  let members = $state<MemberRow[]>([]);
  let invitations = $state<InvitationRow[]>([]);
  let emailEnabled = $state(false);
  let audit = $state<AuditEntry[]>([]);
  let email = $state("");
  let role = $state<string>("moderator");
  let error = $state("");
  let info = $state("");
  let busy = $state(false);

  const orgId = $derived(app.org?.id ?? "");
  const api = $derived(app.org ? app.client.tenant(app.org.id) : null);
  const allowed = $derived(app.can("members.manage"));
  const isOwner = $derived(app.can("org.manage"));
  const myId = $derived(app.me?.user.id);

  async function load() {
    if (!api) return;
    const [m, a] = await Promise.all([api.members.list(), api.audit(40)]);
    members = m.members;
    invitations = m.invitations;
    emailEnabled = m.emailEnabled;
    audit = a.entries;
  }
  $effect(() => {
    void app.org?.id;
    if (allowed) void load();
  });

  async function run(fn: () => Promise<unknown>, ok = "") {
    error = info = "";
    try {
      await fn();
      info = ok;
      await load();
    } catch (err) {
      error = err instanceof ApiError ? String((err.body as { message?: string } | null)?.message ?? t("members.failed")) : t("members.failed");
    }
  }

  async function invite(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    await run(() => app.client.orgs.invite(orgId, email.trim(), role), emailEnabled ? t("members.emailOn") : t("members.emailOff"));
    if (!error) email = "";
    busy = false;
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      info = t("members.copied");
    } catch {
      info = link;
    }
  }

  // Quien no es owner no puede tocar al owner ni asignar ese rol
  const canEdit = (m: MemberRow) => m.userId !== myId && (m.role !== "owner" || isOwner) && m.role !== "owner";
</script>

<svelte:head><title>{t("members.title")} · HiveMonitor</title></svelte:head>

<h1 class="mb-6 text-2xl font-semibold tracking-tight">{t("members.title")}</h1>

{#if !allowed}
  <p class="text-fg-2">{t("members.noPermission")}</p>
{:else}
  {#if error}<p class="mb-4 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad" role="alert">{error}</p>{/if}
  {#if info}<p class="mb-4 break-all rounded-lg border border-good/40 bg-good/10 px-3 py-2 text-sm text-good" role="status">{info}</p>{/if}

  <section class="card mb-6 divide-y divide-border">
    {#each members as m (m.id)}
      <div class="flex flex-wrap items-center gap-3 p-4">
        <div class="min-w-0 flex-1">
          <p class="truncate font-medium">{m.name}{#if m.userId === myId}<span class="ml-2 text-xs text-fg-3">({t("members.you")})</span>{/if}</p>
          <p class="truncate text-xs text-fg-3">{m.email}</p>
        </div>
        {#if canEdit(m)}
          <select class="input !w-auto" value={m.role} aria-label={t("members.role")} onchange={(e) => run(() => app.client.orgs.updateRole(orgId, m.id, e.currentTarget.value))}>
            {#each ASSIGNABLE as r (r)}<option value={r}>{roleLabel(r)}</option>{/each}
          </select>
          <button class="btn" onclick={() => confirm(t("members.confirmRemove", { name: m.name })) && run(() => app.client.orgs.removeMember(orgId, m.id))}>{t("members.remove")}</button>
          {#if isOwner}
            <button class="btn" onclick={() => confirm(t("members.transferConfirm", { name: m.name })) && run(() => api!.members.transferOwnership(m.id))}>{t("members.transfer")}</button>
          {/if}
        {:else}
          <span class="rounded-full border border-border px-3 py-1 text-xs text-fg-2">{roleLabel(m.role)}</span>
        {/if}
      </div>
    {/each}
  </section>

  <form class="card mb-6 grid gap-4 p-4 sm:grid-cols-[1fr_10rem_auto] sm:items-end" onsubmit={invite}>
    <div>
      <label class="mb-1 block text-sm font-medium" for="inv-email">{t("members.email")}</label>
      <input id="inv-email" class="input" type="email" required bind:value={email} autocomplete="off" />
    </div>
    <div>
      <label class="mb-1 block text-sm font-medium" for="inv-role">{t("members.role")}</label>
      <select id="inv-role" class="input" bind:value={role}>{#each ASSIGNABLE as r (r)}<option value={r}>{roleLabel(r)}</option>{/each}</select>
    </div>
    <button class="btn btn-primary" disabled={busy || !email}>{t("members.invite")}</button>
  </form>

  {#if invitations.length}
    <section class="card mb-6 divide-y divide-border">
      <h2 class="px-4 py-3 font-medium">{t("members.pending")}</h2>
      {#each invitations as i (i.id)}
        <div class="flex flex-wrap items-center gap-3 p-4">
          <div class="min-w-0 flex-1"><p class="truncate text-sm font-medium">{i.email}</p><p class="text-xs text-fg-3">{roleLabel(i.role ?? "")} · {fmtDateTime(i.expiresAt)}</p></div>
          <button class="btn" onclick={() => copy(i.link)}>{t("members.copyLink")}</button>
          <button class="btn" onclick={() => run(() => app.client.orgs.cancelInvitation(i.id))}>{t("members.cancelInvite")}</button>
        </div>
      {/each}
    </section>
  {/if}

  <section class="card divide-y divide-border">
    <h2 class="px-4 py-3 font-medium">{t("members.audit")}</h2>
    {#each audit as a (a.id)}
      <div class="flex items-center gap-3 px-4 py-2 text-sm">
        <span class="w-28 shrink-0 text-xs text-fg-3 tabular-nums">{fmtDateTime(a.at)}</span>
        <code class="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-xs">{a.action}</code>
        <span class="min-w-0 flex-1 truncate text-xs text-fg-3">{Object.entries(a.meta ?? {}).map(([k, v]) => `${k}=${v}`).join(" · ")}</span>
      </div>
    {/each}
  </section>
{/if}
