import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@hivemonitor/db";
import type { Auth } from "./auth.ts";

/**
 * Pone una contraseña nueva a un usuario (recuperación sin correo): genera una aleatoria, la guarda con el mismo
 * hash que usa Better Auth y cierra todas sus sesiones. Devuelve la contraseña en claro UNA sola vez.
 * Devuelve null si el usuario no existe o solo entra con login social (no tiene contraseña).
 */
export async function resetUserPassword(auth: Auth, db: Database, email: string): Promise<string | null> {
  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(sql`lower(${schema.user.email}) = lower(${email})`)
    .limit(1);
  if (!u) return null;

  const password = randomBytes(15).toString("base64url"); // 20 caracteres
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(password);
  const rows = await db
    .update(schema.account)
    .set({ password: hash, updatedAt: new Date() })
    .where(and(eq(schema.account.userId, u.id), eq(schema.account.providerId, "credential")))
    .returning({ id: schema.account.id });
  if (rows.length === 0) return null;
  await db.delete(schema.session).where(eq(schema.session.userId, u.id));
  return password;
}
