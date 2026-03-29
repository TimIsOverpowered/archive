-- ============================================
-- VOD Schema Update
-- Remove: downloaded_at, thumbnail_url from vods table
-- Add: updated_at (auto-managed) to schema and DB
-- Rollback user_id and ended_at columns if they exist
-- Migrate thumbnails to vod_uploads where not already present
-- Note: is_live and started_at already in DB - just adding to Prisma schema
-- ============================================

-- Step 1: Migrate thumbnail_url from vods to vod_uploads (only if upload doesn't have one)
UPDATE "vod_uploads" vu
SET thumbnail_url = v.thumbnail_url
FROM "vods" v
WHERE vu.vod_id = v.id 
  AND v.thumbnail_url IS NOT NULL 
  AND vu.thumbnail_url IS NULL;

-- Step 2: Drop deprecated columns from vods table
ALTER TABLE "vods" DROP COLUMN IF EXISTS "downloaded_at";
ALTER TABLE "vods" DROP COLUMN IF EXISTS "thumbnail_url";

-- Step 3: Rollback user_id if it was incorrectly added (per requirements - should not exist)
ALTER TABLE "vods" DROP COLUMN IF EXISTS "user_id";
DROP INDEX IF EXISTS "vods_user_id_platform_idx";

-- Step 4: Drop ended_at if it exists (only keeping is_live and started_at per requirements)
ALTER TABLE "vods" DROP COLUMN IF EXISTS "ended_at";

-- Step 5: Add updated_at column with default value for existing rows
ALTER TABLE "vods" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Initialize any existing rows that might be null (safety check)  
UPDATE "vods" SET "updated_at" = COALESCE("created_at", NOW()) WHERE "updated_at" IS NULL;

-- Step 6: Create trigger function for auto-updating timestamp on row changes
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Drop existing trigger if any (for idempotency)  
DROP TRIGGER IF EXISTS update_vods_updated_at ON "vods";

-- Create trigger to auto-update updated_at on row changes
CREATE TRIGGER update_vods_updated_at 
BEFORE UPDATE ON "vods" 
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Step 7: Add index for updated_at (useful for sorting/filtering)
CREATE INDEX IF NOT EXISTS "vods_updated_at_idx" ON "vods"("updated_at");
