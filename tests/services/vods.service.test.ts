import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildVodQuery, VodQuerySchema } from '../../src/services/vods.service.js';
import type { VodResponse } from '../../src/types/vods.js';

describe('VodService: buildVodQuery', () => {
  it('should return default order by created_at desc when no sort/order specified', () => {
    const query = VodQuerySchema.parse({});
    const { orderBy } = buildVodQuery(query);
    assert.strictEqual(orderBy.col, 'created_at');
    assert.strictEqual(orderBy.dir, 'desc');
  });

  it('should respect custom sort and order', () => {
    const query = VodQuerySchema.parse({ sort: 'duration', order: 'asc' });
    const { orderBy } = buildVodQuery(query);
    assert.strictEqual(orderBy.col, 'duration');
    assert.strictEqual(orderBy.dir, 'asc');
  });

  it('should include platform filter when specified', () => {
    const query = VodQuerySchema.parse({ platform: 'twitch' });
    const { where } = buildVodQuery(query);
    assert.ok(typeof where === 'function');
  });

  it('should include date range filters when specified', () => {
    const query = VodQuerySchema.parse({ from: '2024-01-01T00:00:00Z', to: '2024-12-31T23:59:59Z' });
    const { where } = buildVodQuery(query);
    assert.ok(typeof where === 'function');
  });

  it('should include youtube uploaded filter when specified', () => {
    const query = VodQuerySchema.parse({ uploaded: 'youtube' });
    const { where } = buildVodQuery(query);
    assert.ok(typeof where === 'function');
  });

  it('should include game filter with ILIKE when specified', () => {
    const query = VodQuerySchema.parse({ game: 'fps' });
    const { where } = buildVodQuery(query);
    assert.ok(typeof where === 'function');
  });

  it('should combine multiple filters', () => {
    const query = VodQuerySchema.parse({
      platform: 'kick',
      from: '2024-01-01T00:00:00Z',
      uploaded: 'youtube',
      game: 'moba',
    });
    const { where, orderBy } = buildVodQuery(query);
    assert.ok(typeof where === 'function');
    assert.strictEqual(orderBy.col, 'created_at');
    assert.strictEqual(orderBy.dir, 'desc');
  });
});

describe('VodService: VodQuerySchema', () => {
  it('should parse valid query with defaults', () => {
    const result = VodQuerySchema.parse({ platform: 'twitch' });
    assert.strictEqual(result.platform, 'twitch');
    assert.strictEqual(result.page, 1);
    assert.strictEqual(result.limit, 20);
    assert.strictEqual(result.sort, 'created_at');
    assert.strictEqual(result.order, 'desc');
  });

  it('should coerce string numbers to integers', () => {
    const result = VodQuerySchema.parse({ page: '3', limit: '50' });
    assert.strictEqual(result.page, 3);
    assert.strictEqual(result.limit, 50);
    assert.ok(typeof result.page === 'number');
    assert.ok(typeof result.limit === 'number');
  });

  it('should reject invalid platform', () => {
    assert.throws(() => VodQuerySchema.parse({ platform: 'invalid' as any }), (err: any) => {
      return err.name === 'ZodError';
    });
  });

  it('should reject invalid sort value', () => {
    assert.throws(() => VodQuerySchema.parse({ sort: 'invalid' as any }), (err: any) => {
      return err.name === 'ZodError';
    });
  });

  it('should reject invalid order value', () => {
    assert.throws(() => VodQuerySchema.parse({ order: 'invalid' as any }), (err: any) => {
      return err.name === 'ZodError';
    });
  });

  it('should reject limit below 1', () => {
    assert.throws(() => VodQuerySchema.parse({ limit: 0 }), (err: any) => {
      return err.name === 'ZodError';
    });
  });

  it('should reject limit above 100', () => {
    assert.throws(() => VodQuerySchema.parse({ limit: 101 }), (err: any) => {
      return err.name === 'ZodError';
    });
  });

  it('should reject page below 1', () => {
    assert.throws(() => VodQuerySchema.parse({ page: 0 }), (err: any) => {
      return err.name === 'ZodError';
    });
  });

  it('should accept all valid platforms', () => {
    for (const platform of ['twitch', 'kick'] as const) {
      const result = VodQuerySchema.parse({ platform });
      assert.strictEqual(result.platform, platform);
    }
  });

  it('should parse full query with all fields', () => {
    const result = VodQuerySchema.parse({
      platform: 'twitch',
      from: '2024-01-01T00:00:00Z',
      to: '2024-12-31T23:59:59Z',
      uploaded: 'youtube',
      game: 'fps',
      page: 2,
      limit: 50,
      sort: 'duration',
      order: 'asc',
    });
    assert.strictEqual(result.platform, 'twitch');
    assert.strictEqual(result.from, '2024-01-01T00:00:00Z');
    assert.strictEqual(result.to, '2024-12-31T23:59:59Z');
    assert.strictEqual(result.uploaded, 'youtube');
    assert.strictEqual(result.game, 'fps');
    assert.strictEqual(result.page, 2);
    assert.strictEqual(result.limit, 50);
    assert.strictEqual(result.sort, 'duration');
    assert.strictEqual(result.order, 'asc');
  });

  it('should parse empty object with all defaults', () => {
    const result = VodQuerySchema.parse({});
    assert.strictEqual(result.page, 1);
    assert.strictEqual(result.limit, 20);
    assert.strictEqual(result.sort, 'created_at');
    assert.strictEqual(result.order, 'desc');
    assert.strictEqual(result.platform, undefined);
    assert.strictEqual(result.from, undefined);
    assert.strictEqual(result.to, undefined);
    assert.strictEqual(result.uploaded, undefined);
    assert.strictEqual(result.game, undefined);
  });
});

