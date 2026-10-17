import { fileURLToPath } from "node:url";
import { createDb, migrate } from "@hivemonitor/db";
import { websocket } from "hono/bun";
import { sql } from "drizzle-orm";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { InProcessBus } from "./bus/in-process.ts";
import { createIngest } from "./ingest/manager.ts";
import { IngestPipeline } from "./ingest/pipeline.ts";
import { buildCsp } from "./middleware.ts";
import embedded from "./embedded.generated.ts";
import { createStaticHandler, dirSource, mapSource } from "./static.ts";
import { loadConfig } from "./config.ts";
import { createEncryptorFromEnv } from "./crypto.ts";
import { createTwitchService } from "./twitch/service.ts";
import { AlertEngine } from "./alerts/engine.ts";
import { createLogger } from "./logger.ts";
import { startMaintenance } from "./maintenance.ts";

const config = loadConfig();
const logger = createLogger(config);

if (config.AUTO_MIGRATE) {
  const applied = await migrate(config.DATABASE_URL, {
    appRolePassword: config.DATABASE_APP_PASSWORD,
    files: embedded.migrations ?? undefined,
    log: (m) => logger.info(m),
  });
  logger.info({ applied: applied.length }, "migraciones al día");
}

const admin = createDb(config.DATABASE_URL, { max: 5 });
if (!config.DATABASE_APP_URL) {
  logger.warn("DATABASE_APP_URL no definida: se usa DATABASE_URL y RLS NO protege (solo para desarrollo)");
}
const app = config.DATABASE_APP_URL ? createDb(config.DATABASE_APP_URL, { max: 10 }) : admin;

const bus = new InProcessBus((err) => logger.error({ err }, "handler del bus falló"));
const encryptor = createEncryptorFromEnv(config.ENCRYPTION_KEY);
const twitch = createTwitchService({ config, logger, adminDb: admin.db, encryptor });
const ingest = createIngest({
  config,
  logger,
  bus,
  adminDb: admin.db,
  appDb: app.db,
  encryptor,
  factories: twitch ? { twitch: twitch.factory } : undefined,
});
const alerts = new AlertEngine({ appDb: app.db, bus, encryptor, logger });
alerts.attach(ingest.pipeline, ingest.supervisor);
const auth = createAuth({ config, adminDb: admin.db, logger });
const webDist = process.env.WEB_DIST ?? fileURLToPath(new URL("../../web/build", import.meta.url));
const staticHandler = createStaticHandler(embedded.web ? mapSource(embedded.web) : dirSource(webDist), (hashes) =>
  buildCsp({ config }, hashes),
);
const deps = {
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
  staticHandler,
};

const orphans = await IngestPipeline.closeOrphans(admin.db);
if (orphans) logger.info({ orphans }, "sesiones huérfanas cerradas");

const stopMaintenance = startMaintenance(admin.db, config.EVENT_RETENTION_DAYS, logger);
const server = Bun.serve({
  hostname: config.HOST,
  port: config.PORT,
  idleTimeout: 120,
  fetch: createApp(deps).fetch,
  websocket,
});
logger.info({ url: `http://${config.HOST}:${server.port}` }, "HiveMonitor API escuchando");
void ingest.startAll().then((n) => logger.info({ connections: n }, "conexiones de plataformas iniciadas"));

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "apagado ordenado");
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref?.();
  try {
    stopMaintenance();
    twitch?.stop();
    alerts.close();
    await server.stop(); // deja terminar las peticiones en curso
    await ingest.close(); // desconecta adaptadores y persiste lo pendiente
    await bus.close();
    await admin.close();
    if (app !== admin) await app.close();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
