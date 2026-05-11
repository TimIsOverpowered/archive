import { VodUpdateSchema } from '../../config/schemas.js';
import { withDbRetry } from '../../db/streamer-client.js';
import { publishVodDurationUpdate } from '../../services/cache-invalidator.js';
import type { TenantContext } from '../../types/context.js';
import { PLATFORMS, type Platform } from '../../types/platforms.js';
import { extractErrorDetails } from '../../utils/error.js';
import { childLogger, getLogger } from '../../utils/logger.js';
import { getMetadata } from '../utils/ffmpeg.js';

const log = childLogger({ module: 'duration-updater' });

/**
 * Duration updater for live HLS downloads.
 * Logs errors at error level and re-throws so callers can retry or handle failures.
 * The caller (hls-orchestrator) handles this as fire-and-forget via .catch().
 */
export async function updateVodDurationDuringDownload(
  ctx: TenantContext,
  dbId: number,
  vodId: string,
  platform: Platform,
  m3u8Path?: string,
  m3u8Content?: string
): Promise<void> {
  try {
    let duration: number | null = null;

    // Twitch: try parsing #EXT-X-TWITCH-TOTAL-SECS from m3u8 content first
    if (platform === PLATFORMS.TWITCH && m3u8Content != null) {
      duration = parseTwitchTotalDuration(m3u8Content);

      // Fallback to ffprobe on m3u8 file if tag not found
      if (duration == null && m3u8Path != null) {
        log.debug({ vodId }, 'Twitch tag not found, falling back to ffprobe');
        duration = (await getMetadata(m3u8Path))?.duration ?? null;
      }
    }
    // Other platforms: ffprobe on m3u8 file
    else if (m3u8Path != null) {
      duration = (await getMetadata(m3u8Path))?.duration ?? null;
    }

    // No duration found
    if (duration == null || duration <= 0) {
      return;
    }

    // Update DB if duration increased
    let shouldPublish = false;
    const current = await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
      const row = await db.selectFrom('vods').select(['duration', 'is_live']).where('id', '=', dbId).executeTakeFirst();

      if (row?.duration != null && row.duration >= duration) {
        return row;
      }

      VodUpdateSchema.parse({ duration });
      await db.updateTable('vods').set({ duration }).where('id', '=', dbId).execute();

      shouldPublish = true;
      log.debug({ vodId, duration, previous: row?.duration }, 'Duration updated');
      return row;
    });

    if (shouldPublish) {
      try {
        await publishVodDurationUpdate(ctx.tenantId, dbId, duration, current?.is_live ?? false);
      } catch (error) {
        log.warn({ error: extractErrorDetails(error).message, dbId, vodId }, 'Failed to publish duration update');
      }
    }
  } catch (error) {
    getLogger().error(
      { vodId, dbId, error: extractErrorDetails(error).message },
      'Duration update failed — VOD duration will not be updated, downstream workers may produce incorrect splits'
    );
    throw error;
  }
}

/**
 * Parse #EXT-X-TWITCH-TOTAL-SECS tag from m3u8 content.
 * hls-parser does not support custom tags, so we use regex.
 */
function parseTwitchTotalDuration(m3u8Content: string): number | null {
  try {
    const match = m3u8Content.match(/#EXT-X-TWITCH-TOTAL-SECS:(\d+)/);
    return match?.[1] != null ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}
