import ffmpeg from 'fluent-ffmpeg';
import { writeFileSync } from 'fs';
import events from 'events';
import { extractErrorDetails } from '../../utils/error.js';
import { deleteFileIfExists } from '../../utils/path.js';
import { childLogger } from '../../utils/logger.js';
import { toHHMMSS } from '../../utils/formatting.js';
import { generateBlackSegment, getDuration, getVideoDimensions } from '../utils/ffmpeg.js';

interface ProgressEvent {
  percent?: number;
}

const log = childLogger({ module: 'dmca' });

export const CLAIM_TYPES = {
  AUDIO: 'CLAIM_TYPE_AUDIO',
  VISUAL: 'CLAIM_TYPE_VISUAL',
  AUDIOVISUAL: 'CLAIM_TYPE_AUDIOVISUAL',
} as const;

export type ClaimType = (typeof CLAIM_TYPES)[keyof typeof CLAIM_TYPES];

export interface DMCAClaim {
  claimId?: string;
  assetId?: string;
  type: ClaimType;
  asset?: {
    metadata?: {
      soundRecording?: {
        title?: string;
        artists?: string[];
        recordLabel?: string;
      };
    };
  };
  claimPolicy: { primaryPolicy: { policyType: string } };
  matchDetails: { longestMatchStartTimeSeconds: number; longestMatchDurationSeconds: string };
}

const BLOCKING_POLICY_TYPES = ['POLICY_TYPE_GLOBAL_BLOCK', 'POLICY_TYPE_MOSTLY_GLOBAL_BLOCK'];

export function isBlockingPolicy(claim: DMCAClaim): boolean {
  const policyType = claim.claimPolicy.primaryPolicy.policyType;
  return BLOCKING_POLICY_TYPES.includes(policyType);
}

export function getClaimIdentifier(claim: DMCAClaim): string {
  const title = claim.asset?.metadata?.soundRecording?.title;
  const artists = claim.asset?.metadata?.soundRecording?.artists;
  const claimId = claim.claimId;

  const parts: string[] = [];

  if (title != null && title !== '') {
    parts.push(title);
  }
  if (artists && artists.length > 0) {
    parts.push(artists.join(', '));
  }
  if (claimId != null && claimId !== '') {
    parts.push(`[${claimId}]`);
  }

  if (parts.length === 0) {
    return `claim:${claim.claimId ?? 'unknown'}`;
  }

  return parts.join(' - ');
}

export interface MuteFilterResult {
  startTime: number;
  endTime: number;
}

export function buildMuteFilters(claims: DMCAClaim[]): string[] {
  const muteSection: string[] = [];

  for (const claim of claims) {
    if (!isBlockingPolicy(claim)) continue;

    const startTime = claim.matchDetails.longestMatchStartTimeSeconds;
    const endTime = startTime + parseInt(claim.matchDetails.longestMatchDurationSeconds);

    muteSection.push(`volume=0:enable='between(t,${startTime},${endTime})'`);
  }

  return muteSection;
}

export async function muteAudioSections(
  videoPath: string,
  filters: string[],
  outputPath: string,
  onProgress?: (percent: number) => void
): Promise<string | null> {
  const lastReported = { val: -1 };
  const threshold = 25;

  return new Promise((resolve) => {
    const ffmpegProcess = ffmpeg(videoPath);

    if (filters.length > 0) {
      for (const filter of filters) {
        ffmpegProcess.audioFilters(filter);
      }
    } else {
      ffmpegProcess.videoCodec('copy');
    }

    ffmpegProcess
      .toFormat('mp4')
      .on('end', () => {
        resolve(outputPath);
      })
      .on('error', (err) => {
        log.error(`FFmpeg mute error: ${err.message}`);
        resolve(null);
      });

    if (onProgress) {
      (ffmpegProcess as events.EventEmitter).on('progress', (progress: ProgressEvent) => {
        const percent = progress.percent != null ? Math.round(progress.percent) : 0;
        const bucket = Math.floor(percent / threshold) * threshold;
        if (bucket > lastReported.val) {
          lastReported.val = bucket;
          onProgress(bucket);
        }
      });
    }

    ffmpegProcess.saveToFile(outputPath);
  });
}

export interface BlackoutSection {
  startSeconds: number;
  durationSeconds: number;
  endSeconds: number;
}

export interface BlackoutProgressOptions {
  onProgress?: (percent: number) => void;
  onStep?: (step: string, current: number, total: number) => void;
}

async function extractSegment(
  source: string,
  outputPath: string,
  start: number,
  duration: number,
  onProgress?: (percent: number) => void
): Promise<string | null> {
  const lastReported = { val: -1 };
  const threshold = 25;

  return new Promise((resolve) => {
    const proc = ffmpeg(source)
      .seekInput(start)
      .duration(duration)
      .outputOptions('-c copy')
      .toFormat('mp4')
      .on('end', () => {
        resolve(outputPath);
      })
      .on('error', (err) => {
        log.error(`Segment extract error: ${err.message}`);
        resolve(null);
      });

    if (onProgress) {
      (proc as events.EventEmitter).on('progress', (progress: ProgressEvent) => {
        const percent = progress.percent != null ? Math.round(progress.percent) : 0;
        const bucket = Math.floor(percent / threshold) * threshold;
        if (bucket > lastReported.val) {
          lastReported.val = bucket;
          onProgress(bucket);
        }
      });
    }

    proc.saveToFile(outputPath);
  });
}

