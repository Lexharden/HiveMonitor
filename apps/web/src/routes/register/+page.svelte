<script lang="ts">
  import { goto } from "$app/navigation";
  import { ApiError } from "@hivemonitor/client";
  import AuthCard from "#lib/components/AuthCard.svelte";
  import { t } from "#lib/i18n.ts";
  import { app } from "#lib/stores/app.svelte.ts";

  let server = $state(app.serverUrl);
  let name = $state("");
  let email = $state("");
  let password = $state("");
  let error = $state("");
  let busy = $state(false);

  $effect(() => {
    if (app.me) void goto("/", { replaceState: true });
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = "";
    busy = true;
    try {
      if (app.native) {
        if (!(await app.testServer(server))) {
          error = t("auth.serverFail");
          return;
        }
        await app.setServerUrl(server);
      }
      await app.register(name, email, password);
    } catch (err) {
      error = err instanceof ApiError ? String((err.body as { message?: string } | null)?.message ?? err.code) : t("common.error");
    } finally {
      busy = false;
    }
  }
</script>

<AuthCard title={t("auth.register")}>
  <form class="space-y-4" onsubmit={submit}>
    {#if app.native}
      <div>
        <label class="mb-1 block text-sm font-medium" for="server">{t("auth.server")}</label>
        <input id="server" class="input" type="url" required placeholder="https://hivemonitor.ejemplo.com" bind:value={server} />
      </div>
    {/if}
    <div>
      <label class="mb-1 block text-sm font-medium" for="name">{t("auth.name")}</label>
      <input id="name" class="input" autocomplete="name" required bind:value={name} />
    </div>
    <div>
      <label class="mb-1 block text-sm font-medium" for="email">{t("auth.email")}</label>
      <input id="email" class="input" type="email" autocomplete="username" required bind:value={email} />
    </div>
    <div>
      <label class="mb-1 block text-sm font-medium" for="password">{t("auth.password")}</label>
      <input id="password" class="input" type="password" autocomplete="new-password" minlength="10" required bind:value={password} />
      <p class="mt-1 text-xs text-fg-3">{t("auth.passwordRule")}</p>
    </div>
    {#if error}<p class="text-sm text-bad" role="alert">{error}</p>{/if}
    <button class="btn btn-primary w-full" disabled={busy}>{t("auth.register")}</button>
  </form>
  <p class="mt-5 text-center text-sm text-fg-3">
    {t("auth.haveAccount")} <a class="text-accent hover:underline" href="/login">{t("auth.login")}</a>
  </p>
</AuthCard>
