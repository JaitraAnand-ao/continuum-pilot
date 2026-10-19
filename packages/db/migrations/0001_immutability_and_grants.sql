-- ST-2: what the Drizzle schema cannot express. Stored reports and snapshots are written once and
-- never changed (snapshot-then-compute, published rows immutable); per-role grants follow AD-10.

-- Immutability: no UPDATE or TRUNCATE of a report or its snapshot, ever.
CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: stored reports are immutable', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER reports_reject_update BEFORE UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER reports_reject_truncate BEFORE TRUNCATE ON reports
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER signin_snapshots_reject_update BEFORE UPDATE ON signin_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER signin_snapshots_reject_truncate BEFORE TRUNCATE ON signin_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

-- A snapshot row must fall in its report's window [window_start, window_end), and may only be written
-- in the transaction that inserted the report: a published report's snapshot cannot grow later.
CREATE FUNCTION signin_snapshot_within_window() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r record;
BEGIN
  SELECT reports.xmin, reports.status, reports.window_start, reports.window_end INTO r
    FROM reports WHERE reports.id = NEW.report_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports the missing report
  END IF;
  IF r.status = 'not_generated' THEN
    RAISE EXCEPTION 'report % was recorded as not generated and holds no snapshot', NEW.report_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF r.xmin::text <> (txid_current() % 4294967296)::text THEN
    RAISE EXCEPTION 'report % is already published; its snapshot cannot change', NEW.report_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.created_at < r.window_start OR NEW.created_at >= r.window_end THEN
    RAISE EXCEPTION 'sign-in % at % is outside the report window', NEW.sign_in_id, NEW.created_at
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER signin_snapshots_within_window BEFORE INSERT ON signin_snapshots
  FOR EACH ROW EXECUTE FUNCTION signin_snapshot_within_window();
--> statement-breakpoint

-- At commit, a report's figures must reconcile to the snapshot written with it: a day without
-- sign-ins is a report of zeros, and a report of N sign-ins holds exactly N rows.
CREATE FUNCTION report_reconciles_with_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  n_total integer;
  n_successful integer;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE s.error_code = 0) INTO n_total, n_successful
    FROM signin_snapshots s WHERE s.report_id = NEW.id;
  IF n_total <> NEW.total_count OR n_successful <> NEW.successful_count THEN
    RAISE EXCEPTION 'report % states % sign-ins (% successful) but its snapshot holds % (% successful)',
      NEW.report_date, NEW.total_count, NEW.successful_count, n_total, n_successful
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER reports_reconcile_with_snapshot AFTER INSERT ON reports
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION report_reconciles_with_snapshot();
--> statement-breakpoint

-- Per-role grants (AD-10). The roles are group roles; login users are granted membership where they are
-- provisioned (docker-init locally, Terraform on RDS).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sr_report_worker') THEN
    CREATE ROLE sr_report_worker NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sr_api') THEN
    CREATE ROLE sr_api NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sr_mailer') THEN
    CREATE ROLE sr_mailer NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON reports, signin_snapshots FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON reports, signin_snapshots TO sr_report_worker;
--> statement-breakpoint
GRANT SELECT ON reports, signin_snapshots TO sr_api;
--> statement-breakpoint
GRANT SELECT (id, report_date, status, missing_sources, total_count, successful_count, failed_count, published_at) ON reports TO sr_mailer;
