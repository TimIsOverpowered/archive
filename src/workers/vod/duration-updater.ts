import { withDbRetry } from '../../db/client.js';
import { extractErrorDetails } from '../../utils/error.js';
import { childLogger } from '../../utils/logger.js';
import { PLATFORMS, type Platform } from '../../types/platforms.js';
import { getDuration } from '../utils/ffmpeg.js';
import type { TenantContext } from '../../types/context.js';
import { VodUpdateSchema } from '../../config/schemas.js';

const log = childLogger({ module: 'duration-updater' });

/**
 * Fire-and-forget duration updater for live HLS downloads.
 * Never throws - all errors are caught and logged internally.
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
    if (platform === PLATFORMS.TWITCH && m3u8Content) {
      duration = parseTwitchTotalDuration(m3u8Content);

      // Fallback to ffprobe on m3u8 file if tag not found
      if (!duration && m3u8Path) {
        log.debug({ vodId }, 'Twitch tag not found, falling back to ffprobe');
        duration = await getDuration(m3u8Path);
      }
    }
    // Other platforms: ffprobe on m3u8 file
    else if (m3u8Path) {
      duration = await getDuration(m3u8Path);
    }

    // No duration found
    if (!duration || duration <= 0) {
      return;
    }

    // Update DB if duration increased
    await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
      const current = await db.vod.findUnique({
        where: { id: dbId },
        select: { duration: true },
      });

      // Skip update if current duration is already >= new duration
      if (current?.duration && current.duration >= duration) {
        return;
      }

      VodUpdateSchema.parse({ duration });
      await db.vod.update({
        where: { id: dbId },
        data: { duration },
      });

      log.debug({ vodId, duration, previous: current?.duration }, 'Duration updated');
    });
  } catch (error) {
    // Fire-and-forget: log but never throw
    log.debug({ vodId, error: extractErrorDetails(error).message }, 'Duration update failed (non-fatal)');
  }
}

/**
 * Parse #EXT-X-TWITCH-TOTAL-SECS tag from m3u8 content.
 * hls-parser does not support custom tags, so we use regex.
 */
function parseTwitchTotalDuration(m3u8Content: string): number | null {
  try {
    const match = m3u8Content.match(/#EXT-X-TWITCH-TOTAL-SECS:(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}
