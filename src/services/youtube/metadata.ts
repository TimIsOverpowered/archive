import { getValidYoutubeToken } from './auth.js';
import { createYoutubeClient } from './api.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';

export async function linkParts(tenantId: string, videoIds: { id: string; part: number }[]): Promise<void> {
  const logger = createAutoLogger('youtube-metadata');
  const accessToken = await getValidYoutubeToken(tenantId);
  const youtube = createYoutubeClient(accessToken);

  const sortedParts = [...videoIds].sort((a, b) => a.part - b.part);

  for (let i = 0; i < sortedParts.length; i++) {
    const { id: videoId } = sortedParts[i];

    const currentVideo = await youtube.videos.list({
      id: [videoId],
    });

    const currentDescription = currentVideo.data?.items?.[0]?.snippet?.description || '';

    const nextPart = sortedParts[i + 1];
    const linkText = nextPart ? `Next: EP ${nextPart.part} (${nextPart.id})` : 'End of series';

    let newDescription = currentDescription;
    if (!newDescription.includes(linkText)) {
      newDescription = currentDescription ? `${currentDescription}\n\n${linkText}` : linkText;
    }

    await youtube.videos.update({
      part: ['snippet'],
      requestBody: {
        id: videoId,
        snippet: {
          description: newDescription,
        },
      },
    });
  }

  logger.info({ tenantId, videoCount: sortedParts.length }, 'Linked YouTube video parts');
}
