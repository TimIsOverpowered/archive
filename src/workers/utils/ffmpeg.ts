import { spawn } from 'child_process';
import { writeFileSync } from 'fs';
import { extractErrorDetails } from '../../utils/error.js';
import path from 'path';
import { childLogger } from '../../utils/logger.js';
import { deleteFileIfExists } from '../../utils/path.js';
import HLS from 'hls-parser';
import { parseTimecode } from '../../utils/formatting.js';

const logger = childLogger({ module: 'ffmpeg' });

export interface ProgressEvent {
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

    if (!('segments' in parsed)) {
      return false;
    }

    const mediaPlaylist = parsed as typeof parsed & {
      segments: Array<{ uri?: string; map?: { uri?: string } }>;
    };

    if (mediaPlaylist.segments.some((seg) => seg.map?.uri != null && seg.map.uri !== '')) {
      return true;
    }

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

/**
 * Run an FFmpeg/FFprobe command with standardized spawn, progress tracking, and error handling.
 * Returns the result of onSuccess on success, or onError/onSpawnError on failure.
 */
function runFfmpeg(
  args: string[],
  knownDuration: number | null,
  onProgress?: (percent: number) => void,
  onStart?: (cmd: string) => void
): Promise<void> {
  const cmdStr = `ffmpeg ${args.join(' ')}`;

  return new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    trackProgress(proc, cmdStr, knownDuration, onProgress, onStart)
      .then(resolve)
      .catch(reject);

    proc.on('error', (err: Error) => {
      reject(err);
    });
  });
}

/**
 * Attach progress/start tracking to an FFmpeg spawn process stderr stream.
 * Parses "time=HH:MM:SS.xx" from progress lines against a known total duration.
 * Calls onProgress with bucketed percentage (25% increments).
 */
function trackProgress(
  proc: ReturnType<typeof spawn>,
  cmd: string,
  knownDuration: number | null,
  onProgress?: (percent: number) => void,
  onStart?: (cmd: string) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    proc.on('close', (code) => {
      if (code === 0) {
        logger.info(`FFmpeg complete: ${cmd}`);
        resolve();
      } else {
        logger.error({ code }, `FFmpeg failed: ${cmd}`);
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });

    if (!onProgress && !onStart) return;
    if (!proc.stderr) return;

    logger.info(`FFmpeg start: ${cmd}`);
    onStart?.(cmd);

    let totalDuration = knownDuration;
    let lastBucket = -1;

    const durationRegex = /Duration:\s*(\d{1,2}:\d{2}:\d{2}\.\d+)/;
    const timeRegex = /time=(\d{1,2}:\d{2}:\d{2}\.\d+)/;

    proc.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();

      if (totalDuration === null) {
        const durMatch = chunk.match(durationRegex);
        if (durMatch?.[1] != null) {
          totalDuration = parseTimecode(durMatch[1]);
          logger.debug({ totalDuration, rawTimecode: durMatch[1] }, 'trackProgress: Duration found');
        }
      }

      if (onProgress && totalDuration != null && totalDuration > 0) {
        const timeMatch = chunk.match(timeRegex);
        if (timeMatch?.[1] != null) {
          const elapsed = parseTimecode(timeMatch[1]);
          const percent = Math.min(Math.round((elapsed / totalDuration) * 100), 100);
          const bucket = Math.floor(percent / 25) * 25;
          if (bucket > lastBucket) {
            lastBucket = bucket;
            onProgress(bucket);
          }
        }
      }
    });
  });
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
    const partFile = path.join(outputDir, `${vodId}-part-${i + 1}.mp4`);

    const percent = ((i + 1) / totalParts) * 100;
    onProgress?.(Math.round(percent), i + 1);

    await new Promise<void>((resolve, reject) => {
      const args = [
        '-v',
        'info',
        '-ss',
        start.toString(),
        '-i',
        filePath,
        '-t',
        splitDuration.toString(),
        '-c',
        'copy',
        '-y',
        partFile,
      ];

      const cmdStr = `ffmpeg ${args.join(' ')}`;
      const proc = spawn('ffmpeg', args);
      trackProgress(proc, cmdStr, splitDuration, undefined, onStart).catch(() => {});

      proc.on('close', (code) => {
        if (code === 0) {
          parts.push(partFile);
          resolve();
        } else {
          reject(new Error(`FFmpeg split exited with code ${code}`));
        }
      });

      proc.on('error', (err: Error) => {
        reject(err);
      });
    });
  }

  return parts;
}

