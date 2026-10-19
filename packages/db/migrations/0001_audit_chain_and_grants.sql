-- AD-10: append-only, hash-chained audit trail and per-role least-privilege grants.

-- Canonical form of an audit event, hashed together with the previous event's hash.
CREATE FUNCTION audit_event_digest(prev bytea, e audit_events) RETURNS bytea
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
  SELECT sha256(
    prev || convert_to(concat_ws(chr(31),
      e.id::text,
      to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      e.event_type,
      coalesce(e.actor_oid::text, ''),
      coalesce(e.actor_name, ''),
      coalesce(e.target, ''),
      e.trace_id), 'UTF8'))
$$;
--> statement-breakpoint
CREATE FUNCTION audit_events_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  -- Serialise appends so every row links to exactly one predecessor.
  PERFORM pg_advisory_xact_lock(hashtext('audit_events_chain'));
  SELECT a.hash INTO NEW.prev_hash FROM audit_events a ORDER BY a.id DESC LIMIT 1;
  NEW.hash := audit_event_digest(coalesce(NEW.prev_hash, '\x'::bytea), NEW);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_chain BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_chain();
--> statement-breakpoint
CREATE FUNCTION audit_events_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % rejected', TG_OP;
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update_delete BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_reject_change();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_reject_change();
--> statement-breakpoint
-- Id of the first event whose link or hash does not verify, or NULL when the whole chain holds.
CREATE FUNCTION audit_chain_break() RETURNS bigint
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT id FROM (
    SELECT e.id, e.prev_hash, e.hash,
           lag(e.hash) OVER (ORDER BY e.id) AS expected_prev,
           audit_event_digest(coalesce(e.prev_hash, '\x'::bytea), e) AS recomputed
    FROM audit_events e
  ) c
  WHERE c.prev_hash IS DISTINCT FROM c.expected_prev OR c.hash <> c.recomputed
  ORDER BY id
  LIMIT 1
$$;
--> statement-breakpoint
-- Group roles; the login users that hold them are created per environment (docker-init locally, Terraform on RDS).
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['sr_api', 'sr_report_worker', 'sr_mail_worker'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END
$$;
--> statement-breakpoint
REVOKE ALL ON sessions, audit_events FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_event_digest(bytea, audit_events), audit_events_chain(), audit_chain_break() FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO sr_api, sr_report_worker, sr_mail_worker;
--> statement-breakpoint
-- The BFF owns sessions and appends to the audit trail, which it can never read back or change.
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO sr_api;
--> statement-breakpoint
GRANT INSERT ON audit_events TO sr_api;
--> statement-breakpoint
-- The report worker purges expired sessions; it sees only the deadline columns, never the sealed tokens.
GRANT SELECT (id_hash, idle_expires_at, absolute_expires_at), DELETE ON sessions TO sr_report_worker;
--> statement-breakpoint
GRANT INSERT ON audit_events TO sr_report_worker;
--> statement-breakpoint
-- sr_mail_worker is deliberately granted nothing on sessions or audit_events.
