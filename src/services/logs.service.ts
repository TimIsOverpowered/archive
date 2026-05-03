import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { StreamerDB, SelectableChatMessages } from '../db/streamer-types.js';
import { RedisService } from '../utils/redis-service.js';
import { Cache, Logs  } from '../constants.js';
import { compressChatData, decompressChatData } from '../utils/compression.js';
import { getLogger } from '../utils/logger.js';
import { extractErrorDetails } from '../utils/error.js';
import { badRequest } from '../utils/http-error.js';
import { simpleKeys } from '../utils/cache-keys.js';
import { withCache } from '../utils/cache.js';
import { VodNotFoundError } from '../utils/domain-errors.js';

const BOUNDARIES = [30, 60, 90, 120, 180, 300, 600, 900, 1800, 3600];

interface CursorData {
  offset: number;
  createdAt: string;
  id: string;
}

function computeBucketSize(commentsPer100s: number): number {
  const raw = (Logs.TARGET_COMMENTS_PER_BUCKET / commentsPer100s) * 100;
  return BOUNDARIES.reduce((prev, curr) => (Math.abs(curr - raw) < Math.abs(prev - raw) ? curr : prev));
}

async function getVodBucketSize(db: Kysely<StreamerDB>, tenantId: string, vodId: number): Promise<number> {
  const key = simpleKeys.bucketSize(tenantId, vodId);

  return withCache(key, Cache.CHAT_BUCKET_SIZE_TTL, async () => {
    const result = await db
      .selectFrom('chat_messages')
      .select(
        sql<number>`
        COUNT(*) / NULLIF(MAX(content_offset_seconds) - MIN(content_offset_seconds), 0) * 100
      `.as('comments_per_100s')
      )
      .where('vod_id', '=', vodId)
      .executeTakeFirst();

    const commentsPer100sValue = parseFloat(String(result?.comments_per_100s ?? ''));
    return isFinite(commentsPer100sValue) ? computeBucketSize(commentsPer100sValue) : Logs.DEFAULT_BUCKET_SIZE;
  });
}

/**
 * Fetch chat comments for a VOD using offset-based pagination.
 * Computes dynamic bucket size from comment density, caches results in Redis.
 */
export async function getLogsByOffset(
  db: Kysely<StreamerDB>,
  tenantId: string,
  vodId: number,
  offsetSeconds: number
): Promise<{ comments: SelectableChatMessages[]; cursor?: string | undefined }> {
  const bucketSize = await getVodBucketSize(db, tenantId, vodId);
  const bucket = Math.floor(offsetSeconds / bucketSize) * bucketSize;
  const cacheKey = simpleKeys.bucket(tenantId, vodId, bucket);
  const redis = RedisService.getActiveClient();

  if (redis) {
    try {
      const cached = await redis.getBuffer(cacheKey);
      if (cached != null && cached.length > 0) {
        getLogger().debug({ vodId, bucket }, '[CACHE HIT] bucket');
        const data = (await decompressChatData(cached)) as {
          comments: SelectableChatMessages[];
          cursor?: string | undefined;
        };
        return data;
      }
    } catch (error) {
      const details = extractErrorDetails(error);
      getLogger().warn({ vodId, bucket, ...details }, '[CACHE MISS] bucket read failed');
    }
  }

  const vod = await db.selectFrom('vods').select(['created_at', 'duration']).where('id', '=', vodId).executeTakeFirst();

  if (!vod) throw new VodNotFoundError(vodId, 'logs service');

  // Add a 2-hour buffer to the end time to account for slight timestamp drifts
  const streamStart = vod.created_at;
  const streamEnd = new Date(streamStart.getTime() + (vod.duration + 7200) * 1000);

  const data = await db
    .selectFrom('chat_messages')
    .select([
      'id',
      'vod_id',
      'display_name',
      'content_offset_seconds',
      'user_color',
      'created_at',
      'message',
      'user_badges',
    ])
    .where('vod_id', '=', vodId)
    .where('content_offset_seconds', '>=', bucket)
    .where('created_at', '>=', streamStart)
    .where('created_at', '<=', streamEnd)
    .orderBy('content_offset_seconds', 'asc')
    .orderBy('created_at', 'asc')
    .limit(Logs.PAGE_SIZE + 1)
    .execute();

  if (data.length === 0) {
    return { comments: [], cursor: undefined };
  }

  const comments = data.slice(0, Logs.PAGE_SIZE);

  let cursor: string | undefined;
  if (data.length === Logs.PAGE_SIZE + 1) {
    const lastMsg = data[Logs.PAGE_SIZE];
    if (lastMsg == null) throw new Error('Missing last message in data array');
    if (lastMsg.created_at == null) {
      throw new Error(`Missing created_at on message ${lastMsg.id}`);
    }
    const cursorData: CursorData = {
      offset: lastMsg.content_offset_seconds,
      createdAt: lastMsg.created_at.toISOString(),
      id: lastMsg.id,
    };
    cursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
  }

  const response = { comments, cursor };

  if (redis) {
    try {
      const compressed = await compressChatData(response);
      await redis.set(cacheKey, compressed, 'EX', Cache.CHAT_TTL);
      getLogger().debug({ vodId, bucket }, '[CACHE SET] bucket');
    } catch {
      // Ignore cache errors
    }
  }

  return response;
}

