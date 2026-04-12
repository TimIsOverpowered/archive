import type { StandardVodJob } from './queues.js';
import { getStandardVodQueue } from './queues.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger({ module: 'vod-job' });

export async function triggerVodDownload(
  tenantId: string,
  dbId: number,
  vodId: string,
  platform: 'twitch' | 'kick',
  downloadMethod?: 'ffmpeg' | 'hls',
  uploadMode?: 'vod' | 'all'
): Promise<string | null> {
  const jobId = `vod_${vodId}`;
  const job: StandardVodJob = {
    tenantId,
    dbId,
    vodId,
    platform,
    downloadMethod,
    uploadMode,
  };

  try {
    const added = await getStandardVodQueue().add('standard_vod_download', job, {
      jobId,
      deduplication: { id: jobId },
    });
    return added.id ?? null;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const isDedup = msg.includes('deduplication');
    if (!isDedup) {
      log.error({ jobId, tenantId, error: msg }, 'Failed to enqueue VOD job');
    }
    return null;
  }
}
