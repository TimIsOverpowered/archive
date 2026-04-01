import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';
import { logger } from './logger.js';

interface ProgressEvent {
  percent?: number;
}

export async function downloadM3u8(m3u8Url: string, outputPath: string, onProgress?: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(m3u8Url)
      .outputOptions('-c copy')
      .save(outputPath)
      .on('progress', (progress: ProgressEvent) => {
        if (onProgress && progress.percent != null) {
          onProgress(Math.round(progress.percent));
        }
      })
      .on('end', () => {
        resolve();
      })
      .on('error', (err: Error) => {
        reject(err);
      });
  });
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

export async function convertHlsToMp4(m3u8Path: string, vodId: string, mp4Path: string, onProgress?: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpegProcess = ffmpeg(m3u8Path);

    ffmpegProcess
      .videoCodec('copy')
      .audioCodec('copy')
      .outputOptions(['-bsf:a aac_adtstoasc', '-movflags +faststart'])
      .toFormat('mp4')
      .on('progress', (progress: ProgressEvent) => {
        onProgress?.(progress.percent != null ? Math.round(progress.percent) : 0);
      })
      .on('start', () => {
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

function sortFmp4SegmentPaths(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const nameA = path.basename(a);
    const nameB = path.basename(b);

    if (nameA.includes('init')) return -1;
    if (nameB.includes('init')) return 1;

    const matchA = nameA.match(/^(\d+)/);
    const matchB = nameB.match(/^(\d+)/);

    const numA = matchA ? parseInt(matchA[1], 10) : Infinity;
    const numB = matchB ? parseInt(matchB[1], 10) : Infinity;

    return numA - numB;
  });
}

export async function finalizeFmp4Segments(vodDir: string, outputPath: string, onProgress?: (percent: number) => void): Promise<void> {
  const segmentFiles = await fs.readdir(vodDir).then((files) => files.filter((f) => f.endsWith('.mp4')).map((f) => path.join(vodDir, f)));

  if (segmentFiles.length === 0) {
    throw new Error('No MP4 segments found in directory');
  }

  const sortedSegments = sortFmp4SegmentPaths(segmentFiles);

  logger.debug({ vodDir, count: sortedSegments.length }, 'Finalizing fMP4 segments');

  return new Promise((resolve, reject) => {
    const cmd = spawn('ffmpeg', ['-y', '-i', 'pipe:0', '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-fflags', '+genpts', '-movflags', '+faststart', outputPath]);

    let totalBytes = 0;
    const segmentSizes: number[] = [];

    for (const segPath of sortedSegments) {
      const stat = fsSync.statSync(segPath);
      segmentSizes.push(stat.size);
      totalBytes += stat.size;
    }

    let processedBytes = 0;

    cmd.on('error', reject);
    cmd.stderr.on('data', (data) => {
      logger.debug({ stderr: data.toString() }, 'FFmpeg fMP4 output');
    });

    cmd.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });

    const pipeSegments = async () => {
      for (let i = 0; i < sortedSegments.length; i++) {
        const segPath = sortedSegments[i];
        const readStream = fsSync.createReadStream(segPath);

        await pipeline(readStream, cmd.stdin!);

        processedBytes += segmentSizes[i];
        const percent = Math.round((processedBytes / totalBytes) * 100);
        onProgress?.(percent);
      }

      cmd.stdin.end();
    };

    pipeSegments().catch(reject);
  });
}
