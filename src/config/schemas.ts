import { z } from 'zod';
import path from 'path';
import { YOUTUBE_MAX_DURATION } from '../constants';

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

export const YoutubeSchema = z.object({
  public: z.boolean().default(true),
  upload: z.boolean().default(true),
  vodUpload: z.boolean().default(true),
  liveUpload: z.boolean().default(false),
  multiTrack: z.boolean().default(false),
  splitDuration: z.number().default(YOUTUBE_MAX_DURATION),
  perGameUpload: z.boolean().default(false),
  restrictedGames: z.array(z.string()).default([]),
  description: z.string().default(''),
  auth: z.string().default(''),
});

export const TwitchSchema = z.object({
  enabled: z.boolean().default(false),
  mainPlatform: z.boolean().default(false),
  auth: z.string().optional(),
  username: z.string().optional(),
  id: z.string().optional(),
});

export const KickSchema = z.object({
  enabled: z.boolean().default(false),
  mainPlatform: z.boolean().default(false),
  id: z.string().optional(),
  username: z.string().optional(),
});
