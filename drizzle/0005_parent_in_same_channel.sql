ALTER TABLE "comments" DROP CONSTRAINT "comment_parent";
--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comment_parent" FOREIGN KEY ("tenant_id","channel_id","parent_id") REFERENCES "public"."comments"("tenant_id","channel_id","id") ON DELETE no action ON UPDATE no action;