-- ST-1 (CMP-5): the advisory lock in audit_events_chain only serialises appends correctly
-- under READ COMMITTED; a REPEATABLE READ or SERIALIZABLE snapshot taken before the lock
-- would read a stale last row and fork the chain. Refuse such appends outright.
CREATE OR REPLACE FUNCTION audit_events_chain() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  last_id bigint;
  last_hash bytea;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'audit_events appends require READ COMMITTED isolation'
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('audit_events_chain'));
  SELECT a.id, a.hash INTO last_id, last_hash FROM audit_events a ORDER BY a.id DESC LIMIT 1;
  NEW.id := coalesce(last_id, 0) + 1;
  NEW.prev_hash := last_hash;
  NEW.hash := audit_event_digest(NEW.prev_hash, NEW.id, NEW.occurred_at, NEW.event_type, NEW.subject, NEW.reason, NEW.trace_id);
  RETURN NEW;
END
$$;
