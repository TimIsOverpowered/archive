import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { StreamerDB, SelectableChatMessages } from '../db/streamer-types.js';
import { RedisService } from '../utils/redis-service.js';
import { getDisableRedisCache } from '../config/env-accessors.js';
import { getApiConfig } from '../config/env.js';
import { compressChatData, decompressChatData } from '../utils/compression.js';
import { getLogger } from '../utils/logger.js';
import { extractErrorDetails } from '../utils/error.js';
import { badRequest } from '../utils/http-error.js';
import { LOGS_PAGE_SIZE, LOGS_DEFAULT_BUCKET_SIZE, LOGS_TARGET_COMMENTS_PER_BUCKET } from '../constants.js';

const BOUNDARIES = [30, 60, 90, 120, 180, 300, 600, 900, 1800, 3600];

interface CursorData {
  offset: number;
  createdAt: string;
  id: string;
}

function computeBucketSize(commentsPer100s: number): number {
  const raw = (LOGS_TARGET_COMMENTS_PER_BUCKET / commentsPer100s) * 100;
  return BOUNDARIES.reduce((prev, curr) => (Math.abs(curr - raw) < Math.abs(prev - raw) ? curr : prev));
}

async function getVodBucketSize(db: Kysely<StreamerDB>, tenantId: string, vodId: number): Promise<number> {
  const key = `${tenantId}:${vodId}:bucketSize`;

  const redis = RedisService.instance?.getClient() ?? null;
  if (!getDisableRedisCache() && redis) {
    try {
      const cached = await redis.get(key);
      if (cached) {
        getLogger().debug({ vodId }, '[CACHE HIT] bucketSize');
        return parseInt(cached, 10);
      }
    } catch {
      // fall through to DB query
    }
  }

  const rawResult = await sql`
    SELECT
      COUNT(*) / NULLIF((MAX(content_offset_seconds) - MIN(content_offset_seconds)), 0) * 100 AS comments_per_100s
    FROM chat_messages
    WHERE vod_id = ${vodId}
  `.execute(db);

  const row = (rawResult.rows as unknown[])[0] as { comments_per_100s?: unknown };
  const commentsPer100sValue = parseFloat(String(row?.comments_per_100s ?? ''));
  const bucketSize = isFinite(commentsPer100sValue)
    ? computeBucketSize(commentsPer100sValue)
    : LOGS_DEFAULT_BUCKET_SIZE;

  if (!getDisableRedisCache() && redis) {
    try {
      await redis.set(key, bucketSize.toString(), 'EX', getApiConfig().CHAT_BUCKET_SIZE_TTL);
    } catch {
      // Ignore cache errors
    }
  }

  return bucketSize;
}

export async function getLogsByOffset(
  db: Kysely<StreamerDB>,
  tenantId: string,
  vodId: number,
  offsetSeconds: number
): Promise<{ comments: SelectableChatMessages[]; cursor?: string }> {
  const bucketSize = await getVodBucketSize(db, tenantId, vodId);
  const bucket = Math.floor(offsetSeconds / bucketSize) * bucketSize;
  const cacheKey = `${tenantId}:${vodId}:bucket:${bucket}`;
  const redis = RedisService.instance?.getClient() ?? null;

  if (!getDisableRedisCache() && redis) {
    try {
      const cached = await redis.getBuffer(cacheKey);
      if (cached) {
        getLogger().debug({ vodId, bucket }, '[CACHE HIT] bucket');
        const data = (await decompressChatData(cached)) as { comments: SelectableChatMessages[]; cursor?: string };
        return data;
      }
    } catch (error) {
      const details = extractErrorDetails(error);
      getLogger().warn({ vodId, bucket, ...details }, '[CACHE MISS] bucket read failed');
    }
  }

  const vod = await db.selectFrom('vods').select(['created_at', 'duration']).where('id', '=', vodId).executeTakeFirst();

  if (!vod) throw new Error('VOD not found');

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
    .limit(LOGS_PAGE_SIZE + 1)
    .execute();

  if (!data || data.length === 0) {
    return { comments: [], cursor: undefined };
  }

  const comments = data.slice(0, LOGS_PAGE_SIZE);

  let cursor: string | undefined;
  if (data.length === LOGS_PAGE_SIZE + 1) {
    const lastMsg = data[LOGS_PAGE_SIZE];
    if (!lastMsg.created_at) {
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

  if (!getDisableRedisCache() && redis) {
    try {
      const compressed = await compressChatData(response);
      await redis.set(cacheKey, compressed as Buffer, 'EX', getApiConfig().CHAT_OFFSET_TTL);
      getLogger().debug({ vodId, bucket }, '[CACHE SET] bucket');
    } catch {
      // Ignore cache errors
    }
  }

  return response;
}

export async function getLogsByCursor(
  db: Kysely<StreamerDB>,
  tenantId: string,
  vodId: number,
  cursor: string
): Promise<{ comments: SelectableChatMessages[]; cursor?: string }> {
  const cacheKey = `${tenantId}:${vodId}:cursor:${cursor}`;
  const redis = RedisService.instance?.getClient() ?? null;

  if (!getDisableRedisCache() && redis) {
    try {
      const cached = await redis.getBuffer(cacheKey);
      if (cached) {
        getLogger().debug({ vodId }, '[CACHE HIT] cursor');

        const data = (await decompressChatData(cached)) as { comments: SelectableChatMessages[]; cursor?: string };
        return data;
      }
    } catch (error) {
      const details = extractErrorDetails(error);
      getLogger().warn({ vodId, ...details }, '[CACHE MISS] cursor read failed');
    }
  }

  let cursorJson: CursorData | null = null;
  try {
    cursorJson = JSON.parse(Buffer.from(cursor, 'base64').toString());
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

  if (!vod) throw new Error('VOD not found');

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
        eb('content_offset_seconds', '>', cursorJson.offset!),
        eb.and([
          eb('content_offset_seconds', '=', cursorJson.offset!),
          eb.or([
            eb('created_at', '>', cursorDate),
            eb.and([eb('created_at', '=', cursorDate), eb('id', '>', cursorJson.id!)]),
          ]),
        ]),
      ])
    )
    .orderBy('content_offset_seconds', 'asc')
    .orderBy('created_at', 'asc')
    .limit(LOGS_PAGE_SIZE + 1)
    .execute();

  if (!data || data.length === 0) {
    return { comments: [], cursor: undefined };
  }

  const comments = data.slice(0, LOGS_PAGE_SIZE);

  let nextCursor: string | undefined;
  if (data.length === LOGS_PAGE_SIZE + 1) {
    const lastMsg = data[LOGS_PAGE_SIZE];
    if (!lastMsg.created_at) {
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

  if (!getDisableRedisCache() && redis) {
    try {
      const compressed = await compressChatData(response);
      await redis.set(cacheKey, compressed as Buffer, 'EX', getApiConfig().CHAT_CURSOR_TTL);
      getLogger().debug({ vodId }, '[CACHE SET] cursor');
    } catch {
      // Ignore cache errors
    }
  }

  return response;
}
