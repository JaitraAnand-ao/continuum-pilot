-- ST-1 (CMP-5): a session row only ever moves forward. Once ended it is final, so a
-- signed-out cookie can never be brought back (AC-9); who it belongs to, its roles,
-- its creation time and its 8 h absolute limit are fixed at login; last activity never
-- goes backwards. Enforced for every role, the owner included.
CREATE FUNCTION sessions_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'an ended session is final'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sessions_ended_is_final', TABLE = 'sessions';
  END IF;
  IF NEW.id_hash IS DISTINCT FROM OLD.id_hash
    OR NEW.subject IS DISTINCT FROM OLD.subject
    OR NEW.account_name IS DISTINCT FROM OLD.account_name
    OR NEW.roles IS DISTINCT FROM OLD.roles
    OR NEW.idp_session_id IS DISTINCT FROM OLD.idp_session_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.absolute_expires_at IS DISTINCT FROM OLD.absolute_expires_at THEN
    RAISE EXCEPTION 'a session''s identity and absolute limit are fixed at login'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sessions_identity_is_fixed', TABLE = 'sessions';
  END IF;
  IF NEW.last_seen_at < OLD.last_seen_at THEN
    RAISE EXCEPTION 'last activity cannot move backwards'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sessions_last_seen_monotonic', TABLE = 'sessions';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE TRIGGER sessions_guard BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION sessions_guard();
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION sessions_guard() FROM PUBLIC;
--> statement-breakpoint

-- sr_api (CMP-2) records activity, signs out and stores a rotated refresh token; rows are
-- removed only by purge_expired_sessions, which only sr_report_worker may run.
REVOKE UPDATE, DELETE, TRUNCATE ON sessions FROM sr_api;
--> statement-breakpoint
GRANT UPDATE (last_seen_at, idle_expires_at, ended_at, refresh_token_ciphertext) ON sessions TO sr_api;
