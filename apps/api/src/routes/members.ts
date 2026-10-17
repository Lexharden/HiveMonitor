import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { schema } from "@hivemonitor/db";
import { audit } from "../audit.ts";
import type { AppDeps, AppEnv } from "../context.ts";
import { requireTenant } from "../middleware.ts";

/**
 * Listado de miembros e invitaciones pendientes, y transferencia de propiedad.
 * Invitar, cambiar rol y expulsar usan los endpoints de Better Auth (`/api/auth/organization/*`), que aplican el
 * control de acceso derivado de los permisos; la auditoría se registra desde sus ganchos.
 */
export function memberRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();

  r.get("/members", requireTenant(deps, "members.manage"), async (c) => {
    const { tenantId } = c.get("tenant");
    const members = await deps.adminDb
      .select({
        id: schema.member.id,
        userId: schema.member.userId,
        role: schema.member.role,
        createdAt: schema.member.createdAt,
        name: schema.user.name,
        email: schema.user.email,
      })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(eq(schema.member.organizationId, tenantId))
      .orderBy(schema.member.createdAt);
    const invitations = await deps.adminDb
      .select({
        id: schema.invitation.id,
        email: schema.invitation.email,
        role: schema.invitation.role,
        expiresAt: schema.invitation.expiresAt,
        createdAt: schema.invitation.createdAt,
      })
      .from(schema.invitation)
      .where(and(eq(schema.invitation.organizationId, tenantId), eq(schema.invitation.status, "pending")));
    const now = Date.now();
    return c.json({
      members,
      invitations: invitations
        .filter((i) => i.expiresAt.getTime() > now)
        // Enlace para compartir a mano cuando no hay correo configurado
        .map((i) => ({ ...i, link: `${deps.config.BASE_URL}/accept-invitation/${i.id}` })),
      emailEnabled: Boolean(deps.config.SMTP_URL),
    });
  });

  /** Solo el propietario (org.manage): el propietario pasa a Admin y el miembro elegido a Owner. */
  r.post("/members/transfer-ownership", requireTenant(deps, "org.manage"), async (c) => {
    const t = c.get("tenant");
    const body = z.object({ memberId: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);

    const result = await deps.adminDb.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(schema.member)
        .where(and(eq(schema.member.id, body.data.memberId), eq(schema.member.organizationId, t.tenantId)));
      if (!target) return "not_found" as const;
      if (target.userId === t.userId) return "same_user" as const;
      const [me] = await tx
        .select()
        .from(schema.member)
        .where(and(eq(schema.member.userId, t.userId), eq(schema.member.organizationId, t.tenantId)));
      if (!me || me.role !== "owner") return "not_owner" as const; // un superadmin no se convierte en propietario por esta vía
      await tx.update(schema.member).set({ role: "owner" }).where(eq(schema.member.id, target.id));
      await tx.update(schema.member).set({ role: "admin" }).where(eq(schema.member.id, me.id));
      return { to: target.userId };
    });
    if (result === "not_found") return c.json({ error: "not_found" }, 404);
    if (result === "same_user" || result === "not_owner") return c.json({ error: result }, 400);
    await audit(deps.appDb, {
      tenantId: t.tenantId,
      actorUserId: t.userId,
      action: "org.transfer_ownership",
      target: body.data.memberId,
      meta: { toUser: result.to },
      ip: c.get("ip"),
    });
    return c.json({ ok: true });
  });

  return r;
}
