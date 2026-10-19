-- Custom migration (AD-5): an ended session is final. Neither the API, whose column grant
-- covers ended_at and end_reason, nor the owner can change or revive it afterwards.
CREATE FUNCTION session_ended_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'session has ended and cannot be changed' USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION session_ended_immutable() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER session_ended_immutable BEFORE UPDATE ON session
FOR EACH ROW WHEN (OLD.ended_at IS NOT NULL) EXECUTE FUNCTION session_ended_immutable();
