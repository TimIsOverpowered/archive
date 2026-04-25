export type AlertStatus = 'success' | 'warning' | 'error';

export interface RichEmbedData {
  title: string;
  description?: string | undefined;
  status: AlertStatus;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp?: string | undefined;
  updatedTimestamp?: string | undefined;
  mention?: ('everyone' | 'here') | undefined;
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

export function constructEmbed(data: RichEmbedData): DiscordEmbed {
  const timestamp = data.timestamp != null ? new Date(data.timestamp) : new Date();

  const embed: DiscordEmbed = {
    title: data.title,
    color: getEmbedColor(data.status),
    fields:
      data.fields?.map((f) => ({
        name: f.name,
        value: f.value,
        inline: f.inline === true,
      })) ?? [],
  };

  if (data.description != null && data.description !== '') {
    embed.description = data.description;
  }

  if (data.thumbnailUrl != null && data.thumbnailUrl !== '') {
    embed.thumbnail = { url: data.thumbnailUrl };
  }

  if (data.url != null && data.url !== '') {
    embed.url = data.url;
  }

  if (data.updatedTimestamp != null && data.updatedTimestamp !== '') {
    embed.footer = {
      text: `Started: ${timestamp.toLocaleString()} | Updated: ${new Date(data.updatedTimestamp).toLocaleString()}`,
    };
  } else {
    embed.timestamp = timestamp.toISOString();
  }

  return embed;
}

export function createProgressBar(percent: number): string {
  return createProgressBarInternal(percent) + ` ${percent}%`;
}

export function formatProgressMessage(percent: number): string {
  return createProgressBar(percent);
}

function createProgressBarInternal(percent: number): string {
  const bars = 20;
  const filled = Math.round((percent / 100) * bars);
  const empty = bars - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}
