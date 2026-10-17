import { sql as dsql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type Database = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface DbHandle {
  db: Database;
  sql: postgres.Sql;
  close(): Promise<void>;
}

export function createDb(url: string, opts: { max?: number } = {}): DbHandle {
  const client = postgres(url, {
    max: opts.max ?? 10,
    onnotice: () => {},
    // Todo el sistema trabaja en UTC (buckets de estadísticas, particiones): nunca depender de la TZ del servidor
    connection: { TimeZone: "UTC" },
  });
  return { db: drizzle(client, { schema }), sql: client, close: () => client.end({ timeout: 5 }) };
}

/**
 * Ejecuta `fn` en una transacción con el contexto de tenant fijado
 * (`SET LOCAL app.tenant_id`). Es la ÚNICA vía para tocar tablas de dominio
 * con el rol `hive_app`; RLS actúa como segunda línea de defensa.
 */
export async function withTenant<T>(db: Database, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!tenantId) throw new Error("withTenant requiere un tenantId");
  return db.transaction(async (tx) => {
    await tx.execute(sqlSetTenant(tenantId));
    return fn(tx);
  });
}

function sqlSetTenant(tenantId: string) {
  return dsql`select set_config('app.tenant_id', ${tenantId}, true)`;
}
