import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { Kysely } from 'kysely';

// Must set env vars BEFORE any source imports (youtube auth calls getWorkersConfig at module load)
process.env.REDIS_URL = 'redis://localhost';
process.env.META_DATABASE_URL = 'postgresql://meta';
process.env.PGBOUNCER_URL = 'postgresql://bouncer';
process.env.ENCRYPTION_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.NODE_ENV = 'test';
process.env.VOD_PATH = '/tmp/test-vods';
process.env.TWITCH_CLIENT_ID = 'test-twitch-client-id';
process.env.TWITCH_CLIENT_SECRET = 'test-twitch-client-secret';
process.env.YOUTUBE_CLIENT_ID = 'test-youtube-client-id';
process.env.YOUTUBE_CLIENT_SECRET = 'test-youtube-client-secret';

import type { StreamerDB } from '../../../src/db/streamer-types.ts';
import {
  computeGameEpNumber,
  computeGameLocalEpOffset,
  type EpisodeChapter,
} from '../../../src/workers/youtube/game-upload-processor.ts';

const ch = (name: string | null, start: number, duration: number, end: number | null = null): EpisodeChapter => ({
  name,
  start,
  duration,
  end,
});

describe('computeGameLocalEpOffset', () => {
  it('returns 0 for the first occurrence of a game', () => {
    const chapters = [ch('Intro', 0, 600), ch('Chess', 600, 3600)];
    assert.equal(computeGameLocalEpOffset(chapters, 'Chess', 600, 7200, []), 0);
  });

  it('counts earlier same-name chapters in start order', () => {
    const chapters = [ch('Chess', 0, 3600), ch('Other', 3600, 1200), ch('Chess', 4800, 3600)];
    assert.equal(computeGameLocalEpOffset(chapters, 'Chess', 0, 8400, []), 0);
    assert.equal(computeGameLocalEpOffset(chapters, 'Chess', 4800, 8400, []), 1);
  });

  it('ignores other games', () => {
    const chapters = [ch('Chess', 0, 3600), ch('Go', 3600, 1200)];
    assert.equal(computeGameLocalEpOffset(chapters, 'Go', 3600, 4800, []), 0);
  });

  it('skips restricted chapters', () => {
    const chapters = [ch('Chess', 0, 3600), ch('Chess', 3600, 3600)];
    assert.equal(computeGameLocalEpOffset(chapters, 'Chess', 3600, 7200, ['Chess']), 0);
  });

  it('skips chapters shorter than 10 minutes', () => {
    const chapters = [ch('Chess', 0, 300), ch('Chess', 300, 3600)];
    assert.equal(computeGameLocalEpOffset(chapters, 'Chess', 300, 3900, []), 0);
  });

  it('clamps chapter duration to the VOD duration', () => {
    // First chapter nominally runs to 7200s but the VOD ends at 599s -> not uploadable
    const chapters = [ch('Chess', 0, 7200), ch('Chess', 7200, 3600)];
    assert.equal(computeGameLocalEpOffset(chapters, 'Chess', 7200, 599, []), 0);
    // VOD long enough -> first chapter counts
    assert.equal(computeGameLocalEpOffset(chapters, 'Chess', 7200, 7799, []), 1);
  });

  it('honors the chapter end column when present', () => {
    const chapters = [ch('Chess', 0, 7200, 599), ch('Chess', 7200, 3600)];
    assert.equal(computeGameLocalEpOffset(chapters, 'Chess', 7200, 10800, []), 0);
  });

  it('does not count split parts of the current chapter as earlier occurrences', () => {
    // Single long chapter split into 3 parts (YouTube max duration 43199s)
    const chapters = [ch('Chess', 0, 90000)];
    assert.equal(computeGameLocalEpOffset(chapters, 'Chess', 0, 90000, []), 0);
    assert.equal(computeGameLocalEpOffset(chapters, 'Chess', 43199, 90000, []), 0);
    assert.equal(computeGameLocalEpOffset(chapters, 'Chess', 86398, 90000, []), 0);

    // With an earlier same-name chapter, parts of the second chapter keep the same offset
    const twoChapters = [ch('Chess', 0, 3600), ch('Chess', 3600, 90000)];
    assert.equal(computeGameLocalEpOffset(twoChapters, 'Chess', 3600, 93600, []), 1);
    assert.equal(computeGameLocalEpOffset(twoChapters, 'Chess', 3600 + 43199, 93600, []), 1);
  });

  it('handles unsorted chapter input', () => {
    const chapters = [ch('Chess', 4800, 3600), ch('Other', 3600, 1200), ch('Chess', 0, 3600)];
    assert.equal(computeGameLocalEpOffset(chapters, 'Chess', 4800, 8400, []), 1);
  });
});

