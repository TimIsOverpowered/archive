import stream, { TransformCallback } from 'stream';

export interface UploadProgressData {
  percent: number;
  bytesUploaded: number;
  speed: number;
  eta: number;
}

export class ProgressStream extends stream.Transform {
  private bytesUploaded: number;
  private fileSize: number;
  private lastReportedPercent: number;
  private startTime: number;
  private onProgress?: ((progressData: UploadProgressData) => void) | undefined;

  constructor(fileSize: number, onProgress?: ((progressData: UploadProgressData) => void) | undefined) {
    super();
    this.fileSize = fileSize;
    this.bytesUploaded = 0;
    this.lastReportedPercent = -1;
    this.startTime = Date.now();
    this.onProgress = onProgress;
  }

  _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    const byteLength = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
    this.bytesUploaded += byteLength;

    const percent = Math.min(Math.round((this.bytesUploaded / this.fileSize) * 100), 100);
    const elapsedSeconds = (Date.now() - this.startTime) / 1000;
    const speed = elapsedSeconds > 0 ? this.bytesUploaded / elapsedSeconds : 0;
    const eta = speed > 0 ? (this.fileSize - this.bytesUploaded) / speed : 0;

    const progressData: UploadProgressData = {
      percent,
      bytesUploaded: this.bytesUploaded,
      speed,
      eta: Math.round(eta),
    };

    const threshold = Math.floor(percent / 25) * 25;
    if (threshold > this.lastReportedPercent && this.onProgress) {
      this.lastReportedPercent = threshold;
      this.onProgress(progressData);
    }

    callback(null, chunk);
  }
}
