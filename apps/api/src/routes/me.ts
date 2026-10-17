import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { PERMISSIONS, SYSTEM_ROLES, SYSTEM_ROLE_LABELS, resolvePermissions } from "@hivemonitor/core";
import { schema, withTenant } from "@hivemonitor/db";
import type { AppDeps, AppEnv } from "../context.ts";
import { requireUser } from "../middleware.ts";

export function meRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();

  r.get("/meta/roles", (c) =>
    c.json({
      permissions: PERMISSIONS,
      roles: Object.entries(SYSTEM_ROLES).map(([key, permissions]) => ({
        key,
        label: SYSTEM_ROLE_LABELS[key as keyof typeof SYSTEM_ROLE_LABELS],
        permissions,
      })),
    }),
  );

  /** Usuario, organizaciones y permisos efectivos por organización: el frontend decide por permiso, no por rol. */
  r.get("/me", requireUser(deps), async (c) => {
    const user = c.get("user");
    const rows = await deps.adminDb
      .select({
        organizationId: schema.member.organizationId,
        role: schema.member.role,
        name: schema.organization.name,
        slug: schema.organization.slug,
        logo: schema.organization.logo,
        suspended: schema.tenantSettings.suspended,
      })
      .from(schema.member)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
      .leftJoin(schema.tenantSettings, eq(schema.tenantSettings.tenantId, schema.member.organizationId))
      .where(eq(schema.member.userId, user.id));

    const organizations = await Promise.all(
      rows.map(async (o) => {
        const custom = await withTenant(deps.appDb, o.organizationId, (tx) =>
          tx
            .select({ key: schema.roleDefinition.key, permissions: schema.roleDefinition.permissions })
            .from(schema.roleDefinition),
        );
        return {
          id: o.organizationId,
          name: o.name,
          slug: o.slug,
          logo: o.logo,
          role: o.role,
          suspended: o.suspended ?? false,
          permissions: [...resolvePermissions(o.role, custom, user.isSuperadmin)],
        };
      }),
    );
    return c.json({ user, organizations });
  });

  return r;
}
