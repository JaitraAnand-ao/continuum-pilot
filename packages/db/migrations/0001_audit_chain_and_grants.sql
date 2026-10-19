-- Custom migration (drizzle-kit generate --custom): what the schema DSL cannot express.
-- The audit log's hash chain and append-only triggers, and the per-role grants (AD-10).
-- The roles themselves are created by docker-init/01-roles.sql (locally) or the platform.

CREATE FUNCTION audit_event_digest(
  prev_hash bytea, id bigint, occurred_at timestamptz, event_type text, actor text, trace_id text, detail jsonb
) RETURNS bytea
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT sha256(prev_hash || convert_to(
    id::text || E'\x1f' ||
    to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || E'\x1f' ||
    event_type || E'\x1f' || actor || E'\x1f' || trace_id || E'\x1f' ||
    coalesce(detail::text, ''),
    'UTF8'))
$$;
--> statement-breakpoint
-- Assigns id, prev_hash and hash under one lock held to commit, so the chain stays a single
-- line in id order however many writers there are. Caller-supplied values are overwritten.
CREATE FUNCTION audit_event_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  last_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit_event_chain'));
  SELECT hash INTO last_hash FROM audit_event ORDER BY id DESC LIMIT 1;
  NEW.id := nextval(pg_get_serial_sequence('audit_event', 'id'));
  NEW.prev_hash := coalesce(last_hash, '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea);
  NEW.hash := audit_event_digest(NEW.prev_hash, NEW.id, NEW.occurred_at, NEW.event_type, NEW.actor, NEW.trace_id, NEW.detail);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_event_chain BEFORE INSERT ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_chain();
--> statement-breakpoint
CREATE FUNCTION audit_event_reject_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only: % is not allowed', TG_OP;
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_event_no_update_or_delete BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_reject_change();
--> statement-breakpoint
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_reject_change();
--> statement-breakpoint
-- The id of the first row whose link or digest does not hold, or NULL when the chain is whole.
CREATE FUNCTION audit_event_first_broken() RETURNS bigint
LANGUAGE sql STABLE
SET search_path = public, pg_catalog, pg_temp
AS $$
  SELECT id FROM (
    SELECT id, prev_hash, hash, occurred_at, event_type, actor, trace_id, detail,
           coalesce(lag(hash) OVER (ORDER BY id),
                    '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea) AS expected_prev
      FROM audit_event
  ) chain
  WHERE prev_hash <> expected_prev
     OR hash <> audit_event_digest(prev_hash, id, occurred_at, event_type, actor, trace_id, detail)
  ORDER BY id
  LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON TABLE session, audit_event FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_event_digest(bytea, bigint, timestamptz, text, text, text, jsonb), audit_event_chain(),
  audit_event_reject_change(), audit_event_first_broken() FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO sr_api, sr_report_worker, sr_mail_worker;
--> statement-breakpoint
-- The API owns the session lifecycle and appends audit events; it reads back only the new
-- row's id and hash (RETURNING), never the log itself.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE session TO sr_api;
--> statement-breakpoint
GRANT INSERT ON TABLE audit_event TO sr_api;
--> statement-breakpoint
GRANT SELECT (id, hash) ON TABLE audit_event TO sr_api;
--> statement-breakpoint
-- The report worker purges expired sessions: it sees only the expiry columns, never a token or account.
GRANT SELECT (idle_expires_at, absolute_expires_at), DELETE ON TABLE session TO sr_report_worker;
--> statement-breakpoint
GRANT INSERT ON TABLE audit_event TO sr_report_worker;
--> statement-breakpoint
GRANT SELECT (id, hash) ON TABLE audit_event TO sr_report_worker;
