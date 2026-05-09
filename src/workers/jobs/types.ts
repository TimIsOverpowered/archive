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
  skipFinalize?: boolean; // If true, finalization is handled by downstream consumer
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
  workDir?: string | undefined;
  skipFinalize?: boolean | undefined;
  streamId?: string | undefined;
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
  chapterImage?: string | null | undefined;
  epNumber: number;
  gameTitle?: string | undefined;
  workDir?: string | undefined;
  sourceType?: SourceType | undefined;
}

export type YoutubeUploadJob = YoutubeVodUploadJob | YoutubeGameUploadJob;

export interface VodFinalizeFileJob extends BaseJobData {
  filePath?: string | undefined;
  type: SourceType;
  workDir?: string | undefined;
  saveMP4: boolean;
  streamId?: string | undefined;
}

export interface VodFinalizeFileResult {
  success: true;
}

export interface DmcaProcessingJob extends BaseJobData {
  receivedClaims: DMCAClaim[];
  type: SourceType;
  part?: number | undefined;
  filePath?: string | undefined;
  gameId?: number | undefined;
  gameStart?: number | undefined;
  gameDuration?: number | undefined;
  workDir?: string | undefined;
  skipFinalize?: boolean | undefined;
  streamId?: string | undefined;
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

export interface MonitorJobResult {
  success: true;
}
