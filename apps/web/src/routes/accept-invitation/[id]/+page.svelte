<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import AuthCard from "#lib/components/AuthCard.svelte";
  import { t } from "#lib/i18n.ts";
  import { kv } from "#lib/platform.ts";
  import { app } from "#lib/stores/app.svelte.ts";

  let error = $state("");
  let done = $state(false);

  $effect(() => {
    // Sin sesión: primero iniciar sesión (y volver a abrir el enlace)
    if (!app.me) void kv.set("pending_invite", page.params.id ?? null).then(() => goto("/login", { replaceState: true }));
  });

  async function accept() {
    error = "";
    try {
      await app.client.orgs.acceptInvitation(page.params.id!);
      await app.refreshMe();
      done = true;
      await goto("/");
    } catch {
      error = t("common.error");
    }
  }
</script>

<AuthCard title="Invitación">
  <p class="mb-4 text-sm text-fg-2">Has sido invitado a unirte a una organización en HiveMonitor.</p>
  {#if error}<p class="mb-3 text-sm text-bad" role="alert">{error}</p>{/if}
  <button class="btn btn-primary w-full" onclick={accept} disabled={done}>Aceptar invitación</button>
</AuthCard>
