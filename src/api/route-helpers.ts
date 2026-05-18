import { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { Routing } from '../constants.js';
import type { StreamerDB } from '../db/streamer-types.js';
import { resolveVodIdByPlatformVodId } from '../services/vods.service.js';
import { notFound } from '../utils/http-error.js';

/**
 * Creates an AbortController that aborts when the underlying HTTP request closes.
 * Attaches a one-time listener to the raw request's 'close' event.
 */
export function createRequestController(request: FastifyRequest): AbortController {
  const controller = new AbortController();
  request.raw.once('close', () => {
    if (request.raw.destroyed) {
      controller.abort();
    }
  });
  return controller;
}

/**
 * Resolves a raw VOD ID param to an actual database ID.
 * If the ID is a strict integer below LEGACY_ID_THRESHOLD, uses it directly.
 * Otherwise, looks it up by platform_vod_id in the database.
 * Throws a 404 if the platform lookup returns nothing.
 */
export async function resolveVodDbId(
  db: Kysely<StreamerDB>,
  rawVodId: string,
  signal: AbortSignal,
  notFoundMessage = 'VOD not found'
): Promise<number> {
  const parsedAsInt = parseInt(rawVodId, 10);
  const isStrictInt = !isNaN(parsedAsInt) && String(parsedAsInt) === rawVodId;

  if (isStrictInt && parsedAsInt < Routing.LEGACY_ID_THRESHOLD) {
    return parsedAsInt;
  }

  const resolved = await resolveVodIdByPlatformVodId(db, rawVodId, { signal });
  if (resolved == null) {
    notFound(notFoundMessage);
  }
  return resolved;
}
