<script lang="ts">
  import type { SystemInfo } from "@hivemonitor/client";
  import { fmtDateTime, fmtDuration, fmtNumber } from "#lib/format.ts";
  import { t } from "#lib/i18n.ts";
  import { app } from "#lib/stores/app.svelte.ts";
  import PlatformBadge from "#lib/components/PlatformBadge.svelte";
  import StatusBadge from "#lib/components/StatusBadge.svelte";

  type Tenant = Awaited<ReturnType<typeof app.client.admin.tenants>>["tenants"][number];
  let tenants = $state<Tenant[]>([]);
  let system = $state<SystemInfo | null>(null);
  let error = $state("");

  async function load() {
    try {
      const [a, b] = await Promise.all([app.client.admin.tenants(), app.client.admin.system()]);
      tenants = a.tenants;
      system = b;
    } catch {
      error = t("common.error");
    }
  }
  $effect(() => {
    if (app.isSuperadmin) {
      void load();
      const timer = setInterval(() => void load(), 15_000);
      return () => clearInterval(timer);
    }
  });

  async function patch(id: string, body: { suspended?: boolean; limits?: Record<string, unknown> }) {
    error = "";
    try {
      await app.client.admin.patchTenant(id, body);
      await load();
    } catch {
      error = t("common.error");
    }
  }
  const name = (id: string) => tenants.find((x) => x.id === id)?.name ?? id.slice(0, 8);
</script>

<svelte:head><title>{t("admin.title")} · HiveMonitor</title></svelte:head>

<h1 class="mb-6 text-2xl font-semibold tracking-tight">{t("admin.title")}</h1>

{#if !app.isSuperadmin}
  <p class="text-fg-2">403</p>
{:else}
  {#if error}<p class="mb-4 text-sm text-bad" role="alert">{error}</p>{/if}

  {#if system}
    <section class="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5" aria-label={t("admin.system")}>
      <div class="card p-4"><p class="text-xs text-fg-3">{t("admin.uptime")}</p><p class="mt-1 text-xl font-semibold tabular-nums">{fmtDuration(system.uptimeSec)}</p></div>
      <div class="card p-4"><p class="text-xs text-fg-3">{t("admin.memory")}</p><p class="mt-1 text-xl font-semibold tabular-nums">{system.memory.rssMb} MB</p><p class="text-xs text-fg-3">heap {system.memory.heapUsedMb} MB</p></div>
      <div class="card p-4"><p class="text-xs text-fg-3">{t("admin.connections")}</p><p class="mt-1 text-xl font-semibold tabular-nums">{system.connections.total}</p><p class="text-xs text-fg-3">{Object.entries(system.connections.byStatus).map(([k, v]) => `${v} ${k}`).join(" · ")}</p></div>
      <div class="card p-4"><p class="text-xs text-fg-3">{t("admin.queued")}</p><p class="mt-1 text-xl font-semibold tabular-nums">{system.connections.queued}</p></div>
      <div class="card p-4"><p class="text-xs text-fg-3">{t("admin.rateLimits")}</p><p class="mt-1 text-xl font-semibold tabular-nums">{fmtNumber(system.connections.rateLimitHits)}</p><p class="text-xs text-fg-3">{Object.entries(system.connections.cooldownMs).map(([p, ms]) => `${p}: ${Math.ceil(ms / 1000)} s`).join(" · ")}</p></div>
    </section>
  {/if}

  <section class="card mb-6 overflow-x-auto">
    <h2 class="border-b border-border px-4 py-3 font-medium">{t("admin.tenants")}</h2>
    <table class="w-full text-left text-sm">
      <thead class="text-xs text-fg-3">
        <tr><th class="px-4 py-2 font-medium">Organización</th><th class="px-2 py-2 font-medium">Miembros</th><th class="px-2 py-2 font-medium">Canales (en vivo)</th><th class="px-2 py-2 font-medium">{t("admin.limit")}</th><th class="px-2 py-2 font-medium">Alta</th><th class="px-4 py-2"></th></tr>
      </thead>
      <tbody>
        {#each tenants as tn (tn.id)}
          <tr class="border-t border-border">
            <td class="px-4 py-2"><span class="font-medium">{tn.name}</span><span class="ml-2 text-xs text-fg-3">{tn.slug}</span>{#if tn.suspended}<span class="ml-2 rounded bg-bad/15 px-1.5 py-0.5 text-xs text-bad">{t("admin.suspended")}</span>{/if}</td>
            <td class="px-2 py-2 tabular-nums">{tn.members}</td>
            <td class="px-2 py-2 tabular-nums">{tn.connections} ({tn.live})</td>
            <td class="px-2 py-2">
              <input class="input !w-20 !py-1" type="number" min="0" max="500" value={tn.limits?.maxConnections ?? 5} aria-label={t("admin.limit")} onchange={(e) => patch(tn.id, { limits: { ...(tn.limits ?? {}), maxConnections: Number(e.currentTarget.value) } })} />
            </td>
            <td class="px-2 py-2 text-xs text-fg-3">{fmtDateTime(tn.createdAt)}</td>
            <td class="px-4 py-2 text-right"><button class="btn {tn.suspended ? '' : 'btn-danger'}" onclick={() => patch(tn.id, { suspended: !tn.suspended })}>{tn.suspended ? t("admin.resume") : t("admin.suspend")}</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>

  {#if system}
    <div class="grid gap-6 lg:grid-cols-2">
      <section class="card">
        <h2 class="border-b border-border px-4 py-3 font-medium">{t("admin.connections")}</h2>
        <div class="max-h-80 divide-y divide-border overflow-y-auto">
          {#each system.connectionList as c (c.id)}
            <div class="flex items-center gap-3 px-4 py-2 text-sm">
              <PlatformBadge platform={c.platform} compact />
              <span class="min-w-0 flex-1 truncate">{name(c.tenantId)}</span>
              <StatusBadge status={c.status} />
            </div>
          {/each}
        </div>
      </section>
      <section class="card">
        <h2 class="border-b border-border px-4 py-3 font-medium">{t("admin.errors")}</h2>
        <div class="max-h-80 divide-y divide-border overflow-y-auto">
          {#if system.errors.length === 0}<p class="p-6 text-center text-sm text-fg-3">{t("admin.noErrors")}</p>{/if}
          {#each system.errors as e (e.at + e.msg)}
            <div class="px-4 py-2 text-sm"><span class="text-xs text-fg-3 tabular-nums">{fmtDateTime(e.at)}</span> <span class="font-medium">{e.msg}</span>{#if e.detail}<p class="truncate text-xs text-fg-3">{e.detail}</p>{/if}</div>
          {/each}
        </div>
      </section>
    </div>
  {/if}
{/if}
