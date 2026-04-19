import { z } from 'zod';
import path from 'path';
import { YOUTUBE_MAX_DURATION } from '../constants.js';

function normalizePathForSchema(basePath?: string): string | undefined {
  if (!basePath) return basePath;
  const normalized = path.normalize(basePath);
  return normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) ? normalized : path.resolve(normalized);
}

export const SettingsSchema = z.object({
  domainName: z.string(),
  timezone: z.string(),
  saveMP4: z.boolean().default(false),
  saveHLS: z.boolean().default(false),
  vodDownload: z.boolean().default(true),
  chatDownload: z.boolean().default(true),
  vodPath: z
    .string()
    .optional()
    .transform((p) => (p ? normalizePathForSchema(p) : undefined)),
  livePath: z
    .string()
    .optional()
    .transform((p) => (p ? normalizePathForSchema(p) : undefined)),
});

export const YoutubeAuthSchema = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string(),
  expiry_date: z.number(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export type YoutubeAuthObject = z.infer<typeof YoutubeAuthSchema>;

export const YoutubeSchema = z.object({
  public: z.boolean().default(true),
  upload: z.boolean().default(true),
  vodUpload: z.boolean().default(true),
  liveUpload: z.boolean().default(false),
  multiTrack: z.boolean().default(false),
  splitDuration: z.number().default(YOUTUBE_MAX_DURATION),
  perGameUpload: z.boolean().default(false),
  restrictedGames: z.array(z.string().nullable()).default([]),
  description: z.string().default(''),
  auth: z.string().default(''),
});

export const TwitchAuthSchema = z.object({
  client_id: z.string(),
  client_secret: z.string(),
  access_token: z.string().optional(),
  expiry_date: z.number().optional(),
});

export type TwitchAuthObject = z.infer<typeof TwitchAuthSchema>;

export const TwitchSchema = z.object({
  enabled: z.boolean().default(false),
  mainPlatform: z.boolean().default(false),
  auth: z
    .string()
    .optional()
    .nullable()
    .transform((val) => val ?? undefined),
  username: z
    .string()
    .optional()
    .nullable()
    .transform((val) => val ?? undefined),
  id: z
    .string()
    .optional()
    .nullable()
    .transform((val) => val ?? undefined),
});

export const KickSchema = z.object({
  enabled: z.boolean().default(false),
  mainPlatform: z.boolean().default(false),
  id: z.string().optional(),
  username: z.string().optional(),
});

// ── Prisma Operation Schemas ─────────────────────────────────────────────────

export const VodCreateSchema = z.object({
  vod_id: z.string(),
  title: z.string().nullable().default(null),
  created_at: z.coerce.date(),
  duration: z.number().default(0),
  stream_id: z.string().nullable().default(null),
  platform: z.enum(['twitch', 'kick']),
  is_live: z.boolean().default(false),
});

export const VodUpdateSchema = z.object({
  vod_id: z.string().optional(),
  title: z.string().nullable().default(null),
  created_at: z.coerce.date().optional(),
  duration: z.number().optional(),
  stream_id: z.string().nullable().default(null),
});

export const ChapterCreateSchema = z.object({
  vod_id: z.number(),
  start: z.number(),
  end: z.number().nullable().default(null),
  duration: z.string(),
  title: z.string().nullable().default(null),
  game_id: z.string().nullable().default(null),
});

export const ChapterUpdateSchema = z.object({
  start: z.number().optional(),
  end: z.number().nullable().default(null),
  duration: z.string().optional(),
  title: z.string().nullable().default(null),
  game_id: z.string().nullable().default(null),
});

export const GameUpsertSchema = z.object({
  game_id: z.string(),
  game_name: z.string(),
  box_art_url: z.string().url().nullable().default(null),
});

export const EmoteUpsertSchema = z.object({
  vod_id: z.number(),
  ffz_emotes: z.array(z.object({ id: z.string(), code: z.string() })).default([]),
  bttv_emotes: z.array(z.object({ id: z.string(), code: z.string() })).default([]),
  seventv_emotes: z.array(z.object({ id: z.string(), code: z.string(), flags: z.number().optional() })).default([]),
});
