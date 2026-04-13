import dayjs from '../../utils/dayjs.js';
import type { SourceType, UploadType } from '../../types/platforms.js';
import { SOURCE_TYPES, UPLOAD_TYPES } from '../../types/platforms.js';

export interface YoutubeMetadataOptions {
  channelName: string;
  platform: string;
  vodDate: Date;
  vodTitle?: string;
  domainName: string;
  timezone: string;
  youtubeDescription?: string;
  part?: number;
  type?: SourceType | UploadType;
  gameName?: string;
  epNumber?: number;
}

export interface YoutubeMetadata {
  title: string;
  description: string;
}

export function buildYoutubeMetadata(options: YoutubeMetadataOptions): YoutubeMetadata {
  const { channelName, platform, vodDate, vodTitle, domainName, timezone, youtubeDescription, part, type = UPLOAD_TYPES.VOD, gameName, epNumber } = options;

  const platformName = platform.charAt(0).toUpperCase() + platform.slice(1).toUpperCase();
  const dateFormatted = dayjs(vodDate).tz(timezone).format('MMMM DD YYYY').toUpperCase();

  let title: string;
  let description: string;

  if (type === UPLOAD_TYPES.GAME && gameName) {
    title = `${channelName} plays ${gameName} EP ${epNumber ?? 1} - ${dateFormatted}`;
    description = `Chat Replay: https://${domainName}/games/${vodDate.toISOString().split('T')[0]}\nStream Title: ${vodTitle?.replace(/>|</gi, '') || ''}\n${youtubeDescription || ''}`;
  } else {
    const baseTitle = `${channelName} ${platformName}${type === SOURCE_TYPES.LIVE ? ' LIVE' : ''} VOD - ${dateFormatted}`;
    title = part ? `${baseTitle} PART ${part}` : baseTitle;
    const replayPath = type === UPLOAD_TYPES.VOD || type === SOURCE_TYPES.LIVE ? `youtube/${vodDate.toISOString().split('T')[0]}` : `games/${vodDate.toISOString().split('T')[0]}`;
    description = `Chat Replay: https://${domainName}/${replayPath}\nStream Title: ${vodTitle?.replace(/>|</gi, '') || ''}\n${youtubeDescription || ''}`;
  }

  return { title, description };
}
