<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import type { Permission } from "@hivemonitor/client";
  import Icon, { type IconName } from "#lib/components/Icon.svelte";
  import { t, type MessageKey } from "#lib/i18n.ts";
  import { kv } from "#lib/platform.ts";
  import { app } from "#lib/stores/app.svelte.ts";
  import { live } from "#lib/stores/live.svelte.ts";
  import { onDestroy } from "svelte";

  let { children } = $props();

  interface NavItem {
    href: string;
    label: MessageKey;
    icon: IconName;
    need?: Permission;
    superadmin?: boolean;
  }
  const NAV: NavItem[] = [
    { href: "/", label: "nav.dashboard", icon: "live", need: "stream.view" },
    { href: "/chat", label: "nav.chat", icon: "chat", need: "chat.view" },
    { href: "/events", label: "nav.events", icon: "events", need: "events.view" },
    { href: "/history", label: "nav.history", icon: "history", need: "analytics.view" },
    { href: "/integrations", label: "nav.integrations", icon: "plug", need: "integrations.manage" },
  ];
  const items = $derived(NAV.filter((i) => (!i.need || app.can(i.need)) && (!i.superadmin || app.isSuperadmin)));

  // Guardas de acceso (y retoma una invitación pendiente tras iniciar sesión)
  $effect(() => {
    if (!app.me) {
      void goto("/login", { replaceState: true });
      return;
    }
    const noOrgs = app.orgs.length === 0;
    void kv.get("pending_invite").then((id) => {
      if (id) void kv.set("pending_invite", null).then(() => goto(`/accept-invitation/${id}`));
      else if (noOrgs) void goto("/onboarding", { replaceState: true });
    });
  });

  // Flujo en tiempo real de la organización activa
  $effect(() => {
    const org = app.org;
    if (org && !org.suspended && org.permissions.includes("stream.view")) live.start(app.client, org.id);
    else live.stop();
  });
  onDestroy(() => live.stop());

  const isActive = (href: string) => (href === "/" ? page.url.pathname === "/" : page.url.pathname.startsWith(href));
</script>

{#if app.me && app.org}
  <div class="flex min-h-screen flex-col md:flex-row">
    <!-- Barra lateral (tablet/laptop) -->
    <aside class="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-surface md:flex">
      <div class="flex items-center gap-2 px-4 py-4">
        <img src="/icons/icon-256.png" alt="" class="size-8 rounded-lg" />
        <span class="font-semibold tracking-tight">{t("app.name")}</span>
      </div>

      <div class="px-3 pb-3">
        <label class="mb-1 block px-1 text-xs font-medium text-fg-3" for="org-select">{t("org.select")}</label>
        <select id="org-select" class="input" value={app.org.id} onchange={(e) => app.setOrg(e.currentTarget.value)}>
          {#each app.orgs as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
        </select>
      </div>

      <nav class="flex-1 space-y-1 px-3" aria-label="Principal">
        {#each items as it (it.href)}
          <a
            href={it.href}
            class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition {isActive(it.href) ? 'bg-surface-2 text-fg' : 'text-fg-2 hover:bg-surface-2'}"
            aria-current={isActive(it.href) ? "page" : undefined}
          >
            <Icon name={it.icon} />{t(it.label)}
          </a>
        {/each}
      </nav>

      <div class="space-y-2 border-t border-border p-3">
        <p class="truncate px-1 text-xs text-fg-3" title={app.me.user.email}>{app.me.user.name}</p>
        <div class="flex gap-2">
          <button class="btn flex-1" onclick={() => app.toggleTheme()} aria-label="Cambiar tema">
            <Icon name={app.theme === "dark" ? "sun" : "moon"} class="size-4" />
          </button>
          <button class="btn flex-1" onclick={() => app.logout().then(() => goto("/login"))} aria-label={t("common.signOut")}>
            <Icon name="out" class="size-4" />
          </button>
        </div>
      </div>
    </aside>

    <!-- Cabecera móvil -->
    <header class="flex items-center justify-between gap-2 border-b border-border bg-surface px-4 py-3 md:hidden">
      <span class="font-semibold">{t("app.name")}</span>
      <select class="input !w-auto max-w-[55%]" value={app.org.id} onchange={(e) => app.setOrg(e.currentTarget.value)} aria-label={t("org.select")}>
        {#each app.orgs as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
      </select>
    </header>

    <div class="min-w-0 flex-1">
      {#if live.link === "closed" && app.org.permissions.includes("stream.view")}
        <div class="bg-warn/15 px-4 py-2 text-center text-sm text-warn" role="status">{t("conn.lost")}</div>
      {/if}
      {#if app.org.suspended && !app.isSuperadmin}
        <div class="m-6 card p-6 text-sm text-warn">{t("org.suspended")}</div>
      {:else}
        <main class="mx-auto w-full max-w-6xl p-4 pb-24 md:p-8 md:pb-8">
          {@render children()}
        </main>
      {/if}
    </div>

    <!-- Navegación inferior (móvil) -->
    <nav class="fixed inset-x-0 bottom-0 z-20 flex border-t border-border bg-surface md:hidden" aria-label="Principal">
      {#each items as it (it.href)}
        <a href={it.href} class="flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] {isActive(it.href) ? 'text-accent' : 'text-fg-3'}" aria-current={isActive(it.href) ? "page" : undefined}>
          <Icon name={it.icon} />{t(it.label)}
        </a>
      {/each}
    </nav>
  </div>
{/if}
