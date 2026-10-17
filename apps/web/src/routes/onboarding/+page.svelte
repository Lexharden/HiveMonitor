<script lang="ts">
  import { goto } from "$app/navigation";
  import { ApiError } from "@hivemonitor/client";
  import AuthCard from "#lib/components/AuthCard.svelte";
  import { t } from "#lib/i18n.ts";
  import { app } from "#lib/stores/app.svelte.ts";

  let name = $state("");
  let slug = $state("");
  let touched = $state(false);
  let error = $state("");
  let busy = $state(false);

  $effect(() => {
    if (!app.me) void goto("/login", { replaceState: true });
    else if (app.orgs.length) void goto("/", { replaceState: true });
  });

  const slugify = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);

  $effect(() => {
    if (!touched) slug = slugify(name);
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = "";
    busy = true;
    try {
      const { id } = await app.client.orgs.create(name.trim(), slug);
      await app.refreshMe();
      await app.setOrg(id);
      await goto("/");
    } catch (err) {
      error = err instanceof ApiError ? String((err.body as { message?: string } | null)?.message ?? err.code) : t("common.error");
    } finally {
      busy = false;
    }
  }
</script>

<AuthCard title={t("org.onboardingTitle")}>
  <p class="mb-4 text-sm text-fg-2">{t("org.onboardingText")}</p>
  <form class="space-y-4" onsubmit={submit}>
    <div>
      <label class="mb-1 block text-sm font-medium" for="org">{t("org.name")}</label>
      <input id="org" class="input" required maxlength="60" bind:value={name} />
    </div>
    <div>
      <label class="mb-1 block text-sm font-medium" for="slug">{t("org.slug")}</label>
      <input id="slug" class="input" required pattern="[a-z0-9]+(-[a-z0-9]+)*" bind:value={slug} oninput={() => (touched = true)} />
    </div>
    {#if error}<p class="text-sm text-bad" role="alert">{error}</p>{/if}
    <button class="btn btn-primary w-full" disabled={busy || !name || !slug}>{t("org.create")}</button>
    <button type="button" class="btn w-full" onclick={() => app.logout().then(() => goto("/login"))}>{t("common.signOut")}</button>
  </form>
</AuthCard>
