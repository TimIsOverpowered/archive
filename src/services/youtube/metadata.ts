import type { PrismaClient, Chapter } from '../../../generated/streamer/client.js';
import dayjs from '../../utils/dayjs.js';
import { createYoutubeClient } from './client.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';

export async function saveChaptersAndLinkParts(
  tenantId: string,
  dbId: number,
  uploadedVideos: { id: string; part: number }[],
  splitDuration: number,
  db: PrismaClient
): Promise<void> {
  const logger = createAutoLogger('youtube-metadata');
  const youtube = await createYoutubeClient(tenantId);

  const chapters = await db.chapter.findMany({
    where: { vod_id: dbId },
    orderBy: { start: 'asc' },
  });

  const hasChapters = chapters && chapters.length > 0;
  const needsLinking = uploadedVideos.length > 1;

  if (!hasChapters && !needsLinking) {
    return;
  }

  const sortedParts = [...uploadedVideos].sort((a, b) => a.part - b.part);

  let videosWithChapters = 0;
  let videosWithLinks = 0;

  for (let i = 0; i < sortedParts.length; i++) {
    const { id: videoId, part: partNum } = sortedParts[i];

    const currentVideo = await youtube.videos.list({
      id: [videoId],
      part: ['snippet'],
    });

    const currentSnippet = currentVideo.data?.items?.[0]?.snippet || {};
    const currentDescription = currentSnippet.description || '';

    let newDescription = currentDescription;

    if (hasChapters) {
      const chapterTimestamps = buildChapterTimestampsForPart(chapters, partNum, splitDuration);
      if (chapterTimestamps) {
        newDescription += '\n\n' + chapterTimestamps;
        videosWithChapters++;
      }
    }

    if (needsLinking) {
      const navLinks = buildPartNavigationLinks(sortedParts, videoId);
      if (navLinks) {
        newDescription = navLinks + '\n' + newDescription;
        videosWithLinks++;
      }
    }

    await youtube.videos.update({
      part: ['snippet'],
      requestBody: {
        id: videoId,
        snippet: {
          title: currentSnippet.title,
          description: newDescription,
          categoryId: currentSnippet.categoryId,
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
      chapterCount: chapters?.length || 0,
    },
    'Saved chapters and linked YouTube video parts'
  );
}

function buildChapterTimestampsForPart(chapters: Chapter[], partNum: number, splitDuration: number): string {
  const partStart = splitDuration * (partNum - 1);
  const partEnd = splitDuration * partNum;

  const chaptersInPart = chapters.filter((chapter) => {
    const chapterEnd = chapter.end ?? chapter.start;
    return chapter.start <= partEnd && chapter.start + chapterEnd >= partStart;
  });

  if (chaptersInPart.length === 0) {
    return '';
  }

  let result = '';
  for (const chapter of chaptersInPart) {
    const relativeTime = Math.max(0, chapter.start - partStart);
    const timestamp = dayjs.duration(relativeTime, 'seconds').format('HH:mm:ss');
    const chapterName = chapter.name || `Chapter ${chapter.id}`;
    result += `${timestamp} ${chapterName}\n`;
  }

  return result.trim();
}

function buildPartNavigationLinks(sortedParts: { id: string; part: number }[], currentVideoId: string): string {
  let result = '';

  for (let i = 0; i < sortedParts.length; i++) {
    const part = sortedParts[i];

    if (part.id === currentVideoId) {
      continue;
    }

    result += `PART ${part.part}: https://youtube.com/watch?v=${part.id}\n`;
  }

  return result.trim();
}
