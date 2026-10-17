<script lang="ts">
  import { page } from "$app/state";
  import AuthCard from "#lib/components/AuthCard.svelte";
  import { t } from "#lib/i18n.ts";
  import { app } from "#lib/stores/app.svelte.ts";

  const token = $derived(page.url.searchParams.get("token") ?? "");
  const linkError = $derived(page.url.searchParams.get("error"));
  let password = $state("");
  let done = $state(false);
  let error = $state("");
  let busy = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = "";
    busy = true;
    try {
      await app.client.auth.resetPassword(token, password);
      done = true;
    } catch {
      error = t("auth.resetInvalid");
    } finally {
      busy = false;
    }
  }
</script>

<AuthCard title={t("auth.resetTitle")}>
  {#if done}
    <p class="text-sm text-good" role="status">{t("auth.resetDone")}</p>
  {:else if !token || linkError}
    <p class="text-sm text-bad" role="alert">{t("auth.resetInvalid")}</p>
    <p class="mt-3 text-sm"><a class="text-accent hover:underline" href="/forgot-password">{t("auth.forgot")}</a></p>
  {:else}
    <form class="space-y-4" onsubmit={submit}>
      <div>
        <label class="mb-1 block text-sm font-medium" for="pw">{t("auth.newPassword")}</label>
        <input id="pw" class="input" type="password" autocomplete="new-password" minlength="10" required bind:value={password} />
        <p class="mt-1 text-xs text-fg-3">{t("auth.passwordRule")}</p>
      </div>
      {#if error}<p class="text-sm text-bad" role="alert">{error}</p>{/if}
      <button class="btn btn-primary w-full" disabled={busy || password.length < 10}>{t("common.save")}</button>
    </form>
  {/if}
  <p class="mt-5 text-center text-sm"><a class="text-accent hover:underline" href="/login">{t("auth.backToLogin")}</a></p>
</AuthCard>
