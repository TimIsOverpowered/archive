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
  type?: SourceType | undefined;
  gameName?: string | undefined;
  epNumber?: number | undefined;
  titleTemplate?: string | undefined;
  gameTitleTemplate?: string | undefined;
  segmentPart?: number | null | undefined;
  vodRecord: Pick<SelectableVods, 'id' | 'title' | 'created_at'>;
}

export interface YoutubeMetadata {
  title: string;
  description: string;
}

const TEMPLATE_VAR_RE = /\{\{(\w+)\}\}/g;

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(TEMPLATE_VAR_RE, (_: string, key: string) => vars[key] ?? '');
}

function truncateTitle(title: string, maxLength: number): string {
  if (title.length <= maxLength) return title;
  return title.slice(0, maxLength);
}

function truncateByVariable(
  template: string,
  vars: Record<string, string>,
  maxLength: number,
  primaryVar = 'vodTitle'
): string {
  const rendered = interpolate(template, vars);
  if (rendered.length <= maxLength) return rendered;

  const allMatches = [...template.matchAll(TEMPLATE_VAR_RE)];
  if (allMatches.length === 0) return truncateTitle(rendered, maxLength);

  const firstVar = allMatches[0]?.[1];
  let varName: string;
  if (!(primaryVar in vars)) {
    varName = firstVar ?? primaryVar;
  } else {
    const primaryMatch = allMatches.find((m) => m[1] === primaryVar);
    if (primaryMatch) {
      varName = primaryVar;
    } else {
      varName = firstVar ?? primaryVar;
    }
  }

  const varValue = vars[varName];
  if (varValue == null) return truncateTitle(rendered, maxLength);

  const templateWithOthers = template.replace(TEMPLATE_VAR_RE, (_: string, k: string) =>
    k === varName ? '' : (vars[k] ?? '')
  );
  const varBudget = maxLength - templateWithOthers.length;

  if (varBudget <= 0) {
    vars[varName] = '';
    return interpolate(template, vars);
  }

  vars[varName] = varValue.slice(0, varBudget);
  return interpolate(template, vars);
}

interface SegmentChapter {
  name: string | null;
  start: number;
  duration: number;
}

/**
 * Computes the ordinal "Part N" number for the current uploaded segment of a game.
 *
 * A VOD's chapters are expanded into uploaded segments (a chapter split into P parts
 * contributes P segments, based on `maxDuration`). A game "counts" only when its total
 * segments across the VOD is > 1 (multiple occurrences and/or split parts). The returned
 * number is the 1-based ordinal among *counting* segments in time order. Returns null when
 * the current game produces exactly one segment (a unique, non-split game) so it renders empty.
 */
export function computeGameSegmentPart(
  chapters: SegmentChapter[],
  currentStart: number,
  part: number,
  maxDuration: number
): number | null {
  if (chapters.length === 0) return null;

  const sorted = [...chapters].sort((a, b) => a.start - b.start);
  const segmentCount = (c: SegmentChapter): number =>
    maxDuration > 0 ? Math.max(1, Math.ceil(c.duration / maxDuration)) : 1;

  const totalsByName = new Map<string, number>();
  for (const c of sorted) {
    const key = c.name ?? '';
    totalsByName.set(key, (totalsByName.get(key) ?? 0) + segmentCount(c));
  }

  let current: SegmentChapter | null = null;
  for (const c of sorted) {
    if (c.start <= currentStart) current = c;
    else break;
  }
  if (current == null) return null;

  const currentTotal = totalsByName.get(current.name ?? '') ?? 0;
  if (currentTotal <= 1) return null;

  let before = 0;
  for (const c of sorted) {
    if (c.start >= current.start) break;
    if ((totalsByName.get(c.name ?? '') ?? 0) > 1) before += segmentCount(c);
  }

  return before + (part - 1) + 1;
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
    gameTitleTemplate,
    segmentPart,
  } = options;

  const dateFormatted = dayjs(vodRecord.created_at).tz(timezone).format('MMMM DD YYYY').toUpperCase();
  const isGameUpload = gameName != null && gameName !== '';

  const platformName = capitalizePlatform(platform);
  const liveOrEmpty = type === SOURCE_TYPES.LIVE ? 'LIVE ' : '';
  const vars = {
    channel: channelName,
    platform: platformName,
    type: liveOrEmpty.trim(),
    vodTitle: vodRecord.title ?? '',
    date: dateFormatted,
    part: part != null && part > 0 ? `PART ${part}` : '',
    game: isGameUpload ? (gameName ?? '') : '',
    ep: epNumber != null ? `EP ${epNumber}` : '',
    segmentPart: segmentPart != null ? `Part ${segmentPart}` : '',
  };

  let title: string;
  const replayPath = isGameUpload ? `/games/${vodRecord.id}` : `/youtube/${vodRecord.id}`;

  if (isGameUpload) {
    if (gameTitleTemplate != null && gameTitleTemplate !== '') {
      title = truncateByVariable(gameTitleTemplate, vars, YouTube.TITLE_MAX_LENGTH, 'game');
    } else {
      title = `${channelName} plays ${gameName} ${epNumber != null ? `EP ${epNumber}` : ''} - ${dateFormatted}`;
    }
  } else {
    if (titleTemplate != null && titleTemplate !== '') {
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