describe('VodService: VodResponse type', () => {
  it('should accept a valid VodResponse object', () => {
    const vod: VodResponse = {
      id: 1,
      vod_id: 'abc123',
      platform: 'twitch',
      title: 'Test Stream',
      duration: 3600,
      stream_id: 'stream-1',
      created_at: new Date(),
      updated_at: new Date(),
      is_live: false,
      started_at: null,
      vod_uploads: [],
      chapters: [],
      games: [],
    };
    assert.strictEqual(vod.id, 1);
    assert.strictEqual(vod.platform, 'twitch');
    assert.strictEqual(vod.vod_uploads.length, 0);
    assert.strictEqual(vod.chapters.length, 0);
    assert.strictEqual(vod.games.length, 0);
  });

  it('should accept VodResponse with populated relations', () => {
    const vod: VodResponse = {
      id: 1,
      vod_id: 'abc123',
      platform: 'twitch',
      title: 'Test Stream',
      duration: 3600,
      stream_id: 'stream-1',
      created_at: new Date(),
      updated_at: new Date(),
      is_live: false,
      started_at: new Date(),
      vod_uploads: [{
        upload_id: 'yt-1',
        type: 'youtube',
        duration: 3600,
        part: 0,
        status: 'COMPLETED',
        thumbnail_url: 'https://example.com/thumb.jpg',
        created_at: '2024-01-01T00:00:00Z',
      }],
      chapters: [{
        name: 'Intro',
        image: null,
        duration: null,
        start: 0,
        end: 60,
      }],
      games: [{
        start_time: 120,
        end_time: 300,
        video_provider: null,
        video_id: null,
        thumbnail_url: null,
        game_id: '123',
        game_name: 'FPS Game',
        title: 'Playing FPS',
        chapter_image: null,
      }],
    };
    assert.strictEqual(vod.vod_uploads.length, 1);
    assert.strictEqual(vod.chapters.length, 1);
    assert.strictEqual(vod.games.length, 1);
    assert.strictEqual(vod.vod_uploads[0].upload_id, 'yt-1');
    assert.strictEqual(vod.chapters[0].name, 'Intro');
    assert.strictEqual(vod.games[0].game_name, 'FPS Game');
  });
});
