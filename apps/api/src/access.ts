import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";
import { PERMISSIONS, SYSTEM_ROLES, permissionStatements, type Permission, type SystemRoleKey } from "@hivemonitor/core";

/**
 * Control de acceso de Better Auth derivado de los permisos propios.
 * Los statements por defecto del plugin (organization/member/invitation/...) se
 * conservan y se asignan según nuestros permisos:
 *   - org.manage     → organization:update/delete
 *   - members.manage → member:*, invitation:*
 */
const statements = { ...defaultStatements, ...permissionStatements() } as unknown as Record<string, string[]>;
// El tipado estricto de Better Auth no admite statements calculados; se relaja aquí.
export const ac: any = createAccessControl(statements as never);

function statementsFor(perms: readonly Permission[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of perms) {
    const [res, act] = p.split(".") as [string, string];
    (out[res] ??= []).push(act);
  }
  if (perms.includes("org.manage")) out.organization = ["update", "delete"];
  if (perms.includes("members.manage")) {
    out.member = ["create", "update", "delete"];
    out.invitation = ["create", "cancel"];
  }
  return out;
}

export const orgRoles: Record<SystemRoleKey, any> = Object.fromEntries(
  (Object.keys(SYSTEM_ROLES) as SystemRoleKey[]).map((key) => [key, ac.newRole(statementsFor(SYSTEM_ROLES[key]))]),
) as Record<SystemRoleKey, any>;

export { PERMISSIONS };
