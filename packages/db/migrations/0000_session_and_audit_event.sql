CREATE TABLE "audit_event" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"event_type" text NOT NULL,
	"actor_oid" uuid,
	"trace_id" text NOT NULL,
	"reason" text,
	"prev_hash" "bytea" NOT NULL,
	"hash" "bytea" NOT NULL,
	CONSTRAINT "audit_event_hash_unique" UNIQUE("hash"),
	CONSTRAINT "audit_event_type_known" CHECK ("audit_event"."event_type" IN ('access_denied', 'sign_in', 'sign_in_failed', 'sign_out', 'session_expired')),
	CONSTRAINT "audit_event_trace_id_w3c" CHECK ("audit_event"."trace_id" ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "audit_event_reason_code" CHECK ("audit_event"."reason" ~ '^[A-Za-z0-9_.-]{1,64}$'),
	CONSTRAINT "audit_event_hashes_sha256" CHECK (octet_length("audit_event"."prev_hash") = 32 AND octet_length("audit_event"."hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id_hash" "bytea" PRIMARY KEY NOT NULL,
	"subject_oid" uuid NOT NULL,
	"account_name" text NOT NULL,
	"roles" text[] NOT NULL,
	"refresh_token_ciphertext" "bytea" NOT NULL,
	"refresh_token_iv" "bytea" NOT NULL,
	"refresh_token_tag" "bytea" NOT NULL,
	"idp_session_id" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"last_seen_at" timestamp (3) with time zone NOT NULL,
	"idle_expires_at" timestamp (3) with time zone NOT NULL,
	"absolute_expires_at" timestamp (3) with time zone NOT NULL,
	"ended_at" timestamp (3) with time zone,
	"end_reason" text,
	CONSTRAINT "session_id_hash_sha256" CHECK (octet_length("session"."id_hash") = 32),
	CONSTRAINT "session_refresh_token_iv_96_bits" CHECK (octet_length("session"."refresh_token_iv") = 12),
	CONSTRAINT "session_refresh_token_tag_128_bits" CHECK (octet_length("session"."refresh_token_tag") = 16),
	CONSTRAINT "session_refresh_token_ciphertext_present" CHECK (octet_length("session"."refresh_token_ciphertext") > 0),
	CONSTRAINT "session_roles_known" CHECK ("session"."roles" <@ ARRAY['reader', 'report_admin']::text[]),
	CONSTRAINT "session_absolute_at_most_8_hours" CHECK ("session"."absolute_expires_at" <= "session"."created_at" + interval '8 hours'),
	CONSTRAINT "session_last_seen_after_created" CHECK ("session"."last_seen_at" >= "session"."created_at"),
	CONSTRAINT "session_idle_at_most_15_minutes" CHECK ("session"."idle_expires_at" <= least("session"."absolute_expires_at", "session"."last_seen_at" + interval '15 minutes')),
	CONSTRAINT "session_end_reason_known" CHECK (("session"."ended_at" IS NULL AND "session"."end_reason" IS NULL) OR ("session"."ended_at" IS NOT NULL AND "session"."end_reason" IN ('logout', 'idle', 'absolute', 'rotated')))
);
--> statement-breakpoint
CREATE INDEX "audit_event_actor_oid_idx" ON "audit_event" USING btree ("actor_oid");--> statement-breakpoint
CREATE INDEX "audit_event_occurred_at_idx" ON "audit_event" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "session_subject_oid_idx" ON "session" USING btree ("subject_oid");--> statement-breakpoint
CREATE INDEX "session_absolute_expires_at_idx" ON "session" USING btree ("absolute_expires_at");