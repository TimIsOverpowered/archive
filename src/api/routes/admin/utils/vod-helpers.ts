import { FastifyRequest } from 'fastify';
import { getStreamerConfig } from '../../../../config/loader';
import { getClient } from '../../../../db/client';

export interface VodCreateOptions {
  vodId: string;
  platform: 'twitch' | 'kick';
  streamerId: string;
  title?: string | null;
  createdAt?: Date;
  duration?: number;
  streamId?: string | null;
}

export interface QueueEmoteOptions {
  streamerId: string;
  vodId: string;
  platform: 'twitch' | 'kick';
  channelId: string;
  log: FastifyRequest['log'];
}

/**
 * Validates tenant config and platform enablement
 */
export function validateTenantPlatform(streamerId: string, platform: 'twitch' | 'kick'): { config: ReturnType<typeof getStreamerConfig>; error?: Error } {
  const config = getStreamerConfig(streamerId);

  if (!config) {
    return { config: null as any, error: new Error('Tenant not found') };
  }

  if (platform === 'twitch' && !config.twitch?.enabled) {
    return { config, error: new Error('Twitch is not enabled for this tenant') };
  }

  if (platform === 'kick' && !config.kick?.enabled) {
    return { config, error: new Error('Kick is not enabled for this tenant') };
  }

  return { config };
}

/**
 * Gets and validates database client for streamer
 */
export function getValidatedClient(streamerId: string): { client: any; error?: Error } {
  const client = getClient(streamerId);

  if (!client) {
    return { client: null as any, error: new Error('Database not available') };
  }

  return { client };
}

/**
 * Fetches VOD record or returns null if not found
 */
export async function findVodRecord(client: any, vodId: string): Promise<any> {
  try {
    return await client.vod.findUnique({ where: { id: vodId } });
  } catch {
    return null;
  }
}

/**
 * Parses Twitch ISO duration format "PT2H3M15S" to seconds
 */
export function parseTwitchDuration(durationStr: string): number {
  let durStr = String(durationStr).replace('PT', '');
  let hours = 0;
  let minutes = 0;
  let secs = 0;

  if (durStr.includes('H')) {
    [hours] = durStr.split('H').map(Number);
    durStr = durStr.replace(`${Math.floor(hours)}H`, '');
  }
  if (durStr.includes('M')) {
    const mParts = durStr.split('M');
    minutes = parseInt(mParts[0]);
    secs = parseFloat(mParts[1].replace('S', ''));
  } else if (durStr.endsWith('S')) {
    secs = parseFloat(durStr.replace('S', ''));
  }

  return hours * 3600 + minutes * 60 + Math.floor(secs);
}

/**
 * Parses duration from various formats to seconds
 */
export function parseDurationToSeconds(duration: any, platform?: 'twitch' | 'kick'): number {
  if (typeof duration === 'number') {
    return Number(duration);
  }

  if (platform === 'twitch' && typeof duration === 'string') {
    const [hrs, mins, secs] = String(duration).split(':').map(Number);
    return hrs * 3600 + mins * 60 + secs;
  }

  if (typeof duration === 'string' && !isNaN(parseInt(duration))) {
    return parseInt(duration);
  }

  return 0;
}

/**
 * Queues emote fetch job with proper error handling
 */
export async function queueEmoteFetch(options: QueueEmoteOptions): Promise<void> {
  const { streamerId, vodId, platform, channelId, log } = options;

  import('../../../../services/emotes')
    .then(({ fetchAndSaveEmotes }) =>
      fetchAndSaveEmotes(streamerId, vodId, platform, channelId).catch((err: any) => {
        log.error(`[${vodId}] Emote save failed: ${err.message}`);
      })
    )
    .catch((err: any) => {
      log.error(`[${vodId}] Failed to load emotes module: ${err.message}`);
    });

  log.info(`[${streamerId}] Queued async emote fetch for ${vodId} (channel=${channelId})`);
}
