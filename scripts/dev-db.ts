/**
 * PostgreSQL local persistente para desarrollo SIN Docker (usa binarios embebidos).
 * Uso: bun scripts/dev-db.ts   → deja el servidor corriendo; Ctrl+C para detener.
 * Datos en .dev-data/ (ignorado por git). Puerto 54329.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { migrate } from "@hivemonitor/db";

const dir = join(import.meta.dir, "..", ".dev-data", "pg");
const port = Number(process.env.DEV_DB_PORT ?? 54329);
const fresh = !existsSync(join(dir, "PG_VERSION"));

const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: "hive",
  password: "hive",
  port,
  persistent: true,
  onLog: () => {},
  onError: () => {},
});
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase("hivemonitor");

const adminUrl = `postgres://hive:hive@127.0.0.1:${port}/hivemonitor`;
await migrate(adminUrl, { appRolePassword: "hive_app_dev", log: console.log });

console.log(`
PostgreSQL de desarrollo listo en el puerto ${port}. Variables para apps/api/.env:

DATABASE_URL=${adminUrl}
DATABASE_APP_URL=postgres://hive_app:hive_app_dev@127.0.0.1:${port}/hivemonitor
DATABASE_APP_PASSWORD=hive_app_dev
`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
