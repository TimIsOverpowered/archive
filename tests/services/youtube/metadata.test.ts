import { strict as assert } from 'node:assert';
import { describe, it, mock } from 'node:test';

// ============================================================================
// Hoisted mocks — registered before the module under test is imported
// ============================================================================

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const descriptions = new Map<string, string>();
const mockYoutubeList = mock.fn(async ({ id }: { id: string[] }) => ({
  data: {
    items: id.map((videoId) => ({
      snippet: {
        title: `Title ${videoId}`,
        description: descriptions.get(videoId) ?? '',
        categoryId: '10',
      },
    })),
  },
}));
const mockYoutubeUpdate = mock.fn(
  async ({ requestBody }: { requestBody: { id: string; snippet: { description: string } } }) => {
    descriptions.set(requestBody.id, requestBody.snippet.description);
    return { data: {} };
  }
);

mock.module('../../../src/services/youtube/client.js', {
  namedExports: {
    createYoutubeClient: async () => ({
      videos: {
        list: mockYoutubeList,
        update: mockYoutubeUpdate,
      },
    }),
  },
});

mock.module('../../../src/utils/auto-tenant-logger.js', {
  namedExports: {
    createAutoLogger: () => mockLogger,
  },
});

// ============================================================================
// System Under Test — dynamically imported AFTER mock.module registrations
// ============================================================================

const { saveChaptersAndLinkParts, stripPartNavigationLinks } = await import(
  '../../../src/services/youtube/metadata.ts'
);

function createMockDb(opts: {
  chapters?: Array<{ id: number; vod_id: number; name: string | null; start: number; duration: number | null }>;
  vodUploads?: Array<{ vod_id: number; upload_id: string; type: string; part: number; status: string }>;
}) {
  const builder = (rows: Record<string, unknown>[]) => {
    const filters: Array<{ column: string; value: unknown }> = [];
    const b = {
      where(column: string, _op: string, value: unknown) {
        filters.push({ column, value });
        return b;
      },
      orderBy: () => b,
      select: () => b,
      selectAll: () => b,
      execute: async () => rows.filter((row) => filters.every((f) => row[f.column] === f.value)),
    };
    return b;
  };
  return {
    selectFrom(table: string) {
      if (table === 'chapters') return builder(opts.chapters ?? []);
      if (table === 'vod_uploads') return builder(opts.vodUploads ?? []);
      return builder([]);
    },
  };
}

function resetState(): void {
  descriptions.clear();
  mockYoutubeList.mock.resetCalls();
  mockYoutubeUpdate.mock.resetCalls();
}

describe('stripPartNavigationLinks', () => {
  it('should strip nav lines from the top of a description', () => {
    const desc =
      'PART 1: https://youtube.com/watch?v=abc\nPART 3: https://youtube.com/watch?v=xyz\nBase text\nStream Title: foo';
    assert.strictEqual(stripPartNavigationLinks(desc), 'Base text\nStream Title: foo');
  });

  it('should strip nav lines anywhere in the description', () => {
    const desc = 'Base text\nPART 2: https://youtube.com/watch?v=abc\nMore text';
    assert.strictEqual(stripPartNavigationLinks(desc), 'Base text\nMore text');
  });

  it('should leave descriptions without nav lines unchanged', () => {
    const desc = 'Base text\nStream Title: foo';
    assert.strictEqual(stripPartNavigationLinks(desc), desc);
  });

  it('should not strip similar-looking lines that are not generated nav lines', () => {
    const desc = 'PART 2: watch later\nPART X: https://youtube.com/watch?v=abc\nPART 2: not a url';
    assert.strictEqual(stripPartNavigationLinks(desc), desc);
  });

  it('should handle an empty description', () => {
    assert.strictEqual(stripPartNavigationLinks(''), '');
  });
});

