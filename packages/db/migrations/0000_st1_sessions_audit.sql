CREATE TABLE "audit_events" (
	"id" bigint PRIMARY KEY DEFAULT 0 NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"event_type" text NOT NULL,
	"subject" text,
	"reason" text,
	"trace_id" text NOT NULL,
	"prev_hash" "bytea",
	"hash" "bytea" DEFAULT '\x'::bytea NOT NULL,
	CONSTRAINT "audit_events_event_type_known" CHECK ("audit_events"."event_type" IN ('sign_in', 'sign_in_failed', 'access_denied', 'sign_out', 'session_expired')),
	CONSTRAINT "audit_events_reason_is_code" CHECK ("audit_events"."reason" ~ '^[A-Za-z0-9_.:-]{1,64}$'),
	CONSTRAINT "audit_events_trace_id_w3c" CHECK ("audit_events"."trace_id" ~ '^[0-9a-f]{32}$' AND "audit_events"."trace_id" <> repeat('0', 32))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" "bytea" PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"account_name" text NOT NULL,
	"roles" text[] NOT NULL,
	"refresh_token_ciphertext" "bytea" NOT NULL,
	"idp_session_id" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"last_seen_at" timestamp (3) with time zone NOT NULL,
	"idle_expires_at" timestamp (3) with time zone NOT NULL,
	"absolute_expires_at" timestamp (3) with time zone NOT NULL,
	"ended_at" timestamp (3) with time zone,
	CONSTRAINT "sessions_id_hash_is_sha256" CHECK (octet_length("sessions"."id_hash") = 32),
	CONSTRAINT "sessions_refresh_token_is_gcm" CHECK (octet_length("sessions"."refresh_token_ciphertext") > 28),
	CONSTRAINT "sessions_roles_known" CHECK ("sessions"."roles" <@ ARRAY['reader', 'report_admin']::text[]),
	CONSTRAINT "sessions_last_seen_after_created" CHECK ("sessions"."last_seen_at" >= "sessions"."created_at"),
	CONSTRAINT "sessions_absolute_at_most_8h" CHECK ("sessions"."absolute_expires_at" <= "sessions"."created_at" + interval '8 hours'),
	CONSTRAINT "sessions_idle_at_most_15m" CHECK ("sessions"."idle_expires_at" <= "sessions"."last_seen_at" + interval '15 minutes'),
	CONSTRAINT "sessions_idle_within_absolute" CHECK ("sessions"."idle_expires_at" <= "sessions"."absolute_expires_at")
);
--> statement-breakpoint
CREATE INDEX "audit_events_subject_idx" ON "audit_events" USING btree ("subject");--> statement-breakpoint
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "sessions_absolute_expires_at_idx" ON "sessions" USING btree ("absolute_expires_at");--> statement-breakpoint
CREATE INDEX "sessions_idle_expires_at_idx" ON "sessions" USING btree ("idle_expires_at");