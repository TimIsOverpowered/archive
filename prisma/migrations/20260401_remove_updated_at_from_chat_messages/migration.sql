-- ============================================
-- Remove unused updated_at column from chat_messages table
-- This field was never populated and is not needed for chat message tracking
-- ============================================

ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "updated_at";
