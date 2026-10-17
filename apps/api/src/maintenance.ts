import { sql } from "drizzle-orm";
import type { Database } from "@hivemonitor/db";
import type { Logger } from "./logger.ts";

const SIX_HOURS = 6 * 60 * 60 * 1000;

/** Crea las particiones de eventos futuras y elimina las que superan la retención. */
export async function runMaintenance(adminDb: Database, retentionDays: number, logger: Logger): Promise<void> {
  try {
    await adminDb.execute(sql`select ensure_event_partitions(1, 2)`);
    const res = await adminDb.execute(sql`select drop_old_event_partitions(${retentionDays}) as dropped`);
    const dropped = (res[0] as { dropped?: number } | undefined)?.dropped ?? 0;
    if (dropped > 0) logger.info({ dropped, retentionDays }, "particiones de eventos eliminadas por retención");
  } catch (err) {
    logger.error({ err }, "falló el mantenimiento de particiones");
  }
}

export function startMaintenance(adminDb: Database, retentionDays: number, logger: Logger): () => void {
  void runMaintenance(adminDb, retentionDays, logger);
  const t = setInterval(() => void runMaintenance(adminDb, retentionDays, logger), SIX_HOURS);
  t.unref?.();
  return () => clearInterval(t);
}
