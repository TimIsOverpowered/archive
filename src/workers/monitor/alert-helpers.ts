import { capitalizePlatform, type Platform } from '../../types/platforms.js';
import { sendRichAlert } from '../../utils/discord-alerts.js';
import { createErrorContext } from '../../utils/error.js';
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
