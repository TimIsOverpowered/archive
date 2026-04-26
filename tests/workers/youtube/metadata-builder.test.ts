import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildYoutubeMetadata } from '../../../src/workers/youtube/metadata-builder.js';

describe('buildYoutubeMetadata', () => {
  const baseOptions = {
    channelName: 'TestChannel',
    platform: 'twitch' as const,
    domainName: 'example.com',
    timezone: 'UTC',
    type: 'vod' as const,
    vodRecord: {
      id: 42,
      title: 'Epic Stream',
      created_at: new Date('2024-01-15T20:00:00Z'),
    } as any,
  };

  it('should build metadata with required fields', () => {
    const result = buildYoutubeMetadata(baseOptions);
    assert.ok(result.title.includes('TestChannel'));
    assert.ok(result.title.includes('Twitch'));
    assert.ok(result.title.includes('VOD'));
    assert.ok(result.title.includes('JANUARY 15 2024'));
    assert.ok(result.description.includes('Chat Replay'));
    assert.ok(result.description.includes('example.com'));
    assert.ok(result.description.includes('Stream Title: Epic Stream'));
  });

  it('should add LIVE suffix for live source type', () => {
    const result = buildYoutubeMetadata({ ...baseOptions, type: 'live' });
    assert.ok(result.title.includes('LIVE'));
    assert.ok(result.title.includes('VOD'));
  });

  it('should add PART suffix when part is provided', () => {
    const result = buildYoutubeMetadata({ ...baseOptions, part: 2 });
    assert.ok(result.title.includes('PART 2'));
  });

  it('should handle part 1 explicitly', () => {
    const result = buildYoutubeMetadata({ ...baseOptions, part: 1 });
    assert.ok(result.title.includes('PART 1'));
  });

  it('should handle null part (no PART suffix)', () => {
    const result = buildYoutubeMetadata({ ...baseOptions, part: undefined });
    assert.ok(!result.title.includes('PART'));
  });

  it('should handle Kick platform', () => {
    const result = buildYoutubeMetadata({ ...baseOptions, platform: 'kick' });
    assert.ok(result.title.includes('Kick'));
  });

  it('should strip HTML tags from stream title', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      vodRecord: {
        ...baseOptions.vodRecord,
        title: '<b>Stream</b> with <i>tags</i>',
      },
    });
    assert.ok(!result.description.includes('<'));
    assert.ok(!result.description.includes('>'));
    assert.ok(result.description.includes('Stream with tags'));
  });

  it('should handle null stream title', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      vodRecord: {
        ...baseOptions.vodRecord,
        title: null,
      },
    });
    assert.ok(result.description.includes('Stream Title:'));
  });

  it('should handle empty stream title', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      vodRecord: {
        ...baseOptions.vodRecord,
        title: '',
      },
    });
    assert.ok(result.description.includes('Stream Title: '));
  });

  it('should include youtubeDescription when provided', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      youtubeDescription: 'Custom description here',
    });
    assert.ok(result.description.includes('Custom description here'));
  });

  it('should not include extra whitespace for missing youtubeDescription', () => {
    const result = buildYoutubeMetadata({ ...baseOptions });
    assert.ok(result.description.endsWith('\n'));
  });

  it('should use vodRecord id in replay path', () => {
    const result = buildYoutubeMetadata(baseOptions);
    assert.ok(result.description.includes('/vods/42'));
  });

  it('should handle different timezone formatting', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      timezone: 'America/New_York',
    });
    assert.ok(result.title.includes('JANUARY 15 2024'));
  });

  it('should produce description with correct format', () => {
    const result = buildYoutubeMetadata(baseOptions);
    const lines = result.description.split('\n');
    assert.strictEqual(lines.length, 3);
    assert.ok(lines[0]?.startsWith('Chat Replay:'));
    assert.ok(lines[1]?.startsWith('Stream Title:'));
    assert.strictEqual(lines[2], '');
  });

  it('should handle youtubeDescription with newlines', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      youtubeDescription: 'Line 1\nLine 2',
    });
    assert.ok(result.description.includes('Line 1'));
    assert.ok(result.description.includes('Line 2'));
  });

  it('should capitalize platform name correctly', () => {
    const result = buildYoutubeMetadata({ ...baseOptions, platform: 'twitch' });
    assert.ok(result.title.includes('Twitch'));
  });
});
