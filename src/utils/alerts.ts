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

export async function sendDiscordAlert(message: string): Promise<string | null> {
  if (!isAlertsEnabled()) {
    return null;
  }

  const webhookUrl = process.env.DISCORD_ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    return null;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json' as any,
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
    logger.error({ err }, 'Failed to send Discord alert');
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
    const webhookData = webhookUrl.split('/');
    webhookData.pop();
    const guildId = webhookData.pop();
    const webhookId = webhookData.pop();
    const updateUrl = `${webhookData.join('/')}/${guildId}/${webhookId}/messages/${messageId}`;

    await fetch(updateUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json' as any,
      },
      body: JSON.stringify({ content: message }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to update Discord message');
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
    const embed: any = {
      title: data.title,
      color: getEmbedColor(data.status),
      fields: [],
    };

    if (data.description) {
      embed.description = data.description;
    }

    if (data.fields && data.fields.length > 0) {
      embed.fields = data.fields.map((f) => ({
        name: f.name,
        value: f.value,
        inline: f.inline || false,
      }));
    }

    const timestamp = data.timestamp ? new Date(data.timestamp).toISOString() : new Date().toISOString();

    if (data.updatedTimestamp) {
      embed.footer = {
        text: `Started: ${new Date(timestamp).toLocaleString()} | Updated: ${new Date(data.updatedTimestamp).toLocaleString()}`,
      };
    } else {
      embed.timestamp = timestamp;
    }

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json' as any,
      },
      body: JSON.stringify({ embeds: [embed] }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) throw new Error(`Webhook failed with status ${response.status}`);

    const responseData = await response.json();

    if (responseData.id) {
      return responseData.id;
    }
    return null;
  } catch (err) {
    logger.error({ err }, 'Failed to send rich Discord alert');
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
    const webhookData = webhookUrl.split('/');
    webhookData.pop();
    const guildId = webhookData.pop();
    const webhookId = webhookData.pop();
    const updateUrl = `${webhookData.join('/')}/${guildId}/${webhookId}/messages/${messageId}`;

    const embed: any = {
      title: data.title,
      color: getEmbedColor(data.status),
      fields: [],
    };

    if (data.description) {
      embed.description = data.description;
    }

    if (data.fields && data.fields.length > 0) {
      embed.fields = data.fields.map((f) => ({
        name: f.name,
        value: f.value,
        inline: f.inline || false,
      }));
    }

    const timestamp = data.timestamp ? new Date(data.timestamp).toISOString() : new Date().toISOString();

    if (data.updatedTimestamp) {
      embed.footer = {
        text: `Started: ${new Date(timestamp).toLocaleString()} | Updated: ${new Date(data.updatedTimestamp).toLocaleString()}`,
      };
    } else {
      embed.timestamp = timestamp;
    }

    await fetch(updateUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json' as any,
      },
      body: JSON.stringify({ embeds: [embed] }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to update Discord embed');
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
