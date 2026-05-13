import path from 'node:path';
import { extractErrorDetails } from '../../utils/error.js';
import { toHHMMSS } from '../../utils/formatting.js';
import { childLogger } from '../../utils/logger.js';
import { deleteFileIfExists } from '../../utils/path.js';
import {
  concatSegments,
  extractSegment,
  generateBlackSegment,
  getMetadata,
  type ConcatSegmentsOptions,
} from '../utils/ffmpeg.js';
export { muteAudioSections } from '../utils/ffmpeg.js';

const log = childLogger({ module: 'dmca' });

export const CLAIM_MATCH_TYPE_AUDIOVISUAL = 'CLAIM_MATCH_TYPE_AUDIOVISUAL' as const;
export const CLAIM_MATCH_TYPE_AUDIO = 'CLAIM_MATCH_TYPE_AUDIO' as const;
export const CLAIM_MATCH_TYPE_VIDEO = 'CLAIM_MATCH_TYPE_VIDEO' as const;

export const CLAIM_MATCH_TYPES = {
  AUDIOVISUAL: CLAIM_MATCH_TYPE_AUDIOVISUAL,
  AUDIO: CLAIM_MATCH_TYPE_AUDIO,
  VIDEO: CLAIM_MATCH_TYPE_VIDEO,
} as const;

export type ClaimMatchType = (typeof CLAIM_MATCH_TYPES)[keyof typeof CLAIM_MATCH_TYPES];

export interface DMCAClaim {
  claimId?: string | undefined;
  assetId?: string | undefined;
  matchType: ClaimMatchType;
  videoSegment: { startMillis: number; endMillis: number };
  asset?:
    | {
        metadata?: {
          soundRecording?: {
            title?: string;
            artists?: string[];
            recordLabel?: string;
          };
        };
      }
    | undefined;
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

export function buildAudioFilters(claims: DMCAClaim[]): string[] {
  const muteSection: string[] = [];

  for (const claim of claims) {
    if (claim.matchType !== CLAIM_MATCH_TYPE_AUDIO && claim.matchType !== CLAIM_MATCH_TYPE_AUDIOVISUAL) continue;

    const startTime = claim.videoSegment.startMillis / 1000;
    const endTime = claim.videoSegment.endMillis / 1000;

    muteSection.push(`volume=0:enable='between(t,${startTime},${endTime})'`);
  }

  return muteSection;
}

export interface BlackoutSection {
  startSeconds: number;
  durationSeconds: number;
  endSeconds: number;
}

export interface BlackoutProgressOptions {
  onProgress?: (percent: number) => void;
  onStep?: (step: string, current: number, total: number) => void;
  onStart?: (cmd: string) => void;
  audioFilters?: string[];
}

/**
 * Applies video blackouts using concat demuxer with stream copy (-c copy).
 * No re-encoding — normal segments are byte-copied, black segments are generated fresh.
 */
export async function blackoutVideoSections(
  videoPath: string,
  vodId: string,
  sections: BlackoutSection[],
  workDir: string,
  options?: BlackoutProgressOptions
): Promise<string | null> {
  if (sections.length === 0) return videoPath;

  const outputPath = path.join(workDir, `${vodId}-blackouted.mp4`);
  const meta = await getMetadata(videoPath);
  if (!meta) {
    log.error({ videoPath, vodId }, 'Failed to get video metadata');
    return null;
  }

  const totalDuration = meta.duration;

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
        const file = path.join(workDir, `${vodId}-seg-normal-${prevEnd}.mp4`);
        const result = await extractSegment(videoPath, file, prevEnd, dur, reportProgress, options?.onStart);
        if (result === null) return null;
        segmentFiles.push(result);
        tempFiles.push(result);
        reportStep(`extract:${toHHMMSS(prevEnd)}-${toHHMMSS(section.startSeconds)}`);
      }

      const blackFile = path.join(workDir, `${vodId}-seg-black-${section.startSeconds}.mp4`);
      const blackResult = await generateBlackSegment(
        blackFile,
        section.endSeconds - section.startSeconds,
        meta,
        reportProgress,
        options?.onStart
      );
      if (blackResult === null) return null;
      segmentFiles.push(blackResult);
      tempFiles.push(blackResult);
      reportStep(`black:${toHHMMSS(section.startSeconds)}-${toHHMMSS(section.endSeconds)}`);

      prevEnd = section.endSeconds;
    }

    if (prevEnd < totalDuration) {
      const dur = totalDuration - prevEnd;
      const file = path.join(workDir, `${vodId}-seg-normal-${prevEnd}.mp4`);
      const result = await extractSegment(videoPath, file, prevEnd, dur, reportProgress, options?.onStart);
      if (result === null) return null;
      segmentFiles.push(result);
      tempFiles.push(result);
      reportStep(`extract:${toHHMMSS(prevEnd)}-${toHHMMSS(totalDuration)}`);
    }

    const concatOpts: ConcatSegmentsOptions = {
      onProgress: reportProgress,
      totalDuration,
    };
    if (options?.onStart != null) concatOpts.onStart = options.onStart;
    if (options?.audioFilters != null) concatOpts.audioFilters = options.audioFilters;
    const result = await concatSegments(segmentFiles, outputPath, concatOpts);
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
