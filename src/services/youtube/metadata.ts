import type { Kysely } from 'kysely';
import type { SelectableChapters, StreamerDB } from '../../db/streamer-types.ts';
import { UPLOAD_TYPES } from '../../types/platforms.ts';
import { createAutoLogger } from '../../utils/auto-tenant-logger.ts';
import dayjs from '../../utils/dayjs.ts';
import { createYoutubeClient } from './client.ts';

/** A part of a VOD with its YouTube video ID. */
export interface PartVideo {
  id: string;
  part: number;
}

/**
 * Removes the generated part-navigation lines (e.g. `PART 2: https://youtube.com/watch?v=...`)
 * from a description so re-linking stays idempotent.
 */
export function stripPartNavigationLinks(description: string): string {
  const lines = description.split('\n');
  const kept = lines.filter((line) => !PART_NAV_LINE_RE.test(line));
  if (kept.length === lines.length) {
    return description;
  }
  return kept.join('\n').replace(/^\n+/, '');
}

export async function saveChaptersAndLinkParts(
  tenantId: string,
  dbId: number,
  uploadedVideos: PartVideo[],
  splitDuration: number,
  db: Kysely<StreamerDB>
): Promise<void> {
  const logger = createAutoLogger('youtube-metadata');
  const youtube = await createYoutubeClient(tenantId);

  const chapters = await db
    .selectFrom('chapters')
    .selectAll()
    .where('vod_id', '=', dbId)
    .orderBy('start', 'asc')
    .execute();

  const hasChapters = chapters.length > 0;

  // Merge the freshly uploaded parts with the stored parts so a single-part re-upload
  // (e.g. a DMCA re-upload) can re-link ALL parts with the current video IDs.
  // The DB rows were upserted before this call, so they are the source of truth.
  const dbRows = await db
    .selectFrom('vod_uploads')
    .select(['upload_id', 'part', 'status'])
    .where('vod_id', '=', dbId)
    .where('type', '=', UPLOAD_TYPES.VOD)
    .where('status', '=', 'COMPLETED')
    .execute();

  const videoIdByPart = new Map<number, string>();
  for (const row of dbRows) {
    videoIdByPart.set(row.part, row.upload_id);
  }

  const newParts = new Set<number>();
  for (const video of uploadedVideos) {
    videoIdByPart.set(video.part, video.id);
    newParts.add(video.part);
  }

  const sortedParts: PartVideo[] = [...videoIdByPart.entries()]
    .map(([part, id]) => ({ id, part }))
    .sort((a, b) => a.part - b.part);

  const needsLinking = sortedParts.length > 1;

  if (!hasChapters && !needsLinking) {
    return;
  }

  let videosWithChapters = 0;
  let videosWithLinks = 0;

  for (let i = 0; i < sortedParts.length; i++) {
    const videoPart = sortedParts[i];
    if (!videoPart) continue;
    const { id: videoId, part: partNum } = videoPart;

    // Only append chapters for freshly uploaded parts; existing parts already have them.
    const isNewPart = newParts.has(partNum);

    const currentVideo = await youtube.videos.list({
      id: [videoId],
      part: ['snippet'],
    });

    const currentSnippet = currentVideo.data?.items?.[0]?.snippet ?? {};
    const currentDescription = currentSnippet.description ?? '';

    let newDescription = stripPartNavigationLinks(currentDescription);

    if (hasChapters && isNewPart) {
      const chapterTimestamps = buildChapterTimestampsForPart(chapters, partNum, splitDuration);
      // Guard against a re-run of this flow duplicating the chapter block
      if (chapterTimestamps != null && chapterTimestamps !== '' && !newDescription.includes(chapterTimestamps)) {
        newDescription += `\n\n${chapterTimestamps}`;
        videosWithChapters++;
      }
    }

    if (needsLinking) {
      const navLinks = buildPartNavigationLinks(sortedParts, videoId);
      if (navLinks != null && navLinks !== '') {
        newDescription = `${navLinks}\n${newDescription}`;
        videosWithLinks++;
      }
    }

    if (newDescription === currentDescription) {
      continue;
    }

    await youtube.videos.update({
      part: ['snippet'],
      requestBody: {
        id: videoId,
        snippet: {
          title: currentSnippet.title ?? null,
          description: newDescription,
          categoryId: currentSnippet.categoryId ?? null,
        },
      },
    });
  }

  logger.info(
    {
      tenantId,
      dbId,
      videoCount: sortedParts.length,
      videosWithChapters,
      videosWithLinks,
      chapterCount: chapters?.length ?? 0,
    },
    'Saved chapters and linked YouTube video parts'
  );
}

function buildChapterTimestampsForPart(chapters: SelectableChapters[], partNum: number, splitDuration: number): string {
  const partStart = splitDuration * (partNum - 1);
  const partEnd = splitDuration * partNum;

  const chaptersInPart = chapters.filter((chapter) => {
    const chapterDuration = chapter.duration ?? 0;
    return chapter.start <= partEnd && chapter.start + chapterDuration >= partStart;
  });

  if (chaptersInPart.length === 0) {
    return '';
  }

  let result = '';
  for (const chapter of chaptersInPart) {
    const relativeTime = Math.max(0, chapter.start - partStart);
    const timestamp = dayjs.duration(relativeTime, 'seconds').format('HH:mm:ss');
    const chapterName = chapter.name ?? `Chapter ${chapter.id}`;
    result += `${timestamp} ${chapterName}\n`;
  }

  return result.trim();
}

/** Matches a generated part-navigation line, e.g. `PART 2: https://youtube.com/watch?v=abc`. */
const PART_NAV_LINE_RE = /^PART \d+: https:\/\/youtube\.com\/watch\?v=\S+$/;

function buildPartNavigationLinks(sortedParts: PartVideo[], currentVideoId: string): string {
  let result = '';

  for (let i = 0; i < sortedParts.length; i++) {
    const part = sortedParts[i];
    if (!part) continue;

    if (part.id === currentVideoId) {
      continue;
    }

    result += `PART ${part.part}: https://youtube.com/watch?v=${part.id}\n`;
  }

  return result.trim();
}
