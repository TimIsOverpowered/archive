import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { saveUploadResult, type UploadedVideo } from '../../../src/services/youtube/upload.ts';

interface WhereClause {
  column: string;
  op: string;
  value: unknown;
}

interface DeleteCall {
  table: string;
  wheres: WhereClause[];
  whereNots: WhereClause[];
}

function createMockDb() {
  const state: { inserted: Array<{ table: string; values: unknown }>; deletes: DeleteCall[] } = {
    inserted: [],
    deletes: [],
  };

  const db = {
    insertInto(table: string) {
      let values: unknown = null;
      const b = {
        values(v: unknown) {
          values = v;
          return b;
        },
        onConflict(cb: (oc: unknown) => unknown) {
          cb({ columns: (_cols: unknown) => ({ doUpdateSet: (_set: unknown) => undefined }) });
          return b;
        },
        execute: async () => {
          state.inserted.push({ table, values });
        },
      };
      return b;
    },
    deleteFrom(table: string) {
      const call: DeleteCall = { table, wheres: [], whereNots: [] };
      const eb = (column: string, op: string, value: unknown) => {
        if (op === 'not in') {
          call.whereNots.push({ column, op: 'in', value });
        } else {
          call.wheres.push({ column, op, value });
        }
        return true;
      };
      const b = {
        where(
          columnOrCb:
            | string
            | ((expressionBuilder: (column: string, op: string, value: unknown) => unknown) => unknown),
          op?: string,
          value?: unknown
        ) {
          if (typeof columnOrCb === 'function') {
            columnOrCb(eb);
          } else {
            call.wheres.push({ column: columnOrCb, op: op ?? '', value });
          }
          return b;
        },
        execute: async () => {
          state.deletes.push(call);
        },
      };
      return b;
    },
  };

  return { db, state };
}

describe('saveUploadResult', () => {
  it('should upsert every uploaded video', async () => {
    const { db, state } = createMockDb();
    const videos: UploadedVideo[] = [
      { id: 'A', part: 1, duration: 100, thumbnailUrl: 't1' },
      { id: 'B', part: 2, duration: 200, thumbnailUrl: 't2' },
    ];

    await saveUploadResult(db as any, 10, 'vod', videos, { removeStaleParts: true });

    assert.strictEqual(state.inserted.length, 2);
    const firstValues = state.inserted[0]?.values as { vod_id: number } | undefined;
    const secondValues = state.inserted[1]?.values as { upload_id: string } | undefined;
    assert.ok(firstValues && secondValues);
    assert.strictEqual(firstValues.vod_id, 10);
    assert.strictEqual(secondValues.upload_id, 'B');
  });

  it('should remove stale part rows when removeStaleParts is set', async () => {
    const { db, state } = createMockDb();
    const videos: UploadedVideo[] = [
      { id: 'A', part: 1, duration: 100, thumbnailUrl: 't1' },
      { id: 'B', part: 2, duration: 200, thumbnailUrl: 't2' },
    ];

    await saveUploadResult(db as any, 10, 'vod', videos, { removeStaleParts: true });

    assert.strictEqual(state.deletes.length, 1);
    const del = state.deletes[0];
    assert.ok(del);
    assert.strictEqual(del.table, 'vod_uploads');
    assert.deepEqual(del.wheres, [
      { column: 'vod_id', op: '=', value: 10 },
      { column: 'type', op: '=', value: 'vod' },
    ]);
    assert.deepEqual(del.whereNots, [{ column: 'part', op: 'in', value: [1, 2] }]);
  });

  it('should not delete rows when removeStaleParts is not set (partial re-upload)', async () => {
    const { db, state } = createMockDb();
    const videos: UploadedVideo[] = [{ id: 'NEW', part: 3, duration: 150, thumbnailUrl: 't3' }];

    await saveUploadResult(db as any, 10, 'vod', videos);

    assert.strictEqual(state.inserted.length, 1);
    assert.strictEqual(state.deletes.length, 0);
  });

  it('should not delete rows when the uploaded set is empty (safety guard)', async () => {
    const { db, state } = createMockDb();

    await saveUploadResult(db as any, 10, 'vod', [], { removeStaleParts: true });

    assert.strictEqual(state.inserted.length, 0);
    assert.strictEqual(state.deletes.length, 0);
  });
});
