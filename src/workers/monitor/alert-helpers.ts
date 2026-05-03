import { capitalizePlatform, type Platform } from '../../types/platforms.js';
import { sendRichAlert } from '../../utils/discord-alerts.js';
import { createErrorContext } from '../../utils/error.js';
import { toHHMMSS } from '../../utils/formatting.js';
import { getLogger } from '../../utils/logger.js';

export async function sendStreamLiveAlert(
  platform: Platform,
  vodId: string,
  title: string,
  username: string,
  displayName?: string
): Promise<void> {
  const streamerName = displayName ?? username;

  try {
    await sendRichAlert({
      title: '🔴 Stream Going Live',
      description: `${capitalizePlatform(platform)} live stream detected for ${streamerName}`,
      status: 'success',
      fields: [
        { name: 'Platform', value: platform, inline: true },
        { name: 'Streamer', value: `\`${streamerName}\``, inline: true },
        { name: 'Stream ID', value: `\`${vodId}\``, inline: false },
        { name: 'Title', value: title.substring(0, 1024), inline: false },
      ],
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    getLogger().warn({ vodId, ...createErrorContext(error) }, 'Failed to send stream live alert');
  }
}

export async function sendStreamOfflineAlert(
  platform: Platform,
  vodId: string,
  startedAt?: Date,
  username?: string,
  displayName?: string
): Promise<void> {
  const streamerName = displayName ?? username;

  try {
    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
      { name: 'Platform', value: platform, inline: true },
      { name: 'Streamer', value: `\`${streamerName}\``, inline: true },
      { name: 'Stream ID', value: `\`${vodId}\``, inline: false },
    ];

    if (startedAt) {
      const durationSeconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);
      fields.push({ name: 'Duration', value: toHHMMSS(durationSeconds), inline: true });
    }

    await sendRichAlert({
      title: '⚫ Stream Ended',
      description: `${capitalizePlatform(platform)} stream has gone offline for ${streamerName}`,
      status: 'warning',
      fields,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    getLogger().warn({ vodId, ...createErrorContext(error) }, 'Failed to send stream offline alert');
  }
}
