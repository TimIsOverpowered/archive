import type { ReadonlyKysely } from 'kysely/readonly';
import { Cache, Logs } from '../constants.js';
import type { StreamerDB, SelectableChatMessages } from '../db/streamer-types.js';
import { CacheKeys, simpleKeys } from '../utils/cache-keys.js';
import { compressData, decompressData } from '../utils/compression.js';
import { VodNotFoundError } from '../utils/domain-errors.js';
import { extractErrorDetails } from '../utils/error.js';
import { badRequest } from '../utils/http-error.js';
import { getLogger } from '../utils/logger.js';
import { RedisService } from '../utils/redis-service.js';

interface CursorPayload {
  offset: number;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString('base64');
}

interface VodMeta {
  created_at: Date;
  started_at: Date | null;
  duration: number;
  is_live: boolean;
}

/**
 * Fetch VOD metadata (created_at, duration, is_live) with Redis caching.
 * Prevents repeated DB queries on every chat request.
 */
async function fetchVodMeta(
  db: ReadonlyKysely<StreamerDB>,
  tenantId: string,
  vodId: number,
  options?: { signal?: AbortSignal }
): Promise<VodMeta> {
  const redis = RedisService.getActiveClient();

  if (redis) {
    try {
      const cacheKey = CacheKeys.vodMeta(tenantId, vodId);
      const cached = await redis.getBuffer(cacheKey);
      if (cached != null && cached.length > 0) {
        const data = (await decompressData(cached)) as VodMeta;
        return {
          created_at: new Date(data.created_at),
          started_at: data.started_at ? new Date(data.started_at) : null,
          duration: data.duration,
          is_live: data.is_live,
        };
      }
    } catch (error) {
      const details = extractErrorDetails(error);
      getLogger().warn({ vodId, ...details }, '[CACHE MISS] vod meta read failed');
    }
  }

  const vod = await db
    .selectFrom('vods')
    .select(['created_at', 'started_at', 'duration', 'is_live'])
    .where('id', '=', vodId)
    .executeTakeFirst(options);

  if (!vod) throw new VodNotFoundError(vodId, 'logs service');

  if (redis) {
    try {
      const cacheKey = CacheKeys.vodMeta(tenantId, vodId);
      const compressed = await compressData(vod);
      await redis.set(cacheKey, compressed, 'EX', Cache.VOD_DETAILS_TTL);
    } catch {
      // Ignore cache errors
    }
  }

  return vod;
}

/**
 * Fetch a single 60-second bucket of chat messages.
 * Checks Redis cache first, falls through to DB, then caches result.
 * Bypasses permanent caching if the stream is live to prevent "poisoning"
 * the cache with empty chat arrays before the worker has downloaded them.
 */
async function fetchSingleBucket(
  db: ReadonlyKysely<StreamerDB>,
  tenantId: string,
  vodId: number,
  bucketStart: number,
  vodMeta: VodMeta,
  options?: { signal?: AbortSignal }
): Promise<SelectableChatMessages[]> {
  const bucketEnd = bucketStart + Logs.BUCKET_SIZE;
  const cacheKey = simpleKeys.bucket(tenantId, vodId, bucketStart);
  const redis = RedisService.getActiveClient();

  let streamStart = vodMeta.created_at;
  let streamEnd = new Date(streamStart.getTime() + (vodMeta.duration + 7200) * 1000);

  if (!vodMeta.started_at) {
    streamStart = new Date(streamStart.getTime() - Logs.LEGACY_PADDING_MS);
    streamEnd = new Date(streamEnd.getTime() + Logs.LEGACY_PADDING_MS);
  }

  if (redis) {
    try {
      const cached = await redis.getBuffer(cacheKey);
      if (cached != null && cached.length > 0) {
        getLogger().debug({ vodId, bucketStart }, '[CACHE HIT] bucket');
        const data = (await decompressData(cached)) as SelectableChatMessages[];
        return data;
      }
    } catch (error) {
      const details = extractErrorDetails(error);
      getLogger().warn({ vodId, bucketStart, ...details }, '[CACHE MISS] bucket read failed');
    }
  }

  const comments = await db
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
    .where('content_offset_seconds', '>=', bucketStart)
    .where('content_offset_seconds', '<', bucketEnd)
    .where('created_at', '>=', streamStart)
    .where('created_at', '<=', streamEnd)
    .orderBy('content_offset_seconds', 'asc')
    .orderBy('created_at', 'asc')
    .limit(Logs.BUCKET_LIMIT)
    .execute(options);

  if (redis) {
    try {
      const ttl = vodMeta.is_live ? 15 : Cache.CHAT_TTL;

      const compressed = await compressData(comments);
      await redis.set(cacheKey, compressed, 'EX', ttl);
      getLogger().debug({ vodId, bucketStart }, '[CACHE SET] bucket');
    } catch {
      // Ignore cache errors
    }
  }

  return comments;
}

/**
 * Bi-directional bucket aggregation with sequential expansion.
 *
 * Fetches the anchor bucket, then expands backward for history (scrub UX)
 * and forward for buffer (anti-spam). Each bucket is fetched from the
 * cached 60-second Lego bricks, preserving CDN cacheability.
 */
