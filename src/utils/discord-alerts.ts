import { extractErrorDetails } from './error.js';
import { request } from './http-client.js';
import { formatDuration } from './formatting.js';
import { logger } from './logger.js';
import { getTenantDisplayName } from '../config/loader.js';

const globalDiscordAlertsEnabled = process.env.DISCORD_ALERTS_ENABLED !== 'false';

export type AlertStatus = 'success' | 'warning' | 'error';

export interface RichEmbedData {
  title: string;
  description?: string;
  status: AlertStatus;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp?: string;
  updatedTimestamp?: string;
  mention?: 'everyone' | 'here' | string;
}

interface DiscordEmbed {
  title: string;
  color: number;
  description?: string;
  fields: Array<{ name: string; value: string; inline: boolean }>;
  timestamp?: string;
  footer?: { text: string };
}

export interface StreamAlertData {
  platform: 'twitch' | 'kick';
  vodId: string;
  alertType: 'in_progress' | 'failure' | 'success';
  streamerName?: string;
  durationSeconds?: number;
  errorMessage?: string;
}

export function isAlertsEnabled(): boolean {
  return globalDiscordAlertsEnabled;
}

function getEmbedColor(status: AlertStatus): number {
  switch (status) {
    case 'success':
      return 0x306934;
    case 'warning':
      return 15158332;
    case 'error':
      return 0xed4245;
  }
}

function constructEmbed(data: RichEmbedData): DiscordEmbed {
  const timestamp = data.timestamp ? new Date(data.timestamp) : new Date();

  const embed: DiscordEmbed = {
    title: data.title,
    color: getEmbedColor(data.status),
    fields:
      data.fields?.map((f) => ({
        name: f.name,
        value: f.value,
        inline: !!f.inline,
      })) || [],
  };

  if (data.description) {
    embed.description = data.description;
  }

  if (data.updatedTimestamp) {
    embed.footer = {
      text: `Started: ${timestamp.toLocaleString()} | Updated: ${new Date(data.updatedTimestamp).toLocaleString()}`,
    };
  } else {
    embed.timestamp = timestamp.toISOString();
  }

  return embed;
}

function getUpdateUrl(webhookUrl: string, messageId: string): string {
  const url = new URL(webhookUrl);
  url.pathname = `${url.pathname}/messages/${messageId}`;
  return url.toString();
}

export async function sendDiscordAlert(message: string): Promise<string | null> {
  if (!isAlertsEnabled()) {
    return null;
  }

  const webhookUrl = process.env.DISCORD_ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    return null;
  }

  try {
    const data = await request<{ id?: string }>(`${webhookUrl}?wait=true`, {
      method: 'POST',
      body: { content: message },
    });

    if (data.id) {
      return data.id;
    }
    return null;
  } catch (err) {
    logger.error(extractErrorDetails(err), 'Failed to send Discord alert');
    return null;
  }
}

export async function sendRichAlert(data: RichEmbedData): Promise<string | null> {
  if (!isAlertsEnabled()) {
    return null;
  }

  const webhookUrl = process.env.DISCORD_ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    return null;
  }

  try {
    const embed = constructEmbed(data);

    const payload: Record<string, unknown> = { embeds: [embed] };

    if (data.mention === 'everyone') {
      payload.content = '@everyone';
    } else if (data.mention === 'here') {
      payload.content = '@here';
    } else if (data.mention) {
      payload.content = `<@&${data.mention}>`;
    }

    const responseData = await request<{ id?: string }>(`${webhookUrl}?wait=true`, {
      method: 'POST',
      body: payload,
    });

    if (responseData.id) {
      return responseData.id;
    }
    return null;
  } catch (err) {
    logger.error(extractErrorDetails(err), 'Failed to send rich Discord alert');
    return null;
  }
}

export async function updateDiscordEmbed(messageId: string, data: RichEmbedData): Promise<void> {
  if (!isAlertsEnabled()) {
    return;
  }

  const webhookUrl = process.env.DISCORD_ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    return;
  }

  try {
    const updateUrl = getUpdateUrl(webhookUrl, messageId);
    const embed = constructEmbed(data);

    await request(updateUrl, {
      method: 'PATCH',
      body: { embeds: [embed] },
    });
  } catch (err) {
    logger.error(extractErrorDetails(err), 'Failed to update Discord embed');
  }
}

