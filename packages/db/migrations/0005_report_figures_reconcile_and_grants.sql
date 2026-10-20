-- ST-3: the Daily report's figures are stored with the report, reconcile to it, never change, and each role gets
-- only what its job needs (AD-10).

-- Checks one report's stored figures as a whole. Deferred to commit, so the report worker writes the report and
-- its figures row by row in the publish transaction and they are checked once complete; a delete is checked too, so
-- figures can only leave with their report. It runs once per written row (a constraint trigger cannot run per
-- statement): a few hundred whole-report checks per publish, each served by the primary keys' report_date prefix.
CREATE FUNCTION report_figures_reconcile() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  d constant date := coalesce(NEW.report_date, OLD.report_date);
  problem text;
BEGIN
  -- A report purged later in the same transaction has nothing left to reconcile.
  IF NOT EXISTS (SELECT 1 FROM report r WHERE r.report_date = d) THEN
    RETURN NULL;
  END IF;

  SELECT p.reason INTO problem FROM (
    SELECT 'All types and each of the four sign-in types need one row of figures' AS reason
     WHERE (SELECT count(*) FROM report_figures f WHERE f.report_date = d) <> 5
    UNION ALL
    SELECT 'All types differs from the published totals'
      FROM report r
      JOIN report_figures f ON f.report_date = r.report_date AND f.sign_in_type = 'all'
     WHERE r.report_date = d
       AND (f.total, f.successful, f.failed) IS DISTINCT FROM (r.total, r.successful, r.failed)
    UNION ALL
    SELECT 'the four sign-in types do not add up to All types'
      FROM report_figures a
     CROSS JOIN LATERAL (
           SELECT sum(f.total) AS total, sum(f.successful) AS successful, sum(f.failed) AS failed
             FROM report_figures f
            WHERE f.report_date = d AND f.sign_in_type <> 'all') t
     WHERE a.report_date = d AND a.sign_in_type = 'all'
       AND (a.total, a.successful, a.failed) IS DISTINCT FROM (t.total, t.successful, t.failed)
    UNION ALL
    SELECT 'the applications do not add up to the ' || f.sign_in_type || ' figures'
      FROM report_figures f
     CROSS JOIN LATERAL (
           SELECT coalesce(sum(a.total), 0) AS total, coalesce(sum(a.successful), 0) AS successful,
                  coalesce(sum(a.failed), 0) AS failed
             FROM report_application_figures a
            WHERE a.report_date = f.report_date AND a.sign_in_type = f.sign_in_type) t
     WHERE f.report_date = d
       AND (f.total, f.successful, f.failed) IS DISTINCT FROM (t.total, t.successful, t.failed)
    UNION ALL
    SELECT 'the error codes do not add up to the ' || f.sign_in_type || ' failures'
      FROM report_figures f
     CROSS JOIN LATERAL (
           SELECT coalesce(sum(e.failed), 0) AS failed, count(*) AS codes
             FROM report_error_code_figures e
            WHERE e.report_date = f.report_date AND e.sign_in_type = f.sign_in_type) t
     WHERE f.report_date = d
       AND (f.failed, f.error_code_count) IS DISTINCT FROM (t.failed, t.codes)
    UNION ALL
    SELECT 'an application''s four sign-in types do not add up to its All types row'
      FROM report_application_figures a
     WHERE a.report_date = d
     GROUP BY a.app_id
    HAVING (coalesce(sum(a.total) FILTER (WHERE a.sign_in_type = 'all'), 0),
            coalesce(sum(a.successful) FILTER (WHERE a.sign_in_type = 'all'), 0),
            coalesce(sum(a.failed) FILTER (WHERE a.sign_in_type = 'all'), 0))
           IS DISTINCT FROM
           (coalesce(sum(a.total) FILTER (WHERE a.sign_in_type <> 'all'), 0),
            coalesce(sum(a.successful) FILTER (WHERE a.sign_in_type <> 'all'), 0),
            coalesce(sum(a.failed) FILTER (WHERE a.sign_in_type <> 'all'), 0))
    UNION ALL
    SELECT 'an application is named differently in its sign-in types than in All types'
      FROM report_application_figures a
     WHERE a.report_date = d
     GROUP BY a.app_id
    HAVING count(DISTINCT a.app_display_name) > 1
    UNION ALL
    SELECT 'an error code''s four sign-in types do not add up to its All types row'
      FROM report_error_code_figures e
     WHERE e.report_date = d
     GROUP BY e.error_code
    HAVING coalesce(sum(e.failed) FILTER (WHERE e.sign_in_type = 'all'), 0)
           <> coalesce(sum(e.failed) FILTER (WHERE e.sign_in_type <> 'all'), 0)
  ) p
  LIMIT 1;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'the figures of report % do not reconcile: %', d, problem USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER report_figures_reconcile AFTER INSERT OR DELETE ON report_figures
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION report_figures_reconcile();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER report_application_figures_reconcile AFTER INSERT OR DELETE ON report_application_figures
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION report_figures_reconcile();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER report_error_code_figures_reconcile AFTER INSERT OR DELETE ON report_error_code_figures
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION report_figures_reconcile();
--> statement-breakpoint
-- The publish transaction marks each report it inserts, and figures are accepted only for a report so marked: a
-- report published without figures, as before ST-3, keeps none, and no later transaction can add them.
CREATE FUNCTION report_mark_published() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM set_config('sr_report.published_' || to_char(NEW.report_date, 'YYYYMMDD'), 'on', true);
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER report_mark_published AFTER INSERT ON report
  FOR EACH ROW EXECUTE FUNCTION report_mark_published();
