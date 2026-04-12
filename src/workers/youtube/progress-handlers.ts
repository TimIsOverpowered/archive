import { createYoutubeUploadProgressHandler as createBaseHandler } from '../../utils/youtube-upload-progress.js';

export interface VodUploadProgressOptions {
  messageId: string;
  channelName: string;
  videoTitle: string;
  part?: number;
  totalParts?: number;
}

export interface GameUploadProgressOptions {
  messageId: string;
  channelName: string;
  gameName: string;
  videoTitle?: string;
  part?: number;
  totalParts?: number;
}

export function createVodUploadProgressHandler(options: VodUploadProgressOptions) {
  const { messageId, channelName, videoTitle, part, totalParts } = options;

  return createBaseHandler({
    messageId,
    type: 'vod',
    channelName,
    videoTitle,
    part,
    totalParts,
  });
}

export function createGameUploadProgressHandler(options: GameUploadProgressOptions) {
  const { messageId, channelName, gameName, videoTitle, part, totalParts } = options;

  return createBaseHandler({
    messageId,
    type: 'game',
    channelName,
    gameName,
    videoTitle,
    part,
    totalParts,
  });
}
