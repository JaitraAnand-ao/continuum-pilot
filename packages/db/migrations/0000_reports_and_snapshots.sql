CREATE TYPE "public"."report_status" AS ENUM('complete', 'incomplete', 'not_generated');--> statement-breakpoint
CREATE TYPE "public"."sign_in_type" AS ENUM('interactiveUser', 'nonInteractiveUser', 'servicePrincipal', 'managedIdentity');--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_date" date NOT NULL,
	"window_start" timestamp (3) with time zone NOT NULL,
	"window_end" timestamp (3) with time zone NOT NULL,
	"status" "report_status" NOT NULL,
	"missing_sources" text[] DEFAULT '{}'::text[] NOT NULL,
	"total_count" integer NOT NULL,
	"successful_count" integer NOT NULL,
	"failed_count" integer NOT NULL,
	"content_hash" char(64),
	"config_version_id" uuid NOT NULL,
	"published_at" timestamp (3) with time zone,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "reports_window_is_the_utc_day" CHECK ("reports"."window_start" = ("reports"."report_date"::timestamp AT TIME ZONE 'UTC') AND "reports"."window_end" = "reports"."window_start" + interval '1 day'),
	CONSTRAINT "reports_counts_reconcile" CHECK ("reports"."successful_count" >= 0 AND "reports"."failed_count" >= 0 AND "reports"."total_count" = "reports"."successful_count" + "reports"."failed_count"),
	CONSTRAINT "reports_content_hash_is_sha256" CHECK ("reports"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "reports_status_matches_contents" CHECK (("reports"."status" = 'complete' AND cardinality("reports"."missing_sources") = 0 AND "reports"."content_hash" IS NOT NULL AND "reports"."published_at" IS NOT NULL)
       OR ("reports"."status" = 'incomplete' AND cardinality("reports"."missing_sources") > 0 AND "reports"."content_hash" IS NOT NULL AND "reports"."published_at" IS NOT NULL)
       OR ("reports"."status" = 'not_generated' AND cardinality("reports"."missing_sources") > 0 AND "reports"."content_hash" IS NULL AND "reports"."published_at" IS NULL AND "reports"."total_count" = 0))
);
--> statement-breakpoint
CREATE TABLE "signin_snapshots" (
	"report_id" uuid NOT NULL,
	"sign_in_id" text NOT NULL,
	"sign_in_type" "sign_in_type" NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"error_code" integer NOT NULL,
	"applied_conditional_access_policies" jsonb NOT NULL,
	"device_detail" jsonb NOT NULL,
	"record" jsonb NOT NULL,
	CONSTRAINT "signin_snapshots_pkey" PRIMARY KEY("report_id","sign_in_id"),
	CONSTRAINT "signin_snapshots_evidence_shape" CHECK (jsonb_typeof("signin_snapshots"."applied_conditional_access_policies") = 'array' AND jsonb_typeof("signin_snapshots"."device_detail") = 'object' AND jsonb_typeof("signin_snapshots"."record") = 'object')
);
--> statement-breakpoint
ALTER TABLE "signin_snapshots" ADD CONSTRAINT "signin_snapshots_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reports_report_date_key" ON "reports" USING btree ("report_date");--> statement-breakpoint
CREATE INDEX "signin_snapshots_report_id_sign_in_type_idx" ON "signin_snapshots" USING btree ("report_id","sign_in_type");