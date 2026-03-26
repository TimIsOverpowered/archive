import * as zlib from 'zlib';
import { promisify } from 'util';

const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);
const gzipCompress = promisify(zlib.gzip);
const gzipDecompress = promisify(zlib.gunzip);

type CompressionAlgorithm = 'brotli' | 'gzip' | 'none';

const algorithm: CompressionAlgorithm = (process.env.REDIS_CHAT_COMPRESSION || 'brotli') as CompressionAlgorithm;
const level = parseInt(process.env.REDIS_COMPRESSION_LEVEL || '6', 10);

export function getCompressionAlgorithm(): CompressionAlgorithm {
  return algorithm;
}

export async function compressChatData(data: unknown): Promise<Buffer> {
  const json = JSON.stringify(data);
  const buffer = Buffer.from(json, 'utf8');

  if (algorithm === 'none') {
    return buffer;
  }

  if (algorithm === 'brotli') {
    return brotliCompress(buffer);
  }

  if (algorithm === 'gzip') {
    return gzipCompress(buffer, { level });
  }

  return buffer;
}

export async function decompressChatData(compressed: Buffer): Promise<unknown> {
  if (algorithm === 'none') {
    return JSON.parse(compressed.toString('utf8'));
  }

  let decompressed: Buffer;

  if (algorithm === 'brotli') {
    decompressed = await brotliDecompress(compressed);
  } else {
    decompressed = await gzipDecompress(compressed);
  }

  return JSON.parse(decompressed.toString('utf8'));
}

export function estimateCompressionRatio(): number {
  switch (algorithm) {
    case 'brotli':
      return 0.15; // 85% reduction
    case 'gzip':
      return 0.2; // 80% reduction
    case 'none':
      return 1.0;
    default:
      return 1.0;
  }
}
