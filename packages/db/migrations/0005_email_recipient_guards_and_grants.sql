-- ST-18: a recipient row changes only by its approval, and each role gets only what its job needs (AD-10).

-- A recipient is only ever added waiting for approval, so no caller can name its own approver.
CREATE FUNCTION email_recipient_guard_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' THEN
    RAISE EXCEPTION 'an email recipient is added waiting for approval, never already active';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER email_recipient_guard_insert BEFORE INSERT ON email_recipient
  FOR EACH ROW EXECUTE FUNCTION email_recipient_guard_insert();
--> statement-breakpoint
-- Who or what a recipient is never changes; the only change allowed is a waiting recipient becoming active.
CREATE FUNCTION email_recipient_guard_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.kind, NEW.entra_object_id, NEW.display_name, NEW.address, NEW.member_count,
      NEW.added_by_oid, NEW.added_by_name, NEW.proposed_at)
     IS DISTINCT FROM
     (OLD.kind, OLD.entra_object_id, OLD.display_name, OLD.address, OLD.member_count,
      OLD.added_by_oid, OLD.added_by_name, OLD.proposed_at) THEN
    RAISE EXCEPTION 'an email recipient cannot be rewritten; remove it and add it again';
  END IF;
  IF NOT (OLD.status = 'pending_approval' AND NEW.status = 'active') THEN
    RAISE EXCEPTION 'only a recipient waiting for approval can change, by being approved';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER email_recipient_guard_change BEFORE UPDATE ON email_recipient
  FOR EACH ROW EXECUTE FUNCTION email_recipient_guard_change();
--> statement-breakpoint
REVOKE ALL ON email_recipient FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION email_recipient_guard_insert(), email_recipient_guard_change() FROM PUBLIC;
--> statement-breakpoint
-- The BFF lists recipients, adds them waiting for approval and removes them at once; it cannot approve or rewrite.
-- The approval UPDATE is granted by the story that brings the four-eyes decision, not here.
GRANT SELECT, INSERT, DELETE ON email_recipient TO sr_api;
--> statement-breakpoint
-- The mail worker reads only the address and status it sends by; never who proposed or approved a recipient.
GRANT SELECT (address, status) ON email_recipient TO sr_mail_worker;
--> statement-breakpoint
-- sr_report_worker is deliberately granted nothing on email_recipient.
