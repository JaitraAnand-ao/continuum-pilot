CREATE TABLE "audit_events" (
	"position" bigint PRIMARY KEY NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"event_type" text NOT NULL,
	"subject" text,
	"username" text,
	"trace_id" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" "bytea" NOT NULL,
	"hash" "bytea" NOT NULL,
	CONSTRAINT "audit_events_type_known" CHECK ("audit_events"."event_type" in ('sign_in', 'sign_in_failed', 'access_denied', 'sign_out', 'session_expired')),
	CONSTRAINT "audit_events_trace_id_w3c" CHECK ("audit_events"."trace_id" ~ '^[0-9a-f]{32}$')
);
--> statement-breakpoint
CREATE TABLE "login_transactions" (
	"id_hash" "bytea" PRIMARY KEY NOT NULL,
	"state_hash" "bytea" NOT NULL,
	"nonce_hash" "bytea" NOT NULL,
	"code_verifier_ciphertext" "bytea" NOT NULL,
	"code_verifier_iv" "bytea" NOT NULL,
	"code_verifier_tag" "bytea" NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "login_transactions_hashes_sha256" CHECK (octet_length("login_transactions"."id_hash") = 32 and octet_length("login_transactions"."state_hash") = 32 and octet_length("login_transactions"."nonce_hash") = 32),
	CONSTRAINT "login_transactions_verifier_gcm" CHECK (octet_length("login_transactions"."code_verifier_iv") = 12 and octet_length("login_transactions"."code_verifier_tag") = 16)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" "bytea" PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"username" text NOT NULL,
	"roles" text[] NOT NULL,
	"refresh_token_ciphertext" "bytea" NOT NULL,
	"refresh_token_iv" "bytea" NOT NULL,
	"refresh_token_tag" "bytea" NOT NULL,
	"idp_session_id" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"last_seen_at" timestamp (3) with time zone NOT NULL,
	"absolute_expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "sessions_id_hash_sha256" CHECK (octet_length("sessions"."id_hash") = 32),
	CONSTRAINT "sessions_refresh_token_gcm" CHECK (octet_length("sessions"."refresh_token_iv") = 12 and octet_length("sessions"."refresh_token_tag") = 16),
	CONSTRAINT "sessions_roles_known" CHECK ("sessions"."roles" <@ array['reader', 'admin']::text[]),
	CONSTRAINT "sessions_absolute_8h" CHECK ("sessions"."absolute_expires_at" <= "sessions"."created_at" + interval '8 hours'),
	CONSTRAINT "sessions_last_seen_after_created" CHECK ("sessions"."last_seen_at" >= "sessions"."created_at")
);
--> statement-breakpoint
CREATE INDEX "audit_events_subject_idx" ON "audit_events" USING btree ("subject");--> statement-breakpoint
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "login_transactions_expires_at_idx" ON "login_transactions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_last_seen_at_idx" ON "sessions" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "sessions_absolute_expires_at_idx" ON "sessions" USING btree ("absolute_expires_at");