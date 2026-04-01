import ffmpeg from 'fluent-ffmpeg';
import fsPromises from 'fs/promises';
import { extractErrorDetails } from './error.js';

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

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function deleteFileIfExists(filePath: string): Promise<void> {
  if (await fileExists(filePath)) {
    await fsPromises.unlink(filePath).catch((err) => {
      const details = extractErrorDetails(err);
      console.warn(`Failed to delete file ${filePath}:`, details.message);
    });
  }
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

export async function getStartVideo(vodPath: string, vodId: string, startSeconds: number): Promise<string | null> {
  const outputPath = `${vodId}-start.mp4`;

  return new Promise((resolve) => {
    ffmpeg(vodPath)
      .videoCodec('copy')
      .audioCodec('copy')
      .duration(startSeconds)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => {
        console.error(`FFmpeg start video error: ${err.message}`);
        resolve(null);
      })
      .saveToFile(outputPath);
  });
}

export async function getClip(vodPath: string, vodId: string, startSeconds: number, durationSeconds: number): Promise<string | null> {
  const outputPath = `${vodId}-clip.mp4`;

  return new Promise((resolve) => {
    ffmpeg(vodPath)
      .seekInput(startSeconds)
      .duration(durationSeconds)
      .videoCodec('copy')
      .audioCodec('copy')
      .on('end', () => resolve(outputPath))
      .on('error', (err) => {
        console.error(`FFmpeg clip error: ${err.message}`);
        resolve(null);
      })
      .saveToFile(outputPath);
  });
}

export async function getTrimmedClip(clipPath: string, vodId: string): Promise<string | null> {
  const outputPath = `${vodId}-clip-muted.mp4`;

  return new Promise((resolve) => {
    ffmpeg(clipPath)
      .audioCodec('copy')
      .videoFilter(`color=black:s=${1920}x${1080}`)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => {
        console.error(`FFmpeg blackout error: ${err.message}`);
        resolve(null);
      })
      .saveToFile(outputPath);
  });
}

export async function getEndVideo(vodPath: string, vodId: string, startSeconds: number): Promise<string | null> {
  const outputPath = `${vodId}-end.mp4`;

  return new Promise((resolve) => {
    ffmpeg(vodPath)
      .seekInput(startSeconds)
      .videoCodec('copy')
      .audioCodec('copy')
      .on('end', () => resolve(outputPath))
      .on('error', (err) => {
        console.error(`FFmpeg end video error: ${err.message}`);
        resolve(null);
      })
      .saveToFile(outputPath);
  });
}

export async function getTextList(vodId: string, startVideoPath: string, mutedClipPath: string, endVideoPath: string): Promise<string | null> {
  const listFilePath = `${vodId}-list.txt`;

  try {
    const content = [`file '${startVideoPath}'`, `file '${mutedClipPath}'`, `file '${endVideoPath}'`].join('\n');

    await fsPromises.writeFile(listFilePath, content);
    return listFilePath;
  } catch (error) {
    const details = extractErrorDetails(error);
    console.error(`Failed to write concat list file: ${details.message}`);
    return null;
  }
}

export async function concat(vodId: string, listFilePath: string): Promise<string | null> {
  const outputPath = `${vodId}-trimmed.mp4`;

  return new Promise((resolve) => {
    ffmpeg(listFilePath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .videoCodec('copy')
      .audioCodec('copy')
      .on('end', () => resolve(outputPath))
      .on('error', (err) => {
        console.error(`FFmpeg concat error: ${err.message}`);
        resolve(null);
      })
      .saveToFile(outputPath);
  });
}

export async function blackoutVideoSection(videoPath: string, vodId: string, startSeconds: number, durationSeconds: number, endSeconds: number): Promise<string | null> {
  const tempFiles = [];

  try {
    // Step 1: Split at start point
    const startPath = await getStartVideo(videoPath, vodId, startSeconds);
    if (!startPath) return null;
    tempFiles.push(startPath);

    // Step 2: Extract claim segment
    const clipPath = await getClip(videoPath, vodId, startSeconds, durationSeconds);
    if (!clipPath) return null;
    tempFiles.push(clipPath);

    // Step 3: Create black screen clip
    const mutedClipPath = await getTrimmedClip(clipPath, vodId);
    if (!mutedClipPath) return null;
    tempFiles.push(mutedClipPath);

    // Step 4: Split at end point
    const endPath = await getEndVideo(videoPath, vodId, endSeconds);
    if (!endPath) return null;
    tempFiles.push(endPath);

    // Step 5: Create concat list file
    const listFilePath = await getTextList(vodId, startPath, mutedClipPath, endPath);
    if (!listFilePath) return null;
    tempFiles.push(listFilePath);

    // Step 6: Concatenate parts
    const outputPath = await concat(vodId, listFilePath);

    // Cleanup intermediate files (keep final output)
    for (const file of [startPath, clipPath, mutedClipPath, endPath, listFilePath]) {
      if (
        file !== outputPath &&
        !(await fsPromises
          .access(file)
          .then(() => true)
          .catch(() => false))
      )
        continue;

      try {
        await deleteFileIfExists(file);
      } catch (err) {
        const details = extractErrorDetails(err);
        console.warn('Failed to cleanup temp file:', file, details.message);
      }
    }

    return outputPath;
  } catch (error) {
    const details = extractErrorDetails(error);
    console.error(`Blackout video section error: ${details.message}`);

    // Cleanup on error
    for (const file of tempFiles) {
      try {
        await deleteFileIfExists(file);
      } catch (err) {
        const details = extractErrorDetails(err);
        console.warn('Failed to cleanup temp file during error handling:', file, details.message);
      }
    }

    return null;
  }
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
