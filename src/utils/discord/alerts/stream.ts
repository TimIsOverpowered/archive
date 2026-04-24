import { request } from '../../http-client.js';
import { toHHMMSS } from '../../formatting.js';
import { extractErrorDetails } from '../../error.js';
import { getLogger } from '../../logger.js';
import { capitalizePlatform, type Platform } from '../../../types/platforms.js';
import { getDiscordAlertWebhookUrl } from '../../../config/env.js';
import { isAlertsEnabled } from '../context.js';
import { constructEmbed } from '../embed.js';

export interface StreamAlertData {
  platform: Platform;
  vodId: string;
  alertType: 'in_progress' | 'failure' | 'success';
  streamerName?: string;
  durationSeconds?: number;
  errorMessage?: string;
}

export async function sendStreamAlert(data: StreamAlertData): Promise<string | null> {
  if (!isAlertsEnabled()) {
    return null;
  }

  const webhookUrl = getDiscordAlertWebhookUrl();
  if (!webhookUrl) {
    return null;
  }

  const statusLabels: Record<'in_progress' | 'failure' | 'success', string> = {
    in_progress: '[IN_PROGRESS]',
    failure: '[FAILED]',
    success: '[SUCCESS]',
  };

  const titleMap: Record<'in_progress' | 'failure' | 'success', string> = {
    in_progress: 'Stream Download Started',
    failure: 'Download Failed',
    success: 'Upload Completed Successfully',
  };

  const embedStatus: import('../embed.js').AlertStatus =
    data.alertType === 'success' ? 'success' : data.alertType === 'failure' ? 'error' : 'warning';

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: 'Platform', value: capitalizePlatform(data.platform), inline: true },
    { name: 'VOD ID', value: `\`${data.vodId}\``, inline: true },
  ];

  if (data.durationSeconds) {
    fields.push({ name: 'Duration', value: toHHMMSS(data.durationSeconds), inline: true });
  }

  const embedData = {
    title: `${statusLabels[data.alertType]} ${titleMap[data.alertType]}`,
    description: data.errorMessage ? `**Error:**\n\`\`\`${data.errorMessage}\`\`\`` : undefined,
    status: embedStatus,
    fields,
    timestamp: new Date().toISOString(),
  };
  const embed = constructEmbed(embedData);
  embed.footer = { text: 'Archive System' };

  try {
    const responseData = await request<{ id?: string }>(`${webhookUrl}?wait=true`, {
      method: 'POST',
      body: { embeds: [embed] },
    });
    return responseData.id || null;
  } catch (err) {
    getLogger().error(extractErrorDetails(err), 'Failed to send stream alert');
    return null;
  }
}
