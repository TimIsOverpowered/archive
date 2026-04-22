import { extractErrorDetails } from './error.js';
import { request } from './http-client.js';
import { toHHMMSS } from './formatting.js';
import { getLogger } from './logger.js';
import { LRUCache } from 'lru-cache';
import { getTenantDisplayName } from '../config/loader.js';
import { capitalizePlatform, Platform } from '../types/platforms.js';
import { getBaseConfig, getDiscordAlertWebhookUrl } from '../config/env.js';

export function isAlertsEnabled(): boolean {
  return getBaseConfig().DISCORD_ALERTS_ENABLED;
}

export type AlertStatus = 'success' | 'warning' | 'error';

export interface RichEmbedData {
  title: string;
  description?: string | undefined;
  status: AlertStatus;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp?: string | undefined;
  updatedTimestamp?: string | undefined;
  mention?: ('everyone' | 'here' | string) | undefined;
  thumbnailUrl?: string | undefined;
  url?: string | undefined;
}

interface DiscordEmbed {
  title: string;
  color: number;
  description?: string;
  fields: Array<{ name: string; value: string; inline: boolean }>;
  timestamp?: string;
  footer?: { text: string };
  thumbnail?: { url: string };
  url?: string;
}

export interface StreamAlertData {
  platform: Platform;
  vodId: string;
  alertType: 'in_progress' | 'failure' | 'success';
  streamerName?: string;
  durationSeconds?: number;
  errorMessage?: string;
}

function getEmbedColor(status: AlertStatus): number {
  switch (status) {
    case 'success':
      return 0x306934;
    case 'warning':
      return 0xffcc00;
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

  if (data.thumbnailUrl) {
    embed.thumbnail = { url: data.thumbnailUrl };
  }

  if (data.url) {
    embed.url = data.url;
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

  const webhookUrl = getDiscordAlertWebhookUrl();
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
    getLogger().error(extractErrorDetails(err), 'Failed to send Discord alert');
    return null;
  }
}

export async function sendRichAlert(data: RichEmbedData): Promise<string | null> {
  if (!isAlertsEnabled()) {
    return null;
  }

  const webhookUrl = getDiscordAlertWebhookUrl();
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
    getLogger().error(extractErrorDetails(err), 'Failed to send rich Discord alert');
    return null;
  }
}

export async function updateDiscordEmbed(messageId: string, data: RichEmbedData): Promise<void> {
  if (!isAlertsEnabled()) {
    return;
  }

  const webhookUrl = getDiscordAlertWebhookUrl();
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
    getLogger().error(extractErrorDetails(err), 'Failed to update Discord embed');
  }
}

const failureCounts = new LRUCache<string, number>({
  max: 500,
  ttl: 30 * 60 * 1000,
  allowStale: false,
});

const lastFfmpegProgressByMessage = new LRUCache<string, number>({
  max: 1000,
  ttl: 5 * 60 * 1000,
  allowStale: false,
});

export function trackFailure(tenantId: string, maxBeforeAlert: number = 3): boolean {
  const currentCount = (failureCounts.get(tenantId) ?? 0) + 1;
  failureCounts.set(tenantId, currentCount);
  return currentCount >= maxBeforeAlert;
}

export function resetFailures(tenantId: string): void {
  failureCounts.delete(tenantId);
}

export function formatProgressMessage(percent: number): string {
  return createProgressBar(percent);
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

  const webhookUrl = getDiscordAlertWebhookUrl();
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

  const embedStatus: AlertStatus =
    data.alertType === 'success' ? 'success' : data.alertType === 'failure' ? 'error' : 'warning';

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: 'Platform', value: capitalizePlatform(data.platform), inline: true },
    { name: 'VOD ID', value: `\`${data.vodId}\``, inline: true },
  ];

  if (data.durationSeconds) {
    fields.push({ name: 'Duration', value: toHHMMSS(data.durationSeconds), inline: true });
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
    getLogger().error(extractErrorDetails(err), 'Failed to send stream alert');
    return null;
  }
}

// ============================================================================
// VOD Download Alert Functions
// ============================================================================

/**
 * Send a VOD download started alert
 */
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

/**
 * Send a VOD download success alert
 */
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

// ============================================================================
// FFmpeg Progress Alert Functions
// ============================================================================

/**
 * Update Discord alert with FFmpeg conversion progress (throttled to 25% intervals)
 */
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

/**
 * Send a VOD download failed alert
 */
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
  await updateDiscordEmbed(messageId, data).catch((err) => {
    const details = extractErrorDetails(err);
    getLogger().warn({ ...details }, 'Failed to update Discord embed');
  });
}
