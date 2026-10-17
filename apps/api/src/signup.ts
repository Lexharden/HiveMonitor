import { and, count, eq, gt, sql } from "drizzle-orm";
import { schema, type Database } from "@hivemonitor/db";
import type { Config } from "./config.ts";

export type SignupMode = Config["SIGNUP_MODE"];

export async function userCount(db: Database): Promise<number> {
  const [r] = await db.select({ n: count() }).from(schema.user);
  return r?.n ?? 0;
}

/**
 * Política de registro:
 * - `open`: cualquiera puede registrarse.
 * - `invite`: solo con una invitación pendiente y vigente a ese correo.
 * - `closed`: nadie.
 * En todos los modos el PRIMER usuario siempre puede registrarse (arranque de una instalación nueva).
 */
export async function checkSignup(db: Database, mode: SignupMode, email: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (mode === "open") return { ok: true };
  if ((await userCount(db)) === 0) return { ok: true };
  if (mode === "closed") return { ok: false, reason: "El registro está cerrado en este servidor." };

  const [inv] = await db
    .select({ id: schema.invitation.id })
    .from(schema.invitation)
    .where(
      and(
        sql`lower(${schema.invitation.email}) = lower(${email})`,
        eq(schema.invitation.status, "pending"),
        gt(schema.invitation.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return inv
    ? { ok: true }
    : { ok: false, reason: "El registro es solo por invitación. Pide a un administrador que te invite con este correo." };
}
