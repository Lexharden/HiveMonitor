-- 0001_init: tablas de Better Auth, tablas de dominio, RLS, roles y particiones de eventos.

-- ---------------------------------------------------------------------------
-- Rol de aplicación: SIN BYPASSRLS y SIN propiedad de las tablas, por lo tanto
-- sujeto a RLS. La conexión de migraciones/administración es la propietaria.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hive_app') THEN
    CREATE ROLE hive_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Better Auth (core + organization). Solo las usa la conexión de administración.
-- ---------------------------------------------------------------------------
CREATE TABLE "user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  is_superadmin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE session (
  id text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  active_organization_id text
);
CREATE INDEX session_user_idx ON session(user_id);

CREATE TABLE account (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_user_idx ON account(user_id);

CREATE TABLE verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_identifier_idx ON verification(identifier);

CREATE TABLE organization (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  logo text,
  metadata text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE member (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);
CREATE INDEX member_user_idx ON member(user_id);

CREATE TABLE invitation (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  inviter_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX invitation_org_idx ON invitation(organization_id);

-- ---------------------------------------------------------------------------
-- Dominio (todas con tenant_id = organization.id)
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_settings (
  tenant_id text PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  suspended boolean NOT NULL DEFAULT false,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_definition (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  permissions text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE TABLE platform_connection (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('tiktok', 'twitch', 'youtube')),
  channel_id text NOT NULL,
  channel_name text,
  status text NOT NULL DEFAULT 'offline'
    CHECK (status IN ('connecting', 'live', 'offline', 'error', 'rate_limited')),
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  credentials_enc bytea,
  key_version integer NOT NULL DEFAULT 1,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, platform, channel_id)
);

CREATE TABLE stream_session (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  platform text NOT NULL,
  channel_id text NOT NULL,
  title text,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  peak_viewers integer NOT NULL DEFAULT 0,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX stream_session_tenant_idx ON stream_session(tenant_id, started_at DESC);

-- Eventos: particionada por mes. La retención elimina particiones completas.
CREATE TABLE event (
  id text NOT NULL,
  tenant_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  platform text NOT NULL,
  channel_id text NOT NULL,
  session_id text,
  type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  actor_id text,
  actor_name text,
  amount_minor bigint,
  currency text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw jsonb,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX event_tenant_time_idx ON event(tenant_id, occurred_at DESC);
CREATE INDEX event_tenant_type_time_idx ON event(tenant_id, type, occurred_at DESC);
CREATE TABLE event_default PARTITION OF event DEFAULT;

CREATE TABLE stats_hourly (
  tenant_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  platform text NOT NULL,
  bucket timestamptz NOT NULL,
  viewers_peak integer NOT NULL DEFAULT 0,
  viewers_avg real NOT NULL DEFAULT 0,
  viewer_samples integer NOT NULL DEFAULT 0,
  donations_minor bigint NOT NULL DEFAULT 0,
  messages integer NOT NULL DEFAULT 0,
  new_followers integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, platform, bucket)
);

CREATE TABLE stats_daily (
  tenant_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  platform text NOT NULL,
  bucket date NOT NULL,
  viewers_peak integer NOT NULL DEFAULT 0,
  viewers_avg real NOT NULL DEFAULT 0,
  viewer_samples integer NOT NULL DEFAULT 0,
  donations_minor bigint NOT NULL DEFAULT 0,
  messages integer NOT NULL DEFAULT 0,
  new_followers integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, platform, bucket)
);

CREATE TABLE alert_rule (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  type text NOT NULL,
  name text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  channels text[] NOT NULL DEFAULT '{panel}',
  webhook_url_enc bytea,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alert_event (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  rule_id text REFERENCES alert_rule(id) ON DELETE SET NULL,
  fired_at timestamptz NOT NULL DEFAULT now(),
  data jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX alert_event_tenant_idx ON alert_event(tenant_id, fired_at DESC);

CREATE TABLE heartbeat_token (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  label text NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE heartbeat (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  source text NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX heartbeat_tenant_idx ON heartbeat(tenant_id, source, reported_at DESC);

CREATE TABLE audit_log (
  id text PRIMARY KEY,
  tenant_id text REFERENCES organization(id) ON DELETE CASCADE,
  actor_user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  action text NOT NULL,
  target text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_idx ON audit_log(tenant_id, at DESC);

-- audit_log es append-only para todos (incluido el propietario)
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log es de solo inserción';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- ---------------------------------------------------------------------------
-- Row-Level Security: tenant_id = app.tenant_id (SET LOCAL por transacción).
-- Sin contexto de tenant, current_setting devuelve NULL y no se ve ninguna fila.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_settings', 'role_definition', 'platform_connection', 'stream_session',
    'event', 'stats_hourly', 'stats_daily', 'alert_rule', 'alert_event',
    'heartbeat_token', 'heartbeat', 'audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = current_setting(''app.tenant_id'', true))
         WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Privilegios mínimos de hive_app (sin acceso a tablas de Better Auth)
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO hive_app;
GRANT SELECT ON tenant_settings TO hive_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  role_definition, platform_connection, stream_session, event, stats_hourly,
  stats_daily, alert_rule, alert_event, heartbeat_token, heartbeat TO hive_app;
GRANT SELECT, INSERT ON audit_log TO hive_app;

-- Resolución de token de heartbeat: aún no se conoce el tenant, por eso
-- SECURITY DEFINER (se ejecuta como propietario). Devuelve solo el tenant_id.
CREATE FUNCTION resolve_heartbeat_token(p_hash text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant text;
BEGIN
  UPDATE heartbeat_token SET last_used_at = now()
   WHERE token_hash = p_hash AND revoked_at IS NULL
   RETURNING tenant_id INTO v_tenant;
  RETURN v_tenant;
END $$;
REVOKE ALL ON FUNCTION resolve_heartbeat_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_heartbeat_token(text) TO hive_app;

-- ---------------------------------------------------------------------------
-- Particiones de eventos (las invoca la conexión de administración)
-- ---------------------------------------------------------------------------
CREATE FUNCTION ensure_event_partitions(p_back integer, p_ahead integer) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  m date;
  created integer := 0;
  part text;
BEGIN
  FOR i IN -p_back..p_ahead LOOP
    m := (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => i))::date;
    part := format('event_%s', to_char(m, 'YYYY_MM'));
    IF to_regclass(part) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF event FOR VALUES FROM (%L) TO (%L)',
        part, m::timestamptz, (m + interval '1 month')::timestamptz);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END $$;

CREATE FUNCTION drop_old_event_partitions(p_retention_days integer) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  dropped integer := 0;
  month_start date;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'event'::regclass AND c.relname ~ '^event_[0-9]{4}_[0-9]{2}$'
  LOOP
    month_start := to_date(substr(r.relname, 7), 'YYYY_MM');
    IF (month_start + interval '1 month') < (now() - make_interval(days => p_retention_days)) THEN
      EXECUTE format('DROP TABLE %I', r.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  -- Filas antiguas que cayeron en la partición por defecto
  DELETE FROM event_default WHERE occurred_at < now() - make_interval(days => p_retention_days);
  RETURN dropped;
END $$;

SELECT ensure_event_partitions(1, 2);
