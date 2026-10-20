CREATE TABLE "email_recipient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"entra_object_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"address" text NOT NULL,
	"member_count" integer,
	"status" text NOT NULL,
	"added_by_oid" uuid NOT NULL,
	"added_by_name" text NOT NULL,
	"proposed_at" timestamp (3) with time zone NOT NULL,
	"approved_by_oid" uuid,
	"approved_by_name" text,
	"approved_at" timestamp (3) with time zone,
	CONSTRAINT "email_recipient_kind_known" CHECK ("email_recipient"."kind" IN ('person', 'group')),
	CONSTRAINT "email_recipient_status_known" CHECK ("email_recipient"."status" IN ('pending_approval', 'active')),
	CONSTRAINT "email_recipient_member_count_matches_kind" CHECK (CASE "email_recipient"."kind" WHEN 'group' THEN coalesce("email_recipient"."member_count" >= 1, false) ELSE "email_recipient"."member_count" IS NULL END),
	CONSTRAINT "email_recipient_address_shape" CHECK ("email_recipient"."address" ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
	CONSTRAINT "email_recipient_status_matches_approval" CHECK (CASE "email_recipient"."status" WHEN 'active' THEN "email_recipient"."approved_by_oid" IS NOT NULL AND "email_recipient"."approved_by_name" IS NOT NULL AND "email_recipient"."approved_at" IS NOT NULL ELSE "email_recipient"."approved_by_oid" IS NULL AND "email_recipient"."approved_by_name" IS NULL AND "email_recipient"."approved_at" IS NULL END),
	CONSTRAINT "email_recipient_approver_is_not_proposer" CHECK ("email_recipient"."approved_by_oid" <> "email_recipient"."added_by_oid"),
	CONSTRAINT "email_recipient_approval_after_proposal" CHECK ("email_recipient"."approved_at" >= "email_recipient"."proposed_at")
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_event_type_known";--> statement-breakpoint
CREATE UNIQUE INDEX "email_recipient_entra_object_id_key" ON "email_recipient" USING btree ("entra_object_id");--> statement-breakpoint
CREATE INDEX "email_recipient_status_idx" ON "email_recipient" USING btree ("status");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_event_type_known" CHECK ("audit_events"."event_type" IN ('access_denied', 'recipient.check_passed', 'recipient.check_rejected', 'recipient.check_failed', 'recipient.proposed', 'recipient.removed'));