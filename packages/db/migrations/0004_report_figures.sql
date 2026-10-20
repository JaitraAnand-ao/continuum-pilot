CREATE TABLE "report_application_figures" (
	"report_date" date NOT NULL,
	"sign_in_type" text NOT NULL,
	"app_id" text NOT NULL,
	"app_display_name" text NOT NULL,
	"total" integer NOT NULL,
	"successful" integer NOT NULL,
	"failed" integer NOT NULL,
	CONSTRAINT "report_application_figures_report_date_sign_in_type_app_id_pk" PRIMARY KEY("report_date","sign_in_type","app_id"),
	CONSTRAINT "report_application_figures_counts_non_negative" CHECK ("report_application_figures"."successful" >= 0 AND "report_application_figures"."failed" >= 0),
	CONSTRAINT "report_application_figures_total_is_successful_plus_failed" CHECK ("report_application_figures"."total" = "report_application_figures"."successful" + "report_application_figures"."failed"),
	CONSTRAINT "report_application_figures_has_sign_ins" CHECK ("report_application_figures"."total" > 0)
);
--> statement-breakpoint
CREATE TABLE "report_error_code_figures" (
	"report_date" date NOT NULL,
	"sign_in_type" text NOT NULL,
	"error_code" integer NOT NULL,
	"failed" integer NOT NULL,
	CONSTRAINT "report_error_code_figures_report_date_sign_in_type_error_code_pk" PRIMARY KEY("report_date","sign_in_type","error_code"),
	CONSTRAINT "report_error_code_figures_code_is_failure" CHECK ("report_error_code_figures"."error_code" <> 0),
	CONSTRAINT "report_error_code_figures_has_failures" CHECK ("report_error_code_figures"."failed" > 0)
);
--> statement-breakpoint
CREATE TABLE "report_figures" (
	"report_date" date NOT NULL,
	"sign_in_type" text NOT NULL,
	"total" integer NOT NULL,
	"successful" integer NOT NULL,
	"failed" integer NOT NULL,
	"error_code_count" integer NOT NULL,
	CONSTRAINT "report_figures_report_date_sign_in_type_pk" PRIMARY KEY("report_date","sign_in_type"),
	CONSTRAINT "report_figures_sign_in_type_known" CHECK ("report_figures"."sign_in_type" IN ('all', 'interactiveUser', 'nonInteractiveUser', 'servicePrincipal', 'managedIdentity')),
	CONSTRAINT "report_figures_counts_non_negative" CHECK ("report_figures"."successful" >= 0 AND "report_figures"."failed" >= 0),
	CONSTRAINT "report_figures_total_is_successful_plus_failed" CHECK ("report_figures"."total" = "report_figures"."successful" + "report_figures"."failed"),
	CONSTRAINT "report_figures_error_codes_within_failed" CHECK ("report_figures"."error_code_count" <= "report_figures"."failed" AND ("report_figures"."failed" = 0) = ("report_figures"."error_code_count" = 0))
);
--> statement-breakpoint
ALTER TABLE "report_application_figures" ADD CONSTRAINT "report_application_figures_scope_fk" FOREIGN KEY ("report_date","sign_in_type") REFERENCES "public"."report_figures"("report_date","sign_in_type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_error_code_figures" ADD CONSTRAINT "report_error_code_figures_scope_fk" FOREIGN KEY ("report_date","sign_in_type") REFERENCES "public"."report_figures"("report_date","sign_in_type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_figures" ADD CONSTRAINT "report_figures_report_date_report_report_date_fk" FOREIGN KEY ("report_date") REFERENCES "public"."report"("report_date") ON DELETE cascade ON UPDATE no action;