CREATE TABLE "report" (
	"report_date" date PRIMARY KEY NOT NULL,
	"window_start" timestamp(3) with time zone NOT NULL,
	"window_end" timestamp(3) with time zone NOT NULL,
	"status" text NOT NULL,
	"missing_sources" text[] NOT NULL,
	"total" integer NOT NULL,
	"successful" integer NOT NULL,
	"failed" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"published_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "report_window_is_the_utc_day" CHECK ("report"."window_start" = ("report"."report_date"::timestamp AT TIME ZONE 'UTC') AND "report"."window_end" = "report"."window_start" + interval '1 day'),
	CONSTRAINT "report_status_known" CHECK ("report"."status" IN ('complete', 'incomplete')),
	CONSTRAINT "report_missing_sources_known" CHECK ("report"."missing_sources" <@ ARRAY['signIns.interactiveUser', 'signIns.nonInteractiveUser', 'signIns.servicePrincipal', 'signIns.managedIdentity', 'identityProtection.riskDetections']::text[]),
	CONSTRAINT "report_complete_iff_nothing_missing" CHECK (("report"."status" = 'complete') = (cardinality("report"."missing_sources") = 0)),
	CONSTRAINT "report_totals_add_up" CHECK ("report"."successful" >= 0 AND "report"."failed" >= 0 AND "report"."total" = "report"."successful" + "report"."failed"),
	CONSTRAINT "report_snapshot_shape" CHECK (coalesce(jsonb_typeof("report"."snapshot" -> 'signIns') = 'array' AND jsonb_typeof("report"."snapshot" -> 'riskDetections') = 'array', false)),
	CONSTRAINT "report_content_hash_sha256_hex" CHECK ("report"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "report_published_after_window" CHECK ("report"."published_at" >= "report"."window_end")
);
--> statement-breakpoint
CREATE TABLE "report_not_generated" (
	"report_date" date PRIMARY KEY NOT NULL,
	"missing_sources" text[] NOT NULL,
	"recorded_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "report_not_generated_missing_sources_known" CHECK (cardinality("report_not_generated"."missing_sources") > 0 AND "report_not_generated"."missing_sources" <@ ARRAY['signIns.interactiveUser', 'signIns.nonInteractiveUser', 'signIns.servicePrincipal', 'signIns.managedIdentity', 'identityProtection.riskDetections']::text[]),
	CONSTRAINT "report_not_generated_after_day" CHECK ("report_not_generated"."recorded_at" >= (("report_not_generated"."report_date" + 1)::timestamp AT TIME ZONE 'UTC'))
);
