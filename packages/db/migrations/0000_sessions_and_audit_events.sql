CREATE TABLE "audit_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"event_type" text NOT NULL,
	"actor_oid" uuid,
	"actor_name" text,
	"target" text,
	"trace_id" text NOT NULL,
	"prev_hash" "bytea",
	"hash" "bytea" NOT NULL,
	CONSTRAINT "audit_events_event_type_known" CHECK ("audit_events"."event_type" IN ('access_denied')),
	CONSTRAINT "audit_events_trace_id_w3c" CHECK ("audit_events"."trace_id" ~ '^[0-9a-f]{32}$')
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" "bytea" PRIMARY KEY NOT NULL,
	"subject_oid" uuid NOT NULL,
	"account_name" text NOT NULL,
	"roles" text[] NOT NULL,
	"refresh_token_ciphertext" "bytea" NOT NULL,
	"refresh_token_iv" "bytea" NOT NULL,
	"refresh_token_tag" "bytea" NOT NULL,
	"refresh_token_key_id" text NOT NULL,
	"idp_session_id" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"last_seen_at" timestamp (3) with time zone NOT NULL,
	"idle_expires_at" timestamp (3) with time zone NOT NULL,
	"absolute_expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "sessions_id_hash_sha256" CHECK (octet_length("sessions"."id_hash") = 32),
	CONSTRAINT "sessions_refresh_token_iv_96_bit" CHECK (octet_length("sessions"."refresh_token_iv") = 12),
	CONSTRAINT "sessions_refresh_token_tag_128_bit" CHECK (octet_length("sessions"."refresh_token_tag") = 16),
	CONSTRAINT "sessions_refresh_token_present" CHECK (octet_length("sessions"."refresh_token_ciphertext") > 0),
	CONSTRAINT "sessions_idle_within_absolute" CHECK ("sessions"."idle_expires_at" <= "sessions"."absolute_expires_at"),
	CONSTRAINT "sessions_absolute_after_created" CHECK ("sessions"."absolute_expires_at" > "sessions"."created_at")
);
--> statement-breakpoint
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_actor_oid_idx" ON "audit_events" USING btree ("actor_oid");--> statement-breakpoint
CREATE INDEX "sessions_idle_expires_at_idx" ON "sessions" USING btree ("idle_expires_at");--> statement-breakpoint
CREATE INDEX "sessions_absolute_expires_at_idx" ON "sessions" USING btree ("absolute_expires_at");