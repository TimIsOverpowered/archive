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
  interface EpDbRow {
    start: number;
    duration: number;
    end: number | null;
    vodId: number;
    vodDuration: number;
    vodCreatedAt: string;
  }

  interface EpDbCall {
    table: string;
    joined: string | null;
    conditions: Array<[string, string, unknown]>;
  }

  function buildEpDb(rows: EpDbRow[]): { db: Kysely<StreamerDB>; calls: EpDbCall[] } {
    const calls: EpDbCall[] = [];
    const db = {
      selectFrom(table: string) {
        const call: EpDbCall = { table, joined: null, conditions: [] };
        calls.push(call);
        const builder = {
          innerJoin(target: string) {
            call.joined = target;
            return builder;
          },
          select(_cols: unknown) {
            return builder;
          },
          where(column: string, op: string, value: unknown) {
            call.conditions.push([column, op, value]);
            return builder;
          },
          execute: async () => rows,
        };
        return builder;
      },
    };
    return { db: db as unknown as Kysely<StreamerDB>, calls };
  }

  // One Chess chapter per VOD, one VOD per day.
  const row = (vodId: number, date: string, duration = 3600): EpDbRow => ({
    start: 0,
    duration,
    end: null,
    vodId,
    vodDuration: duration + 600,
    vodCreatedAt: date,
  });

  it('returns 1 when no other VODs have the game', async () => {
    const { db, calls } = buildEpDb([]);
    const ep = await computeGameEpNumber(db, 5, [], {
      chapterName: 'Chess',
      chapterStart: 0,
      vodDuration: 3600,
      vodCreatedAt: '2026-10-11T20:00:00Z',
      restrictedGames: [],
    });
    assert.equal(ep, 1);
    const call = calls[0];
    assert.ok(call != null);
    assert.equal(call.table, 'chapters');
    assert.equal(call.joined, 'vods');
    assert.ok(call.conditions.some(([col, op, val]) => col === 'chapters.name' && op === '=' && val === 'Chess'));
    assert.ok(call.conditions.some(([col, op, val]) => col === 'vods.id' && op === '!=' && val === 5));
  });

  it('counts chronologically earlier VODs plus the local offset', async () => {
    const { db } = buildEpDb([row(1, '2026-10-11T20:00:00Z')]);
    const chapters = [ch('Chess', 0, 3600), ch('Chess', 3600, 3600)];
    const ep = await computeGameEpNumber(db, 5, chapters, {
      chapterName: 'Chess',
      chapterStart: 3600,
      vodDuration: 7200,
      vodCreatedAt: '2026-10-12T20:00:00Z',
      restrictedGames: [],
    });
    assert.equal(ep, 3);
  });

  it('assigns EPs by stream date, not by the order uploads are processed', async () => {
    // Four VODs (Oct 11-14) all queued together; the Oct 12 VOD's upload runs
    // FIRST because its download finished first. Its EP must still be 2.
    // Each row set is what the DB returns for that VOD (own VOD excluded by query).
    const epOct12 = await computeGameEpNumber(
      buildEpDb([row(1, '2026-10-11T20:00:00Z'), row(3, '2026-10-13T20:00:00Z'), row(4, '2026-10-14T20:00:00Z')]).db,
      2,
      [ch('Chess', 0, 3600)],
      {
        chapterName: 'Chess',
        chapterStart: 0,
        vodDuration: 3600,
        vodCreatedAt: '2026-10-12T20:00:00Z',
        restrictedGames: [],
      }
    );
    assert.equal(epOct12, 2);

    const epOct11 = await computeGameEpNumber(
      buildEpDb([row(2, '2026-10-12T20:00:00Z'), row(3, '2026-10-13T20:00:00Z'), row(4, '2026-10-14T20:00:00Z')]).db,
      1,
      [ch('Chess', 0, 3600)],
      {
        chapterName: 'Chess',
        chapterStart: 0,
        vodDuration: 3600,
        vodCreatedAt: '2026-10-11T20:00:00Z',
        restrictedGames: [],
      }
    );
    assert.equal(epOct11, 1);

    const epOct13 = await computeGameEpNumber(
      buildEpDb([row(1, '2026-10-11T20:00:00Z'), row(2, '2026-10-12T20:00:00Z'), row(4, '2026-10-14T20:00:00Z')]).db,
      3,
      [ch('Chess', 0, 3600)],
      {
        chapterName: 'Chess',
        chapterStart: 0,
        vodDuration: 3600,
        vodCreatedAt: '2026-10-13T20:00:00Z',
        restrictedGames: [],
      }
    );
    assert.equal(epOct13, 3);

    const epOct14 = await computeGameEpNumber(
      buildEpDb([row(1, '2026-10-11T20:00:00Z'), row(2, '2026-10-12T20:00:00Z'), row(3, '2026-10-13T20:00:00Z')]).db,
      4,
      [ch('Chess', 0, 3600)],
      {
        chapterName: 'Chess',
        chapterStart: 0,
        vodDuration: 3600,
        vodCreatedAt: '2026-10-14T20:00:00Z',
        restrictedGames: [],
      }
    );
    assert.equal(epOct14, 4);
  });

  it('skips earlier VODs whose only chapter of the game is too short', async () => {
    const { db } = buildEpDb([row(1, '2026-10-11T20:00:00Z', 300)]);
    const ep = await computeGameEpNumber(db, 5, [ch('Chess', 0, 3600)], {
      chapterName: 'Chess',
      chapterStart: 0,
      vodDuration: 3600,
      vodCreatedAt: '2026-10-12T20:00:00Z',
      restrictedGames: [],
    });
    assert.equal(ep, 1);
  });

  it('clamps earlier chapters to their VOD duration', async () => {
    // Chapter nominally 7200s but its VOD is only 599s long -> not uploadable
    const { db } = buildEpDb([
      { start: 0, duration: 7200, end: null, vodId: 1, vodDuration: 599, vodCreatedAt: '2026-10-11T20:00:00Z' },
    ]);
    const ep = await computeGameEpNumber(db, 5, [ch('Chess', 0, 3600)], {
      chapterName: 'Chess',
      chapterStart: 0,
      vodDuration: 3600,
      vodCreatedAt: '2026-10-12T20:00:00Z',
      restrictedGames: [],
    });
    assert.equal(ep, 1);
  });

  it('does not count earlier VODs for restricted games', async () => {
    const { db } = buildEpDb([row(1, '2026-10-11T20:00:00Z')]);
    const ep = await computeGameEpNumber(db, 5, [ch('Chess', 0, 3600)], {
      chapterName: 'Chess',
      chapterStart: 0,
      vodDuration: 3600,
      vodCreatedAt: '2026-10-12T20:00:00Z',
      restrictedGames: ['Chess'],
    });
    assert.equal(ep, 1);
  });

  it('breaks equal created_at ties by VOD id', async () => {
    const sameInstant = '2026-10-11T20:00:00Z';
    const { db } = buildEpDb([row(2, sameInstant), row(4, sameInstant)]);
    // Current VOD 3 at the same instant: VOD 2 is earlier by id, VOD 4 is not
    const ep = await computeGameEpNumber(db, 3, [ch('Chess', 0, 3600)], {
      chapterName: 'Chess',
      chapterStart: 0,
      vodDuration: 3600,
      vodCreatedAt: sameInstant,
      restrictedGames: [],
    });
    assert.equal(ep, 2);
  });
});
