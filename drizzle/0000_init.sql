CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"subject_external_id" text NOT NULL,
	"subject_name" text,
	"subject_handle" text,
	"credential_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"degraded_at" timestamp with time zone,
	"capture_started_at" timestamp with time zone,
	CONSTRAINT "channels_tenantId_platform_subjectExternalId_unique" UNIQUE("tenant_id","platform","subject_external_id"),
	CONSTRAINT "channels_tenantId_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "channel_status" CHECK ("channels"."status" IN ('active', 'degraded', 'disconnected'))
);
--> statement-breakpoint
CREATE TABLE "comment_states" (
	"comment_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"handling" text DEFAULT 'new' NOT NULL,
	"handled_at" timestamp with time zone,
	"handled_by" text,
	"note" text,
	"ingest_seq" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "state_handling" CHECK ("comment_states"."handling" IN ('new', 'answered', 'escalated', 'ignored')),
	CONSTRAINT "state_new_is_unhandled" CHECK ("comment_states"."handling" <> 'new' OR ("comment_states"."handled_at" IS NULL AND "comment_states"."handled_by" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"parent_external_id" text,
	"parent_id" uuid,
	"depth" smallint DEFAULT 0 NOT NULL,
	"author_external_id" text,
	"author_display_name" text,
	"author_handle" text,
	"body" text,
	"media" jsonb,
	"is_outbound" boolean DEFAULT false NOT NULL,
	"lifecycle" text DEFAULT 'active' NOT NULL,
	"reply_disabled" boolean DEFAULT false NOT NULL,
	"created_at_remote" timestamp with time zone NOT NULL,
	"edited_at_remote" timestamp with time zone,
	"remote_version" timestamp with time zone,
	"first_seen_at" timestamp with time zone NOT NULL,
	"ingest_seq" bigserial NOT NULL,
	"last_synced_at" timestamp with time zone NOT NULL,
	"purge_after" timestamp with time zone NOT NULL,
	"content_purged_at" timestamp with time zone,
	CONSTRAINT "comments_ingestSeq_unique" UNIQUE("ingest_seq"),
	CONSTRAINT "comments_tenantId_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "comments_tenantId_channelId_id_unique" UNIQUE("tenant_id","channel_id","id"),
	CONSTRAINT "comments_channelId_externalId_unique" UNIQUE("channel_id","external_id"),
	CONSTRAINT "comment_lifecycle" CHECK ("comments"."lifecycle" IN ('active', 'hidden', 'deleted', 'unknown')),
	CONSTRAINT "comment_depth_non_negative" CHECK ("comments"."depth" >= 0)
);
--> statement-breakpoint
CREATE TABLE "outbound_replies" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"in_reply_to_comment_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"requested_by" text,
	"body" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"external_id" text,
	"posted_at" timestamp with time zone,
	"error_code" text,
	"error_detail" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "outbound_replies_tenantId_idempotencyKey_unique" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "reply_status" CHECK ("outbound_replies"."status" IN ('queued', 'sending', 'retrying', 'posted', 'failed', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "platform_credentials" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"identity_name" text,
	"credential_ref" text NOT NULL,
	"expires_at" timestamp with time zone,
	"granted_scopes" text[],
	"state" text DEFAULT 'ok' NOT NULL,
	"state_changed_at" timestamp with time zone,
	CONSTRAINT "platform_credentials_tenantId_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "platform_credentials_tenantId_platform_id_unique" UNIQUE("tenant_id","platform","id"),
	CONSTRAINT "credential_state" CHECK ("platform_credentials"."state" IN ('ok', 'expired', 'insufficient_scope', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"external_post_id" text NOT NULL,
	"publisher_post_id" text,
	"published_at" timestamp with time zone,
	"permalink" text,
	"preview" text,
	"comments_read_through" timestamp with time zone,
	CONSTRAINT "posts_channelId_externalPostId_unique" UNIQUE("channel_id","external_post_id"),
	CONSTRAINT "posts_tenantId_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "posts_tenantId_channelId_id_unique" UNIQUE("tenant_id","channel_id","id")
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"last_reconcile_at" timestamp with time zone,
	"consecutive_failures" smallint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channel_credential_same_tenant_and_platform" FOREIGN KEY ("tenant_id","platform","credential_id") REFERENCES "public"."platform_credentials"("tenant_id","platform","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_states" ADD CONSTRAINT "state_comment_same_tenant" FOREIGN KEY ("tenant_id","comment_id") REFERENCES "public"."comments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comment_post_in_same_channel" FOREIGN KEY ("tenant_id","channel_id","post_id") REFERENCES "public"."posts"("tenant_id","channel_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comment_parent" FOREIGN KEY ("parent_id") REFERENCES "public"."comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_replies" ADD CONSTRAINT "reply_comment_in_same_channel" FOREIGN KEY ("tenant_id","channel_id","in_reply_to_comment_id") REFERENCES "public"."comments"("tenant_id","channel_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "post_channel_same_tenant" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."channels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channels_credential_id_index" ON "channels" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "comment_states_tenant_id_ingest_seq_index" ON "comment_states" USING btree ("tenant_id","ingest_seq") WHERE handling IN ('new', 'escalated');--> statement-breakpoint
CREATE INDEX "comments_tenant_id_ingest_seq_index" ON "comments" USING btree ("tenant_id","ingest_seq");--> statement-breakpoint
CREATE INDEX "comments_channel_id_ingest_seq_index" ON "comments" USING btree ("channel_id","ingest_seq");--> statement-breakpoint
CREATE INDEX "comments_post_id_created_at_remote_id_index" ON "comments" USING btree ("post_id","created_at_remote" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "comments_purge_after_index" ON "comments" USING btree ("purge_after") WHERE content_purged_at IS NULL;--> statement-breakpoint
CREATE INDEX "outbound_replies_in_reply_to_comment_id_index" ON "outbound_replies" USING btree ("in_reply_to_comment_id");--> statement-breakpoint
CREATE INDEX "posts_publisher_post_id_index" ON "posts" USING btree ("publisher_post_id") WHERE publisher_post_id IS NOT NULL;