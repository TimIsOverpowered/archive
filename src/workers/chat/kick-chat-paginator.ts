import dayjs from 'dayjs';
import pLimit from 'p-limit';
import { Kick } from '../../constants.js';
import { KickChatWaterfallClient, type KickChatMessage } from '../../services/kick/chat.js';
import { kickCloudflareManager } from '../../services/kick/cloudflare.js';
import { sleep } from '../../utils/delay.js';
import type { AppLogger } from '../../utils/logger.js';

export async function* paginateKickChatCommentsParallel(
  channelId: number | string,
  vodCreatedAt: dayjs.Dayjs,
  durationSeconds: number,
  startOffsetSeconds: number,
  logger: AppLogger
): AsyncGenerator<KickChatMessage[]> {
  const client = new KickChatWaterfallClient(logger);

  const testUrl = `${Kick.API_BASE}/api/v2/channels/${channelId}/messages`;
  try {
    await kickCloudflareManager.ensureValidClearance(testUrl);
  } catch {
    logger.warn({ testUrl }, 'Pre-flight CF check failed. Proceeding without clearance.');
  }

  const CONCURRENCY = Kick.CHAT_FETCH_CONCURRENCY;
  const CHUNK_SIZE = Kick.CHAT_FETCH_CHUNK_SIZE;
  const STEP_SECONDS = Kick.CHAT_FETCH_STEP_SECONDS;
  const STAGGER_MS = Kick.CHAT_FETCH_STAGGER_MS;

  // Snap base time to nearest 5-second floor
  const alignedStart = vodCreatedAt.second(Math.floor(vodCreatedAt.second() / 5) * 5);

  // Ensure startOffset is aligned to 5-second boundary
  const startOffset = Math.floor(startOffsetSeconds / 5) * 5;

  // Pre-calculate all offsets to be fetched
  const allOffsets: number[] = [];
  for (let offset = startOffset; offset <= durationSeconds; offset += STEP_SECONDS) {
    allOffsets.push(offset);
  }

  logger.info(
    { channelId, totalSlots: allOffsets.length, concurrency: CONCURRENCY },
    'Starting Kick chat fetch (Parallel + Chunked)'
  );

  const limit = pLimit(CONCURRENCY);

  try {
    // Process in bounded chunks so we don't load millions of messages into memory
    for (let i = 0; i < allOffsets.length; i += CHUNK_SIZE) {
      const offsetChunk = allOffsets.slice(i, i + CHUNK_SIZE);

      const promises = offsetChunk.map((offset, index) =>
        limit(async () => {
          // Micro-stagger: threads spread over ~250ms (CONCURRENCY * STAGGER_MS)
          await sleep((index % CONCURRENCY) * STAGGER_MS);

          // Build ISO timestamp for Kick API
          const fetchTime = alignedStart.add(offset, 'second');

          try {
            const rawPage = await client.fetchPage(channelId, fetchTime.toISOString());
            return rawPage?.data?.messages ?? [];
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);

            if (msg.includes('429')) {
              logger.warn({ offset }, 'Thread hit 429 Rate Limit. Sleeping for 30s...');
              await sleep(30000);
              return [];
            }

            logger.error({ offset, err: msg }, 'Failed to fetch parallel bucket');
            return [];
          }
        })
      );

      const results = await Promise.all(promises);

      // Flatten and sort strictly by creation time
      const flattenedMessages = results.flat();

      if (flattenedMessages.length > 0) {
        flattenedMessages.sort((a, b) => {
          const aTime = dayjs.utc(a.created_at).valueOf();
          const bTime = dayjs.utc(b.created_at).valueOf();
          return aTime - bTime;
        });
        yield flattenedMessages;
      }
    }
  } finally {
    client.close();
  }
}
