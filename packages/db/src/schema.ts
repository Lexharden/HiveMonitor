/**
 * Esquema Drizzle (tipos para las consultas). La fuente de verdad del DDL son
 * las migraciones SQL en `migrations/`; este archivo debe mantenerse en sync.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true });
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

// --- Better Auth -----------------------------------------------------------
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  isSuperadmin: boolean("is_superadmin").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: ts("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  activeOrganizationId: text("active_organization_id"),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: ts("access_token_expires_at"),
  refreshTokenExpiresAt: ts("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [unique().on(t.organizationId, t.userId)],
);

export const invitation = pgTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull().default("pending"),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

// --- Dominio (con RLS por tenant_id) ---------------------------------------
const tenantId = () =>
  text("tenant_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" });

export const tenantSettings = pgTable("tenant_settings", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  suspended: boolean("suspended").notNull().default(false),
  limits: jsonb("limits").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const roleDefinition = pgTable(
  "role_definition",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    permissions: text("permissions")
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [unique().on(t.tenantId, t.key)],
);

export const platformConnection = pgTable(
  "platform_connection",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    platform: text("platform").notNull(),
    channelId: text("channel_id").notNull(),
    channelName: text("channel_name"),
    status: text("status").notNull().default("offline"),
    enabled: boolean("enabled").notNull().default(true),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    credentialsEnc: bytea("credentials_enc"),
    keyVersion: integer("key_version").notNull().default(1),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [unique().on(t.tenantId, t.platform, t.channelId)],
);

export const streamSession = pgTable(
  "stream_session",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    platform: text("platform").notNull(),
    channelId: text("channel_id").notNull(),
    title: text("title"),
    startedAt: ts("started_at").notNull(),
    endedAt: ts("ended_at"),
    peakViewers: integer("peak_viewers").notNull().default(0),
    stats: jsonb("stats").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index("stream_session_tenant_idx").on(t.tenantId, t.startedAt)],
);

/** Tabla particionada por mes (ver migración 0001); Drizzle la ve como una tabla normal. */
export const event = pgTable(
  "event",
  {
    id: text("id").notNull(),
    tenantId: tenantId(),
    platform: text("platform").notNull(),
    channelId: text("channel_id").notNull(),
    sessionId: text("session_id"),
    type: text("type").notNull(),
    occurredAt: ts("occurred_at").notNull(),
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    amountMinor: bigint("amount_minor", { mode: "number" }),
    currency: text("currency"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    raw: jsonb("raw"),
  },
  (t) => [primaryKey({ columns: [t.id, t.occurredAt] })],
);

const statsColumns = {
  viewersPeak: integer("viewers_peak").notNull().default(0),
  viewersAvg: real("viewers_avg").notNull().default(0),
  viewerSamples: integer("viewer_samples").notNull().default(0),
  donationsMinor: bigint("donations_minor", { mode: "number" }).notNull().default(0),
  messages: integer("messages").notNull().default(0),
  newFollowers: integer("new_followers").notNull().default(0),
};

export const statsHourly = pgTable(
  "stats_hourly",
  { tenantId: tenantId(), platform: text("platform").notNull(), bucket: ts("bucket").notNull(), ...statsColumns },
  (t) => [primaryKey({ columns: [t.tenantId, t.platform, t.bucket] })],
);

export const statsDaily = pgTable(
  "stats_daily",
  { tenantId: tenantId(), platform: text("platform").notNull(), bucket: date("bucket").notNull(), ...statsColumns },
  (t) => [primaryKey({ columns: [t.tenantId, t.platform, t.bucket] })],
);

export const alertRule = pgTable("alert_rule", {
  id: text("id").primaryKey(),
  tenantId: tenantId(),
  type: text("type").notNull(),
  name: text("name").notNull(),
  params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
  channels: text("channels")
    .array()
    .notNull()
    .default(sql`'{panel}'`),
  webhookUrlEnc: bytea("webhook_url_enc"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const alertEvent = pgTable("alert_event", {
  id: text("id").primaryKey(),
  tenantId: tenantId(),
  ruleId: text("rule_id").references(() => alertRule.id, { onDelete: "set null" }),
  firedAt: ts("fired_at").notNull().defaultNow(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
});

export const heartbeatToken = pgTable("heartbeat_token", {
  id: text("id").primaryKey(),
  tenantId: tenantId(),
  tokenHash: text("token_hash").notNull().unique(),
  label: text("label").notNull(),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const heartbeat = pgTable("heartbeat", {
  id: text("id").primaryKey(),
  tenantId: tenantId(),
  source: text("source").notNull(),
  reportedAt: ts("reported_at").notNull().defaultNow(),
  metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull().default({}),
});

export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").references(() => organization.id, { onDelete: "cascade" }),
  actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  target: text("target"),
  meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
  ip: text("ip"),
  at: ts("at").notNull().defaultNow(),
});

export const streamMarker = pgTable(
  "stream_marker",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    at: ts("at").notNull().defaultNow(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    platform: text("platform"),
    channelId: text("channel_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [index("stream_marker_tenant_idx").on(t.tenantId, t.at)],
);

export const tenantPref = pgTable(
  "tenant_pref",
  {
    tenantId: tenantId(),
    key: text("key").notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);
