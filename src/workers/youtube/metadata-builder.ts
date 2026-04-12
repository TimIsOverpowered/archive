import dayjs from '../../utils/dayjs.js';
import { capitalizePlatform } from '../../utils/formatting.js';

export interface YoutubeMetadataOptions {
  channelName: string;
  platform: string;
  vodDate: Date;
  vodTitle?: string;
  domainName: string;
  timezone: string;
  youtubeDescription?: string;
  part?: number;
  type?: 'vod' | 'live' | 'game';
  gameName?: string;
  epNumber?: number;
}

export interface YoutubeMetadata {
  title: string;
  description: string;
}

export function buildYoutubeMetadata(options: YoutubeMetadataOptions): YoutubeMetadata {
  const { channelName, platform, vodDate, vodTitle, domainName, timezone, youtubeDescription, part, type = 'vod', gameName, epNumber } = options;

  const platformName = capitalizePlatform(platform).toUpperCase();
  const dateFormatted = dayjs(vodDate).tz(timezone).format('MMMM DD YYYY').toUpperCase();

  let title: string;
  let description: string;

  if (type === 'game' && gameName) {
    title = `${channelName} plays ${gameName} EP ${epNumber ?? 1} - ${dateFormatted}`;
    description = `Chat Replay: https://${domainName}/games/${vodDate.toISOString().split('T')[0]}\nStream Title: ${vodTitle?.replace(/>|</gi, '') || ''}\n${youtubeDescription || ''}`;
  } else {
    const baseTitle = `${channelName} ${platformName}${type === 'live' ? ' LIVE' : ''} VOD - ${dateFormatted}`;
    title = part ? `${baseTitle} PART ${part}` : baseTitle;
    const replayPath = type === 'vod' || type === 'live' ? `youtube/${vodDate.toISOString().split('T')[0]}` : `games/${vodDate.toISOString().split('T')[0]}`;
    description = `Chat Replay: https://${domainName}/${replayPath}\nStream Title: ${vodTitle?.replace(/>|</gi, '') || ''}\n${youtubeDescription || ''}`;
  }

  return { title, description };
}
