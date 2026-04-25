import dayjs from '../../utils/dayjs.js';
import type { Platform, SourceType } from '../../types/platforms.js';
import { capitalizePlatform, SOURCE_TYPES } from '../../types/platforms.js';
import type { VodRecord } from '../../types/db.js';

export interface YoutubeMetadataOptions {
  channelName: string;
  platform: Platform;
  domainName: string;
  timezone: string;
  youtubeDescription?: string | undefined;
  part?: number | undefined;
  type: SourceType;
  gameName?: string | undefined;
  epNumber?: number | undefined;
  vodRecord: VodRecord;
}

export interface YoutubeMetadata {
  title: string;
  description: string;
}

export function buildYoutubeMetadata(options: YoutubeMetadataOptions): YoutubeMetadata {
  const { channelName, platform, vodRecord, domainName, timezone, youtubeDescription, part, type } = options;

  const platformName = capitalizePlatform(platform);
  const dateFormatted = dayjs(vodRecord.created_at).tz(timezone).format('MMMM DD YYYY').toUpperCase();

  const baseTitle = `${channelName} ${platformName}${type === SOURCE_TYPES.LIVE ? ' LIVE' : ''} VOD - ${dateFormatted}`;
  const title = part != null && part > 0 ? `${baseTitle} PART ${part}` : baseTitle;
  const replayPath = `/vods/${vodRecord.id}`;
  const description = `Chat Replay: https://${domainName}${replayPath}\nStream Title: ${vodRecord.title?.replace(/<[^>]*>/g, '') ?? ''}\n${youtubeDescription ?? ''}`;

  return { title, description };
}
