-- AD-10: one group role per deployable, no LOGIN and no password here. The platform (or a
-- local operator) grants LOGIN with a secret from outside the repository. Idempotent, and
-- safe when two sessions create the roles at once.
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['sr_api', 'sr_report_worker', 'sr_mail_worker', 'keycloak'] LOOP
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', role_name);
      EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
      END;
    END IF;
  END LOOP;
END
$$;
