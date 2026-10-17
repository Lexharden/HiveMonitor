import { createClient, type Client, type Me, type OrgMembership, type Permission, type TokenStore } from "@hivemonitor/client";
import { applyTheme, isTauri, kv, type Theme } from "#lib/platform.ts";

const KEYS = { server: "server_url", token: "auth_token", org: "active_org", theme: "theme" } as const;

/** Estado global: servidor, sesión, organización activa y tema. */
class AppState {
  ready = $state(false);
  serverUrl = $state("");
  me = $state<Me | null>(null);
  activeOrgId = $state<string | null>(null);
  theme = $state<Theme>("dark");

  readonly native = isTauri();
  private token: string | null = null;

  private readonly tokenStore: TokenStore | undefined = this.native
    ? {
        get: () => this.token,
        set: (t) => {
          this.token = t;
          return kv.set(KEYS.token, t);
        },
      }
    : undefined;

  /** En web el servidor es el propio origen; en Tauri es la URL configurada. */
  readonly client: Client = createClient({
    baseUrl: () => (this.native ? this.serverUrl : ""),
    tokenStore: this.tokenStore,
    onUnauthorized: () => {
      this.me = null;
    },
  });

  orgs = $derived(this.me?.organizations ?? []);
  org = $derived<OrgMembership | null>(this.orgs.find((o) => o.id === this.activeOrgId) ?? this.orgs[0] ?? null);
  isSuperadmin = $derived(this.me?.user.isSuperadmin ?? false);

  can(p: Permission): boolean {
    return this.org?.permissions.includes(p) ?? false;
  }

  async init() {
    const [theme, server, token, org] = await Promise.all([kv.get(KEYS.theme), kv.get(KEYS.server), kv.get(KEYS.token), kv.get(KEYS.org)]);
    this.theme = theme === "light" ? "light" : "dark";
    applyTheme(this.theme);
    this.serverUrl = server ?? "";
    this.token = token;
    this.activeOrgId = org;
    if (!this.native || this.serverUrl) await this.refreshMe();
    this.ready = true;
  }

  async refreshMe(): Promise<Me | null> {
    try {
      this.me = await this.client.me();
    } catch {
      this.me = null;
    }
    return this.me;
  }

  async setServerUrl(url: string) {
    this.serverUrl = url.trim().replace(/\/+$/, "");
    await kv.set(KEYS.server, this.serverUrl);
  }

  /** Comprueba que hay un servidor HiveMonitor en esa URL. */
  async testServer(url: string): Promise<boolean> {
    try {
      const res = await fetch(`${url.trim().replace(/\/+$/, "")}/healthz`);
      return res.ok && (await res.json()).status === "ok";
    } catch {
      return false;
    }
  }

  async login(email: string, password: string) {
    await this.client.auth.signInEmail(email, password);
    await this.refreshMe();
  }

  async register(name: string, email: string, password: string) {
    await this.client.auth.signUpEmail(name, email, password);
    await this.refreshMe();
  }

  async logout() {
    try {
      await this.client.auth.signOut();
    } finally {
      this.me = null;
    }
  }

  async setOrg(id: string) {
    this.activeOrgId = id;
    await kv.set(KEYS.org, id);
    try {
      await this.client.orgs.setActive(id);
    } catch {
      /* solo informativo */
    }
  }

  async toggleTheme() {
    this.theme = this.theme === "dark" ? "light" : "dark";
    applyTheme(this.theme);
    await kv.set(KEYS.theme, this.theme);
  }
}

export const app = new AppState();
