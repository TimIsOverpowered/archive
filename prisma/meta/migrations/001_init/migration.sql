-- Migration table for Prisma
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id" varchar(36) PRIMARY KEY,
    "checksum" varchar(64) NOT NULL,
    "steps" text NOT NULL,
    "batch_id" bigint DEFAULT 1,
    "rolled_back_at" timestamptz DEFAULT now()
);

-- Tenants table
CREATE TABLE IF NOT EXISTS "tenants" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text NOT NULL,
    "platform" text[] NOT NULL,
    "createdAt" timestamp(3) NOT NULL DEFAULT NOW(),
    "updatedAt" timestamp(3) NOT NULL DEFAULT NOW()
);

-- Credentials table (encrypted values stored as BYTEA)
CREATE TABLE IF NOT EXISTS "credentials" (
    "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" text NOT NULL,
    "platform" text NOT NULL,
    "type" text NOT NULL,
    "encryptedValue" bytea,
    "iv" bytea,
    CONSTRAINT "credentials_tenant_platform_type_unique" UNIQUE ("tenantId", "platform", "type"),
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
);

-- Admins table (API key hashes for admin auth)
CREATE TABLE IF NOT EXISTS "admins" (
    "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
    "apiKeyHash" text UNIQUE NOT NULL,
    "createdAt" timestamp(3) NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS "credentials_tenantId_idx" ON "credentials" ("tenantId");
