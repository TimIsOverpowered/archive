import type { DMCAClaim } from '../dmca/dmca.js';
import type { Platform, SourceType, UploadType, DownloadMethod } from '../../types/platforms.js';

export interface LiveDownloadJob {
  dbId: number;
  vodId: string;
  platform: Platform;
  tenantId: string;
  platformUserId: string;
  platformUsername?: string | undefined;
  startedAt?: string | undefined;
  sourceUrl?: string | undefined;
}

export interface StandardVodJob {
  tenantId: string;
  dbId: number;
  vodId: string;
  platform: Platform;
  platformUserId: string;
  platformUsername: string;
  sourceUrl?: string | undefined;
  downloadMethod?: DownloadMethod | undefined;
}

export interface ChatDownloadJob {
  tenantId: string;
  platformUserId?: string | undefined;
  platformUsername?: string | undefined;
  dbId: number;
  vodId: string;
  platform: Platform;
  duration: number;
  startOffset?: number | undefined;
  forceRerun?: boolean | undefined;
}

export interface YoutubeVodUploadJob {
  kind: 'vod';
  tenantId: string;
  dbId: number;
  vodId: string;
  filePath?: string | undefined;
  type: SourceType;
  platform: Platform;
  dmcaProcessed?: boolean | undefined;
  part?: number | undefined;
}

export interface YoutubeGameUploadJob {
  kind: 'game';
  tenantId: string;
  dbId: number;
  vodId: string;
  filePath?: string | undefined;
  type: UploadType;
  platform: Platform;
  chapterId: number;
  chapterName: string;
  chapterStart: number;
  chapterEnd: number;
  chapterGameId?: string | undefined;
  title: string;
  description: string;
}

export type YoutubeUploadJob = YoutubeVodUploadJob | YoutubeGameUploadJob;

export interface DmcaProcessingJob {
  tenantId: string;
  dbId: number;
  vodId: string;
  receivedClaims: DMCAClaim[];
  type: SourceType;
  platform: Platform;
  part?: number | undefined;
  filePath?: string | undefined;
}

export interface MonitorJob {
  tenantId: string;
}

export interface ChatDownloadResult {
  success: true;
  totalMessages?: number;
  batchCount?: number;
  skipped?: boolean;
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
