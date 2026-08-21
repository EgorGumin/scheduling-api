DROP INDEX "comments_purge_after_index";--> statement-breakpoint
ALTER TABLE "comments" DROP COLUMN "purge_after";--> statement-breakpoint
ALTER TABLE "comments" DROP COLUMN "content_purged_at";