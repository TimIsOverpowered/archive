import type { Platform, SourceType, UploadType, DownloadMethod } from '../../types/platforms.js';
import type { DMCAClaim } from '../dmca/dmca.js';

export interface BaseJobData {
  tenantId: string;
  dbId: number;
  vodId: string;
  platform: Platform;
}

export interface LiveDownloadJob extends BaseJobData {
  platformUserId: string;
  platformUsername?: string | undefined;
  startedAt?: string | undefined;
  sourceUrl?: string | undefined;
}

export interface StandardVodJob extends BaseJobData {
  platformUserId: string;
  platformUsername: string;
  sourceUrl?: string | undefined;
  downloadMethod?: DownloadMethod | undefined;
}

export interface ChatDownloadJob extends BaseJobData {
  displayName?: string | undefined;
  platformUserId?: string | undefined;
  platformUsername?: string | undefined;
  duration: number;
  startOffset?: number | undefined;
  forceRerun?: boolean | undefined;
}

export interface YoutubeVodUploadJob extends BaseJobData {
  kind: 'vod';
  filePath?: string | undefined;
  type: SourceType;
  dmcaProcessed?: boolean | undefined;
  part?: number | undefined;
}

export interface YoutubeGameUploadJob extends BaseJobData {
  kind: 'game';
  filePath?: string | undefined;
  type: UploadType;
  chapterId: number;
  chapterName: string;
  chapterStart: number;
  chapterDuration: number;
  chapterEnd: number;
  chapterGameId?: string | undefined;
  description: string;
  epNumber: number;
  gameTitle?: string | undefined;
}

export type YoutubeUploadJob = YoutubeVodUploadJob | YoutubeGameUploadJob;

export interface DmcaProcessingJob extends BaseJobData {
  receivedClaims: DMCAClaim[];
  type: SourceType;
  part?: number | undefined;
  filePath?: string | undefined;
  gameId?: number | undefined;
  gameStart?: number | undefined;
  gameDuration?: number | undefined;
}

export interface MonitorJob {
  tenantId?: string;
  platform?: Platform;
}

export interface ChatDownloadResult {
  success: true;
  totalMessages?: number;
  batchCount?: number;
  skipped?: boolean;
}

export interface LiveDownloadResult {
  success: true;
}

export interface StandardVodResult {
  success: true;
  finalPath: string;
}

export interface YoutubeUploadVodResult {
  success: true;
  videos: Array<{ id: string; part: number }>;
}

export interface YoutubeUploadGameResult {
  success: true;
  videoId: string;
  gameId: string;
}

export interface YoutubeUploadSplitGameResult {
  success: true;
  videos: Array<{ id: string; part: number; startTime: number; endTime: number; gameId: string }>;
}

export interface YoutubeUploadSkippedResult {
  success: true;
  skipped: boolean;
}

export type YoutubeUploadResult =
  | YoutubeUploadVodResult
  | YoutubeUploadGameResult
  | YoutubeUploadSplitGameResult
  | YoutubeUploadSkippedResult;

export interface DmcaProcessingSuccessResult {
  success: true;
  youtubeJobId?: string;
  vodId?: string;
  message?: string;
}

export type DmcaProcessingResult = DmcaProcessingSuccessResult;
