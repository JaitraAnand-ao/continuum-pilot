CREATE TABLE "audit_event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"event_type" text NOT NULL,
	"actor" text NOT NULL,
	"trace_id" text NOT NULL,
	"detail" jsonb,
	"prev_hash" "bytea" NOT NULL,
	"hash" "bytea" NOT NULL,
	CONSTRAINT "audit_event_prev_hash_unique" UNIQUE("prev_hash"),
	CONSTRAINT "audit_event_type_known" CHECK ("audit_event"."event_type" IN ('access_denied', 'sign_in', 'sign_in_failed', 'sign_out', 'session_expired')),
	CONSTRAINT "audit_event_actor_present" CHECK (length("audit_event"."actor") > 0),
	CONSTRAINT "audit_event_trace_id_w3c" CHECK ("audit_event"."trace_id" ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "audit_event_hash_is_sha256" CHECK (octet_length("audit_event"."prev_hash") = 32 AND octet_length("audit_event"."hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id_hash" "bytea" PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"account_name" text NOT NULL,
	"roles" text[] NOT NULL,
	"refresh_token_ciphertext" "bytea" NOT NULL,
	"refresh_token_iv" "bytea" NOT NULL,
	"refresh_token_tag" "bytea" NOT NULL,
	"keycloak_session_id" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"last_seen_at" timestamp (3) with time zone NOT NULL,
	"idle_expires_at" timestamp (3) with time zone NOT NULL,
	"absolute_expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "session_id_hash_is_sha256" CHECK (octet_length("session"."id_hash") = 32),
	CONSTRAINT "session_refresh_token_iv_is_96_bit" CHECK (octet_length("session"."refresh_token_iv") = 12),
	CONSTRAINT "session_refresh_token_tag_is_128_bit" CHECK (octet_length("session"."refresh_token_tag") = 16),
	CONSTRAINT "session_roles_known" CHECK ("session"."roles" <@ ARRAY['reader', 'report_admin']::text[]),
	CONSTRAINT "session_last_seen_in_lifetime" CHECK ("session"."last_seen_at" >= "session"."created_at"),
	CONSTRAINT "session_absolute_at_most_8h" CHECK ("session"."absolute_expires_at" > "session"."created_at" AND "session"."absolute_expires_at" <= "session"."created_at" + interval '8 hours'),
	CONSTRAINT "session_idle_at_most_15m" CHECK ("session"."idle_expires_at" > "session"."last_seen_at" AND "session"."idle_expires_at" <= "session"."last_seen_at" + interval '15 minutes' AND "session"."idle_expires_at" <= "session"."absolute_expires_at")
);
--> statement-breakpoint
CREATE INDEX "audit_event_occurred_at_idx" ON "audit_event" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "session_idle_expires_at_idx" ON "session" USING btree ("idle_expires_at");--> statement-breakpoint
CREATE INDEX "session_absolute_expires_at_idx" ON "session" USING btree ("absolute_expires_at");