--> statement-breakpoint
CREATE FUNCTION report_figures_with_publish() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- A report that does not exist is left to the foreign key.
  IF EXISTS (SELECT 1 FROM report r WHERE r.report_date = NEW.report_date)
     AND current_setting('sr_report.published_' || to_char(NEW.report_date, 'YYYYMMDD'), true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'the figures of report % can only be written in the transaction that publishes it', NEW.report_date
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER report_figures_with_publish BEFORE INSERT ON report_figures
  FOR EACH ROW EXECUTE FUNCTION report_figures_with_publish();
--> statement-breakpoint
-- Stored figures are as immutable as the report they belong to (report_reject_change, migration 0003).
CREATE TRIGGER report_figures_no_update BEFORE UPDATE ON report_figures
  FOR EACH ROW EXECUTE FUNCTION report_reject_change();
--> statement-breakpoint
CREATE TRIGGER report_figures_no_truncate BEFORE TRUNCATE ON report_figures
  FOR EACH STATEMENT EXECUTE FUNCTION report_reject_change();
--> statement-breakpoint
CREATE TRIGGER report_application_figures_no_update BEFORE UPDATE ON report_application_figures
  FOR EACH ROW EXECUTE FUNCTION report_reject_change();
--> statement-breakpoint
CREATE TRIGGER report_application_figures_no_truncate BEFORE TRUNCATE ON report_application_figures
  FOR EACH STATEMENT EXECUTE FUNCTION report_reject_change();
--> statement-breakpoint
CREATE TRIGGER report_error_code_figures_no_update BEFORE UPDATE ON report_error_code_figures
  FOR EACH ROW EXECUTE FUNCTION report_reject_change();
--> statement-breakpoint
CREATE TRIGGER report_error_code_figures_no_truncate BEFORE TRUNCATE ON report_error_code_figures
  FOR EACH STATEMENT EXECUTE FUNCTION report_reject_change();
--> statement-breakpoint
REVOKE ALL ON report_figures, report_application_figures, report_error_code_figures FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION report_figures_reconcile(), report_mark_published(), report_figures_with_publish() FROM PUBLIC;
--> statement-breakpoint
-- The report worker writes the figures once, in the publish transaction, and can never change them.
GRANT SELECT, INSERT ON report_figures, report_application_figures, report_error_code_figures TO sr_report_worker;
--> statement-breakpoint
-- The BFF serves the figures as they were published; it writes none of them.
GRANT SELECT ON report_figures, report_application_figures, report_error_code_figures TO sr_api;
