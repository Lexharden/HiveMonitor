import { AsyncLocalStorage } from "node:async_hooks";
import { schema, withTenant, type Database } from "@hivemonitor/db";

export interface AuditEntry {
  tenantId: string;
  actorUserId: string | null;
  action: string;
  target?: string;
  meta?: Record<string, unknown>;
  ip?: string;
}

/** Registra una acción sensible en `audit_log` (con contexto de tenant, bajo RLS). */
export async function audit(appDb: Database, e: AuditEntry): Promise<void> {
  await withTenant(appDb, e.tenantId, (tx) =>
    tx.insert(schema.auditLog).values({
      id: crypto.randomUUID(),
      tenantId: e.tenantId,
      actorUserId: e.actorUserId,
      action: e.action,
      target: e.target,
      meta: e.meta ?? {},
      ip: e.ip,
    }),
  );
}

/**
 * Actor de la petición en curso. Better Auth no informa de quién ejecuta una acción en sus ganchos,
 * así que las rutas `/api/auth/organization/*` lo fijan aquí y los ganchos de auditoría lo leen.
 */
export const actorStore = new AsyncLocalStorage<{ userId: string | null; ip?: string }>();

/** Auditoría con la conexión propietaria (ganchos de Better Auth: no hay contexto de tenant). */
export async function auditAdmin(adminDb: Database, e: AuditEntry): Promise<void> {
  const actor = actorStore.getStore();
  await adminDb.insert(schema.auditLog).values({
    id: crypto.randomUUID(),
    tenantId: e.tenantId,
    actorUserId: e.actorUserId ?? actor?.userId ?? null,
    action: e.action,
    target: e.target,
    meta: e.meta ?? {},
    ip: e.ip ?? actor?.ip,
  });
}