const failureCounts = new Map<string, number>();

export function trackFailure(tenantId: string, maxBeforeAlert: number = 3): boolean {
  const currentCount = (failureCounts.get(tenantId) || 0) + 1;
  failureCounts.set(tenantId, currentCount);
  return currentCount >= maxBeforeAlert;
}

export function resetFailures(tenantId: string): void {
  failureCounts.delete(tenantId);
}

export function formatProgressMessage(operation: string, streamerName: string, percent: number, current?: number, total?: number): string {
  const bar = createProgressBarInternal(percent);

  if (total !== undefined && current !== undefined) {
    return `[${operation}] ${streamerName} ${bar} ${Math.round((current / total) * 100)}% (${current}/${total})`;
  }

  return `[${operation}] ${streamerName} ${bar} ${percent}%`;
}

export function createProgressBar(percent: number): string {
  return createProgressBarInternal(percent) + ` ${percent}%`;
}

function createProgressBarInternal(percent: number): string {
  const bars = 20;
  const filled = Math.round((percent / 100) * bars);
  const empty = bars - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

export async function sendStreamAlert(data: StreamAlertData): Promise<string | null> {
  if (!isAlertsEnabled()) {
    return null;
  }

  const webhookUrl = process.env.DISCORD_ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    return null;
  }

  const emojiMap: Record<'in_progress' | 'failure' | 'success', string> = {
    in_progress: '[IN_PROGRESS]',
    failure: '[FAILED]',
    success: '[SUCCESS]',
  };

  const titleMap: Record<'in_progress' | 'failure' | 'success', string> = {
    in_progress: 'Stream Download Started',
    failure: 'Download Failed',
    success: 'Upload Completed Successfully',
  };

  const embedStatus: AlertStatus = data.alertType === 'success' ? 'success' : data.alertType === 'failure' ? 'error' : 'warning';

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: 'Platform', value: data.platform.toUpperCase(), inline: true },
    { name: 'VOD ID', value: `\`${data.vodId}\``, inline: true },
  ];

  if (data.durationSeconds) {
    fields.push({ name: 'Duration', value: formatDuration(data.durationSeconds), inline: true });
  }

  const embedData = {
    title: `${emojiMap[data.alertType]} ${titleMap[data.alertType]}`,
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
    logger.error(extractErrorDetails(err), 'Failed to send stream alert');
    return null;
  }
}

// ============================================================================
// VOD Download Alert Functions
// ============================================================================

/**
 * Send a VOD download started alert
 */
export async function sendVodDownloadStarted(platform: 'kick' | 'twitch', tenantId: string, vodId: string, streamerName?: string): Promise<string | null> {
  if (!isAlertsEnabled()) return null;

  const name = streamerName || getTenantDisplayName(tenantId);
  const platformName = platform.charAt(0).toUpperCase() + platform.slice(1);

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

/**
 * Send a VOD download success alert
 */
export async function sendVodDownloadSuccess(messageId: string, platform: 'kick' | 'twitch', vodId: string, vodPath: string, _streamerName?: string): Promise<void> {
  if (!isAlertsEnabled()) return;

  const platformName = platform.charAt(0).toUpperCase() + platform.slice(1);

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

/**
 * Send a VOD download failed alert
 */
export async function sendVodDownloadFailed(messageId: string, platform: 'kick' | 'twitch', vodId: string, error: string, _tenantId?: string): Promise<void> {
  if (!isAlertsEnabled()) return;

  const platformName = platform.charAt(0).toUpperCase() + platform.slice(1);
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

// ============================================================================
// Generic Alert Helper Functions
// ============================================================================

export interface AlertContext {
  messageId: string | null;
  enabled: boolean;
}

export function createAlertContext(): AlertContext {
  return {
    messageId: null,
    enabled: isAlertsEnabled(),
  };
}

export async function initRichAlert(data: RichEmbedData): Promise<string | null> {
  if (!isAlertsEnabled()) return null;

  try {
    return await sendRichAlert(data);
  } catch {
    return null;
  }
}

export async function updateAlert(messageId: string | null, data: RichEmbedData): Promise<void> {
  if (!messageId || !isAlertsEnabled()) return;
  await updateDiscordEmbed(messageId, data).catch(() => {});
}
