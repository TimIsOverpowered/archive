-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'UPLOADING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "vods" (
    "id" SERIAL NOT NULL,
    "platform_vod_id" TEXT,
    "platform" TEXT NOT NULL,
    "title" TEXT,
    "duration" INTEGER NOT NULL DEFAULT 0,
    "platform_stream_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_live" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMP(3),

    CONSTRAINT "vods_new_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vod_uploads" (
    "vod_id" INTEGER NOT NULL,
    "upload_id" TEXT NOT NULL,
    "type" TEXT,
    "duration" INTEGER NOT NULL DEFAULT 0,
    "part" INTEGER NOT NULL DEFAULT 1,
    "status" "UploadStatus" NOT NULL DEFAULT 'PENDING',
    "thumbnail_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vod_uploads_pkey" PRIMARY KEY ("upload_id")
);

-- CreateTable
CREATE TABLE "emotes" (
    "id" SERIAL NOT NULL,
    "vod_id" INTEGER NOT NULL,
    "ffz_emotes" JSONB,
    "bttv_emotes" JSONB,
    "seventv_emotes" JSONB,

    CONSTRAINT "emotes_new_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games" (
    "id" SERIAL NOT NULL,
    "vod_id" INTEGER NOT NULL,
    "start" INTEGER NOT NULL,
    "duration" INTEGER NOT NULL DEFAULT 0,
    "end" INTEGER NOT NULL,
    "video_provider" TEXT,
    "video_id" TEXT,
    "thumbnail_url" TEXT,
    "game_id" TEXT,
     "game_name" TEXT,
    "title" TEXT,
    "chapter_image" TEXT,

    CONSTRAINT "games_new_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapters" (
    "id" SERIAL NOT NULL,
    "vod_id" INTEGER NOT NULL,
    "game_id" TEXT,
    "name" TEXT,
    "image" TEXT,
    "start" INTEGER NOT NULL DEFAULT 0,
    "duration" INTEGER NOT NULL DEFAULT 0,
    "end" INTEGER,

    CONSTRAINT "chapters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "vod_id" INTEGER NOT NULL,
    "display_name" TEXT,
    "content_offset_seconds" INTEGER NOT NULL,
    "user_color" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "message" JSONB,
    "user_badges" JSONB,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id", "created_at")
);

-- CreateIndex
CREATE INDEX "vods_new_platform_idx" ON "vods"("platform");

-- CreateIndex
CREATE INDEX "vods_title_fts_idx" ON "vods" USING GIN (to_tsvector('english', coalesce(title, '')));

-- CreateIndex
CREATE INDEX "chapters_name_fts_idx" ON "chapters" USING GIN (to_tsvector('english', coalesce(name, '')));

-- CreateIndex
CREATE INDEX "chapters_game_id_idx" ON "chapters"("game_id");

-- CreateIndex
CREATE UNIQUE INDEX "vods_platform_vod_id_key" ON "vods"("platform", "platform_vod_id");

-- CreateIndex
CREATE UNIQUE INDEX "vods_platform_stream_id_key" ON "vods"("platform", "platform_stream_id");

-- CreateIndex
CREATE INDEX "vod_uploads_vod_id_idx" ON "vod_uploads"("vod_id");

-- CreateIndex
CREATE INDEX "vod_uploads_status_idx" ON "vod_uploads"("status");

-- CreateIndex
CREATE INDEX "vod_uploads_type_idx" ON "vod_uploads"("type");

-- CreateIndex
CREATE INDEX "vod_uploads_vod_id_type_part_idx" ON "vod_uploads"("vod_id", "type", "part");

-- CreateIndex
CREATE UNIQUE INDEX "emotes_new_vod_id_key" ON "emotes"("vod_id");

-- CreateIndex
CREATE INDEX "games_new_game_name_idx" ON "games"("game_name");

-- CreateIndex
CREATE INDEX "games_new_game_id_idx" ON "games"("game_id");

-- CreateIndex
CREATE INDEX "games_new_vod_id_start_idx" ON "games"("vod_id", "start");

-- CreateIndex
CREATE INDEX "games_new_game_name_fts_idx" ON "games" USING GIN (to_tsvector('english', coalesce("game_name", '')));

-- CreateIndex
CREATE INDEX "chapters_vod_id_start_idx" ON "chapters"("vod_id", "start");

-- CreateIndex
CREATE UNIQUE INDEX "chapters_vod_id_start_key" ON "chapters"("vod_id", "start");

-- CreateIndex
CREATE INDEX "idx_chat_messages_vod_offset_created" ON "chat_messages"("vod_id", "content_offset_seconds", "created_at");

-- AddForeignKey
ALTER TABLE "vod_uploads" ADD CONSTRAINT "vod_uploads_vod_id_fkey" FOREIGN KEY ("vod_id") REFERENCES "vods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emotes" ADD CONSTRAINT "emotes_new_vod_id_fkey" FOREIGN KEY ("vod_id") REFERENCES "vods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_new_vod_id_fkey" FOREIGN KEY ("vod_id") REFERENCES "vods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_vod_id_fkey" FOREIGN KEY ("vod_id") REFERENCES "vods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "vod_uploads_vod_id_type_part_key" ON "vod_uploads"("vod_id", "type", "part");

-- CreateIndex
CREATE UNIQUE INDEX "games_unique_chapter_key" ON "games"("vod_id", "start", "end");

-- Create the trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Attach the trigger to the vods table
CREATE TRIGGER update_vods_updated_at
BEFORE UPDATE ON "vods"
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 1. Enable the extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 2. Convert the table into a Hypertable chunked by 7 days
SELECT create_hypertable('chat_messages', 'created_at', chunk_time_interval => INTERVAL '7 days');

-- 3. Enable Compression (Segmented by vod_id for fast replay queries)
ALTER TABLE chat_messages SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'vod_id',
  timescaledb.compress_orderby = 'content_offset_seconds ASC'
);

-- 4. Auto-compress chunks older than 30 days
SELECT add_compression_policy('chat_messages', INTERVAL '30 days');