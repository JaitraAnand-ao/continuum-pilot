-- AD-10 group roles: NOLOGIN, one per deployable; docker-init (local) and Terraform (RDS) create
-- the login users that are members. Idempotent because roles are cluster-wide.
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['sr_api', 'sr_report_worker', 'sr_mail_worker', 'sr_auditor'] LOOP
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
    END IF;
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO sr_api, sr_report_worker, sr_mail_worker, sr_auditor;
--> statement-breakpoint
REVOKE ALL ON TABLE sessions, login_transactions, audit_events FROM PUBLIC;
--> statement-breakpoint
-- AD-5: the BFF creates, resumes (sliding last_seen_at only), ends and purges sessions.
GRANT SELECT, INSERT, DELETE ON TABLE sessions TO sr_api;
--> statement-breakpoint
GRANT UPDATE (last_seen_at) ON TABLE sessions TO sr_api;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE login_transactions TO sr_api;
--> statement-breakpoint
-- The audit log: the BFF appends, the auditor reads, nobody changes or removes.
GRANT INSERT (occurred_at, event_type, subject, username, trace_id, detail) ON TABLE audit_events TO sr_api;
--> statement-breakpoint
GRANT SELECT ON TABLE audit_events TO sr_auditor;
--> statement-breakpoint
CREATE FUNCTION audit_event_digest(
  p_prev_hash bytea, p_position bigint, p_occurred_at timestamptz, p_event_type text,
  p_subject text, p_username text, p_trace_id text, p_detail jsonb
) RETURNS bytea
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT sha256(p_prev_hash || convert_to(jsonb_build_array(
    p_position,
    to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    p_event_type, p_subject, p_username, p_trace_id, p_detail
  )::text, 'UTF8'))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_event_digest(bytea, bigint, timestamptz, text, text, text, text, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit_event_digest(bytea, bigint, timestamptz, text, text, text, text, jsonb) TO sr_auditor;
--> statement-breakpoint
-- Serialised by a transaction-scoped advisory lock so concurrent writers form one chain.
CREATE FUNCTION audit_events_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  last_position bigint;
  last_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit_events_chain'));
  SELECT a.position, a.hash INTO last_position, last_hash FROM audit_events a ORDER BY a.position DESC LIMIT 1;
  NEW.position := coalesce(last_position, 0) + 1;
  NEW.prev_hash := coalesce(last_hash, '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea);
  NEW.hash := audit_event_digest(NEW.prev_hash, NEW.position, NEW.occurred_at, NEW.event_type,
    NEW.subject, NEW.username, NEW.trace_id, NEW.detail);
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_events_chain() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION audit_events_reject_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % refused', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_chain BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_events_chain();
--> statement-breakpoint
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_reject_change();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_reject_change();
