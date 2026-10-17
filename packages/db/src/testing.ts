import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import postgres from "postgres";
import { migrate } from "./migrate.ts";

export interface TestPostgres {
  /** Conexión propietaria (migraciones/administración). */
  adminUrl: string;
  /** Conexión con el rol hive_app (sujeto a RLS). */
  appUrl: string;
  stop(): Promise<void>;
}

const APP_PASSWORD = "hive_app_test";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/**
 * Levanta una base de datos de pruebas migrada. Usa `TEST_DATABASE_URL`
 * (usuario con permisos para crear bases y roles) si existe; si no, arranca un
 * PostgreSQL embebido temporal.
 */
export async function startTestPostgres(): Promise<TestPostgres> {
  const external = process.env.TEST_DATABASE_URL;
  let adminUrl: string;
  let appUrl: string;
  let stopServer = async () => {};

  if (external) {
    const base = new URL(external);
    const dbName = `hive_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const root = postgres(external, { max: 1 });
    await root.unsafe(`create database ${dbName}`);
    await root.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    const app = new URL(adminUrl);
    app.username = "hive_app";
    app.password = APP_PASSWORD;
    appUrl = app.toString();
    stopServer = async () => {
      const r = postgres(external, { max: 1 });
      await r.unsafe(`drop database if exists ${dbName} with (force)`);
      await r.end();
    };
  } else {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    const dir = await mkdtemp(join(tmpdir(), "hive-pg-"));
    const port = await freePort();
    const pg = new EmbeddedPostgres({
      databaseDir: join(dir, "data"),
      user: "postgres",
      password: "postgres",
      port,
      persistent: false,
      onLog: () => {},
      onError: () => {},
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("hive");
    adminUrl = `postgres://postgres:postgres@127.0.0.1:${port}/hive`;
    appUrl = `postgres://hive_app:${APP_PASSWORD}@127.0.0.1:${port}/hive`;
    stopServer = async () => {
      await pg.stop().catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    };
  }

  await migrate(adminUrl, { appRolePassword: APP_PASSWORD });
  return { adminUrl, appUrl, stop: stopServer };
}
