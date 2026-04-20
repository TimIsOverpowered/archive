import * as zlib from 'zlib';
import { promisify } from 'util';
import { getRedisChatCompression, getRedisCompressionLevel } from '../config/env-accessors.js';

const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);
const gzipCompress = promisify(zlib.gzip);
const gzipDecompress = promisify(zlib.gunzip);

export async function compressChatData(data: unknown): Promise<Buffer> {
  const algo = getRedisChatCompression();
  const lvl = getRedisCompressionLevel();
  const buffer = Buffer.from(JSON.stringify(data), 'utf8');

  if (algo === 'none') {
    return buffer;
  }

  if (algo === 'brotli') {
    return brotliCompress(buffer, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: lvl },
    });
  }

  if (algo === 'gzip') {
    return gzipCompress(buffer, { level: lvl });
  }

  return buffer;
}

export async function decompressChatData(compressed: Buffer): Promise<unknown> {
  const algo = getRedisChatCompression();

  if (algo === 'none') {
    return JSON.parse(compressed.toString('utf8'));
  }

  let decompressed: Buffer;

  if (algo === 'brotli') {
    decompressed = await brotliDecompress(compressed);
  } else if (algo === 'gzip') {
    decompressed = await gzipDecompress(compressed);
  } else {
    throw new Error(`Unknown compression algorithm: ${algo}`);
  }

  return JSON.parse(decompressed.toString('utf8'));
}
