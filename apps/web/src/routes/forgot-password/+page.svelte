<script lang="ts">
  import { onMount } from "svelte";
  import AuthCard from "#lib/components/AuthCard.svelte";
  import { t } from "#lib/i18n.ts";
  import { app } from "#lib/stores/app.svelte.ts";

  let email = $state("");
  let sent = $state(false);
  let busy = $state(false);
  let error = $state("");

  onMount(() => void app.loadPublicMeta());

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = "";
    busy = true;
    try {
      // El enlace del correo abre la web del servidor (también desde la app Tauri: se completa en el navegador)
      const base = app.native ? app.serverUrl : location.origin;
      await app.client.auth.requestPasswordReset(email.trim(), `${base}/reset-password`);
      sent = true; // misma respuesta exista o no la cuenta
    } catch {
      error = t("common.error");
    } finally {
      busy = false;
    }
  }
</script>

<AuthCard title={t("auth.forgotTitle")}>
  {#if app.meta && !app.meta.emailEnabled}
    <p class="text-sm text-fg-2">{t("auth.noEmail")}</p>
  {:else if sent}
    <p class="text-sm text-good" role="status">{t("auth.forgotSent")}</p>
  {:else}
    <p class="mb-4 text-sm text-fg-2">{t("auth.forgotText")}</p>
    <form class="space-y-4" onsubmit={submit}>
      <div>
        <label class="mb-1 block text-sm font-medium" for="email">{t("auth.email")}</label>
        <input id="email" class="input" type="email" autocomplete="username" required bind:value={email} />
      </div>
      {#if error}<p class="text-sm text-bad" role="alert">{error}</p>{/if}
      <button class="btn btn-primary w-full" disabled={busy || !email}>{t("auth.forgotSend")}</button>
    </form>
  {/if}
  <p class="mt-5 text-center text-sm"><a class="text-accent hover:underline" href="/login">{t("auth.backToLogin")}</a></p>
</AuthCard>
