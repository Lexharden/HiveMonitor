<script lang="ts">
  import { goto } from "$app/navigation";
  import { ApiError } from "@hivemonitor/client";
  import AuthCard from "#lib/components/AuthCard.svelte";
  import { t } from "#lib/i18n.ts";
  import { openExternal } from "#lib/platform.ts";
  import { app } from "#lib/stores/app.svelte.ts";

  let server = $state(app.serverUrl);
  let serverState = $state<"idle" | "ok" | "fail" | "testing">("idle");
  let email = $state("");
  let password = $state("");
  let error = $state("");
  let busy = $state(false);

  $effect(() => {
    if (app.me) void goto("/", { replaceState: true });
  });

  async function testServer() {
    serverState = "testing";
    serverState = (await app.testServer(server)) ? "ok" : "fail";
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = "";
    busy = true;
    try {
      if (app.native) {
        if (!(await app.testServer(server))) {
          serverState = "fail";
          return;
        }
        await app.setServerUrl(server);
      }
      await app.login(email, password);
    } catch (err) {
      error = err instanceof ApiError && err.status === 429 ? t("common.error") : t("auth.invalid");
    } finally {
      busy = false;
    }
  }

  /** Web: redirección OAuth completa. Tauri: se abre el navegador del sistema (el retorno por deep link llega en una fase posterior). */
  async function social(provider: "twitch" | "google") {
    error = "";
    try {
      const url = await app.client.auth.socialSignIn(provider, location.origin + "/");
      if (!url) error = t("common.error");
      else if (app.native) await openExternal(url);
      else location.href = url;
    } catch {
      error = t("common.error");
    }
  }
</script>

<AuthCard title={t("auth.login")}>
  <form class="space-y-4" onsubmit={submit}>
    {#if app.native}
      <div>
        <label class="mb-1 block text-sm font-medium" for="server">{t("auth.server")}</label>
        <div class="flex gap-2">
          <input id="server" class="input" type="url" required placeholder="https://hivemonitor.ejemplo.com" bind:value={server} oninput={() => (serverState = "idle")} />
          <button type="button" class="btn shrink-0" onclick={testServer} disabled={!server || serverState === "testing"}>{t("auth.serverTest")}</button>
        </div>
        <p class="mt-1 text-xs {serverState === 'ok' ? 'text-good' : serverState === 'fail' ? 'text-bad' : 'text-fg-3'}" role="status">
          {serverState === "ok" ? t("auth.serverOk") : serverState === "fail" ? t("auth.serverFail") : t("auth.serverHint")}
        </p>
      </div>
    {/if}
    <div>
      <label class="mb-1 block text-sm font-medium" for="email">{t("auth.email")}</label>
      <input id="email" class="input" type="email" autocomplete="username" required bind:value={email} />
    </div>
    <div>
      <label class="mb-1 block text-sm font-medium" for="password">{t("auth.password")}</label>
      <input id="password" class="input" type="password" autocomplete="current-password" required bind:value={password} />
    </div>
    {#if error}<p class="text-sm text-bad" role="alert">{error}</p>{/if}
    <button class="btn btn-primary w-full" disabled={busy}>{t("auth.login")}</button>
  </form>

  {#if !app.native}
    <div class="my-4 flex items-center gap-3 text-xs text-fg-3"><span class="h-px flex-1 bg-border"></span>o<span class="h-px flex-1 bg-border"></span></div>
    <div class="grid gap-2">
      <button class="btn" onclick={() => social("twitch")}>{t("auth.withTwitch")}</button>
      <button class="btn" onclick={() => social("google")}>{t("auth.withGoogle")}</button>
    </div>
  {/if}

  <p class="mt-5 text-center text-sm text-fg-3">
    {t("auth.noAccount")} <a class="text-accent hover:underline" href="/register">{t("auth.register")}</a>
  </p>
</AuthCard>
