CREATE TABLE "report_risky_sign_in_flag" (
	"report_date" date NOT NULL,
	"request_id" text NOT NULL,
	"trigger_level" text NOT NULL,
	"observed_risk_level" text NOT NULL,
	"signed_in_at" timestamp (3) with time zone NOT NULL,
	"user_id" text,
	"user_principal_name" text,
	"app_id" text,
	"app_display_name" text,
	"ip_address" "inet",
	"location" text,
	"device_compliant" boolean,
	"conditional_access_status" text,
	CONSTRAINT "report_risky_sign_in_flag_report_date_request_id_pk" PRIMARY KEY("report_date","request_id"),
	CONSTRAINT "report_risky_sign_in_flag_request_id_present" CHECK ("report_risky_sign_in_flag"."request_id" ~ '[^[:space:]]'),
	CONSTRAINT "report_risky_sign_in_flag_observed_meets_trigger" CHECK ((CASE "report_risky_sign_in_flag"."observed_risk_level" WHEN 'medium' THEN 2 WHEN 'high' THEN 3 END) IS NOT NULL AND (CASE "report_risky_sign_in_flag"."trigger_level" WHEN 'medium' THEN 2 WHEN 'high' THEN 3 END) IS NOT NULL AND (CASE "report_risky_sign_in_flag"."observed_risk_level" WHEN 'medium' THEN 2 WHEN 'high' THEN 3 END) >= (CASE "report_risky_sign_in_flag"."trigger_level" WHEN 'medium' THEN 2 WHEN 'high' THEN 3 END)),
	CONSTRAINT "report_risky_sign_in_flag_signed_in_within_day" CHECK ("report_risky_sign_in_flag"."signed_in_at" >= ("report_risky_sign_in_flag"."report_date"::timestamp AT TIME ZONE 'UTC') AND "report_risky_sign_in_flag"."signed_in_at" < (("report_risky_sign_in_flag"."report_date" + 1)::timestamp AT TIME ZONE 'UTC')),
	CONSTRAINT "report_risky_sign_in_flag_blank_is_not_recorded" CHECK ("report_risky_sign_in_flag"."user_id" ~ '[^[:space:]]' AND "report_risky_sign_in_flag"."user_principal_name" ~ '[^[:space:]]' AND "report_risky_sign_in_flag"."app_id" ~ '[^[:space:]]' AND "report_risky_sign_in_flag"."app_display_name" ~ '[^[:space:]]' AND "report_risky_sign_in_flag"."location" ~ '[^[:space:]]'),
	CONSTRAINT "report_risky_sign_in_flag_conditional_access_known" CHECK ("report_risky_sign_in_flag"."conditional_access_status" IN ('success', 'failure', 'notApplied', 'unknownFutureValue'))
);
--> statement-breakpoint
CREATE TABLE "report_risky_user_flag" (
	"report_date" date NOT NULL,
	"user_id" text NOT NULL,
	"user_principal_name" text,
	"user_display_name" text,
	"trigger_level" text NOT NULL,
	"risk_state" text NOT NULL,
	"risk_level" text NOT NULL,
	"detections" jsonb NOT NULL,
	"sign_in_ids" text[] NOT NULL,
	CONSTRAINT "report_risky_user_flag_report_date_user_id_pk" PRIMARY KEY("report_date","user_id"),
	CONSTRAINT "report_risky_user_flag_user_id_present" CHECK ("report_risky_user_flag"."user_id" ~ '[^[:space:]]'),
	CONSTRAINT "report_risky_user_flag_state_flagged" CHECK ("report_risky_user_flag"."risk_state" IN ('atRisk', 'confirmedCompromised')),
	CONSTRAINT "report_risky_user_flag_level_meets_trigger" CHECK ((CASE "report_risky_user_flag"."risk_level" WHEN 'medium' THEN 2 WHEN 'high' THEN 3 END) IS NOT NULL AND (CASE "report_risky_user_flag"."trigger_level" WHEN 'medium' THEN 2 WHEN 'high' THEN 3 END) IS NOT NULL AND (CASE "report_risky_user_flag"."risk_level" WHEN 'medium' THEN 2 WHEN 'high' THEN 3 END) >= (CASE "report_risky_user_flag"."trigger_level" WHEN 'medium' THEN 2 WHEN 'high' THEN 3 END)),
	CONSTRAINT "report_risky_user_flag_detections_complete" CHECK (jsonb_typeof("report_risky_user_flag"."detections") = 'array' AND NOT jsonb_path_exists("report_risky_user_flag"."detections", 'strict $[*] ? (@.type() != "object")') AND NOT jsonb_path_exists("report_risky_user_flag"."detections", '$[*] ? (!(@.id.type() == "string" && @.riskEventType.type() == "string" && @.detectedDateTime.type() == "string" && @.id like_regex "\\S" && @.riskEventType like_regex "\\S" && (@.riskLevel == "none" || @.riskLevel == "low" || @.riskLevel == "medium" || @.riskLevel == "high" || @.riskLevel == "hidden" || @.riskLevel == "unknownFutureValue") && @.detectedDateTime like_regex "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}"))')),
	CONSTRAINT "report_risky_user_flag_sign_in_ids_present" CHECK (NOT jsonb_path_exists(to_jsonb("report_risky_user_flag"."sign_in_ids"), '$[*] ? (@ == null || !(@ like_regex "\\S"))')),
	CONSTRAINT "report_risky_user_flag_blank_is_not_recorded" CHECK ("report_risky_user_flag"."user_principal_name" ~ '[^[:space:]]' AND "report_risky_user_flag"."user_display_name" ~ '[^[:space:]]')
);
--> statement-breakpoint
ALTER TABLE "report_not_generated" DROP CONSTRAINT "report_not_generated_missing_sources_known";--> statement-breakpoint
ALTER TABLE "report" DROP CONSTRAINT "report_missing_sources_known";--> statement-breakpoint
ALTER TABLE "report" ADD COLUMN "risky_sign_ins" integer;--> statement-breakpoint
ALTER TABLE "report" ADD COLUMN "risky_users" integer;--> statement-breakpoint
ALTER TABLE "report_risky_sign_in_flag" ADD CONSTRAINT "report_risky_sign_in_flag_report_date_report_report_date_fk" FOREIGN KEY ("report_date") REFERENCES "public"."report"("report_date") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_risky_user_flag" ADD CONSTRAINT "report_risky_user_flag_report_date_report_report_date_fk" FOREIGN KEY ("report_date") REFERENCES "public"."report"("report_date") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_risky_user_flag_user_id_idx" ON "report_risky_user_flag" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "report_not_generated" ADD CONSTRAINT "report_not_generated_missing_sources_known" CHECK ("report_not_generated"."missing_sources" <@ ARRAY['signIns.interactiveUser', 'signIns.nonInteractiveUser', 'signIns.servicePrincipal', 'signIns.managedIdentity', 'identityProtection.riskDetections', 'identityProtection.riskyUsers']::text[]);--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_risky_counts_evaluated_together" CHECK (("report"."risky_sign_ins" IS NULL) = ("report"."risky_users" IS NULL));--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_risky_counts_non_negative" CHECK ("report"."risky_sign_ins" >= 0 AND "report"."risky_users" >= 0);--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_risky_not_evaluated_without_identity_protection" CHECK (NOT ("report"."missing_sources" && ARRAY['identityProtection.riskDetections', 'identityProtection.riskyUsers']::text[]) OR ("report"."risky_sign_ins" IS NULL AND "report"."risky_users" IS NULL));--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_risky_snapshot_holds_risk_data" CHECK ("report"."risky_sign_ins" IS NULL OR COALESCE(jsonb_typeof("report"."snapshot" -> 'riskDetections') = 'array' AND jsonb_typeof("report"."snapshot" -> 'riskyUsers') = 'array', false));--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_missing_sources_known" CHECK ("report"."missing_sources" <@ ARRAY['signIns.interactiveUser', 'signIns.nonInteractiveUser', 'signIns.servicePrincipal', 'signIns.managedIdentity', 'identityProtection.riskDetections', 'identityProtection.riskyUsers']::text[]);