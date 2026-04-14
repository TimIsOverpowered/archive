import dayjs from '../../utils/dayjs.js';
import type { SourceType, UploadType } from '../../types/platforms.js';
import { SOURCE_TYPES, UPLOAD_TYPES } from '../../types/platforms.js';
import type { VodRecord } from '../../types/db.js';

export interface YoutubeMetadataOptions {
  channelName: string;
  platform: string;
  domainName: string;
  timezone: string;
  youtubeDescription?: string;
  part?: number;
  type?: SourceType | UploadType;
  gameName?: string;
  epNumber?: number;
  vodRecord: VodRecord;
}

export interface YoutubeMetadata {
  title: string;
  description: string;
}

export function buildYoutubeMetadata(options: YoutubeMetadataOptions): YoutubeMetadata {
  const { channelName, platform, vodRecord, domainName, timezone, youtubeDescription, part, type = UPLOAD_TYPES.VOD, gameName, epNumber } = options;

  const platformName = platform.charAt(0).toUpperCase() + platform.slice(1).toUpperCase();
  const dateFormatted = dayjs(vodRecord.created_at).tz(timezone).format('MMMM DD YYYY').toUpperCase();

  let title: string;
  let description: string;

  const baseTitle = `${channelName} ${platformName}${type === SOURCE_TYPES.LIVE ? ' LIVE' : ''} VOD - ${dateFormatted}`;
  title = part ? `${baseTitle} PART ${part}` : baseTitle;
  const replayPath = `/vods/${vodRecord.id}`;
  description = `Chat Replay: https://${domainName}${replayPath}\nStream Title: ${vodRecord.title?.replace(/>|</gi, '') || ''}\n${youtubeDescription || ''}`;

  return { title, description };
}
