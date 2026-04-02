-- ============================================
-- Ensure no updated_at column exists on chat_messages (idempotent)
-- The schema defines ChatMessage without this field, so just ensure it doesn't exist
-- ============================================

DO $$ BEGIN
    ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "updated_at";
END $$;
