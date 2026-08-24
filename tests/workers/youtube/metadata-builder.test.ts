import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildYoutubeMetadata, computeGameSegmentPart } from '../../../src/workers/youtube/metadata-builder.ts';

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

  it('should use description as a template (plain text passes through)', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      youtubeDescription: 'Custom description here',
    });
    assert.strictEqual(result.description, 'Custom description here');
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

  it('should handle description template with newlines', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      youtubeDescription: 'Line 1\nLine 2',
    });
    assert.strictEqual(result.description, 'Line 1\nLine 2');
  });

  it('should interpolate description template variables', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      youtubeDescription: 'Chat Replay: {{chatReplay}}\nStream Title: {{vodTitle}}\n{{channel}} - {{date}}',
    });
    assert.strictEqual(
      result.description,
      'Chat Replay: https://example.com/youtube/42\nStream Title: Epic Stream\nTestChannel - JANUARY 15 2024'
    );
  });

  it('should render {{chatReplay}} as empty when chatDownload is false', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      chatDownload: false,
      youtubeDescription: 'Chat Replay: {{chatReplay}}',
    });
    assert.strictEqual(result.description, 'Chat Replay: ');
  });

  it('should use the games replay path in description template for game uploads', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      gameName: 'Elden Ring',
      youtubeDescription: '{{chatReplay}}',
    });
    assert.strictEqual(result.description, 'https://example.com/games/42');
  });

  it('should strip angled brackets from {{vodTitle}} in description template', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      vodRecord: { ...baseOptions.vodRecord, title: 'Stream <<< hype >>> here' },
      youtubeDescription: '{{vodTitle}}',
    });
    assert.strictEqual(result.description, 'Stream  hype  here');
  });

  it('should expose all shared variables in description template', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      type: 'live',
      part: 2,
      gameName: 'Elden Ring',
      epNumber: 5,
      segmentPart: 3,
      youtubeDescription: '{{channel}} {{platform}} {{type}} {{date}} {{part}} {{game}} {{ep}} {{segmentPart}}',
    });
    assert.strictEqual(result.description, 'TestChannel Twitch LIVE JANUARY 15 2024 PART 2 Elden Ring EP 5 Part 3');
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

  it('should use default game title when gameTitleTemplate is undefined', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      gameName: 'Elden Ring',
      epNumber: 5,
    });
    assert.strictEqual(result.title, 'TestChannel plays Elden Ring EP 5 - JANUARY 15 2024');
  });

  it('should use default game title when gameTitleTemplate is empty', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      gameName: 'Elden Ring',
      epNumber: 5,
      gameTitleTemplate: '',
    });
    assert.strictEqual(result.title, 'TestChannel plays Elden Ring EP 5 - JANUARY 15 2024');
  });

  it('should interpolate game title template with game and ep', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      gameName: 'Elden Ring',
      epNumber: 5,
      gameTitleTemplate: '{{channel}} plays {{game}} {{ep}} - {{date}}',
    });
    assert.strictEqual(result.title, 'TestChannel plays Elden Ring EP 5 - JANUARY 15 2024');
  });

  it('should interpolate game title template with platform and type', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      type: 'live',
      gameName: 'Elden Ring',
      gameTitleTemplate: '{{channel}} {{platform}} {{type}} {{game}} - {{date}}',
    });
    assert.strictEqual(result.title, 'TestChannel Twitch LIVE Elden Ring - JANUARY 15 2024');
  });

  it('should interpolate part in game title template', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      gameName: 'Elden Ring',
      gameTitleTemplate: '{{game}} {{part}} - {{date}}',
      part: 2,
    });
    assert.strictEqual(result.title, 'Elden Ring PART 2 - JANUARY 15 2024');
  });

  it('should support vodTitle variable in game title template', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      gameName: 'Elden Ring',
      gameTitleTemplate: '{{vodTitle}} - {{game}}',
    });
    assert.strictEqual(result.title, 'Epic Stream - Elden Ring');
  });

  it('should not include stream title in game title template unless referenced', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      gameName: 'Elden Ring',
      gameTitleTemplate: '{{game}} - {{date}}',
    });
    assert.strictEqual(result.title, 'Elden Ring - JANUARY 15 2024');
    assert.ok(!result.title.includes('Epic Stream'));
  });

  it('should truncate {{game}} not {{channel}} when truncating game title template', () => {
    const longGame = 'G'.repeat(120);
    const result = buildYoutubeMetadata({
      ...baseOptions,
      gameName: longGame,
      gameTitleTemplate: '{{channel}} plays {{game}} - {{date}}',
    });
    assert.ok(result.title.length <= 100, `Title length ${result.title.length} should be <= 100`);
    assert.ok(result.title.startsWith('TestChannel plays '));
    assert.ok(result.title.endsWith('- JANUARY 15 2024'));
  });

  it('should truncate {{vodTitle}} before {{game}} when both are present in game title template', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      gameName: 'Elden Ring',
      gameTitleTemplate: '{{channel}} plays {{game}}: {{vodTitle}} - {{date}}',
      vodRecord: { ...baseOptions.vodRecord, title: 'V'.repeat(120) },
    });
    assert.ok(result.title.length <= 100, `Title length ${result.title.length} should be <= 100`);
    assert.ok(result.title.startsWith('TestChannel plays Elden Ring: '));
    assert.ok(result.title.includes('Elden Ring'));
    assert.ok(result.title.endsWith(' - JANUARY 15 2024'));
  });

  it('should truncate {{vodTitle}} not {{channel}} when {{game}} is absent from game title template', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      gameName: 'Elden Ring',
      gameTitleTemplate: '{{channel}}: {{vodTitle}} - {{date}}',
      vodRecord: { ...baseOptions.vodRecord, title: 'V'.repeat(120) },
    });
    assert.ok(result.title.length <= 100, `Title length ${result.title.length} should be <= 100`);
    assert.ok(result.title.startsWith('TestChannel: '));
    assert.ok(result.title.endsWith(' - JANUARY 15 2024'));
  });

  it('should render {{segmentPart}} as "Part N" in game title template', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      gameName: 'IRL',
      gameTitleTemplate: '{{game}} {{segmentPart}} - {{date}}',
      segmentPart: 3,
    });
    assert.strictEqual(result.title, 'IRL Part 3 - JANUARY 15 2024');
  });

  it('should render {{segmentPart}} as empty when null', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      gameName: 'Slots',
      gameTitleTemplate: '{{game}} - {{date}} {{segmentPart}}',
      segmentPart: null,
    });
    assert.ok(!result.title.includes('Part'));
    assert.ok(result.title.startsWith('Slots - JANUARY 15 2024'));
  });

  it('should ignore segmentPart when using the default game title (no template)', () => {
    const result = buildYoutubeMetadata({
      ...baseOptions,
      gameName: 'IRL',
      segmentPart: 2,
    });
    assert.ok(!result.title.includes('Part'));
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

describe('computeGameSegmentPart', () => {
  const MAX = 43199;

  it('returns null when there are no chapters', () => {
    assert.strictEqual(computeGameSegmentPart([], 0, 1, MAX), null);
  });

  it('returns null for a unique, non-split game', () => {
    const chapters = [{ name: 'Slots', start: 0, duration: 3600 }];
    assert.strictEqual(computeGameSegmentPart(chapters, 0, 1, MAX), null);
  });

  it('numbers split parts of a single-occurrence game', () => {
    const chapters = [{ name: 'IRL', start: 0, duration: 43200 }]; // 12h+ -> 2 segments
    assert.strictEqual(computeGameSegmentPart(chapters, 0, 1, MAX), 1);
    assert.strictEqual(computeGameSegmentPart(chapters, 21600, 2, MAX), 2);
  });

  it('counts game occurrences while skipping a unique game in between', () => {
    const chapters = [
      { name: 'IRL', start: 0, duration: 43200 }, // 2 segments
      { name: 'Slots', start: 43200, duration: 10800 }, // 1 segment (skipped)
      { name: 'IRL', start: 54000, duration: 10800 }, // 1 segment
    ];
    assert.strictEqual(computeGameSegmentPart(chapters, 0, 1, MAX), 1);
    assert.strictEqual(computeGameSegmentPart(chapters, 21600, 2, MAX), 2);
    assert.strictEqual(computeGameSegmentPart(chapters, 43200, 1, MAX), null);
    assert.strictEqual(computeGameSegmentPart(chapters, 54000, 1, MAX), 3);
  });

  it('numbers parts independently per game name', () => {
    const chapters = [
      { name: 'IRL', start: 0, duration: 3600 },
      { name: 'IRL', start: 3600, duration: 3600 },
      { name: 'Poker', start: 7200, duration: 3600 },
      { name: 'Poker', start: 10800, duration: 3600 },
    ];
    assert.strictEqual(computeGameSegmentPart(chapters, 0, 1, MAX), 1);
    assert.strictEqual(computeGameSegmentPart(chapters, 3600, 1, MAX), 2);
    assert.strictEqual(computeGameSegmentPart(chapters, 7200, 1, MAX), 1);
    assert.strictEqual(computeGameSegmentPart(chapters, 10800, 1, MAX), 2);
  });

  it('treats null chapter names as their own group', () => {
    const chapters = [
      { name: null, start: 0, duration: 3600 },
      { name: null, start: 3600, duration: 3600 },
    ];
    assert.strictEqual(computeGameSegmentPart(chapters, 0, 1, MAX), 1);
    assert.strictEqual(computeGameSegmentPart(chapters, 3600, 1, MAX), 2);
  });
});
