import stream from 'stream';

export class ProgressStream extends stream.Transform {
  private bytesUploaded: number;
  private fileSize: number;
  private lastReportedPercent: number;
  private onProgress?: (percent: number) => void;

  constructor(fileSize: number, onProgress?: (percent: number) => void) {
    super();
    this.fileSize = fileSize;
    this.bytesUploaded = 0;
    this.lastReportedPercent = -1;
    this.onProgress = onProgress;
  }

  _transform(chunk: Buffer | string, encoding: string, callback: (error?: Error | null, data?: any) => void): void {
    const byteLength = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    this.bytesUploaded += byteLength;

    const percent = Math.min(Math.round((this.bytesUploaded / this.fileSize) * 100), 100);

    const threshold = Math.floor(percent / 25) * 25;
    if (threshold > this.lastReportedPercent && this.onProgress) {
      this.lastReportedPercent = threshold;
      this.onProgress(threshold);
    }

    callback(null, chunk);
  }
}
