import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildYoutubeMetadata } from '../../../src/workers/youtube/metadata-builder.js';

describe('buildYoutubeMetadata', () => {
  const baseOptions = {
    channelName: 'TestChannel',
    platform: 'twitch' as const,
    domainName: 'example.com',
    timezone: 'UTC',
    chatDownload: true,
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

  it('should strip angled brackets from stream title', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      vodRecord: {
        ...baseOptions.vodRecord,
        title: 'Stream <<< hype >>> here',
      },
    });
    assert.ok(!result.description.includes('<'));
    assert.ok(!result.description.includes('>'));
    assert.ok(result.description.includes('Stream  hype  here'));
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
    assert.ok(result.description.includes('/youtube/42'));
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

  it('should omit Chat Replay line when chatDownload is false', () => {
    const result = buildYoutubeMetadata({ ...baseOptions, chatDownload: false });
    assert.ok(!result.description.includes('Chat Replay'));
    assert.ok(result.description.startsWith('Stream Title:'));
  });

  it('should include Chat Replay line when chatDownload is true', () => {
    const result = buildYoutubeMetadata({ ...baseOptions, chatDownload: true });
    assert.ok(result.description.startsWith('Chat Replay:'));
  });

  it('should use structured title by default (empty template)', () => {
    const result = buildYoutubeMetadata(baseOptions);
    assert.strictEqual(result.title, 'TestChannel Twitch VOD - JANUARY 15 2024');
  });

  it('should interpolate stream title template', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      titleTemplate: '{{vodTitle}} - {{date}}',
    });
    assert.strictEqual(result.title, 'Epic Stream - JANUARY 15 2024');
  });

  it('should interpolate full template with all variables', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      titleTemplate: '{{channel}}: {{vodTitle}} - {{date}}',
    });
    assert.strictEqual(result.title, 'TestChannel: Epic Stream - JANUARY 15 2024');
  });

  it('should interpolate LIVE type correctly', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      type: 'live',
      titleTemplate: '{{channel}} {{platform}} {{type}}VOD - {{date}}',
    });
    assert.strictEqual(result.title, 'TestChannel Twitch LIVEVOD - JANUARY 15 2024');
  });

  it('should interpolate part in template', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      titleTemplate: '{{vodTitle}} {{part}} - {{date}}',
      part: 3,
    });
    assert.strictEqual(result.title, 'Epic Stream PART 3 - JANUARY 15 2024');
  });

  it('should truncate title from end when exceeding 100 chars', () => {
    const longTitle = 'A'.repeat(120);
    const result = buildYoutubeMetadata({
      ...baseOptions,
      titleTemplate: '{{vodTitle}} - {{date}}',
      vodRecord: { ...baseOptions.vodRecord, title: longTitle },
    });
    assert.ok(result.title.length <= 100, `Title length ${result.title.length} should be <= 100`);
    assert.ok(result.title.endsWith('- JANUARY 15 2024'));
  });

  it('should truncate structured title when exceeding 100 chars', () => {
    const longChannel = 'A'.repeat(90);
    const result = buildYoutubeMetadata({
      ...baseOptions,
      channelName: longChannel,
    });
    assert.ok(result.title.length <= 100, `Title length ${result.title.length} should be <= 100`);
  });

  it('should handle undefined template (same as empty)', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      titleTemplate: undefined,
    });
    assert.strictEqual(result.title, 'TestChannel Twitch VOD - JANUARY 15 2024');
  });

  it('should handle game upload with template (template ignored)', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      titleTemplate: '{{vodTitle}} - {{date}}',
      gameName: 'Elden Ring',
      epNumber: 5,
    });
    assert.ok(result.title.includes('TestChannel plays Elden Ring'));
    assert.ok(result.title.includes('EP 5'));
    assert.ok(!result.title.includes('Epic Stream'));
  });

  it('should handle empty vodTitle in template', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      titleTemplate: '{{vodTitle}} - {{date}}',
      vodRecord: { ...baseOptions.vodRecord, title: '' },
    });
    assert.strictEqual(result.title, ' - JANUARY 15 2024');
  });

  it('should truncate {{vodTitle}} not {{channel}} when channel is first in template', () => {
    const longTitle = 'A'.repeat(80);
    const result = buildYoutubeMetadata({
      ...baseOptions,
      titleTemplate: '{{channel}}: {{vodTitle}} - {{date}}',
      channelName: 'Short',
      vodRecord: { ...baseOptions.vodRecord, title: longTitle },
    });
    assert.ok(result.title.length <= 100, `Title length ${result.title.length} should be <= 100`);
    assert.ok(result.title.startsWith('Short: '));
    assert.ok(result.title.endsWith('- JANUARY 15 2024'));
  });

  it('should preserve {{channel}} when truncating with part', () => {
    const longTitle = 'A'.repeat(90);
    const result = buildYoutubeMetadata({
      ...baseOptions,
      titleTemplate: '{{channel}} {{vodTitle}} {{part}} - {{date}}',
      channelName: 'MyChannel',
      vodRecord: { ...baseOptions.vodRecord, title: longTitle },
      part: 2,
    });
    assert.ok(result.title.length <= 100, `Title length ${result.title.length} should be <= 100`);
    assert.ok(result.title.startsWith('MyChannel'));
    assert.ok(result.title.includes('PART 2'));
    assert.ok(result.title.endsWith('- JANUARY 15 2024'));
  });

  it('should fallback to first variable when {{vodTitle}} not in template', () => {
    const longChannel = 'A'.repeat(90);
    const result = buildYoutubeMetadata({
      ...baseOptions,
      titleTemplate: '{{channel}} - {{date}}',
      channelName: longChannel,
    });
    assert.ok(result.title.length <= 100, `Title length ${result.title.length} should be <= 100`);
    assert.ok(result.title.endsWith('- JANUARY 15 2024'));
  });
});
