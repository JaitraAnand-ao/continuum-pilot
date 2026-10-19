-- The report tables as the worker expects them from packages/db (CMP-5); loaded into a
-- throwaway schema per test run. Published rows reject UPDATE and DELETE, so any write
-- the store makes other than INSERT fails these tests.
CREATE TABLE report (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date date NOT NULL UNIQUE,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  complete boolean NOT NULL,
  missing_sources text[] NOT NULL,
  total_count integer NOT NULL,
  successful_count integer NOT NULL,
  failed_count integer NOT NULL,
  content_hash text NOT NULL,
  published_at timestamptz NOT NULL,
  CHECK (window_end = window_start + interval '1 day'),
  CHECK (total_count = successful_count + failed_count)
);

CREATE TABLE report_sign_in (
  report_id uuid NOT NULL REFERENCES report (id),
  sign_in_id text NOT NULL,
  sign_in_type text NOT NULL,
  created_at timestamptz NOT NULL,
  error_code integer NOT NULL,
  record jsonb NOT NULL,
  PRIMARY KEY (report_id, sign_in_id)
);

CREATE TABLE report_risk_detection (
  report_id uuid NOT NULL REFERENCES report (id),
  detection_id text NOT NULL,
  detected_at timestamptz NOT NULL,
  record jsonb NOT NULL,
  PRIMARY KEY (report_id, detection_id)
);

CREATE TABLE report_not_generated (
  report_date date PRIMARY KEY,
  missing_sources text[] NOT NULL,
  recorded_at timestamptz NOT NULL
);

CREATE FUNCTION reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'published report rows are immutable';
END
$$;

CREATE TRIGGER report_immutable BEFORE UPDATE OR DELETE ON report
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER report_sign_in_immutable BEFORE UPDATE OR DELETE ON report_sign_in
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER report_risk_detection_immutable BEFORE UPDATE OR DELETE ON report_risk_detection
  FOR EACH ROW EXECUTE FUNCTION reject_change();
