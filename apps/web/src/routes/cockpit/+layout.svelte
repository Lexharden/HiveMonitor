<script lang="ts">
  import { goto } from "$app/navigation";
  import { onDestroy } from "svelte";
  import Toasts from "#lib/components/Toasts.svelte";
  import { t } from "#lib/i18n.ts";
  import { notify } from "#lib/platform.ts";
  import { app } from "#lib/stores/app.svelte.ts";
  import { live } from "#lib/stores/live.svelte.ts";

  let { children } = $props();

  // Misma guarda que el panel: sin sesión → login; sin organización → onboarding
  $effect(() => {
    if (!app.me) void goto("/login", { replaceState: true });
    else if (app.orgs.length === 0) void goto("/onboarding", { replaceState: true });
  });

  // Flujo en tiempo real de la organización activa
  $effect(() => {
    const org = app.org;
    if (org && !org.suspended && org.permissions.includes("stream.view")) live.start(app.client, org.id);
    else live.stop();
  });
  onDestroy(() => live.stop());

  // Notificación del sistema para alertas con ese canal, salvo que se hayan silenciado
  $effect(() => live.onAlert((a) => a.channels.includes("native") && !live.muted && void notify(a.ruleName, a.message)));
</script>

{#if app.me && app.org}
  <Toasts />
  {#if live.link === "closed"}
    <div class="bg-warn/15 px-4 py-1.5 text-center text-sm text-warn" role="status">{t("conn.lost")}</div>
  {/if}
  {@render children()}
{/if}
