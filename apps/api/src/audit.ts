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