async function fetchAggregatedBuckets(
  db: ReadonlyKysely<StreamerDB>,
  tenantId: string,
  vodId: number,
  requestedOffset: number,
  options?: { signal?: AbortSignal }
): Promise<{ comments: SelectableChatMessages[]; cursor?: string | undefined }> {
  const vodMeta = await fetchVodMeta(db, tenantId, vodId, options);

  let streamStart = vodMeta.created_at;
  let streamEnd = new Date(streamStart.getTime() + (vodMeta.duration + 7200) * 1000);

  if (!vodMeta.started_at) {
    streamStart = new Date(streamStart.getTime() - Logs.LEGACY_PADDING_MS);
    streamEnd = new Date(streamEnd.getTime() + Logs.LEGACY_PADDING_MS);
  }

  const anchorBucketStart = Math.floor(requestedOffset / Logs.BUCKET_SIZE) * Logs.BUCKET_SIZE;

  // 1. Fetch anchor bucket
  const anchorComments = await fetchSingleBucket(db, tenantId, vodId, anchorBucketStart, vodMeta, options);

  // 2. Split at requested offset
  const pastComments: SelectableChatMessages[] = anchorComments.filter(
    (c) => c.content_offset_seconds <= requestedOffset
  );
  const futureComments: SelectableChatMessages[] = anchorComments.filter(
    (c) => c.content_offset_seconds > requestedOffset
  );

  // 3. Expand backward for history (scrub UX)
  let backSteps = 1;
  while (pastComments.length < Logs.TARGET_PAST && backSteps <= Logs.MAX_EXPANSION) {
    const prevBucket = anchorBucketStart - backSteps * Logs.BUCKET_SIZE;
    if (prevBucket < 0) break;

    const olderComments = await fetchSingleBucket(db, tenantId, vodId, prevBucket, vodMeta, options);
    pastComments.unshift(...olderComments);
    backSteps++;
  }

  // 4. Expand forward for buffer (anti-spam)
  let forwardSteps = 1;
  while (futureComments.length < Logs.TARGET_FUTURE && forwardSteps <= Logs.MAX_EXPANSION) {
    const nextBucket = anchorBucketStart + forwardSteps * Logs.BUCKET_SIZE;

    const newerComments = await fetchSingleBucket(db, tenantId, vodId, nextBucket, vodMeta, options);
    futureComments.push(...newerComments);
    forwardSteps++;
  }

  // 5. Combine into chronological order
  const allComments: SelectableChatMessages[] = [...pastComments, ...futureComments];

  // 6. Calculate cursor: next un-scanned forward bucket boundary
  let nextCursorOffset: number | null = anchorBucketStart + forwardSteps * Logs.BUCKET_SIZE;

  // 7. Dead air peek: if no future comments found, fast-forward cursor to next actual message
  if (futureComments.length === 0) {
    const peek = await db
      .selectFrom('chat_messages')
      .select(['content_offset_seconds'])
      .where('vod_id', '=', vodId)
      .where('content_offset_seconds', '>=', nextCursorOffset)
      .where('created_at', '>=', streamStart)
      .where('created_at', '<=', streamEnd)
      .orderBy('content_offset_seconds', 'asc')
      .limit(1)
      .executeTakeFirst(options);

    if (peek) {
      nextCursorOffset = Math.floor(peek.content_offset_seconds / Logs.BUCKET_SIZE) * Logs.BUCKET_SIZE;
    } else {
      nextCursorOffset = null;
    }
  }

  const cursor = nextCursorOffset !== null ? encodeCursor(nextCursorOffset) : undefined;

  return {
    comments: allComments,
    cursor,
  };
}

/**
 * Fetch chat comments for a VOD using offset-based pagination.
 * Uses bi-directional bucket aggregation to guarantee minimum comment counts.
 */
export async function getLogsByOffset(
  db: ReadonlyKysely<StreamerDB>,
  tenantId: string,
  vodId: number,
  offsetSeconds: number,
  options?: { signal?: AbortSignal }
): Promise<{ comments: SelectableChatMessages[]; cursor?: string | undefined }> {
  return fetchAggregatedBuckets(db, tenantId, vodId, offsetSeconds, options);
}

/**
 * Fetch chat comments for a VOD using cursor-based pagination.
 * Cursor encodes the offset of the next bucket boundary.
 */
export async function getLogsByCursor(
  db: ReadonlyKysely<StreamerDB>,
  tenantId: string,
  vodId: number,
  cursor: string,
  options?: { signal?: AbortSignal }
): Promise<{ comments: SelectableChatMessages[]; cursor?: string | undefined }> {
  let cursorJson: CursorPayload | null = null;
  try {
    cursorJson = JSON.parse(Buffer.from(cursor, 'base64').toString()) as CursorPayload;
  } catch {
    badRequest('Invalid cursor format');
  }

  if (typeof cursorJson?.offset !== 'number') {
    badRequest('Invalid cursor: missing offset');
  }

  return fetchAggregatedBuckets(db, tenantId, vodId, cursorJson.offset, options);
}
