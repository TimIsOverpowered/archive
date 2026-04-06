import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs/promises';
import path from 'path';
import { logger } from './logger.js';
import HLS from 'hls-parser';

interface ProgressEvent {
  percent?: number;
}

interface HlsToMp4Options {
  vodId?: number;
  onProgress?: (percent: number) => void;
  isFmp4?: boolean;
}

/**
 * Detects if HLS playlist uses fragmented MP4 segments.
 * Shared utility function for callers to determine fMP4 status before calling convertHlsToMp4.
 *
 * @param m3u8Content - Raw m3u8 playlist text content
 * @returns true if fMP4 detected, false for standard .ts segments
 */
export function detectFmp4FromPlaylist(m3u8Content: string): boolean {
  try {
    const parsed = HLS.parse(m3u8Content);

    // Check if this is a media playlist (not master) with segments
    if (!parsed || !('segments' in parsed)) {
      return false;
    }

    const mediaPlaylist = parsed as typeof parsed & {
      segments: Array<{ uri?: string; map?: { uri?: string } }>;
    };

    // Check for init segment (EXT-X-MAP tag) - strongest fMP4 indicator
    if (mediaPlaylist.segments.some((seg) => seg.map && seg.map.uri)) {
      return true;
    }

    // Check segment extensions (.mp4 or .m4s but not .ts)
    const hasFmp4Segments = mediaPlaylist.segments.some(
      (seg) => seg?.uri?.endsWith('.mp4') || seg?.uri?.endsWith('.m4s') || (!seg?.uri?.endsWith('.ts') && (seg.uri?.includes('fMP4') || seg.uri?.includes('init')))
    );

    return hasFmp4Segments;
  } catch {
    throw new Error('Failed to parse m3u8 playlist for fMP4 detection');
  }
}

export async function splitVideo(filePath: string, duration: number, splitDuration: number, vodId: string, onProgress?: (percent: number, part: number) => void): Promise<string[]> {
  const outputDir = path.dirname(filePath);
  const parts: string[] = [];
  const totalParts = Math.ceil(duration / splitDuration);

  for (let i = 0; i < totalParts; i++) {
    const start = i * splitDuration;
    const end = Math.min(start + splitDuration, duration);
    const partDuration = end - start;
    const partFile = path.join(outputDir, `${vodId}-part-${i + 1}.mp4`);

    const percent = ((i + 1) / totalParts) * 100;
    onProgress?.(Math.round(percent), i + 1);

    await new Promise<void>((resolve, reject) => {
      ffmpeg(filePath)
        .seekInput(start)
        .duration(partDuration)
        .outputOptions('-c copy')
        .save(partFile)
        .on('end', () => {
          parts.push(partFile);
          resolve();
        })
        .on('error', (err: Error) => {
          reject(err);
        });
    });
  }

  return parts;
}

export async function trimVideo(filePath: string, start: number, end: number, vodId: string, onProgress?: (percent: number) => void): Promise<string> {
  const outputDir = path.dirname(filePath);
  const duration = end - start;
  const outputFile = path.join(outputDir, `${vodId}-${start}-${end}.mp4`);

  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .seekInput(start)
      .duration(duration)
      .outputOptions('-c copy')
      .save(outputFile)
      .on('progress', (progress: ProgressEvent) => {
        if (onProgress && progress.percent != null) {
          onProgress(Math.round(progress.percent));
        }
      })
      .on('end', () => {
        resolve(outputFile);
      })
      .on('error', (err: Error) => {
        reject(err);
      });
  });
}

export async function getDuration(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err || !metadata.format?.duration) {
        logger.error({ filePath }, `Failed to probe video file: ${err?.message}`);
        resolve(null);
      } else {
        const duration = Math.round(metadata.format.duration);
        resolve(duration > 0 ? duration : null);
      }
    });
  });
}

/**
 * Converts HLS stream to MP4 using ffmpeg.
 * Caller is responsible for determining fMP4 status and passing it via options.isFmp4.
 *
 * @param source - Can be local file path or remote URL (m3u8 media playlist)
 * @param outputPath - Output .mp4 file path
 * @param options - Optional vodId for logging, progress callback, isFmp4 flag from caller
 */
export async function convertHlsToMp4(source: string, outputPath: string, options?: HlsToMp4Options): Promise<void> {
  // Use fMP4 status provided by caller (defaults to false for standard .ts segments)
  const isFmp4 = options?.isFmp4 ?? false;

  logger.debug({ vodId: options?.vodId || source.substring(0, 30), isFmp4 }, `HLS format determined`);

  // Build ffmpeg output options based on caller-provided fMP4 status
  const baseOptions: string[] = ['-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart'];

  if (isFmp4) {
    baseOptions.push('-avoid_negative_ts', 'make_zero', '-fflags', '+genpts');
  }

  // Execute ffmpeg conversion with fluent API
  return new Promise((resolve, reject) => {
    const ffmpegProcess = ffmpeg(source);

    ffmpegProcess
      .videoCodec('copy')
      .audioCodec('copy')
      .outputOptions(baseOptions)
      .toFormat('mp4')
      // Progress callback (optional - not currently used by callers per requirement Z/skip)
      .on('progress', (progress: ProgressEvent) => {
        const percent = progress.percent != null ? Math.round(progress.percent) : 0;
        options?.onProgress?.(percent);
      })
      // Start logging with format context
      .on('start', () => {
        const ctx = options?.vodId ? `VOD ${options.vodId}` : source.substring(0, 40);

        logger.info({ isFmp4 }, `${ctx} - Converting HLS to MP4${isFmp4 ? ' (fMP4)' : ''}`);
      })
      // Error handling with process cleanup
      .on('error', (err: Error, _stdout: string | null, stderr: string | null) => {
        ffmpegProcess.kill('SIGKILL');
        reject(err || new Error(stderr?.toString() || 'Unknown error'));
      })
      // Success completion
      .on('end', () => resolve())
      .saveToFile(outputPath);
  });
}

export async function deleteFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== 'ENOENT') {
      throw err;
    }
  }
}
