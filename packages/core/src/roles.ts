import { PERMISSIONS, type Permission, isPermission } from "./permissions.ts";

export const SYSTEM_ROLE_KEYS = ["owner", "admin", "moderator", "analyst"] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

/** `system.admin` es global (flag de superadmin del usuario), nunca de un rol de organización. */
const TENANT_PERMISSIONS = PERMISSIONS.filter((p) => p !== "system.admin");

export const SYSTEM_ROLES: Record<SystemRoleKey, readonly Permission[]> = {
  owner: TENANT_PERMISSIONS,
  admin: TENANT_PERMISSIONS.filter((p) => p !== "org.manage"),
  moderator: ["stream.view", "chat.view", "chat.moderate", "events.view"],
  analyst: ["stream.view", "events.view", "analytics.view"],
};

export const SYSTEM_ROLE_LABELS: Record<SystemRoleKey, string> = {
  owner: "Owner",
  admin: "Admin",
  moderator: "Moderador",
  analyst: "Analista",
};

export function isSystemRole(key: string): key is SystemRoleKey {
  return (SYSTEM_ROLE_KEYS as readonly string[]).includes(key);
}

/** Rol personalizado de un tenant (tabla `role_definition`). */
export interface CustomRole {
  key: string;
  permissions: readonly string[];
}

/**
 * Permisos efectivos de un miembro. Los roles personalizados del tenant tienen
 * prioridad sobre los del sistema; los permisos desconocidos y `system.admin`
 * se descartan siempre salvo para el superadmin.
 */
export function resolvePermissions(
  roleKeys: string | readonly string[],
  customRoles: readonly CustomRole[] = [],
  isSuperadmin = false,
): Set<Permission> {
  const result = new Set<Permission>();
  if (isSuperadmin) {
    for (const p of PERMISSIONS) result.add(p);
    return result;
  }
  const keys = typeof roleKeys === "string" ? roleKeys.split(",") : roleKeys;
  for (const raw of keys) {
    const key = raw.trim();
    const custom = customRoles.find((r) => r.key === key);
    const perms: readonly string[] = custom ? custom.permissions : isSystemRole(key) ? SYSTEM_ROLES[key] : [];
    for (const p of perms) if (isPermission(p) && p !== "system.admin") result.add(p);
  }
  return result;
}

export function hasPermission(perms: ReadonlySet<Permission>, needed: Permission): boolean {
  return perms.has(needed);
}