/**
 * Fetch chat comments for a VOD using cursor-based pagination.
 * Cursor encodes offset, timestamp, and message ID for deterministic ordering.
 */
export async function getLogsByCursor(
  db: Kysely<StreamerDB>,
  tenantId: string,
  vodId: number,
  cursor: string
): Promise<{ comments: SelectableChatMessages[]; cursor?: string | undefined }> {
  const cacheKey = simpleKeys.cursor(tenantId, vodId, cursor);
  const redis = RedisService.getActiveClient();

  if (redis) {
    try {
      const cached = await redis.getBuffer(cacheKey);
      if (cached) {
        getLogger().debug({ vodId }, '[CACHE HIT] cursor');

        const data = (await decompressChatData(cached)) as {
          comments: SelectableChatMessages[];
          cursor?: string | undefined;
        };
        return data;
      }
    } catch (error) {
      const details = extractErrorDetails(error);
      getLogger().warn({ vodId, ...details }, '[CACHE MISS] cursor read failed');
    }
  }

  let cursorJson: CursorData | null = null;
  try {
    cursorJson = JSON.parse(Buffer.from(cursor, 'base64').toString()) as CursorData;
  } catch {
    badRequest('Invalid cursor format');
  }

  if (cursorJson?.offset == null || cursorJson?.createdAt == null || cursorJson?.id == null) {
    badRequest('Invalid cursor: missing required fields');
  }

  const cursorDate = new Date(cursorJson.createdAt);
  if (isNaN(cursorDate.getTime())) {
    badRequest('Invalid cursor: invalid date');
  }

  const vod = await db.selectFrom('vods').select(['created_at', 'duration']).where('id', '=', vodId).executeTakeFirst();

  if (!vod) throw new VodNotFoundError(vodId, 'logs service cursor');

  const streamStart = vod.created_at;
  const streamEnd = new Date(streamStart.getTime() + (vod.duration + 7200) * 1000);

  const data = await db
    .selectFrom('chat_messages')
    .select([
      'id',
      'vod_id',
      'display_name',
      'content_offset_seconds',
      'user_color',
      'created_at',
      'message',
      'user_badges',
    ])
    .where('vod_id', '=', vodId)
    .where('created_at', '>=', streamStart)
    .where('created_at', '<=', streamEnd)
    .where((eb) =>
      eb.or([
        eb('content_offset_seconds', '>', cursorJson.offset),
        eb.and([
          eb('content_offset_seconds', '=', cursorJson.offset),
          eb.or([
            eb('created_at', '>', cursorDate),
            eb.and([eb('created_at', '=', cursorDate), eb('id', '>', cursorJson.id)]),
          ]),
        ]),
      ])
    )
    .orderBy('content_offset_seconds', 'asc')
    .orderBy('created_at', 'asc')
    .limit(Logs.PAGE_SIZE + 1)
    .execute();

  if (data.length === 0) {
    return { comments: [], cursor: undefined };
  }

  const comments = data.slice(0, Logs.PAGE_SIZE);

  let nextCursor: string | undefined;
  if (data.length === Logs.PAGE_SIZE + 1) {
    const lastMsg = data[Logs.PAGE_SIZE];
    if (lastMsg == null) throw new Error('Missing last message in data array');
    if (lastMsg.created_at == null) {
      throw new Error(`Missing created_at on message ${lastMsg.id}`);
    }
    const cursorData: CursorData = {
      offset: lastMsg.content_offset_seconds,
      createdAt: lastMsg.created_at.toISOString(),
      id: lastMsg.id,
    };
    nextCursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
  }

  const response = { comments, cursor: nextCursor };

  if (redis) {
    try {
      const compressed = await compressChatData(response);
      await redis.set(cacheKey, compressed, 'EX', Cache.CHAT_TTL);
      getLogger().debug({ vodId }, '[CACHE SET] cursor');
    } catch {
      // Ignore cache errors
    }
  }

  return response;
}
