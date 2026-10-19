-- Custom migration (AD-10): per-role privileges on the ST-1 tables and the audit_event
-- hash chain. The roles exist before migrations run: docker-init/ creates them locally,
-- the RDS Terraform root module in production.
REVOKE ALL ON TABLE session, audit_event FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO sr_api;
--> statement-breakpoint
GRANT SELECT, INSERT ON session TO sr_api;
--> statement-breakpoint
GRANT UPDATE (last_seen_at, idle_expires_at, ended_at, end_reason) ON session TO sr_api;
--> statement-breakpoint
GRANT INSERT ON audit_event TO sr_api;
--> statement-breakpoint
-- Sets seq, prev_hash and hash whatever the caller supplied. Runs as the table owner so a
-- role that may only INSERT can still read the chain head. The advisory lock serialises
-- writers so each entry chains to the one committed before it. The hashed text is the
-- formula auditEntryHash in src/audit-chain.ts verifies.
CREATE FUNCTION audit_event_chain() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  last_seq bigint;
  last_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('public.audit_event chain'));
  SELECT seq, hash INTO last_seq, last_hash FROM public.audit_event ORDER BY seq DESC LIMIT 1;
  NEW.seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := coalesce(last_hash, decode(repeat('00', 32), 'hex'));
  NEW.hash := sha256(NEW.prev_hash || convert_to(concat_ws('|',
    NEW.seq::text,
    to_char(NEW.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    NEW.event_type,
    coalesce(NEW.actor_oid::text, ''),
    NEW.trace_id,
    coalesce(NEW.reason, '')
  ), 'UTF8'));
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_event_chain() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER audit_event_chain BEFORE INSERT ON audit_event
FOR EACH ROW EXECUTE FUNCTION audit_event_chain();
--> statement-breakpoint
CREATE FUNCTION audit_event_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only: % refused', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_event_append_only() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER audit_event_no_update_or_delete BEFORE UPDATE OR DELETE ON audit_event
FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON audit_event
FOR EACH STATEMENT EXECUTE FUNCTION audit_event_append_only();
