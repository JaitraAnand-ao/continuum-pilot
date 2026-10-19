-- ST-1 (CMP-5): what Drizzle cannot express for the tables in 0000 — the audit hash
-- chain, append-only enforcement, the session purge, and per-role grants (AD-10).

-- Runtime roles are NOLOGIN groups; deployments grant them to their login users.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['sr_api', 'sr_report_worker', 'sr_mail_worker'] LOOP
    BEGIN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL;
    END;
  END LOOP;
END
$$;
--> statement-breakpoint

-- Length-prefixed encoding: a NULL field is '-', a value is '<octets>:<utf8>'.
CREATE FUNCTION audit_field(value text) RETURNS bytea
  LANGUAGE sql IMMUTABLE STRICT
  SET search_path = pg_catalog
AS $$
  SELECT convert_to(octet_length(convert_to(value, 'UTF8'))::text || ':', 'UTF8') || convert_to(value, 'UTF8')
$$;
--> statement-breakpoint

-- Mirrored by auditEventDigest in packages/db/src/audit.ts; change both or neither.
CREATE FUNCTION audit_event_digest(
  prev_hash bytea, id bigint, occurred_at timestamptz, event_type text, subject text, reason text, trace_id text
) RETURNS bytea
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT sha256(
    CASE WHEN prev_hash IS NULL THEN '\x00'::bytea ELSE '\x01'::bytea || prev_hash END
    || coalesce(audit_field(id::text), '\x2d'::bytea)
    || coalesce(audit_field(to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), '\x2d'::bytea)
    || coalesce(audit_field(event_type), '\x2d'::bytea)
    || coalesce(audit_field(subject), '\x2d'::bytea)
    || coalesce(audit_field(reason), '\x2d'::bytea)
    || coalesce(audit_field(trace_id), '\x2d'::bytea)
  )
$$;
--> statement-breakpoint

-- Serialises appends with a transaction-scoped advisory lock so ids are gap-free and each
-- row's prev_hash is the hash of the row before it. Requires READ COMMITTED callers.
CREATE FUNCTION audit_events_chain() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  last_id bigint;
  last_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit_events_chain'));
  SELECT a.id, a.hash INTO last_id, last_hash FROM audit_events a ORDER BY a.id DESC LIMIT 1;
  NEW.id := coalesce(last_id, 0) + 1;
  NEW.prev_hash := last_hash;
  NEW.hash := audit_event_digest(NEW.prev_hash, NEW.id, NEW.occurred_at, NEW.event_type, NEW.subject, NEW.reason, NEW.trace_id);
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE TRIGGER audit_events_chain BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_chain();
--> statement-breakpoint

CREATE FUNCTION audit_events_reject_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint

CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_reject_change();
--> statement-breakpoint

-- The session-purge job deletes ended or expired sessions without being able to read them.
CREATE FUNCTION purge_expired_sessions(as_of timestamptz) RETURNS integer
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  WITH gone AS (
    DELETE FROM sessions
    WHERE ended_at IS NOT NULL OR idle_expires_at <= as_of OR absolute_expires_at <= as_of
    RETURNING 1
  )
  SELECT count(*)::integer FROM gone
$$;
--> statement-breakpoint

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON sessions, audit_events FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION
  audit_field(text),
  audit_event_digest(bytea, bigint, timestamptz, text, text, text, text),
  audit_events_chain(),
  audit_events_reject_change(),
  purge_expired_sessions(timestamptz)
FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO sr_api, sr_report_worker, sr_mail_worker;
--> statement-breakpoint

-- sr_api (CMP-2): owns the session lifecycle; may append audit events and learn the new
-- row's id, but can neither read the log back nor change it.
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO sr_api;
--> statement-breakpoint
GRANT INSERT ON audit_events TO sr_api;
--> statement-breakpoint
GRANT SELECT (id) ON audit_events TO sr_api;
--> statement-breakpoint

-- sr_report_worker (CMP-3): only the purge. sr_mail_worker (CMP-4): nothing here.
GRANT EXECUTE ON FUNCTION purge_expired_sessions(timestamptz) TO sr_report_worker;
