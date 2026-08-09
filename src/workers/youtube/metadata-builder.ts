import { YouTube } from '../../constants.js';
import type { SelectableVods } from '../../db/streamer-types.js';
import type { Platform, SourceType } from '../../types/platforms.js';
import { capitalizePlatform, SOURCE_TYPES } from '../../types/platforms.js';
import dayjs from '../../utils/dayjs.js';

function sanitizeYoutubeText(text: string): string {
  return text.replace(/[<>]/g, '');
}

export interface YoutubeMetadataOptions {
  channelName: string;
  platform: Platform;
  domainName: string;
  timezone: string;
  youtubeDescription?: string | undefined;
  chatDownload?: boolean | undefined;
  part?: number | undefined;
  type?: SourceType;
  gameName?: string | undefined;
  epNumber?: number | undefined;
  titleTemplate?: string | undefined;
  vodRecord: Pick<SelectableVods, 'id' | 'title' | 'created_at'>;
}

export interface YoutubeMetadata {
  title: string;
  description: string;
}

const TEMPLATE_VAR_RE = /\{\{(\w+)\}\}/g;

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(TEMPLATE_VAR_RE, (_, key) => vars[key] ?? '');
}

function truncateTitle(title: string, maxLength: number): string {
  if (title.length <= maxLength) return title;
  return title.slice(0, maxLength);
}

function truncateByVariable(template: string, vars: Record<string, string>, maxLength: number): string {
  const rendered = interpolate(template, vars);
  if (rendered.length <= maxLength) return rendered;

  const allMatches = [...template.matchAll(TEMPLATE_VAR_RE)];
  if (allMatches.length === 0) return truncateTitle(rendered, maxLength);

  const firstVar = allMatches[0]![1];
  let varName: string;
  if (!('vodTitle' in vars)) {
    varName = firstVar ?? 'vodTitle';
  } else {
    const vodTitleMatch = allMatches.find((m) => m[1] === 'vodTitle');
    if (vodTitleMatch) {
      varName = 'vodTitle';
    } else {
      varName = firstVar ?? 'vodTitle';
    }
  }

  const varValue = vars[varName];
  if (varValue == null) return truncateTitle(rendered, maxLength);

  const templateWithOthers = template.replace(TEMPLATE_VAR_RE, (_, k) => (k === varName ? '' : (vars[k] ?? '')));
  const varBudget = maxLength - templateWithOthers.length;

  if (varBudget <= 0) {
    vars[varName] = '';
    return interpolate(template, vars);
  }

  vars[varName] = varValue.slice(0, varBudget);
  return interpolate(template, vars);
}

export function buildYoutubeMetadata(options: YoutubeMetadataOptions): YoutubeMetadata {
  const {
    channelName,
    platform,
    vodRecord,
    domainName,
    timezone,
    youtubeDescription,
    chatDownload,
    part,
    type,
    gameName,
    epNumber,
    titleTemplate,
  } = options;

  const dateFormatted = dayjs(vodRecord.created_at).tz(timezone).format('MMMM DD YYYY').toUpperCase();
  const isGameUpload = gameName != null && gameName !== '';

  let title: string;
  const replayPath = isGameUpload ? `/games/${vodRecord.id}` : `/youtube/${vodRecord.id}`;

  if (isGameUpload) {
    title = `${channelName} plays ${gameName} ${epNumber != null ? `EP ${epNumber}` : ''} - ${dateFormatted}`;
  } else {
    const platformName = capitalizePlatform(platform);
    const liveOrEmpty = type === SOURCE_TYPES.LIVE ? 'LIVE ' : '';

    if (titleTemplate != null && titleTemplate !== '') {
      const vars = {
        channel: channelName,
        platform: platformName,
        type: liveOrEmpty.trim(),
        vodTitle: vodRecord.title ?? '',
        date: dateFormatted,
        part: part != null && part > 0 ? `PART ${part}` : '',
      };
      title = truncateByVariable(titleTemplate, vars, YouTube.TITLE_MAX_LENGTH);
    } else {
      const baseTitle = `${channelName} ${platformName} ${liveOrEmpty}VOD - ${dateFormatted}`;
      title = part != null && part > 0 ? `${baseTitle} PART ${part}` : baseTitle;
    }
  }

  // Truncate structured title if it exceeds the limit
  if (title.length > YouTube.TITLE_MAX_LENGTH) {
    title = truncateTitle(title, YouTube.TITLE_MAX_LENGTH);
  }

  const sanitizedTitle = vodRecord.title != null && vodRecord.title !== '' ? sanitizeYoutubeText(vodRecord.title) : '';
  const sanitizedDesc =
    youtubeDescription != null && youtubeDescription !== '' ? sanitizeYoutubeText(youtubeDescription) : '';
  const chatLine = (chatDownload ?? true) ? `Chat Replay: https://${domainName}${replayPath}\n` : '';
  const description = `${chatLine}Stream Title: ${sanitizedTitle}\n${sanitizedDesc}`;

  return { title, description };
}
