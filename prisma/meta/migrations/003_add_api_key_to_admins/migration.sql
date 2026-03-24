-- Add api_key column to admins table
ALTER TABLE "admins" ADD COLUMN "api_key" TEXT NOT NULL DEFAULT '';

-- Update existing rows with empty string (should be none, but safety first)
UPDATE "admins" SET "api_key" = '' WHERE "api_key" IS NULL;

-- Make column unique
ALTER TABLE "admins" ADD CONSTRAINT "admins_api_key_key" UNIQUE ("api_key");
