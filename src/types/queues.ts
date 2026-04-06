import type { DMCAClaim } from '../utils/dmca.js';

export type VodJobType = 'STANDARD_VOD_DOWNLOAD' | 'LIVE_HLS_DOWNLOAD';

export interface VODDownloadJob {
  tenantId: string;
  platformUserId: string;
  platformUsername?: string;
  vodId: number;
  platform: 'twitch' | 'kick';
  externalVodId?: string;
}

export interface LiveHlsDownloadJob {
  vodId: number;
  platform: 'twitch' | 'kick';
  tenantId: string;
  platformUserId: string;
  platformUsername?: string;
  startedAt?: string;
  sourceUrl?: string;
  isFallback?: boolean;
  uploadAfterDownload?: boolean;
  uploadMode?: 'vod' | 'all';
}

export interface ChatDownloadJob {
  tenantId: string;
  platformUserId: string;
  platformUsername?: string;
  vodId: number;
  platform: 'twitch' | 'kick';
  duration: number;
  vodStartDate?: string;
  startOffset?: number;
}

export interface YoutubeUploadJob {
  tenantId: string;
  vodId: string;
  filePath: string;
  title: string;
  description: string;
  type: 'vod' | 'game';
  platform?: 'twitch' | 'kick';
  part?: number;
  chapter?: {
    name: string;
    start: number;
    end: number;
    gameId?: string;
  };
  dmcaProcessed?: boolean;
}

export interface DmcaProcessingJob {
  tenantId: string;
  vodId: string;
  receivedClaims: DMCAClaim[];
  type: 'vod' | 'live';
  platform: 'twitch' | 'kick';
  part?: number;
}

export interface ChatDownloadResult {
  success: true;
  totalMessages?: number;
  skipped?: boolean;
}

export interface YoutubeUploadVodResult {
  success: true;
  videos: Array<{ id: string; part: number }>;
}

export interface YoutubeUploadGameResult {
  success: true;
  videoId: string;
  gameId?: number;
}

export interface YoutubeUploadSplitGamesResult {
  success: true;
  videos: Array<{ id: string; part: number; startTime: number; endTime: number; gameId?: number }>;
}

export interface YoutubeUploadSkippedResult {
  success: true;
  skipped: boolean;
}

export type YoutubeUploadResult = YoutubeUploadVodResult | YoutubeUploadGameResult | YoutubeUploadSplitGamesResult | YoutubeUploadSkippedResult;

export interface DmcaProcessingSuccessResult {
  success: true;
  youtubeJobId?: string;
  vodId?: string;
  message?: string;
}

export type DmcaProcessingResult = DmcaProcessingSuccessResult;

export const QUEUE_NAMES = {
  VOD_DOWNLOAD: 'vod_download',
  CHAT_DOWNLOAD: 'chat_download',
  YOUTUBE_UPLOAD: 'youtube_upload',
  DMCA_PROCESSING: 'dmca_processing',
} as const;

export const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
};

export const youtubeJobOptions = {
  ...defaultJobOptions,
  attempts: 5,
};

export interface JobLogger {
  info: (context: Record<string, unknown>, message: string) => void;
  debug: (context: Record<string, unknown>, message: string) => void;
}

export interface JobEnqueueResult {
  jobId: string;
  isNew: boolean;
}
