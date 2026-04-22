import { LRUCache } from 'lru-cache';
import { getTenantDisplayName } from '../../../config/loader.js';
import { capitalizePlatform, type Platform } from '../../../types/platforms.js';
import { isAlertsEnabled } from '../context.js';
import { updateDiscordEmbed, sendRichAlert } from '../webhook.js';
import { createProgressBar } from '../embed.js';

const lastFfmpegProgressByMessage = new LRUCache<string, number>({
  max: 1000,
  ttl: 5 * 60 * 1000,
  allowStale: false,
});

export async function sendVodDownloadStarted(
  platform: Platform,
  tenantId: string,
  vodId: string,
  streamerName?: string
): Promise<string | null> {
  if (!isAlertsEnabled()) return null;

  const name = streamerName || getTenantDisplayName(tenantId);
  const platformName = capitalizePlatform(platform);

  return sendRichAlert({
    title: `📥 ${platformName} VOD Download Started`,
    description: `${vodId} download in progress for ${name}`,
    status: 'warning',
    fields: [
      { name: 'VOD ID', value: `\`${vodId}\``, inline: false },
      { name: 'Streamer', value: `\`${name}\`` },
    ],
    timestamp: new Date().toISOString(),
  });
}

export async function sendVodDownloadSuccess(
  messageId: string,
  platform: Platform,
  vodId: string,
  vodPath: string,
  _streamerName?: string
): Promise<void> {
  if (!isAlertsEnabled()) return;

  const platformName = capitalizePlatform(platform);

  await updateDiscordEmbed(messageId, {
    title: `✅ ${platformName} VOD Download Complete!`,
    description: `${vodId} successfully downloaded and converted to MP4`,
    status: 'success',
    fields: [
      { name: 'VOD ID', value: `\`${vodId}\``, inline: false },
      { name: 'Output Path', value: vodPath, inline: false },
    ],
    timestamp: new Date().toISOString(),
    updatedTimestamp: new Date().toISOString(),
  });
}

export async function updateFfmpegProgress(
  messageId: string,
  platform: Platform,
  vodId: string,
  percent: number,
  streamerName: string
): Promise<void> {
  if (!isAlertsEnabled()) return;

  const threshold = Math.floor(percent / 25) * 25;
  const lastReported = lastFfmpegProgressByMessage.get(messageId) ?? -1;

  if (threshold <= lastReported) return;

  lastFfmpegProgressByMessage.set(messageId, threshold);

  const platformName = capitalizePlatform(platform);

  await updateDiscordEmbed(messageId, {
    title: `🔄 ${platformName} VOD Converting`,
    description: `${vodId} conversion in progress for ${streamerName}`,
    status: 'warning',
    fields: [
      { name: 'VOD ID', value: `\`${vodId}\``, inline: false },
      { name: 'Streamer', value: streamerName },
      { name: 'Progress', value: createProgressBar(threshold), inline: false },
    ],
    timestamp: new Date().toISOString(),
    updatedTimestamp: new Date().toISOString(),
  });
}

export async function sendVodDownloadFailed(
  messageId: string,
  platform: Platform,
  vodId: string,
  error: string,
  _tenantId?: string
): Promise<void> {
  if (!isAlertsEnabled()) return;

  const platformName = capitalizePlatform(platform);
  const errorMsg = error.substring(0, 500);

  await updateDiscordEmbed(messageId, {
    title: `❌ ${platformName} VOD Download Failed`,
    description: `${vodId} download failed`,
    status: 'error',
    fields: [
      { name: 'VOD ID', value: `\`${vodId}\``, inline: false },
      { name: 'Error', value: errorMsg, inline: false },
    ],
    timestamp: new Date().toISOString(),
    updatedTimestamp: new Date().toISOString(),
  });
}
