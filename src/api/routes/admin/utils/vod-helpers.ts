import { FastifyRequest } from 'fastify';
import { getTenantConfig } from '../../../../config/loader';
import { getClient } from '../../../../db/client.js';

type StreamerDbClient = NonNullable<ReturnType<typeof getClient>>;

export interface VodCreateOptions {
  vodId: number;
  platform: 'twitch' | 'kick';
  tenantId: string;
  title?: string | null;
  createdAt?: Date;
  duration?: number;
  streamId?: string | null;
}

export interface QueueEmoteOptions {
  tenantId: string;
  vodId: number;
  platform: 'twitch' | 'kick';
  platformId: string;
  log: FastifyRequest['log'];
}

/**
 * Validates tenant config and platform enablement
 */
export function validateTenantPlatform(tenantId: string, platform: 'twitch' | 'kick'): { config: ReturnType<typeof getTenantConfig> | null; error?: Error } {
  const config = getTenantConfig(tenantId);

  if (!config) {
    return { config: null, error: new Error('Tenant not found') };
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
export function getValidatedClient(tenantId: string): { client: StreamerDbClient | null; error?: Error } {
  const client = getClient(tenantId);
  if (!client) return { client: null, error: new Error('Database not available') };
  return { client };
}

/**
 * Fetches VOD record or returns null if not found
 */
export async function findVodRecord(client: StreamerDbClient, vodId: number | string, platform?: 'twitch' | 'kick'): Promise<unknown> {
  try {
    if (platform) {
      return await client.vod.findUnique({ where: { platform_vod_id: { platform, vod_id: String(vodId) } } });
    }
    return await client.vod.findFirst({ where: { vod_id: String(vodId) } });
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
export function parseDurationToSeconds(duration: number | string, platform?: 'twitch' | 'kick'): number {
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
  const { tenantId, vodId, platform, platformId, log } = options;

  void import('../../../../services/emotes')
    .then(({ fetchAndSaveEmotes }) =>
      fetchAndSaveEmotes(tenantId, vodId, platform, platformId).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[${vodId}] Emote save failed: ${msg}`);
      })
    )
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[${vodId}] Emote save failed: ${msg}`);
    });

  log.info(`[${tenantId}] Queued async emote fetch for ${vodId} (platform=${platform}) (platformId=${platformId})`);
}