describe('saveChaptersAndLinkParts', () => {
  it('should early-return without touching YouTube when there is one part and no chapters', async () => {
    resetState();
    const db = createMockDb({
      vodUploads: [{ vod_id: 10, upload_id: 'A', type: 'vod', part: 1, status: 'COMPLETED' }],
    });
    await saveChaptersAndLinkParts('t1', 10, [{ id: 'A', part: 1 }], 3600, db as any);
    assert.strictEqual(mockYoutubeList.mock.callCount(), 0);
    assert.strictEqual(mockYoutubeUpdate.mock.callCount(), 0);
  });

  it('should re-link all parts when only one part is re-uploaded (DMCA case)', async () => {
    resetState();
    const db = createMockDb({
      chapters: [{ id: 1, vod_id: 10, name: 'Ch2', start: 4200, duration: 120 }],
      vodUploads: [
        { vod_id: 10, upload_id: 'A', type: 'vod', part: 1, status: 'COMPLETED' },
        { vod_id: 10, upload_id: 'NEW', type: 'vod', part: 2, status: 'COMPLETED' },
        { vod_id: 10, upload_id: 'C', type: 'vod', part: 3, status: 'COMPLETED' },
      ],
    });

    descriptions.set('A', 'PART 2: https://youtube.com/watch?v=OLD\nPART 3: https://youtube.com/watch?v=C\nBase A');
    descriptions.set('NEW', 'Base NEW');
    descriptions.set('C', 'PART 1: https://youtube.com/watch?v=A\nPART 2: https://youtube.com/watch?v=OLD\nBase C');

    await saveChaptersAndLinkParts('t1', 10, [{ id: 'NEW', part: 2 }], 3600, db as any);

    // All three parts were rewritten with the fresh part-2 ID
    assert.strictEqual(mockYoutubeUpdate.mock.callCount(), 3);

    assert.strictEqual(
      descriptions.get('A'),
      'PART 2: https://youtube.com/watch?v=NEW\nPART 3: https://youtube.com/watch?v=C\nBase A'
    );
    // New part gets nav links AND its chapter timestamps
    assert.strictEqual(
      descriptions.get('NEW'),
      'PART 1: https://youtube.com/watch?v=A\nPART 3: https://youtube.com/watch?v=C\nBase NEW\n\n00:10:00 Ch2'
    );
    assert.strictEqual(
      descriptions.get('C'),
      'PART 1: https://youtube.com/watch?v=A\nPART 2: https://youtube.com/watch?v=NEW\nBase C'
    );
  });

  it('should be idempotent: a second run makes no further updates', async () => {
    resetState();
    const db = createMockDb({
      chapters: [{ id: 1, vod_id: 10, name: 'Ch2', start: 4200, duration: 120 }],
      vodUploads: [
        { vod_id: 10, upload_id: 'A', type: 'vod', part: 1, status: 'COMPLETED' },
        { vod_id: 10, upload_id: 'NEW', type: 'vod', part: 2, status: 'COMPLETED' },
        { vod_id: 10, upload_id: 'C', type: 'vod', part: 3, status: 'COMPLETED' },
      ],
    });

    descriptions.set('A', 'Base A');
    descriptions.set('NEW', 'Base NEW');
    descriptions.set('C', 'Base C');

    await saveChaptersAndLinkParts('t1', 10, [{ id: 'NEW', part: 2 }], 3600, db as any);
    const updatesAfterFirstRun = mockYoutubeUpdate.mock.callCount();
    assert.strictEqual(updatesAfterFirstRun, 3);

    mockYoutubeUpdate.mock.resetCalls();
    await saveChaptersAndLinkParts('t1', 10, [{ id: 'NEW', part: 2 }], 3600, db as any);

    // No stacked nav blocks and no duplicated chapter block
    assert.strictEqual(mockYoutubeUpdate.mock.callCount(), 0);
    assert.strictEqual(
      descriptions.get('NEW'),
      'PART 1: https://youtube.com/watch?v=A\nPART 3: https://youtube.com/watch?v=C\nBase NEW\n\n00:10:00 Ch2'
    );
  });

  it('should link and chapter all parts on a full multi-part upload', async () => {
    resetState();
    const db = createMockDb({
      chapters: [{ id: 1, vod_id: 10, name: 'Ch1', start: 60, duration: 120 }],
      vodUploads: [
        { vod_id: 10, upload_id: 'A', type: 'vod', part: 1, status: 'COMPLETED' },
        { vod_id: 10, upload_id: 'B', type: 'vod', part: 2, status: 'COMPLETED' },
      ],
    });

    descriptions.set('A', 'Base A');
    descriptions.set('B', 'Base B');

    await saveChaptersAndLinkParts(
      't1',
      10,
      [
        { id: 'A', part: 1 },
        { id: 'B', part: 2 },
      ],
      3600,
      db as any
    );

    assert.strictEqual(mockYoutubeUpdate.mock.callCount(), 2);
    // Chapter at 00:01:00 belongs to part 1 only
    assert.strictEqual(descriptions.get('A'), 'PART 2: https://youtube.com/watch?v=B\nBase A\n\n00:01:00 Ch1');
    assert.strictEqual(descriptions.get('B'), 'PART 1: https://youtube.com/watch?v=A\nBase B');
  });

  it('should ignore vod_uploads rows that are not completed', async () => {
    resetState();
    const db = createMockDb({
      vodUploads: [
        { vod_id: 10, upload_id: 'A', type: 'vod', part: 1, status: 'COMPLETED' },
        { vod_id: 10, upload_id: 'FAILED-1', type: 'vod', part: 2, status: 'FAILED' },
      ],
    });

    descriptions.set('A', 'Base A');
    descriptions.set('FAILED-1', 'Base FAILED-1');

    await saveChaptersAndLinkParts('t1', 10, [{ id: 'A', part: 1 }], 3600, db as any);

    // Only one completed part -> no linking at all
    assert.strictEqual(mockYoutubeUpdate.mock.callCount(), 0);
  });
});
