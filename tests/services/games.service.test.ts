import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ChapterLibraryQuerySchema } from '../../src/services/chapters.service.js';
import { GameLibraryQuerySchema, GameQuerySchema } from '../../src/services/games.service.js';

describe('ChaptersService: ChapterLibraryQuerySchema', () => {
  it('should parse valid query with defaults', () => {
    const result = ChapterLibraryQuerySchema.parse({});
    assert.strictEqual(result.sort, 'count');
    assert.strictEqual(result.order, 'desc');
    assert.strictEqual(result.page, 1);
    assert.strictEqual(result.limit, 50);
  });

  it('should coerce string numbers to integers', () => {
    const result = ChapterLibraryQuerySchema.parse({ page: '3', limit: '25' });
    assert.strictEqual(result.page, 3);
    assert.strictEqual(result.limit, 25);
    assert.ok(typeof result.page === 'number');
    assert.ok(typeof result.limit === 'number');
  });

  it('should parse chapter_name filter', () => {
    const result = ChapterLibraryQuerySchema.parse({ chapter_name: 'intro' });
    assert.strictEqual(result.chapter_name, 'intro');
  });

  it('should accept custom sort and order', () => {
    const result = ChapterLibraryQuerySchema.parse({ sort: 'recent', order: 'asc' });
    assert.strictEqual(result.sort, 'recent');
    assert.strictEqual(result.order, 'asc');
  });

  it('should reject invalid sort value', () => {
    assert.throws(
      () => ChapterLibraryQuerySchema.parse({ sort: 'invalid' as any }),
      (err: any) => err.name === 'ZodError'
    );
  });

  it('should reject invalid order value', () => {
    assert.throws(
      () => ChapterLibraryQuerySchema.parse({ order: 'invalid' as any }),
      (err: any) => err.name === 'ZodError'
    );
  });

  it('should reject limit above 100', () => {
    assert.throws(
      () => ChapterLibraryQuerySchema.parse({ limit: 101 }),
      (err: any) => err.name === 'ZodError'
    );
  });

  it('should reject page below 1', () => {
    assert.throws(
      () => ChapterLibraryQuerySchema.parse({ page: 0 }),
      (err: any) => err.name === 'ZodError'
    );
  });

  it('should parse all valid sort options', () => {
    for (const sort of ['count', 'chapter_name', 'recent'] as const) {
      const result = ChapterLibraryQuerySchema.parse({ sort });
      assert.strictEqual(result.sort, sort);
    }
  });

  it('should parse full query with all fields', () => {
    const result = ChapterLibraryQuerySchema.parse({
      chapter_name: 'intro',
      sort: 'recent',
      order: 'desc',
      page: 2,
      limit: 30,
    });
    assert.strictEqual(result.chapter_name, 'intro');
    assert.strictEqual(result.sort, 'recent');
    assert.strictEqual(result.order, 'desc');
    assert.strictEqual(result.page, 2);
    assert.strictEqual(result.limit, 30);
  });
});

describe('GamesService: GameLibraryQuerySchema', () => {
  it('should parse valid query with defaults', () => {
    const result = GameLibraryQuerySchema.parse({});
    assert.strictEqual(result.sort, 'count');
    assert.strictEqual(result.order, 'desc');
    assert.strictEqual(result.page, 1);
    assert.strictEqual(result.limit, 50);
  });

  it('should parse game_id filter', () => {
    const result = GameLibraryQuerySchema.parse({ game_id: '123' });
    assert.strictEqual(result.game_id, '123');
  });

  it('should parse game_name filter', () => {
    const result = GameLibraryQuerySchema.parse({ game_name: 'elden ring' });
    assert.strictEqual(result.game_name, 'elden ring');
  });

  it('should accept custom sort and order', () => {
    const result = GameLibraryQuerySchema.parse({ sort: 'recent', order: 'asc' });
    assert.strictEqual(result.sort, 'recent');
    assert.strictEqual(result.order, 'asc');
  });

  it('should reject invalid sort value', () => {
    assert.throws(
      () => GameLibraryQuerySchema.parse({ sort: 'invalid' as any }),
      (err: any) => err.name === 'ZodError'
    );
  });

  it('should reject invalid order value', () => {
    assert.throws(
      () => GameLibraryQuerySchema.parse({ order: 'invalid' as any }),
      (err: any) => err.name === 'ZodError'
    );
  });

  it('should reject limit above 100', () => {
    assert.throws(
      () => GameLibraryQuerySchema.parse({ limit: 101 }),
      (err: any) => err.name === 'ZodError'
    );
  });

  it('should reject page below 1', () => {
    assert.throws(
      () => GameLibraryQuerySchema.parse({ page: 0 }),
      (err: any) => err.name === 'ZodError'
    );
  });

  it('should parse all valid sort options', () => {
    for (const sort of ['count', 'game_name', 'recent'] as const) {
      const result = GameLibraryQuerySchema.parse({ sort });
      assert.strictEqual(result.sort, sort);
    }
  });

  it('should parse full query with all fields', () => {
    const result = GameLibraryQuerySchema.parse({
      game_id: '123',
      game_name: 'elden ring',
      sort: 'recent',
      order: 'desc',
      page: 2,
      limit: 30,
    });
    assert.strictEqual(result.game_id, '123');
    assert.strictEqual(result.game_name, 'elden ring');
    assert.strictEqual(result.sort, 'recent');
    assert.strictEqual(result.order, 'desc');
    assert.strictEqual(result.page, 2);
    assert.strictEqual(result.limit, 30);
  });
});

describe('GamesService: GameQuerySchema with game_id', () => {
  it('should parse game_id filter', () => {
    const result = GameQuerySchema.parse({ game_id: '456' });
    assert.strictEqual(result.game_id, '456');
  });

  it('should parse all filters including game_id', () => {
    const result = GameQuerySchema.parse({
      game_name: 'fps',
      game_id: '789',
      platform: 'twitch',
      page: 1,
      limit: 20,
    });
    assert.strictEqual(result.game_name, 'fps');
    assert.strictEqual(result.game_id, '789');
    assert.strictEqual(result.platform, 'twitch');
  });
});
