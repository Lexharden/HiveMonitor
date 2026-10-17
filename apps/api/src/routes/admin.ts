import { count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { schema } from "@hivemonitor/db";
import type { AppDeps, AppEnv } from "../context.ts";
import { requireSuperadmin, requireUser } from "../middleware.ts";

const patchSchema = z.object({
  suspended: z.boolean().optional(),
  limits: z.record(z.string(), z.unknown()).optional(),
});

/** Vista superadmin (global): tenants, suspensión y límites. */
export function adminRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  r.use("*", requireUser(deps), requireSuperadmin());

  r.get("/tenants", async (c) => {
    const rows = await deps.adminDb
      .select({
        id: schema.organization.id,
        name: schema.organization.name,
        slug: schema.organization.slug,
        createdAt: schema.organization.createdAt,
        suspended: schema.tenantSettings.suspended,
        limits: schema.tenantSettings.limits,
        members: count(schema.member.id),
      })
      .from(schema.organization)
      .leftJoin(schema.tenantSettings, eq(schema.tenantSettings.tenantId, schema.organization.id))
      .leftJoin(schema.member, eq(schema.member.organizationId, schema.organization.id))
      .groupBy(schema.organization.id, schema.tenantSettings.tenantId);
    return c.json({ tenants: rows });
  });

  r.patch("/tenants/:id", async (c) => {
    const id = c.req.param("id");
    const body = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_body", issues: body.error.issues }, 400);
    const [org] = await deps.adminDb
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.id, id));
    if (!org) return c.json({ error: "not_found" }, 404);

    await deps.adminDb
      .insert(schema.tenantSettings)
      .values({ tenantId: id, ...body.data })
      .onConflictDoUpdate({ target: schema.tenantSettings.tenantId, set: body.data });
    await deps.adminDb.insert(schema.auditLog).values({
      id: crypto.randomUUID(),
      tenantId: id,
      actorUserId: c.get("user").id,
      action: "tenant.admin_update",
      target: id,
      meta: body.data,
      ip: c.get("ip"),
    });
    return c.json({ ok: true });
  });

  return r;
}
