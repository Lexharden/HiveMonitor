import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import postgres from "postgres";

export const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

export interface MigrateOptions {
  dir?: string;
  /** Migraciones ya cargadas en memoria (binario compilado); si se dan, no se lee el disco. */
  files?: { name: string; sql: string }[];
  /** Contraseña a asignar al rol hive_app tras migrar (si se da). */
  appRolePassword?: string;
  log?: (msg: string) => void;
}

/**
 * Aplica las migraciones SQL pendientes en orden, cada una en su transacción,
 * bajo un advisory lock para que varias instancias no choquen.
 * Verifica el checksum de las ya aplicadas.
 */
export async function migrate(url: string, opts: MigrateOptions = {}): Promise<string[]> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const log = opts.log ?? (() => {});
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const applied: string[] = [];
  try {
    await sql`select pg_advisory_lock(727274)`;
    await sql`create table if not exists _migrations (
      name text primary key, checksum text not null, applied_at timestamptz not null default now())`;
    const done = new Map(
      (await sql<{ name: string; checksum: string }[]>`select name, checksum from _migrations`).map((r) => [r.name, r.checksum]),
    );
    const list: { name: string; sql: string }[] = opts.files
      ? [...opts.files].sort((a, b) => a.name.localeCompare(b.name))
      : await Promise.all(
          (await readdir(dir))
            .filter((f) => /^\d{4}_.+\.sql$/.test(f))
            .sort()
            .map(async (f) => ({ name: f, sql: await readFile(join(dir, f), "utf8") })),
        );
    for (const { name: file, sql: text } of list) {
      const checksum = createHash("sha256").update(text).digest("hex");
      const prev = done.get(file);
      if (prev) {
        if (prev !== checksum) throw new Error(`La migración ${file} fue modificada tras aplicarse`);
        continue;
      }
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
        await tx`insert into _migrations (name, checksum) values (${file}, ${checksum})`;
      });
      log(`migración aplicada: ${file}`);
      applied.push(file);
    }
    if (opts.appRolePassword) {
      await sql.unsafe(`alter role hive_app password '${opts.appRolePassword.replaceAll("'", "''")}'`);
    }
  } finally {
    await sql`select pg_advisory_unlock(727274)`.catch(() => {});
    await sql.end({ timeout: 5 });
  }
  return applied;
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL es obligatoria");
  const applied = await migrate(url, { log: console.log, appRolePassword: process.env.DATABASE_APP_PASSWORD });
  console.log(applied.length ? `${applied.length} migraciones aplicadas` : "sin migraciones pendientes");
}
