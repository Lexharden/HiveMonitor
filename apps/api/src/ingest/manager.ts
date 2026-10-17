import { and, eq, sql } from "drizzle-orm";
import { createBridgeClientFactory, createTikTokAdapterFactory, mockAdapterFactory, youtubeAdapterFactory } from "@hivemonitor/adapters";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdapterFactory, Platform } from "@hivemonitor/core";
import { schema, withTenant, type Database } from "@hivemonitor/db";
import type { Config } from "../config.ts";
import type { Encryptor } from "../crypto.ts";
import type { Logger } from "../logger.ts";
import type { EventBus } from "@hivemonitor/core";
import { MarkerDetector } from "./markers.ts";
import { IngestPipeline } from "./pipeline.ts";
import { Supervisor, type ConnectionSpec } from "./supervisor.ts";

export type ConnectionRow = typeof schema.platformConnection.$inferSelect;

export interface IngestDeps {
  config: Config;
  logger: Logger;
  bus: EventBus;
  adminDb: Database;
  appDb: Database;
  encryptor: Encryptor;
  /** Factorías reales por plataforma (TikTok y Twitch se registran en sus fases). */
  factories?: Partial<Record<Platform, AdapterFactory>>;
}

export interface Ingest {
  pipeline: IngestPipeline;
  supervisor: Supervisor;
  markers: MarkerDetector;
  allowMock: boolean;
  specFromRow(row: ConnectionRow): ConnectionSpec;
  startConnection(row: ConnectionRow): Promise<boolean>;
  stopConnection(id: string): Promise<void>;
  /** Arranca todas las conexiones habilitadas de tenants no suspendidos (con escalonado). */
  startAll(): Promise<number>;
  stopTenant(tenantId: string): Promise<void>;
  startTenant(tenantId: string): Promise<void>;
  close(): Promise<void>;
}

/** Ejecutable del puente: la ruta configurada, o el que está junto al binario de HiveMonitor, o el del PATH. */
export function resolveBridgePath(configured?: string): string {
  if (configured) return configured;
  const exe = process.platform === "win32" ? "tiktok-bridge.exe" : "tiktok-bridge";
  const sibling = join(dirname(process.execPath), exe);
  return existsSync(sibling) ? sibling : exe;
}

export function createIngest(deps: IngestDeps): Ingest {
  const { config, logger, adminDb, appDb, encryptor } = deps;
  const allowMock = config.ALLOW_MOCK_ADAPTERS ?? config.NODE_ENV !== "production";
  const pipeline = new IngestPipeline({ appDb, bus: deps.bus, logger });
  const markers = new MarkerDetector({ appDb, bus: deps.bus, logger, bigDonationUsd: config.MARKER_BIG_DONATION_USD });
  pipeline.addTap(markers.tap);

  const real: Partial<Record<Platform, AdapterFactory>> = {
    youtube: youtubeAdapterFactory,
    tiktok: createTikTokAdapterFactory({
      signApiKey: config.TIKTOK_SIGN_API_KEY,
      usdCentsPerCoin: config.TIKTOK_USD_CENTS_PER_COIN,
      clientFactory:
        config.TIKTOK_PROVIDER === "bridge"
          ? createBridgeClientFactory({ bridgePath: resolveBridgePath(config.TIKTOK_BRIDGE_PATH), proxy: config.TIKTOK_PROXY })
          : undefined,
    }),
    ...deps.factories,
  };

  const supervisor = new Supervisor({
    logger,
    bus: deps.bus,
    pipeline,
    connectConcurrency: { tiktok: config.TIKTOK_MAX_CONCURRENCY },
    backoff: { baseMs: config.RECONNECT_BASE_MS, maxMs: config.RECONNECT_MAX_MS },
    offlineRetryMs: config.OFFLINE_RETRY_MS,
    resolveFactory: (spec) => {
      if (spec.config?.mode === "mock") return allowMock ? mockAdapterFactory : undefined;
      return real[spec.platform];
    },
    onStatusChange: async (spec, status, detail) => {
      await withTenant(appDb, spec.tenantId, (tx) =>
        tx
          .update(schema.platformConnection)
          .set({ status, lastError: status === "error" || status === "rate_limited" ? (detail ?? null) : null, updatedAt: new Date() })
          .where(eq(schema.platformConnection.id, spec.id)),
      );
    },
  });

  function specFromRow(row: ConnectionRow): ConnectionSpec {
    let credentials: Record<string, unknown> | undefined;
    if (row.credentialsEnc) {
      credentials = JSON.parse(encryptor.decrypt(row.credentialsEnc)) as Record<string, unknown>;
    }
    return {
      id: row.id,
      tenantId: row.tenantId,
      platform: row.platform as Platform,
      channelId: row.channelId,
      credentials,
      config: row.config,
    };
  }

  async function startConnection(row: ConnectionRow) {
    return supervisor.start(specFromRow(row));
  }

  async function startTenant(tenantId: string) {
    const rows = await withTenant(appDb, tenantId, (tx) =>
      tx.select().from(schema.platformConnection).where(eq(schema.platformConnection.enabled, true)),
    );
    for (const r of rows) {
      try {
        await startConnection(r);
      } catch (err) {
        logger.error({ err, id: r.id }, "no se pudo iniciar la conexión");
      }
    }
  }

  return {
    pipeline,
    markers,
    supervisor,
    allowMock,
    specFromRow,
    startConnection,
    stopConnection: (id) => supervisor.stop(id),
    startTenant,
    async stopTenant(tenantId) {
      for (const c of supervisor.list(tenantId)) await supervisor.stop(c.id);
    },
    async startAll() {
      // Lectura entre tenants: solo la conexión de administración puede hacerla.
      const rows = await adminDb
        .select({ conn: schema.platformConnection })
        .from(schema.platformConnection)
        .leftJoin(schema.tenantSettings, eq(schema.tenantSettings.tenantId, schema.platformConnection.tenantId))
        .where(and(eq(schema.platformConnection.enabled, true), sql`coalesce(${schema.tenantSettings.suspended}, false) = false`));
      let n = 0;
      for (const { conn } of rows) {
        try {
          if (await startConnection(conn)) n++;
        } catch (err) {
          logger.error({ err, id: conn.id }, "no se pudo iniciar la conexión");
        }
        await new Promise((r) => setTimeout(r, 100)); // evita el efecto estampida al arrancar
      }
      return n;
    },
    async close() {
      await supervisor.shutdown();
      await pipeline.close();
    },
  };
}
