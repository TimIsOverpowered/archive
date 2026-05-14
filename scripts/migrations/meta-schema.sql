-- Meta database schema: admins and tenants tables
-- This migration creates the admin authentication and tenant management tables.

-- 1. Admins table
-- Stores admin accounts with bcrypt-hashed API keys.
-- The api_key_hash column is the sole credential storage — plaintext keys
-- are never persisted. Use scripts/create-admin.ts or scripts/reset-admin-key.ts
-- to manage admin credentials.
CREATE TABLE "admins" (
    "id" SERIAL PRIMARY KEY,
    "username" TEXT NOT NULL UNIQUE,
    "api_key_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "admins_api_key_hash_key" ON "admins"("api_key_hash");

-- 2. Tenants table
-- Each tenant represents a streamer/channel with platform-specific OAuth data
-- and a separate database connection.
CREATE TABLE "tenants" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "display_name" TEXT,
    "profile_image_url" TEXT,
    "twitch" JSONB,
    "youtube" JSONB,
    "kick" JSONB,
    "database_name" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