describe('computeGameEpNumber', () => {
  interface CountDbCall {
    table: string;
    conditions: Array<[string, string, unknown]>;
  }

  function buildCountDb(existingCount: number): { db: Kysely<StreamerDB>; calls: CountDbCall[] } {
    const calls: CountDbCall[] = [];
    const db = {
      selectFrom(table: string) {
        const conditions: CountDbCall['conditions'] = [];
        calls.push({ table, conditions });
        const whereable = {
          select(_cb: (eb: unknown) => unknown) {
            return whereable;
          },
          where(column: string, op: string, value: unknown) {
            conditions.push([column, op, value]);
            return whereable;
          },
          executeTakeFirst: async () => ({ cnt: existingCount }),
        };
        return whereable;
      },
    };
    return { db: db as unknown as Kysely<StreamerDB>, calls };
  }

  it('returns game count + 1 with no local chapters', async () => {
    const { db, calls } = buildCountDb(3);
    const ep = await computeGameEpNumber(db, 5, [], {
      chapterName: 'Chess',
      chapterStart: 0,
      vodDuration: 3600,
      restrictedGames: [],
    });
    assert.equal(ep, 4);
    const call = calls[0];
    assert.ok(call != null);
    assert.equal(call.table, 'games');
    assert.ok(call.conditions.some(([col, op, val]) => col === 'game_name' && op === '=' && val === 'Chess'));
    assert.ok(call.conditions.some(([col, op, val]) => col === 'vod_id' && op === '!=' && val === 5));
  });

  it('combines existing count and local offset', async () => {
    const { db } = buildCountDb(4);
    const chapters = [ch('Chess', 0, 3600), ch('Chess', 3600, 3600)];
    const ep = await computeGameEpNumber(db, 5, chapters, {
      chapterName: 'Chess',
      chapterStart: 3600,
      vodDuration: 7200,
      restrictedGames: [],
    });
    assert.equal(ep, 6);
  });

  it('returns 1 when no existing games', async () => {
    const { db } = buildCountDb(0);
    const ep = await computeGameEpNumber(db, 5, [ch('Chess', 0, 3600)], {
      chapterName: 'Chess',
      chapterStart: 0,
      vodDuration: 3600,
      restrictedGames: [],
    });
    assert.equal(ep, 1);
  });

  it('assigns sequential EPs to two VODs queued back-to-back for the same game', async () => {
    // Both VODs were queued against the same snapshot (4 existing games), but by the
    // time VOD B's upload runs, VOD A's game row has been inserted (5 existing games).
    const forVodA = buildCountDb(4);
    const epA = await computeGameEpNumber(forVodA.db, 1, [ch('Chess', 0, 3600)], {
      chapterName: 'Chess',
      chapterStart: 0,
      vodDuration: 3600,
      restrictedGames: [],
    });

    const forVodB = buildCountDb(5);
    const epB = await computeGameEpNumber(forVodB.db, 2, [ch('Chess', 0, 3600)], {
      chapterName: 'Chess',
      chapterStart: 0,
      vodDuration: 3600,
      restrictedGames: [],
    });

    assert.equal(epA, 5);
    assert.equal(epB, 6);
  });
});
