import { sql } from "drizzle-orm";
import { createDb, type DbHandle } from "@hivemonitor/db";
import { startTestPostgres, type TestPostgres } from "@hivemonitor/db/testing";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { InProcessBus } from "../src/bus/in-process.ts";
import { loadConfig } from "../src/config.ts";
import type { AppDeps } from "../src/context.ts";
import { createIngest } from "../src/ingest/manager.ts";
import { createTwitchService } from "../src/twitch/service.ts";
import { AlertEngine } from "../src/alerts/engine.ts";
import { createEncryptorFromEnv } from "../src/crypto.ts";
import { createLogger } from "../src/logger.ts";

export const BASE_URL = "http://localhost:3000";

export interface TestEnv {
  pg: TestPostgres;
  admin: DbHandle;
  app: DbHandle;
  deps: AppDeps;
  http: ReturnType<typeof createApp>;
  invitations: { email: string; role: string; link: string }[];
  stop(): Promise<void>;
  /** Registra un usuario y devuelve su token bearer. */
  signUp(email: string, name?: string): Promise<string>;
  /** Petición autenticada con bearer. */
  call(token: string | null, method: string, path: string, body?: unknown): Promise<Response>;
}

export async function createTestEnv(
  extra: Record<string, string> = {},
  twitchFetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  alertsFetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): Promise<TestEnv> {
  const pg = await startTestPostgres();
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: pg.adminUrl,
    DATABASE_APP_URL: pg.appUrl,
    BASE_URL,
    BETTER_AUTH_SECRET: "x".repeat(40),
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    CORS_ORIGINS: "http://tauri.localhost",
    RATE_LIMIT_PER_MINUTE: "10000",
    ...extra,
  });
  const logger = createLogger(config);
  const admin = createDb(pg.adminUrl, { max: 4 });
  const app = createDb(pg.appUrl, { max: 4 });
  const invitations: TestEnv["invitations"] = [];
  const auth = createAuth({
    config,
    adminDb: admin.db,
    logger,
    onInvitation: async (i) => void invitations.push({ email: i.email, role: i.role, link: i.link }),
  });
  const bus = new InProcessBus();
  const encryptor = createEncryptorFromEnv(config.ENCRYPTION_KEY);
  const twitch = createTwitchService({ config, logger, adminDb: admin.db, encryptor, fetch: twitchFetch });
  const ingest = createIngest({
    config,
    logger,
    bus,
    adminDb: admin.db,
    appDb: app.db,
    encryptor,
    factories: twitch ? { twitch: twitch.factory } : undefined,
  });
  const alerts = new AlertEngine({ appDb: app.db, bus, encryptor, logger, fetch: alertsFetch });
  alerts.attach(ingest.pipeline, ingest.supervisor);
  const deps: AppDeps = {
    config,
    logger,
    adminDb: admin.db,
    appDb: app.db,
    ping: async () => void (await admin.db.execute(sql`select 1`)),
    auth,
    bus,
    ingest,
    alerts,
    twitch,
    encryptor,
  };
  const http = createApp(deps);

  const call: TestEnv["call"] = (token, method, path, body) =>
    Promise.resolve(
      http.request(path, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          origin: BASE_URL,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    );

  return {
    pg,
    admin,
    app,
    deps,
    http,
    invitations,
    call,
    async signUp(email, name = email.split("@")[0]!) {
      const res = await call(null, "POST", "/api/auth/sign-up/email", { email, name, password: "correct-horse-battery" });
      if (!res.ok) throw new Error(`sign-up falló: ${res.status} ${await res.text()}`);
      const token = res.headers.get("set-auth-token");
      if (!token) throw new Error("sin set-auth-token");
      return token;
    },
    async stop() {
      deps.alerts.close();
      deps.twitch?.stop();
      await deps.ingest.close();
      await deps.bus.close();
      await app.close();
      await admin.close();
      await pg.stop();
    },
  };
}