async function concatSegments(
  segmentFiles: string[],
  outputPath: string,
  onProgress?: (percent: number) => void
): Promise<string | null> {
  const lastReported = { val: -1 };
  const threshold = 25;

  return new Promise((resolve) => {
    const listPath = outputPath.replace('.mp4', '-concat.txt');
    writeFileSync(listPath, segmentFiles.map((f) => `file '${f}'`).join('\n') + '\n');

    const proc = ffmpeg(listPath)
      .inputOptions(['-f concat', '-safe 0'])
      .videoCodec('copy')
      .audioCodec('copy')
      .toFormat('mp4')
      .on('end', () => {
        void deleteFileIfExists(listPath);
        resolve(outputPath);
      })
      .on('error', (err) => {
        void deleteFileIfExists(listPath);
        log.error(`Concat error: ${err.message}`);
        resolve(null);
      });

    if (onProgress) {
      (proc as events.EventEmitter).on('progress', (progress: ProgressEvent) => {
        const percent = progress.percent != null ? Math.round(progress.percent) : 0;
        const bucket = Math.floor(percent / threshold) * threshold;
        if (bucket > lastReported.val) {
          lastReported.val = bucket;
          onProgress(bucket);
        }
      });
    }

    proc.saveToFile(outputPath);
  });
}

/**
 * Applies video blackouts using concat demuxer with stream copy (-c copy).
 * No re-encoding — normal segments are byte-copied, black segments are generated fresh.
 */
export async function blackoutVideoSections(
  videoPath: string,
  vodId: string,
  sections: BlackoutSection[],
  options?: BlackoutProgressOptions
): Promise<string | null> {
  if (sections.length === 0) return videoPath;

  const outputPath = `${vodId}-blackouted.mp4`;
  const dims = await getVideoDimensions(videoPath);
  if (!dims) {
    log.error({ videoPath, vodId }, 'Failed to get video dimensions');
    return null;
  }

  const totalDuration = await getDuration(videoPath);
  if (totalDuration === null) {
    log.error({ videoPath, vodId }, 'Failed to get video duration');
    return null;
  }

  const sorted = [...sections].sort((a, b) => a.startSeconds - b.startSeconds);
  const tempFiles: string[] = [];
  const segmentFiles: string[] = [];
  let prevEnd = 0;

  // Calculate total steps: for each section (extract if gap + black gen) + trailing extract + final concat
  let totalSteps = 0;
  for (const section of sorted) {
    if (section.startSeconds > prevEnd) totalSteps++;
    totalSteps++;
    prevEnd = section.endSeconds;
  }
  if (prevEnd < totalDuration) totalSteps++;
  totalSteps++; // final concat
  let currentStep = 0;

  const reportProgress = (percent: number) => {
    options?.onProgress?.(percent);
  };

  const reportStep = (step: string) => {
    currentStep++;
    options?.onStep?.(step, currentStep, totalSteps);
  };

  try {
    prevEnd = 0;
    for (const section of sorted) {
      if (section.startSeconds > prevEnd) {
        const dur = section.startSeconds - prevEnd;
        const file = `${vodId}-seg-normal-${prevEnd}.mp4`;
        const result = await extractSegment(videoPath, file, prevEnd, dur, reportProgress);
        if (result === null) return null;
        segmentFiles.push(result);
        tempFiles.push(result);
        reportStep(`extract:${toHHMMSS(prevEnd)}-${toHHMMSS(section.startSeconds)}`);
      }

      const blackFile = `${vodId}-seg-black-${section.startSeconds}.mp4`;
      const blackResult = await generateBlackSegment(blackFile, section.endSeconds - section.startSeconds, dims);
      if (blackResult === null) return null;
      segmentFiles.push(blackResult);
      tempFiles.push(blackResult);
      reportStep(`black:${toHHMMSS(section.startSeconds)}-${toHHMMSS(section.endSeconds)}`);

      prevEnd = section.endSeconds;
    }

    if (prevEnd < totalDuration) {
      const dur = totalDuration - prevEnd;
      const file = `${vodId}-seg-normal-${prevEnd}.mp4`;
      const result = await extractSegment(videoPath, file, prevEnd, dur, reportProgress);
      if (result === null) return null;
      segmentFiles.push(result);
      tempFiles.push(result);
      reportStep(`extract:${toHHMMSS(prevEnd)}-${toHHMMSS(totalDuration)}`);
    }

    const result = await concatSegments(segmentFiles, outputPath, reportProgress);
    reportStep('concat');
    return result;
  } finally {
    await cleanupTempFiles(tempFiles);
  }
}

export async function cleanupTempFiles(files: string[]): Promise<void> {
  const uniqueFiles = [...new Set(files)];

  for (const file of uniqueFiles) {
    try {
      await deleteFileIfExists(file);
    } catch (err) {
      const details = extractErrorDetails(err);
      log.warn({ file, error: details.message }, 'Failed to cleanup temp file');
    }
  }
}
