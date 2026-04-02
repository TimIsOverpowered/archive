import { extractErrorDetails } from './error.js';
import { formatDuration } from './formatting.js';
import { logger } from './logger.js';

const globalDiscordAlertsEnabled = process.env.DISCORD_ALERTS_ENABLED !== 'false';

export type AlertStatus = 'success' | 'warning' | 'error';

interface RichEmbedData {
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
    const response = await fetch(`${webhookUrl}?wait=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: message }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) throw new Error(`Webhook failed with status ${response.status}`);

    const data = await response.json();

    if (data.id) {
      return data.id;
    }
    return null;
  } catch (err) {
    logger.error(extractErrorDetails(err), 'Failed to send Discord alert');
    return null;
  }
}

export async function updateDiscordMessage(messageId: string, message: string): Promise<void> {
  if (!isAlertsEnabled()) {
    return;
  }

  const webhookUrl = process.env.DISCORD_ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    return;
  }

  try {
    const updateUrl = getUpdateUrl(webhookUrl, messageId);

    const response = await fetch(updateUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: message }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) throw new Error(`Webhook failed with status ${response.status}`);
  } catch (err) {
    logger.error(extractErrorDetails(err), 'Failed to update Discord message');
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

    const response = await fetch(`${webhookUrl}?wait=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) throw new Error(`Webhook failed with status ${response.status}`);

    const responseData = await response.json();

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

    await fetch(updateUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ embeds: [embed] }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    logger.error(extractErrorDetails(err), 'Failed to update Discord embed');
  }
}

const failureCounts = new Map<string, number>();

export function trackFailure(streamerId: string, maxBeforeAlert: number = 3): boolean {
  const currentCount = (failureCounts.get(streamerId) || 0) + 1;
  failureCounts.set(streamerId, currentCount);
  return currentCount >= maxBeforeAlert;
}

export function resetFailures(streamerId: string): void {
  failureCounts.delete(streamerId);
}

export function createProgressBar(percent: number, total?: number, current?: number): string {
  const bars = 20;
  const filled = Math.round((percent / 100) * bars);
  const empty = bars - filled;

  const bar = '█'.repeat(filled) + '░'.repeat(empty);

  if (total !== undefined && current !== undefined) {
    return `${bar} ${Math.round((current / total) * 100)}% (${current}/${total})`;
  }

  return `${bar} ${percent}%`;
}

export function formatProgressMessage(operation: string, streamerName: string, percent: number, current?: number, total?: number): string {
  const bar = createProgressBar(percent, total, current);
  return `[${operation}] ${streamerName} ${bar}`;
}

export async function sendStreamAlert(data: StreamAlertData): Promise<string | null> {
  if (!isAlertsEnabled()) {
    return null;
  }

  const webhookUrl = process.env.DISCORD_ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    return null;
  }

  const colorMap: Record<'in_progress' | 'failure' | 'success', number> = {
    in_progress: 3447003,
    failure: 15158332,
    success: 3066992,
  };

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
  (embed as any).footer = { text: 'Archive System' };

  try {
    const response = await fetch(`${webhookUrl}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) throw new Error(`Webhook failed with status ${response.status}`);

    const responseData = await response.json();
    return responseData.id || null;
  } catch (err) {
    logger.error(extractErrorDetails(err), 'Failed to send stream alert');
    return null;
  }
}
