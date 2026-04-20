import * as zlib from 'zlib';
import { promisify } from 'util';
import { getRedisChatCompression, getRedisCompressionLevel } from '../config/env-accessors.js';

const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);
const gzipCompress = promisify(zlib.gzip);
const gzipDecompress = promisify(zlib.gunzip);

type CompressionAlgorithm = 'brotli' | 'gzip' | 'none';

const algorithm: CompressionAlgorithm = getRedisChatCompression();
const level = getRedisCompressionLevel();

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
