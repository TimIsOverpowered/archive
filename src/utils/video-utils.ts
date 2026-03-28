import ffmpeg from 'fluent-ffmpeg';

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
      .on('progress', (progress: any) => {
        if (process.env.NODE_ENV !== 'production') {
          process.stdout.write(`\rM3U8 CONVERT TO MP4 PROGRESS: ${Math.round(progress.percent)}%`);
        }
      })
      .on('start', (cmd: string) => {
        console.info(`Converting VOD ${vodId} m3u8 to mp4 (${cmd})`);
      })
      .on('error', (err: any, stdout: string | null, stderr: string | null) => {
        ffmpegProcess.kill('SIGKILL');
        reject(err || new Error(stderr?.toString() || 'Unknown error'));
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
    ffmpeg.ffprobe(filePath, (err: any, metadata: any) => {
      if (err) {
        console.error(`Failed to probe ${filePath}:`, err.message);
        resolve(null);
      } else {
        const duration = Math.round(metadata.format.duration || 0);
        resolve(duration > 0 ? duration : null);
      }
    });
  });
}