export async function trimVideo(
  filePath: string,
  start: number,
  duration: number,
  vodId: string,
  onProgress?: (percent: number) => void,
  onStart?: (cmd: string) => void
): Promise<string> {
  const outputDir = path.dirname(filePath);
  const outputFile = path.join(outputDir, `${vodId}-${start}-${duration}.mp4`);

  const args = [
    '-v',
    'info',
    '-ss',
    start.toString(),
    '-i',
    filePath,
    '-t',
    duration.toString(),
    '-c',
    'copy',
    '-y',
    outputFile,
  ];

  await runFfmpeg(args, duration, onProgress, onStart);

  return outputFile;
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
    const proc = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', filePath]);

    let stdout = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        const errDetails = extractErrorDetails(new Error(`ffprobe exited with code ${code}`));
        logger.error({ filePath, error: errDetails.message }, 'Failed to probe file');
        resolve(null);
        return;
      }

      let data: { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> } | null = null;
      try {
        data = JSON.parse(stdout) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
      } catch {
        logger.error({ filePath }, 'Failed to parse ffprobe JSON output');
        resolve(null);
        return;
      }

      const videoStream = data?.streams?.find((s) => s.codec_type === 'video');
      const audioStream = data?.streams?.find((s) => s.codec_type === 'audio');
      const fmt = data?.format;
      const fmtDuration = fmt?.duration != null ? Number(fmt.duration) : 0;
      const duration = fmtDuration != null ? Math.round(fmtDuration) : 0;

      if (duration <= 0 || !videoStream) {
        logger.warn({ filePath }, 'Invalid duration or no video stream found');
        resolve(null);
        return;
      }

      resolve({
        duration,
        width: (videoStream.width as number) ?? 0,
        height: (videoStream.height as number) ?? 0,
        videoCodec: (videoStream.codec_name as string) ?? '',
        audioCodec: (audioStream?.codec_name as string) ?? null,
        videoBitRate: (videoStream.bit_rate as string) ?? null,
        audioBitRate: (audioStream?.bit_rate as string) ?? null,
        formatBitRate: (fmt?.bit_rate as number) ?? null,
        fileSize: (fmt?.size as number) ?? null,
        formatName: (fmt?.format_name as string) ?? null,
        formatLongName: (fmt?.format_long_name as string) ?? null,
        sampleRate: (audioStream?.sample_rate as number) ?? null,
        channels: (audioStream?.channels as number) ?? null,
        channelLayout: (audioStream?.channel_layout as string) ?? null,
        frameRate: (videoStream.r_frame_rate as string) ?? null,
        pixFmt: (videoStream.pix_fmt as string) ?? null,
        profile: typeof videoStream.profile === 'string' ? videoStream.profile : null,
        nbStreams: (fmt?.nb_streams as number) ?? null,
        nbPrograms: (fmt?.nb_programs as number) ?? null,
        tags: (fmt?.tags as Record<string, string | number>) ?? null,
      });
    });

    proc.on('error', (err) => {
      const errDetails = extractErrorDetails(err);
      logger.error({ filePath, error: errDetails.message }, 'Failed to probe file');
      resolve(null);
    });
  });
}

function resolveVideoEncoder(codecName: string): string {
  switch (codecName) {
    case 'h264':
      return 'libx264';
    case 'hevc':
      return 'libx265';
    case 'vp9':
      return 'libvpx-vp9';
    case 'vp8':
      return 'libvpx';
    default:
      return 'libx264';
  }
}

function resolveAudioEncoder(codecName: string): string {
  switch (codecName) {
    case 'aac':
      return 'aac';
    case 'opus':
      return 'libopus';
    case 'mp3':
      return 'libmp3lame';
    default:
      return 'aac';
  }
}

function resolveAudioChannel(audioChannel: number | null): string {
  switch (audioChannel) {
    case 1:
      return 'mono';
    case 2:
      return 'stereo';
    case 6:
      return '5.1';
    case 8:
      return '7.1';
    default:
      return 'stereo';
  }
}

