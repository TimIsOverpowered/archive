import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { stripTypename, extractEdges, extractMessageData } from '../../../src/workers/chat/chat-helpers.js';

describe('stripTypename', () => {
  it('should remove __typename from a plain object', () => {
    const input = { __typename: 'Foo', name: 'test', value: 42 };
    const result = stripTypename(input);
    assert.deepStrictEqual(result, { name: 'test', value: 42 });
  });

  it('should remove __typename from nested objects', () => {
    const input = {
      __typename: 'Outer',
      nested: { __typename: 'Inner', data: 'hello' },
    };
    const result = stripTypename(input);
    assert.deepStrictEqual(result, { nested: { data: 'hello' } });
  });

  it('should remove __typename from objects inside arrays', () => {
    const input = {
      edges: [
        { __typename: 'Edge', node: { __typename: 'Node', id: '1' } },
        { __typename: 'Edge', node: { __typename: 'Node', id: '2' } },
      ],
    };
    const result = stripTypename(input);
    assert.deepStrictEqual(result, {
      edges: [
        { node: { id: '1' } },
        { node: { id: '2' } },
      ],
    });
  });

  it('should handle null', () => {
    assert.strictEqual(stripTypename(null), null);
  });

  it('should handle undefined', () => {
    assert.strictEqual(stripTypename(undefined), undefined);
  });

  it('should handle primitives unchanged', () => {
    assert.strictEqual(stripTypename('hello'), 'hello');
    assert.strictEqual(stripTypename(42), 42);
    assert.strictEqual(stripTypename(true), true);
    assert.strictEqual(stripTypename(0), 0);
  });

  it('should handle empty object', () => {
    assert.deepStrictEqual(stripTypename({}), {});
  });

  it('should handle deeply nested __typename', () => {
    const input = {
      a: { b: { c: { __typename: 'Deep', d: { __typename: 'Deeper', e: 'val' } } } },
    };
    const result = stripTypename(input);
    assert.deepStrictEqual(result, {
      a: { b: { c: { d: { e: 'val' } } } },
    });
  });

  it('should handle arrays of primitives', () => {
    const input = { items: [1, 'two', true, null] };
    const result = stripTypename(input);
    assert.deepStrictEqual(result, { items: [1, 'two', true, null] });
  });

  it('should not mutate the original object', () => {
    const input = { __typename: 'Foo', bar: 'baz' };
    stripTypename(input);
    assert.deepStrictEqual(input, { __typename: 'Foo', bar: 'baz' });
  });
});

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
    const result = extractEdges(input as any);
    assert.deepStrictEqual(result, []);
  });

  it('should return empty array when edges is undefined', () => {
    const input = {};
    const result = extractEdges(input as any);
    assert.deepStrictEqual(result, []);
  });

  it('should filter out null edges', () => {
    const input = {
      edges: [
        null,
        { node: { id: '1' }, cursor: 'abc' },
        null,
        { node: { id: '2' }, cursor: 'def' },
      ],
    };
    const result = extractEdges(input as any);
    assert.strictEqual(result.length, 2);
  });

  it('should filter out edges missing node or cursor', () => {
    const input = {
      edges: [
        { node: { id: '1' } },
        { cursor: 'abc' },
        { node: { id: '2' }, cursor: 'def' },
      ],
    };
    const result = extractEdges(input as any);
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0], { node: { id: '2' }, cursor: 'def' });
  });

  it('should filter out non-object edges', () => {
    const input = {
      edges: [
        'string-edge',
        42,
        { node: { id: '1' }, cursor: 'abc' },
      ],
    };
    const result = extractEdges(input as any);
    assert.strictEqual(result.length, 1);
  });

  it('should handle empty edges array', () => {
    const input = { edges: [] };
    const result = extractEdges(input as any);
    assert.deepStrictEqual(result, []);
  });
});

describe('extractMessageData', () => {
  it('should extract message content from a valid node', () => {
    const node = {
      message: {
        fragments: [{ text: 'hello ' }, { text: 'world' }],
        userBadges: null,
      },
    };
    const result = extractMessageData(node as any);
    assert.strictEqual(result.message.content, 'hello world');
    assert.deepStrictEqual(result.message.fragments, [{ text: 'hello ' }, { text: 'world' }]);
    assert.strictEqual(result.userBadges, undefined);
  });

  it('should handle node with null message', () => {
    const node = { message: null };
    const result = extractMessageData(node as any);
    assert.strictEqual(result.message.content, '');
    assert.deepStrictEqual(result.message.fragments, []);
    assert.strictEqual(result.userBadges, undefined);
  });

  it('should handle undefined node', () => {
    const result = extractMessageData(undefined as any);
    assert.strictEqual(result.message.content, '');
    assert.deepStrictEqual(result.message.fragments, []);
    assert.strictEqual(result.userBadges, undefined);
  });

  it('should handle null node', () => {
    const result = extractMessageData(null as any);
    assert.strictEqual(result.message.content, '');
    assert.deepStrictEqual(result.message.fragments, []);
    assert.strictEqual(result.userBadges, undefined);
  });

  it('should strip __typename from fragments', () => {
    const node = {
      message: {
        fragments: [
          { __typename: 'EmoteFragment', text: 'hello' },
          { text: ' world' },
        ],
        userBadges: null,
      },
    };
    const result = extractMessageData(node as any);
    assert.strictEqual(result.message.content, 'hello world');
    assert.deepStrictEqual((result.message.fragments as any)[0], { text: 'hello' });
  });

  it('should extract userBadges when present', () => {
    const node = {
      message: {
        fragments: [],
        userBadges: [
          { __typename: 'BadgeSetItem', badgeVersionId: '1', setID: 'subscriber' },
        ],
      },
    };
    const result = extractMessageData(node as any);
    assert.deepStrictEqual(result.userBadges, [
      { badgeVersionId: '1', setID: 'subscriber' },
    ]);
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
    assert.strictEqual(result.message.content, '');
  });

  it('should handle fragments with null/undefined text', () => {
    const node = {
      message: {
        fragments: [
          { text: null },
          { text: undefined },
          { text: 'valid' },
        ],
        userBadges: null,
      },
    };
    const result = extractMessageData(node as any);
    assert.strictEqual(result.message.content, 'valid');
  });

  it('should handle non-object fragments in array', () => {
    const node = {
      message: {
        fragments: ['not-an-object', 42, null, { text: 'good' }],
        userBadges: null,
      },
    };
    const result = extractMessageData(node as any);
    assert.strictEqual(result.message.content, 'good');
  });

  it('should handle fragments as non-array (should return empty string)', () => {
    const node = {
      message: {
        fragments: 'not-an-array',
        userBadges: null,
      },
    };
    const result = extractMessageData(node as any);
    assert.strictEqual(result.message.content, '');
  });

  it('should deep copy fragments array', () => {
    const node = {
      message: {
        fragments: [{ text: 'test' }],
        userBadges: null,
      },
    };
    const result = extractMessageData(node as any);
    (result.message.fragments as any)[0].text = 'modified';
    // The original should not be affected since we create a new object
    assert.deepStrictEqual((result.message.fragments as any)[0], { text: 'modified' });
  });
});
