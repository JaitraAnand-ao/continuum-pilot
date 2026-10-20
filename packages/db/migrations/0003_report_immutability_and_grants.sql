-- ST-2: a published report is immutable, and each role gets only what its job needs (AD-10).

CREATE FUNCTION report_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a published report is immutable: % rejected', TG_OP;
END
$$;
--> statement-breakpoint
CREATE TRIGGER report_no_update BEFORE UPDATE ON report
  FOR EACH ROW EXECUTE FUNCTION report_reject_change();
--> statement-breakpoint
CREATE TRIGGER report_no_truncate BEFORE TRUNCATE ON report
  FOR EACH STATEMENT EXECUTE FUNCTION report_reject_change();
--> statement-breakpoint
REVOKE ALL ON report, report_not_generated FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION report_reject_change() FROM PUBLIC;
--> statement-breakpoint
-- The report worker publishes each report once (INSERT ... ON CONFLICT DO NOTHING) and can never change one.
GRANT SELECT, INSERT ON report TO sr_report_worker;
--> statement-breakpoint
-- It records, and may record again, a day it could not generate.
GRANT SELECT, INSERT ON report_not_generated TO sr_report_worker;
--> statement-breakpoint
GRANT UPDATE (missing_sources, recorded_at) ON report_not_generated TO sr_report_worker;
--> statement-breakpoint
-- The BFF serves the stored reports as they were written; it writes neither table.
GRANT SELECT ON report, report_not_generated TO sr_api;
--> statement-breakpoint
-- The mail worker sends counts only: it can read the figures but never the snapshot evidence.
GRANT SELECT (report_date, status, missing_sources, total, successful, failed, published_at) ON report TO sr_mail_worker;
