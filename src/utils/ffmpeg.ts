import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface ProgressEvent {
  percent?: number;
}

export async function downloadM3u8(m3u8Url: string, outputPath: string, onProgress?: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(m3u8Url)
      .outputOptions('-c copy')
      .save(outputPath)
      .on('progress', (progress: ProgressEvent) => {
        if (onProgress && progress.percent) {
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
        if (onProgress && progress.percent) {
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

export async function getDuration(filePath: string): Promise<number> {
  const command = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
  const { stdout } = await execAsync(command);
  const duration = parseFloat(stdout.trim());
  return Math.round(duration);
}

export async function convertM3u8ToMp4(m3u8Path: string, outputPath: string, onProgress?: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(m3u8Path)
      .outputOptions('-c copy')
      .save(outputPath)
      .on('progress', (progress: ProgressEvent) => {
        if (onProgress && progress.percent) {
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
