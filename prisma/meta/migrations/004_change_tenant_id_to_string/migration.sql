-- Change tenant id from SERIAL to VARCHAR(25) with unique constraint
DROP TABLE IF EXISTS "tenants" CASCADE;

CREATE TABLE "tenants" (
    "id" VARCHAR(25) NOT NULL,
    "display_name" TEXT NOT NULL,
    "twitch" JSONB,
    "youtube" JSONB,
    "kick" JSONB,
    "google" JSONB,
    "database_url" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);
