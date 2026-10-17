-- 0002_cockpit: marcadores de momentos del directo y preferencias por tenant (meta de donaciones).

-- Momentos marcados a mano (botón del cockpit) o detectados (raid, donación grande, pico de espectadores).
-- Son del tenant y se cruzan con las sesiones por tiempo (un mismo momento vale para varias plataformas a la vez).
CREATE TABLE stream_marker (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('manual', 'raid', 'donation', 'viewers_spike')),
  label text NOT NULL,
  platform text,
  channel_id text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text REFERENCES "user"(id) ON DELETE SET NULL
);
CREATE INDEX stream_marker_tenant_idx ON stream_marker(tenant_id, at DESC);

-- Preferencias por tenant (clave → valor JSON): hoy, la meta de donaciones del cockpit.
CREATE TABLE tenant_pref (
  tenant_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stream_marker', 'tenant_pref'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = current_setting(''app.tenant_id'', true))
         WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, DELETE ON stream_marker TO hive_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_pref TO hive_app;
