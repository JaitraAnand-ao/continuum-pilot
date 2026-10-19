-- ST-2: a report's figures reconcile to its snapshot, a published report never changes, and per-role grants (AD-10).

-- The figures and the window are checked against every stored sign-in when the report is published. Errors name
-- counts only, never a sign-in's content.
CREATE FUNCTION report_reconcile_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  stored integer;
  unique_ids integer;
  successful integer;
  malformed integer;
  outside integer;
BEGIN
  -- A snapshot without a sign-ins array is left to the report_snapshot_shape CHECK, which runs after this trigger.
  IF jsonb_typeof(NEW.snapshot -> 'signIns') IS DISTINCT FROM 'array' THEN
    RETURN NEW;
  END IF;

  SELECT count(*),
         count(DISTINCT s.id),
         count(*) FILTER (WHERE s.error_code = 0),
         count(*) FILTER (WHERE NOT s.well_formed),
         count(*) FILTER (WHERE s.well_formed AND NOT (s.at >= NEW.window_start AND s.at < NEW.window_end))
    INTO stored, unique_ids, successful, malformed, outside
    FROM (
      SELECT e ->> 'id' AS id,
             CASE WHEN f.well_formed THEN (e ->> 'errorCode')::numeric END AS error_code,
             CASE WHEN f.well_formed THEN (e ->> 'createdDateTime')::timestamptz END AS at,
             f.well_formed
        FROM jsonb_array_elements(NEW.snapshot -> 'signIns') AS e
       CROSS JOIN LATERAL (SELECT coalesce(
               jsonb_typeof(e -> 'id') = 'string'
           AND jsonb_typeof(e -> 'errorCode') = 'number'
           AND e ->> 'signInEventType' IN ('interactiveUser', 'nonInteractiveUser', 'servicePrincipal', 'managedIdentity')
           AND e ->> 'createdDateTime' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$'
           AND jsonb_typeof(e -> 'conditionalAccessPolicies') = 'array'
           AND jsonb_typeof(e -> 'deviceDetail') = 'object', false) AS well_formed) AS f
    ) AS s;

  IF malformed > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = 'report_snapshot_sign_ins_well_formed',
      MESSAGE = format('report %s: %s stored sign-in(s) lack an id, error code, known type, UTC time, CA results or device details', NEW.report_date, malformed);
  END IF;
  IF outside > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = 'report_snapshot_within_window',
      MESSAGE = format('report %s: %s stored sign-in(s) fall outside the window', NEW.report_date, outside);
  END IF;
  IF unique_ids <> stored THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = 'report_snapshot_sign_ins_unique',
      MESSAGE = format('report %s: %s stored sign-in(s) repeat an id', NEW.report_date, stored - unique_ids);
  END IF;
  IF NEW.total <> stored OR NEW.successful <> successful THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = 'report_figures_reconcile',
      MESSAGE = format('report %s: figures %s/%s do not reconcile to the %s/%s in the snapshot',
                       NEW.report_date, NEW.total, NEW.successful, stored, successful);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER report_reconcile_snapshot BEFORE INSERT ON report
  FOR EACH ROW EXECUTE FUNCTION report_reconcile_snapshot();
--> statement-breakpoint
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
-- A day with a published report is never also recorded as not generated.
CREATE FUNCTION report_not_generated_unpublished() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM report r WHERE r.report_date = NEW.report_date) THEN
    RAISE EXCEPTION 'report % is published; it cannot be recorded as not generated', NEW.report_date;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER report_not_generated_unpublished BEFORE INSERT OR UPDATE ON report_not_generated
  FOR EACH ROW EXECUTE FUNCTION report_not_generated_unpublished();
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
REVOKE ALL ON report, report_not_generated FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION report_reconcile_snapshot(), report_reject_change(), report_not_generated_unpublished() FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO sr_api, sr_report_worker, sr_mail_worker;
--> statement-breakpoint
-- The report worker publishes (INSERT ... ON CONFLICT DO NOTHING) and records not-generated days (upsert); it can
-- never change or remove a published report.
GRANT SELECT, INSERT ON report TO sr_report_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON report_not_generated TO sr_report_worker;
--> statement-breakpoint
-- The BFF serves stored reports and not-generated days as they are; it writes neither.
GRANT SELECT ON report, report_not_generated TO sr_api;
--> statement-breakpoint
-- The mailer sends counts only: it sees no snapshot evidence and no content hash.
GRANT SELECT (report_date, window_start, window_end, status, missing_sources, total, successful, failed, published_at)
  ON report TO sr_mail_worker;
