/**
 * Permisos del sistema. Formato `recurso.acción`, que coincide con los
 * statements de control de acceso de Better Auth (recurso → acciones).
 */
export const PERMISSIONS = [
  "stream.view",
  "chat.view",
  "chat.moderate",
  "events.view",
  "analytics.view",
  "integrations.manage",
  "alerts.manage",
  "members.manage",
  "org.manage",
  "system.admin",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/** Convierte la lista plana en statements `{ recurso: [acciones] }`. */
export function permissionStatements(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of PERMISSIONS) {
    const [resource, action] = p.split(".") as [string, string];
    (out[resource] ??= []).push(action);
  }
  return out;
}
