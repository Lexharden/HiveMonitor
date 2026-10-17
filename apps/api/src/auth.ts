import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins/bearer";
import { organization } from "better-auth/plugins/organization";
import { schema, type Database } from "@hivemonitor/db";
import { ac, orgRoles } from "./access.ts";
import { isProd, type Config } from "./config.ts";
import type { Logger } from "./logger.ts";

export interface AuthDeps {
  config: Config;
  /** Conexión propietaria: Better Auth es un componente de confianza del sistema. */
  adminDb: Database;
  logger: Logger;
  /** Notificación de invitaciones (correo/enlace). Por defecto solo se registra. */
  onInvitation?: (data: { email: string; role: string; organizationName: string; link: string }) => Promise<void>;
}

export function createAuth({ config, adminDb, logger, onInvitation }: AuthDeps) {
  const social: Record<string, { clientId: string; clientSecret: string }> = {};
  if (config.TWITCH_CLIENT_ID && config.TWITCH_CLIENT_SECRET) {
    social.twitch = { clientId: config.TWITCH_CLIENT_ID, clientSecret: config.TWITCH_CLIENT_SECRET };
  }
  if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
    social.google = { clientId: config.GOOGLE_CLIENT_ID, clientSecret: config.GOOGLE_CLIENT_SECRET };
  }

  return betterAuth({
    appName: "HiveMonitor",
    baseURL: config.BASE_URL,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.BASE_URL, ...config.CORS_ORIGINS],
    database: drizzleAdapter(adminDb, {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        organization: schema.organization,
        member: schema.member,
        invitation: schema.invitation,
      },
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 10, maxPasswordLength: 128 },
    socialProviders: social,
    user: {
      additionalFields: {
        // Solo asignable desde el servidor (script make-superadmin); nunca desde la entrada del cliente
        isSuperadmin: { type: "boolean", required: false, defaultValue: false, input: false },
      },
    },
    session: {
      // El token bearer del cliente Tauri es el token de sesión: renovación deslizante,
      // expira a los 14 días sin uso y se rota diariamente.
      expiresIn: 60 * 60 * 24 * 14,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 3600, max: 10 },
      },
    },
    advanced: {
      useSecureCookies: isProd(config) || config.BASE_URL.startsWith("https://"),
      // La app sobrescribe X-Forwarded-For con la IP ya validada (ver app.ts)
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    plugins: [
      bearer(),
      organization({
        ac,
        roles: orgRoles,
        creatorRole: "owner",
        invitationExpiresIn: 60 * 60 * 24 * 7,
        organizationHooks: {
          afterCreateOrganization: async ({ organization: org, user }) => {
            await adminDb.insert(schema.tenantSettings).values({ tenantId: org.id }).onConflictDoNothing();
            await adminDb.insert(schema.auditLog).values({
              id: crypto.randomUUID(),
              tenantId: org.id,
              actorUserId: user.id,
              action: "org.create",
              target: org.id,
            });
          },
        },
        sendInvitationEmail: async (data) => {
          const link = `${config.BASE_URL}/accept-invitation/${data.id}`;
          logger.info({ email: data.email, org: data.organization.name }, "invitación creada");
          await onInvitation?.({
            email: data.email,
            role: data.role,
            organizationName: data.organization.name,
            link,
          });
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
