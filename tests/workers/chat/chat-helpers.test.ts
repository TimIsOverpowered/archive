import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { extractEdges, extractMessageData } from '../../../src/workers/chat/chat-helpers.js';

describe('extractEdges', () => {
  it('should return edges array from a valid comments connection', () => {
    const input = {
      edges: [
        { node: { id: '1' }, cursor: 'abc' },
        { node: { id: '2' }, cursor: 'def' },
      ],
    };
    const result = extractEdges(input as any);
    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(result[0], { node: { id: '1' }, cursor: 'abc' });
    assert.deepStrictEqual(result[1], { node: { id: '2' }, cursor: 'def' });
  });

  it('should return empty array when edges is not an array', () => {
    const input = { edges: 'not-an-array' };
    const result = extractEdges(input as any);
    assert.deepStrictEqual(result, []);
  });

  it('should return empty array when edges is null', () => {
    const input = { edges: null };
    const result = extractEdges(input);
    assert.deepStrictEqual(result, []);
  });

  it('should return empty array when edges is undefined', () => {
    const input = {};
    const result = extractEdges(input as any);
    assert.deepStrictEqual(result, []);
  });

  it('should filter out null edges', () => {
    const input = {
      edges: [null, { node: { id: '1' }, cursor: 'abc' }, null, { node: { id: '2' }, cursor: 'def' }],
    };
    const result = extractEdges(input as any);
    assert.strictEqual(result.length, 2);
  });

  it('should filter out edges missing node or cursor', () => {
    const input = {
      edges: [{ node: { id: '1' } }, { cursor: 'abc' }, { node: { id: '2' }, cursor: 'def' }],
    };
    const result = extractEdges(input as any);
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0], { node: { id: '2' }, cursor: 'def' });
  });

  it('should filter out non-object edges', () => {
    const input = {
      edges: ['string-edge', 42, { node: { id: '1' }, cursor: 'abc' }],
    };
    const result = extractEdges(input as any);
    assert.strictEqual(result.length, 1);
  });

  it('should handle empty edges array', () => {
    const input = { edges: [] };
    const result = extractEdges(input);
    assert.deepStrictEqual(result, []);
  });
});

describe('extractMessageData', () => {
  it('should extract fragments from a valid node', () => {
    const node = {
      message: {
        fragments: [{ text: 'hello ' }, { text: 'world' }],
        userBadges: null,
      },
    };
    const result = extractMessageData(node as any);
    assert.deepStrictEqual(result.message, [{ text: 'hello ' }, { text: 'world' }]);
    assert.strictEqual(result.userBadges, undefined);
  });

  it('should handle node with null message', () => {
    const node = { message: null };
    const result = extractMessageData(node as any);
    assert.deepStrictEqual(result.message, []);
    assert.strictEqual(result.userBadges, undefined);
  });

  it('should handle undefined node', () => {
    const result = extractMessageData(undefined);
    assert.deepStrictEqual(result.message, []);
    assert.strictEqual(result.userBadges, undefined);
  });

  it('should handle null node', () => {
    const result = extractMessageData(null);
    assert.deepStrictEqual(result.message, []);
    assert.strictEqual(result.userBadges, undefined);
  });

  it('should extract userBadges when present', () => {
    const node = {
      message: {
        fragments: [],
        userBadges: [{ badgeVersionId: '1', setID: 'subscriber' }],
      },
    };
    const result = extractMessageData(node as any);
    assert.deepStrictEqual(result.userBadges, [{ badgeVersionId: '1', setID: 'subscriber' }]);
  });

  it('should handle node with no userBadges property', () => {
    const node = {
      message: {
        fragments: [],
      },
    };
    const result = extractMessageData(node as any);
    assert.strictEqual(result.userBadges, undefined);
  });

  it('should handle empty fragments array', () => {
    const node = {
      message: {
        fragments: [],
        userBadges: null,
      },
    };
    const result = extractMessageData(node as any);
    assert.deepStrictEqual(result.message, []);
  });

  it('should handle fragments with null/undefined text', () => {
    const node = {
      message: {
        fragments: [{ text: null }, { text: undefined }, { text: 'valid' }],
        userBadges: null,
      },
    };
    const result = extractMessageData(node as any);
    assert.deepStrictEqual(result.message, [{ text: null }, { text: undefined }, { text: 'valid' }]);
  });

  it('should pass through non-object fragments as-is', () => {
    const node = {
      message: {
        fragments: ['not-an-object', 42, null, { text: 'good' }],
        userBadges: null,
      },
    };
    const result = extractMessageData(node as any);
    assert.deepStrictEqual(result.message, ['not-an-object', 42, null, { text: 'good' }]);
  });

  it('should handle fragments as non-array (should return empty array)', () => {
    const node = {
      message: {
        fragments: 'not-an-array',
        userBadges: null,
      },
    };
    const result = extractMessageData(node as any);
    assert.deepStrictEqual(result.message, []);
  });

  it('should deep copy fragments array', () => {
    const node = {
      message: {
        fragments: [{ text: 'test' }],
        userBadges: null,
      },
    };
    const result = extractMessageData(node as any);
    (result.message as any)[0].text = 'modified';
    assert.deepStrictEqual(result.message[0], { text: 'modified' });
  });
});
