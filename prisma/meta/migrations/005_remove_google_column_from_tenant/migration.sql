-- Remove google column from tenants table (credentials now stored globally in .env)

ALTER TABLE "tenants" DROP COLUMN IF EXISTS "google";
