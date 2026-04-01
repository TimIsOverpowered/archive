import ffmpeg, { FfprobeData } from 'fluent-ffmpeg';
import { logger } from './logger.js';

/**
 * Convert HLS playlist to MP4 using fluent-ffmpeg (same as legacy convertToMp4)
 */
export async function convertHlsToMp4(m3u8Path: string, vodId: string, mp4Path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpegProcess = ffmpeg(m3u8Path);

    ffmpegProcess
      .videoCodec('copy')
      .audioCodec('copy')
      .outputOptions(['-bsf:a aac_adtstoasc', '-movflags +faststart'])
      .toFormat('mp4')
      .on('progress', (progress) => {
        if (process.env.NODE_ENV !== 'production') {
          process.stdout.write(`\rM3U8 CONVERT TO MP4 PROGRESS: ${Math.round(progress.percent ?? 0)}%`);
        }
      })
      .on('start', (_cmd: string) => {
        logger.info({ vodId }, 'Converting VOD m3u8 to mp4');
      })
      .on('error', (err, _stdout, _stderr) => {
        ffmpegProcess.kill('SIGKILL');
        reject(err || new Error(_stderr?.toString() || 'Unknown error'));
      })
      .on('end', () => resolve())
      .saveToFile(mp4Path);
  });
}

/**
 * Get video duration using ffprobe from fluent-ffmpeg
 */
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