export async function generateBlackSegment(
  outputPath: string,
  duration: number,
  metadata: VideoMetadata,
  onProgress?: (percent: number) => void,
  onStart?: (cmd: string) => void
): Promise<string | null> {
  const { width, height, frameRate, pixFmt, audioCodec, sampleRate, channels, profile } = metadata;
  const videoCodec = resolveVideoEncoder(metadata.videoCodec);
  const fr = frameRate ?? '30';
  const pf = pixFmt ?? 'yuv420p';

  const args: string[] = [];
  args.push('-f', 'lavfi');
  args.push('-i', `color=c=black:s=${width}x${height}:r=${fr}`);

  if (audioCodec != null && sampleRate != null) {
    const chLayout = resolveAudioChannel(channels);
    args.push('-f', 'lavfi');
    args.push('-i', `anullsrc=r=${sampleRate}:cl=${chLayout}`);
  }

  args.push('-t', duration.toString());
  args.push('-c:v', videoCodec);
  args.push('-pix_fmt', pf);

  if (profile != null && profile !== '') {
    args.push('-profile:v', profile);
  }

  if (audioCodec != null && sampleRate != null) {
    const audioEncoder = resolveAudioEncoder(audioCodec);
    args.push('-c:a', audioEncoder);
    args.push('-map', '0:v:0');
    args.push('-map', '1:a:0');
  }

  args.push('-v', 'info');
  args.push('-y');
  args.push(outputPath);

  await runFfmpeg(args, duration, onProgress, onStart);
  return outputPath;
}

export async function muteAudioSections(
  videoPath: string,
  filters: string[],
  outputPath: string,
  onProgress?: (percent: number) => void,
  onStart?: (cmd: string) => void
): Promise<string | null> {
  const meta = await getMetadata(videoPath);
  const knownDuration = meta?.duration ?? null;
  const afFilter = filters.join(',');

  const args = ['-v', 'info', '-i', videoPath, '-c:v', 'copy', '-af', afFilter, '-c:a', 'aac', '-y', outputPath];

  await runFfmpeg(args, knownDuration, onProgress, onStart);
  return outputPath;
}

export async function extractSegment(
  source: string,
  outputPath: string,
  start: number,
  duration: number,
  onProgress?: (percent: number) => void,
  onStart?: (cmd: string) => void
): Promise<string | null> {
  const args = [
    '-v',
    'info',
    '-ss',
    start.toString(),
    '-i',
    source,
    '-t',
    duration.toString(),
    '-c',
    'copy',
    '-y',
    outputPath,
  ];

  await runFfmpeg(args, duration, onProgress, onStart);
  return outputPath;
}

export interface ConcatSegmentsOptions {
  onProgress?: (percent: number) => void;
  onStart?: (cmd: string) => void;
  totalDuration?: number;
  audioFilters?: string[];
}

export async function concatSegments(
  segmentFiles: string[],
  outputPath: string,
  options?: ConcatSegmentsOptions
): Promise<string | null> {
  const listPath = outputPath.replace('.mp4', '-concat.txt');
  writeFileSync(listPath, segmentFiles.map((f) => `file '${f}'`).join('\n') + '\n');

  const args: string[] = ['-v', 'info', '-f', 'concat', '-safe', '0', '-i', listPath];
  if (options?.audioFilters != null && options.audioFilters.length > 0) {
    args.push('-c:v', 'copy', '-af', options.audioFilters.join(','), '-c:a', 'aac');
  } else {
    args.push('-c', 'copy');
  }
  args.push('-y', outputPath);

  try {
    await runFfmpeg(args, options?.totalDuration ?? null, options?.onProgress, options?.onStart);
    return outputPath;
  } finally {
    await deleteFileIfExists(listPath);
  }
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
  const isFmp4 = options?.isFmp4 ?? false;

  logger.debug({ vodId: options?.vodId ?? source.substring(0, 30), isFmp4 }, `HLS format determined`);

  const meta = await getMetadata(source);
  const knownDuration = meta?.duration ?? null;

  const baseOptions: string[] = ['-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart'];

  if (isFmp4) {
    baseOptions.push('-avoid_negative_ts', 'make_zero', '-fflags', '+genpts');
  }

  const args: string[] = ['-v', 'info', '-i', source, '-c', 'copy', ...baseOptions, '-y', outputPath];

  const ctx = options?.vodId != null ? `VOD ${options.vodId}` : source.substring(0, 40);
  let hlsLogged = false;
  const customOnStart = (_cmd: string) => {
    if (!hlsLogged) {
      hlsLogged = true;
      logger.info({ isFmp4 }, `${ctx} - Converting HLS to MP4${isFmp4 ? ' (fMP4)' : ''}`);
    }
  };

  await runFfmpeg(args, knownDuration, options?.onProgress, customOnStart);
}
