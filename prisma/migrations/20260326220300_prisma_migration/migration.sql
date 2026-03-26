/*
  Warnings:

  - You are about to drop the `chapters` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `emotes` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `games` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `vod_uploads` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `vods` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "chapters" DROP CONSTRAINT "chapters_vod_id_fkey";

-- DropForeignKey
ALTER TABLE "emotes" DROP CONSTRAINT "emotes_vod_id_fkey";

-- DropForeignKey
ALTER TABLE "games" DROP CONSTRAINT "games_vod_id_fkey";

-- DropForeignKey
ALTER TABLE "vod_uploads" DROP CONSTRAINT "vod_uploads_vod_id_fkey";

-- DropTable
DROP TABLE "chapters";

-- DropTable
DROP TABLE "emotes";

-- DropTable
DROP TABLE "games";

-- DropTable
DROP TABLE "vod_uploads";

-- DropTable
DROP TABLE "vods";

-- DropEnum
DROP TYPE "UploadStatus";

-- CreateTable
CREATE TABLE "tenants" (
    "id" VARCHAR(25) NOT NULL,
    "display_name" TEXT NOT NULL,
    "twitch" JSONB,
    "youtube" JSONB,
    "kick" JSONB,
    "google" JSONB,
    "database_url" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admins" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "api_key" TEXT NOT NULL,
    "api_key_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_id_key" ON "tenants"("id");

-- CreateIndex
CREATE UNIQUE INDEX "admins_username_key" ON "admins"("username");

-- CreateIndex
CREATE UNIQUE INDEX "admins_api_key_key" ON "admins"("api_key");

-- CreateIndex
CREATE UNIQUE INDEX "admins_api_key_hash_key" ON "admins"("api_key_hash");
