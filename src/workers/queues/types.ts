import type {
  LiveDownloadJob,
  StandardVodJob,
  ChatDownloadJob,
  YoutubeUploadJob,
  DmcaProcessingJob,
  MonitorJob,
} from '../jobs/types.js';

export type QueueJob =
  | LiveDownloadJob
  | StandardVodJob
  | ChatDownloadJob
  | YoutubeUploadJob
  | DmcaProcessingJob
  | MonitorJob;
