import ffmpeg from 'fluent-ffmpeg';
import { extractErrorDetails } from './error.js';
import { deleteFileIfExists } from './path.js';

export interface DMCAClaim {
  type: 'CLAIM_TYPE_AUDIO' | 'CLAIM_TYPE_VISUAL' | 'CLAIM_TYPE_AUDIOVISUAL';
  claimPolicy: { primaryPolicy: { policyType: string } };
  matchDetails: { longestMatchStartTimeSeconds: number; longestMatchDurationSeconds: string };
}

const BLOCKING_POLICY_TYPES = ['POLICY_TYPE_GLOBAL_BLOCK', 'POLICY_TYPE_MOSTLY_GLOBAL_BLOCK', 'POLICY_TYPE_BLOCK'];

export function isBlockingPolicy(claim: DMCAClaim): boolean {
  const policyType = claim.claimPolicy.primaryPolicy.policyType;
  return BLOCKING_POLICY_TYPES.includes(policyType);
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

export async function muteAudioSections(videoPath: string, filters: string[], outputPath: string): Promise<string | null> {
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
      .on('end', () => resolve(outputPath))
      .on('error', (err) => {
        console.error(`FFmpeg mute error: ${err.message}`);
        resolve(null);
      })
      .saveToFile(outputPath);
  });
}

export interface BlackoutSection {
  startSeconds: number;
  durationSeconds: number;
  endSeconds: number;
}

/**
 * Applies multiple video blackouts in a single FFmpeg pass using overlay filters.
 * This is significantly more efficient than the old concat-based approach as it only reads/writes once.
 */
export async function blackoutVideoSections(videoPath: string, vodId: string, sections: BlackoutSection[]): Promise<string | null> {
  if (sections.length === 0) return videoPath;

  const outputPath = `${vodId}-blackouted.mp4`;

  // Sort sections by start time to ensure proper processing order
  const sortedSections = [...sections].sort((a, b) => a.startSeconds - b.startSeconds);

  if (sortedSections.length === 1) {
    return new Promise<string | null>((resolve) => {
      const section = sortedSections[0];

      ffmpeg(videoPath)
        .input('color=c=black:s=hd1080')
        .videoFilters(`[1:v]overlay=0:0:enable='between(t,${section.startSeconds},${section.endSeconds})'[v_out]`)
        .outputOptions(['-map', '[v_out]', '-map', '0:a'])
        .toFormat('mp4')
        .on('end', () => resolve(outputPath))
        .on('error', (err) => {
          console.error(`FFmpeg blackout error: ${err.message}`);
          resolve(null);
        })
        .saveToFile(outputPath);
    });
  }

  // Multiple sections - build chained overlay filter complex string
  return new Promise<string | null>((resolve) => {
    const ffmpegProcess = ffmpeg(videoPath);

    for (let i = 0; i < sortedSections.length; i++) {
      ffmpegProcess.input('color=c=black:s=hd1080');
    }

    let filterComplex = '';

    for (let i = 0; i < sortedSections.length; i++) {
      const section = sortedSections[i];
      const inputLabel = i === 0 ? '0:v' : `v_${i - 1}`;
      const colorInput = `${i + 1}:v`;
      const outputLabel = i === sortedSections.length - 1 ? '[v_final]' : `[v_${i}]`;

      filterComplex += `[${inputLabel}][${colorInput}]overlay=0:0:enable='between(t,${section.startSeconds},${section.endSeconds})'${outputLabel};`;
    }

    ffmpegProcess
      .videoFilters(filterComplex)
      .outputOptions(['-map', '[v_final]', '-map', '0:a'])
      .toFormat('mp4')
      .on('end', () => resolve(outputPath))
      .on('error', (err) => {
        console.error(`FFmpeg blackout error: ${err.message}`);
        resolve(null);
      })
      .saveToFile(outputPath);
  });
}

export async function cleanupTempFiles(files: string[]): Promise<void> {
  const uniqueFiles = [...new Set(files)];

  for (const file of uniqueFiles) {
    try {
      await deleteFileIfExists(file);
    } catch (err) {
      const details = extractErrorDetails(err);
      console.warn('Failed to cleanup temp file:', file, details.message);
    }
  }
}
