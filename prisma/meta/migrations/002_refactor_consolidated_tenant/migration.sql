-- Drop existing tables (data will be re-imported)
DROP TABLE IF EXISTS "credentials" CASCADE;
DROP TABLE IF EXISTS "tenants" CASCADE;

-- Recreate tenants table with new schema
CREATE TABLE "tenants" (
    "id" SERIAL NOT NULL,
    "display_name" TEXT,
    "twitch" JSONB,
    "youtube" JSONB,
    "kick" JSONB,
    "google" JSONB,
    "database_url" TEXT,
    "settings" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- Recreate admins table with new schema (auto-increment ID)
DROP TABLE IF EXISTS "admins" CASCADE;

CREATE TABLE "admins" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "api_key_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- Create unique indexes
CREATE UNIQUE INDEX "admins_username_key" ON "admins"("username");
CREATE UNIQUE INDEX "admins_api_key_hash_key" ON "admins"("api_key_hash");
