-- ST-9: risk flags are written with their report and never changed; the report's risk counts equal its flags.

CREATE TRIGGER report_risky_sign_in_flag_no_update BEFORE UPDATE ON report_risky_sign_in_flag
  FOR EACH ROW EXECUTE FUNCTION report_reject_change();
--> statement-breakpoint
CREATE TRIGGER report_risky_sign_in_flag_no_truncate BEFORE TRUNCATE ON report_risky_sign_in_flag
  FOR EACH STATEMENT EXECUTE FUNCTION report_reject_change();
--> statement-breakpoint
CREATE TRIGGER report_risky_user_flag_no_update BEFORE UPDATE ON report_risky_user_flag
  FOR EACH ROW EXECUTE FUNCTION report_reject_change();
--> statement-breakpoint
CREATE TRIGGER report_risky_user_flag_no_truncate BEFORE TRUNCATE ON report_risky_user_flag
  FOR EACH STATEMENT EXECUTE FUNCTION report_reject_change();
--> statement-breakpoint
-- Checked at commit, once the report and all its flags are written: a category not evaluated (NULL) holds no flag,
-- and an evaluated one counts exactly its flags. Inserting or removing a flag is checked the same way; a report purged
-- in the same transaction has nothing left to check. The fixed search_path keeps a temporary table from shadowing them.
CREATE FUNCTION report_risk_flags_reconcile() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  day date := CASE WHEN TG_OP = 'DELETE' THEN OLD.report_date ELSE NEW.report_date END;
  counted public.report%ROWTYPE;
  sign_ins integer;
  users integer;
BEGIN
  SELECT * INTO counted FROM public.report WHERE report_date = day;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO sign_ins FROM public.report_risky_sign_in_flag WHERE report_date = day;
  SELECT count(*) INTO users FROM public.report_risky_user_flag WHERE report_date = day;
  IF counted.risky_sign_ins IS NULL THEN
    IF sign_ins + users > 0 THEN
      RAISE EXCEPTION 'report %: risk categories not evaluated but % flag(s) stored', day, sign_ins + users
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF counted.risky_sign_ins <> sign_ins OR counted.risky_users <> users THEN
    RAISE EXCEPTION 'report %: risk counts do not reconcile to the stored flags', day
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER report_risk_flags_reconcile AFTER INSERT ON report
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION report_risk_flags_reconcile();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER report_risky_sign_in_flag_reconcile AFTER INSERT OR DELETE ON report_risky_sign_in_flag
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION report_risk_flags_reconcile();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER report_risky_user_flag_reconcile AFTER INSERT OR DELETE ON report_risky_user_flag
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION report_risk_flags_reconcile();
--> statement-breakpoint
REVOKE ALL ON report_risky_sign_in_flag, report_risky_user_flag FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION report_risk_flags_reconcile() FROM PUBLIC;
--> statement-breakpoint
-- The report worker writes each flag once, with its report (INSERT ... ON CONFLICT DO NOTHING), and can never change one.
GRANT SELECT, INSERT ON report_risky_sign_in_flag, report_risky_user_flag TO sr_report_worker;
--> statement-breakpoint
-- The BFF serves the stored flags as they were written.
GRANT SELECT ON report_risky_sign_in_flag, report_risky_user_flag TO sr_api;
--> statement-breakpoint
-- The mail worker sends counts only: it reads the two risk counts, never a flag or its evidence.
GRANT SELECT (risky_sign_ins, risky_users) ON report TO sr_mail_worker;
