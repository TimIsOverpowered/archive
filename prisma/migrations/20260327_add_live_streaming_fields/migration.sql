-- Add live streaming fields to vods table (consolidated from streams model)

ALTER TABLE "vods" 
ADD COLUMN "is_live" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "started_at" TIMESTAMP(3),
ADD COLUMN "ended_at" TIMESTAMP(3),
ADD COLUMN "user_id" TEXT;

-- Create indexes for live stream queries and multi-tenant tracking
CREATE INDEX "vods_is_live_idx" ON "vods"("is_live");
CREATE INDEX "vods_user_id_platform_idx" ON "vods"("user_id", "platform");

COMMENT ON COLUMN "vods"."is_live" IS 'Indicates if this VOD record represents an active live stream';
COMMENT ON COLUMN "vods"."started_at" IS 'Timestamp when the live stream started (set on offline->live transition)';
COMMENT ON COLUMN "vods"."ended_at" IS 'Timestamp when the live stream ended (set on live->offline transition)';
COMMENT ON COLUMN "vods"."user_id" IS 'Channel/user identifier for tracking which channel this VOD belongs to (multi-tenant/multi-channel support)';
