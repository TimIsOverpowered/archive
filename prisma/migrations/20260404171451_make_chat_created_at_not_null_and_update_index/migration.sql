-- Make created_at NOT NULL by backfilling NULLs first
UPDATE "chat_messages" SET "created_at" = NOW() WHERE "created_at" IS NULL;

-- Add NOT NULL constraint
ALTER TABLE "chat_messages" ALTER COLUMN "created_at" SET NOT NULL;

-- Drop old index if it exists
DROP INDEX IF EXISTS "idx_chat_messages_vod_offset_id";

-- Create new index with created_at instead of id
CREATE INDEX "idx_chat_messages_vod_offset_created" ON "chat_messages"("vod_id", "content_offset_seconds", "created_at");
