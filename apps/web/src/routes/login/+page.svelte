<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { onMount } from "svelte";
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

  // Política de registro y correo (en Tauri se carga al comprobar la URL del servidor)
  onMount(() => {
    if (!app.native || app.serverUrl) void app.loadPublicMeta();
  });

  // Vuelta del proveedor con error (p. ej. cuenta nueva sin invitación): Better Auth añade ?error=…
  const oauthError = $derived(page.url.searchParams.get("error"));
  const oauthMessage = $derived(!oauthError ? "" : app.meta?.signupMode !== "open" ? t("auth.socialDenied") : t("auth.socialError"));
  const providers = $derived(app.meta?.socialProviders ?? []);

  $effect(() => {
    if (app.me) void goto("/", { replaceState: true });
  });

  async function testServer() {
    serverState = "testing";
    serverState = (await app.testServer(server)) ? "ok" : "fail";
    if (serverState === "ok") void app.loadPublicMeta(server);
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
      const code = err instanceof ApiError ? (err.body as { code?: string } | null)?.code : undefined;
      error =
        code === "EMAIL_NOT_VERIFIED"
          ? t("auth.notVerified")
          : err instanceof ApiError && err.status === 429
            ? t("common.error")
            : t("auth.invalid");
    } finally {
      busy = false;
    }
  }

  /** Web: redirección OAuth completa. Tauri: se abre el navegador del sistema (el retorno por deep link llega en una fase posterior). */
  async function social(provider: "twitch" | "google") {
    error = "";
    try {
      const url = await app.client.auth.socialSignIn(provider, location.origin + "/", location.origin + "/login");
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
          <input
            id="server"
            class="input"
            type="url"
            required
            placeholder="https://hivemonitor.ejemplo.com"
            bind:value={server}
            oninput={() => (serverState = "idle")}
          />
          <button type="button" class="btn shrink-0" onclick={testServer} disabled={!server || serverState === "testing"}
            >{t("auth.serverTest")}</button
          >
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
      <p class="mt-1 text-right text-xs"><a class="text-accent hover:underline" href="/forgot-password">{t("auth.forgot")}</a></p>
    </div>
    {#if error || oauthMessage}<p class="text-sm text-bad" role="alert">{error || oauthMessage}</p>{/if}
    <button class="btn btn-primary w-full" disabled={busy}>{t("auth.login")}</button>
  </form>

  {#if !app.native && providers.length > 0}
    <div class="my-4 flex items-center gap-3 text-xs text-fg-3">
      <span class="h-px flex-1 bg-border"></span>o<span class="h-px flex-1 bg-border"></span>
    </div>
    <div class="grid gap-2">
      {#if providers.includes("twitch")}<button class="btn" onclick={() => social("twitch")}>{t("auth.withTwitch")}</button>{/if}
      {#if providers.includes("google")}<button class="btn" onclick={() => social("google")}>{t("auth.withGoogle")}</button>{/if}
    </div>
    {#if app.meta?.signupMode === "invite"}<p class="mt-2 text-center text-xs text-fg-3">{t("auth.socialNote")}</p>{/if}
  {/if}

  {#if !app.meta || app.meta.signupMode !== "closed" || app.meta.firstRun}
    <p class="mt-5 text-center text-sm text-fg-3">
      {t("auth.noAccount")} <a class="text-accent hover:underline" href="/register">{t("auth.register")}</a>
    </p>
    {#if app.meta?.firstRun}<p class="mt-2 text-center text-xs text-fg-3">{t("auth.firstRun")}</p>
    {:else if app.meta?.signupMode === "invite"}<p class="mt-2 text-center text-xs text-fg-3">{t("auth.signupInvite")}</p>{/if}
  {/if}
</AuthCard>
