-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'UPLOADING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "vods" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "title" TEXT,
    "duration" INTEGER NOT NULL DEFAULT 0,
    "thumbnail_url" TEXT,
    "stream_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "downloaded_at" TIMESTAMP(3),

    CONSTRAINT "vods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vod_uploads" (
    "vod_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "upload_id" TEXT NOT NULL,
    "type" TEXT,
    "duration" INTEGER NOT NULL DEFAULT 0,
    "part" INTEGER NOT NULL DEFAULT 0,
    "status" "UploadStatus" NOT NULL DEFAULT 'PENDING',
    "thumbnail_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vod_uploads_pkey" PRIMARY KEY ("upload_id")
);

-- CreateTable
CREATE TABLE "emotes" (
    "id" SERIAL NOT NULL,
    "vod_id" TEXT NOT NULL,
    "ffz_emotes" JSONB,
    "bttv_emotes" JSONB,
    "seventv_emotes" JSONB,

    CONSTRAINT "emotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games" (
    "id" SERIAL NOT NULL,
    "vod_id" TEXT NOT NULL,
    "start_time" INTEGER,
    "end_time" INTEGER,
    "video_provider" TEXT,
    "video_id" TEXT,
    "thumbnail_url" TEXT,
    "game_id" TEXT,
    "game_name" TEXT,
    "title" TEXT,
    "chapter_image" TEXT,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapters" (
    "id" SERIAL NOT NULL,
    "vod_id" TEXT NOT NULL,
    "game_id" TEXT,
    "name" TEXT,
    "image" TEXT,
    "duration" TEXT,
    "start" INTEGER NOT NULL DEFAULT 0,
    "end" INTEGER,

    CONSTRAINT "chapters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "vod_id" TEXT NOT NULL,
    "display_name" TEXT,
    "content_offset_seconds" DECIMAL(65,30) NOT NULL,
    "user_color" TEXT,
    "created_at" TIMESTAMP(3),

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);


-- CreateIndex
CREATE INDEX "vods_platform_idx" ON "vods"("platform");

-- CreateIndex
CREATE UNIQUE INDEX "vods_platform_id_key" ON "vods"("platform", "id");

-- CreateIndex
CREATE INDEX "vod_uploads_vod_id_platform_idx" ON "vod_uploads"("vod_id", "platform");

-- CreateIndex
CREATE INDEX "vod_uploads_platform_idx" ON "vod_uploads"("platform");

-- CreateIndex
CREATE INDEX "vod_uploads_status_idx" ON "vod_uploads"("status");

-- CreateIndex
CREATE INDEX "vod_uploads_type_idx" ON "vod_uploads"("type");

-- CreateIndex
CREATE INDEX "vod_uploads_vod_id_type_part_idx" ON "vod_uploads"("vod_id", "type", "part");

-- CreateIndex
CREATE UNIQUE INDEX "emotes_vod_id_key" ON "emotes"("vod_id");

-- CreateIndex
CREATE INDEX "games_vod_id_start_time_idx" ON "games"("vod_id", "start_time");

-- CreateIndex
CREATE INDEX "games_game_name_idx" ON "games"("game_name");

-- CreateIndex
CREATE INDEX "chapters_vod_id_idx" ON "chapters"("vod_id");

-- CreateIndex
CREATE INDEX "idx_chat_messages_vod_offset_id" ON "chat_messages"("vod_id", "content_offset_seconds", "id");



-- AddForeignKey
ALTER TABLE "vod_uploads" ADD CONSTRAINT "vod_uploads_vod_id_fkey" FOREIGN KEY ("vod_id") REFERENCES "vods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emotes" ADD CONSTRAINT "emotes_vod_id_fkey" FOREIGN KEY ("vod_id") REFERENCES "vods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_vod_id_fkey" FOREIGN KEY ("vod_id") REFERENCES "vods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_vod_id_fkey" FOREIGN KEY ("vod_id") REFERENCES "vods"("id") ON DELETE CASCADE ON UPDATE CASCADE;


