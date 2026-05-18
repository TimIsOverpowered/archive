-- Migration tracking table
-- Records all applied migrations for audit and idempotency.
CREATE TABLE "migrations" (
    "id" SERIAL PRIMARY KEY,
    "name" TEXT NOT NULL UNIQUE,
    "applied_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
