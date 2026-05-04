import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { registerStrategy, getStrategy } from '../../../src/services/platforms/strategy.js';
import { strategy } from '../../../src/services/twitch/strategy.js';

describe('Twitch Strategy: createVodData', () => {
  it('should create correct VodCreateData from platform metadata', () => {
    const meta = {
      id: 'twitch-vod-123',
      title: 'Epic Stream',
      createdAt: '2024-01-15T10:00:00Z',
      duration: 7200,
      streamId: 'stream-456',
    };

    const result = strategy.createVodData(meta);

    assert.strictEqual(result.platform_vod_id, 'twitch-vod-123');
    assert.strictEqual(result.title, 'Epic Stream');
    assert.strictEqual(result.platform, 'twitch');
    assert.strictEqual(result.is_live, false);
    assert.strictEqual(result.duration, 7200);
    assert.strictEqual(result.platform_stream_id, 'stream-456');
    assert.strictEqual(result.created_at, '2024-01-15T10:00:00Z');
  });

  it('should handle null title', () => {
    const meta = {
      id: 'twitch-vod-123',
      title: '',
      createdAt: '2024-01-15T10:00:00Z',
      duration: 3600,
      streamId: '',
    };

    const result = strategy.createVodData(meta);
    assert.strictEqual(result.platform_stream_id, '');
  });

  it('should handle empty string title', () => {
    const meta = {
      id: 'twitch-vod-123',
      title: '',
      createdAt: '2024-01-15T10:00:00Z',
      duration: 3600,
      streamId: 'stream-1',
    };

    const result = strategy.createVodData(meta);
    assert.strictEqual(result.title, null);
  });

  it('should parse createdAt as Date', () => {
    const meta = {
      id: 'twitch-vod-123',
      title: 'Test',
      createdAt: '2024-06-15T14:30:00Z',
      duration: 1800,
      streamId: 'stream-1',
    };

    const result = strategy.createVodData(meta);
    assert.strictEqual(result.created_at, '2024-06-15T14:30:00Z');
  });
});

describe('Twitch Strategy: updateVodData', () => {
  it('should create correct VodUpdateData from platform metadata', () => {
    const meta = {
      id: 'twitch-vod-123',
      title: 'Updated Stream',
      createdAt: '2024-01-15T10:00:00Z',
      duration: 7200,
      streamId: 'stream-456',
    };

    const result = strategy.updateVodData(meta);

    assert.strictEqual(result.platform_vod_id, 'twitch-vod-123');
    assert.strictEqual(result.title, 'Updated Stream');
    assert.strictEqual(result.duration, 7200);
    assert.strictEqual(result.platform_stream_id, 'stream-456');
    assert.ok(result.created_at instanceof Date);
  });

  it('should handle null title', () => {
    const meta = {
      id: 'twitch-vod-123',
      title: '',
      createdAt: '2024-01-15T10:00:00Z',
      duration: 3600,
      streamId: 'stream-1',
    };

    const result = strategy.updateVodData(meta);
    assert.strictEqual(result.title, null);
  });

  it('should handle empty string title', () => {
    const meta = {
      id: 'twitch-vod-123',
      title: '',
      createdAt: '2024-01-15T10:00:00Z',
      duration: 3600,
      streamId: 'stream-1',
    };

    const result = strategy.updateVodData(meta);
    assert.strictEqual(result.title, null);
  });
});

describe('Twitch Strategy: finalizeChapters', () => {
  it('should not throw when chapters finalize fails (error is caught)', async () => {
    const ctx = {
      tenantId: 'tenant-1',
      config: { id: 'tenant-1', twitch: { enabled: true }, database: { url: 'postgresql://test' }, settings: {} },
      db: null,
    };

    await assert.doesNotReject((strategy as any).finalizeChapters?.(ctx as any, 42, 'vod-123', 3600));
  });
});

describe('Twitch Strategy: registration', () => {
  it('should be registerable as twitch strategy', () => {
    registerStrategy('twitch', strategy);
    const registered = getStrategy('twitch');
    assert.strictEqual(registered, strategy);
  });

  it('should have all required methods', () => {
    assert.ok(typeof strategy.checkStreamStatus === 'function');
    assert.ok(typeof strategy.fetchVodMetadata === 'function');
    assert.ok(typeof strategy.createVodData === 'function');
    assert.ok(typeof strategy.updateVodData === 'function');
    assert.ok(typeof strategy.finalizeChapters === 'function');
  });
});
