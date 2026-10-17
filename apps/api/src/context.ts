import type { Permission } from "@hivemonitor/core";
import type { Database } from "@hivemonitor/db";
import type { EventBus } from "@hivemonitor/core";
import type { AlertEngine } from "./alerts/engine.ts";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Encryptor } from "./crypto.ts";
import type { Ingest } from "./ingest/manager.ts";
import type { Logger } from "./logger.ts";
import type { TwitchService } from "./twitch/service.ts";

export interface AppDeps {
  config: Config;
  logger: Logger;
  /** Conexión propietaria (autenticación, superadmin, tareas globales). */
  adminDb: Database;
  /** Conexión hive_app: sujeta a RLS; todo acceso a datos de tenant pasa por withTenant. */
  appDb: Database;
  /** Cliente SQL crudo del pool de administración (readyz). */
  ping: () => Promise<void>;
  auth: Auth;
  bus: EventBus;
  ingest: Ingest;
  alerts: AlertEngine;
  /** null si no hay credenciales de aplicación de Twitch. */
  twitch: TwitchService | null;
  encryptor: Encryptor;
  /** Hay envío de correo (SMTP): verificación de correo, recuperación de contraseña e invitaciones por email. */
  emailEnabled: boolean;
  /** Hook opcional para servir el frontend embebido. */
  staticHandler?: (req: Request) => Promise<Response | null>;
}

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
  isSuperadmin: boolean;
}

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: string;
  permissions: ReadonlySet<Permission>;
  isSuperadmin: boolean;
}

export type AppEnv = {
  Variables: {
    ip: string;
    requestId: string;
    user: AuthedUser;
    tenant: TenantContext;
  };
};
