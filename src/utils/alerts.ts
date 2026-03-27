import axios from 'axios';

const globalDiscordAlertsEnabled = process.env.DISCORD_ALERTS_ENABLED !== 'false';

export function isAlertsEnabled(): boolean {
  return globalDiscordAlertsEnabled;
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
    const response = await axios.post(webhookUrl, {
      content: message,
    });

    if (response.data.id) {
      return response.data.id;
    }
    return null;
  } catch (err) {
    console.error('Failed to send Discord alert:', err);
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

    await axios.patch(updateUrl, {
      content: message,
    });
  } catch (err) {
    console.error('Failed to update Discord message:', err);
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
