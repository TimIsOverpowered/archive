import ffmpeg from 'fluent-ffmpeg';
import { extractErrorDetails } from '../../utils/error.js';
import path from 'path';
import events from 'events';
import { childLogger } from '../../utils/logger.js';

const logger = childLogger({ module: 'ffmpeg' });
import HLS from 'hls-parser';

const lastFfmpegProgressBySource = new Map<string, number>();

interface ProgressEvent {
  percent?: number;
}

interface HlsToMp4Options {
  vodId?: string | number;
  onProgress?: (percent: number) => void;
  isFmp4?: boolean;
  onStart?: (cmd: string) => void;
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
    if (!('segments' in parsed)) {
      return false;
    }

    const mediaPlaylist = parsed as typeof parsed & {
      segments: Array<{ uri?: string; map?: { uri?: string } }>;
    };

    // Check for init segment (EXT-X-MAP tag) - strongest fMP4 indicator
    if (mediaPlaylist.segments.some((seg) => seg.map?.uri != null && seg.map.uri !== '')) {
      return true;
    }

    // Check segment extensions (.mp4 or .m4s but not .ts)
    const hasFmp4Segments = mediaPlaylist.segments.some(
      (seg) =>
        seg?.uri?.endsWith('.mp4') ||
        seg?.uri?.endsWith('.m4s') ||
        (!seg?.uri?.endsWith('.ts') && (seg.uri?.includes('fMP4') || seg.uri?.includes('init')))
    );

    return hasFmp4Segments;
  } catch {
    return false;
  }
}

export async function splitVideo(
  filePath: string,
  duration: number,
  splitDuration: number,
  vodId: string,
  onProgress?: (percent: number, part: number) => void,
  onStart?: (cmd: string) => void
): Promise<string[]> {
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
        .on('start', (cmd) => {
          logger.info(`FFmpeg start: ${cmd}`);
          onStart?.(cmd);
        })
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

export async function trimVideo(
  filePath: string,
  start: number,
  end: number,
  vodId: string,
  onProgress?: (percent: number) => void,
  onStart?: (cmd: string) => void
): Promise<string> {
  const outputDir = path.dirname(filePath);
  const duration = end - start;
  const outputFile = path.join(outputDir, `${vodId}-${start}-${end}.mp4`);

  return new Promise((resolve, reject) => {
    const proc = ffmpeg(filePath).seekInput(start).duration(duration).outputOptions('-c copy').save(outputFile);

    proc.on('start', (cmd) => {
      logger.info(`FFmpeg start: ${cmd}`);
      onStart?.(cmd);
    });

    (proc as events.EventEmitter).on('progress', (progress: ProgressEvent) => {
      if (onProgress && progress.percent != null) {
        onProgress(Math.round(progress.percent));
      }
    });
    proc.on('end', () => {
      resolve(outputFile);
    });
    proc.on('error', (err: Error) => {
      reject(err);
    });
  });
}

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
  videoBitRate: string | null;
  audioBitRate: string | null;
  formatBitRate: number | null;
  fileSize: number | null;
  formatName: string | null;
  formatLongName: string | null;
  sampleRate: number | null;
  channels: number | null;
  channelLayout: string | null;
  frameRate: string | null;
  pixFmt: string | null;
  profile: string | null;
  nbStreams: number | null;
  nbPrograms: number | null;
  tags: Record<string, string | number> | null;
}

export async function getMetadata(filePath: string): Promise<VideoMetadata | null> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err != null) {
        const errDetails = extractErrorDetails(err);
        logger.error({ filePath, error: errDetails.message }, 'Failed to probe file');
        resolve(null);
        return;
      }

      const videoStream = data.streams.find((s) => s.codec_type === 'video');
      const audioStream = data.streams.find((s) => s.codec_type === 'audio');
      const fmt = data.format;
      const duration = fmt?.duration != null ? Math.round(fmt.duration) : 0;

      if (duration <= 0 || !videoStream) {
        logger.warn({ filePath }, 'Invalid duration or no video stream found');
        resolve(null);
        return;
      }

      resolve({
        duration,
        width: videoStream.width ?? 0,
        height: videoStream.height ?? 0,
        videoCodec: videoStream.codec_name ?? '',
        audioCodec: audioStream?.codec_name ?? null,
        videoBitRate: videoStream.bit_rate ?? null,
        audioBitRate: audioStream?.bit_rate ?? null,
        formatBitRate: fmt.bit_rate ?? null,
        fileSize: fmt.size ?? null,
        formatName: fmt.format_name ?? null,
        formatLongName: fmt.format_long_name ?? null,
        sampleRate: audioStream?.sample_rate ?? null,
        channels: audioStream?.channels ?? null,
        channelLayout: audioStream?.channel_layout ?? null,
        frameRate: videoStream.r_frame_rate ?? null,
        pixFmt: videoStream.pix_fmt ?? null,
        profile: videoStream.profile?.toString() ?? null,
        nbStreams: fmt.nb_streams ?? null,
        nbPrograms: fmt.nb_programs ?? null,
        tags: fmt.tags ?? null,
      });
    });
  });
}

export interface VideoDimensions {
  width: number;
  height: number;
}

export async function generateBlackSegment(
  outputPath: string,
  duration: number,
  dims: VideoDimensions,
  onStart?: (cmd: string) => void
): Promise<string | null> {
  return new Promise((resolve) => {
    const colorSrc = `color=c=black:s=${dims.width}x${dims.height}:d=${duration}`;

    ffmpeg()
      .inputOptions(['-f', 'lavfi'])
      .input(colorSrc)
      .duration(duration)
      .videoCodec('copy')
      .toFormat('mp4')
      .on('start', (cmd) => {
        logger.info(`FFmpeg start: ${cmd}`);
        onStart?.(cmd);
      })
      .on('end', () => {
        resolve(outputPath);
      })
      .on('error', (err) => {
        logger.error(`Black segment error: ${err.message}`);
        resolve(null);
      })
      .saveToFile(outputPath);
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

  logger.debug({ vodId: options?.vodId ?? source.substring(0, 30), isFmp4 }, `HLS format determined`);

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
      .saveToFile(outputPath);

    (ffmpegProcess as events.EventEmitter).on('progress', (progress: ProgressEvent) => {
      const percent = progress.percent != null ? Math.round(progress.percent) : 0;
      const threshold = Math.floor(percent / 25) * 25;
      const lastReported = lastFfmpegProgressBySource.get(source) ?? -1;

      if (threshold > lastReported) {
        lastFfmpegProgressBySource.set(source, threshold);
        options?.onProgress?.(threshold);
      }
    });
    ffmpegProcess.on('start', (cmd) => {
      const ctx = options?.vodId != null ? `VOD ${options.vodId}` : source.substring(0, 40);

      logger.info({ isFmp4 }, `${ctx} - Converting HLS to MP4${isFmp4 ? ' (fMP4)' : ''}`);
      logger.info(`FFmpeg start: ${cmd}`);
      options?.onStart?.(cmd);
    });
    ffmpegProcess.on('error', (err: Error, _stdout: string | null, stderr: string | null) => {
      ffmpegProcess.kill('SIGKILL');
      reject(err ?? new Error(stderr?.toString() ?? 'Unknown error'));
    });
    ffmpegProcess.on('end', () => {
      resolve();
    });
  });
}
