import { strict as assert } from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { AppLogger } from '../../../src/utils/logger.ts';
import { wrapWorkerProcessor, type WorkerOutcome } from '../../../src/workers/utils/worker-wrapper.ts';
import { reapWorkDir } from '../../../src/workers/utils/workdir.ts';

function makeLog(): AppLogger {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop, child: () => makeLog() } as unknown as AppLogger;
}

function makeJob(attempts: number, attemptsMade: number): any {
  return { id: 'job-1', opts: { attempts }, attemptsMade };
}

describe('wrapWorkerProcessor outcome', () => {
  async function runFailing(attempts: number, attemptsMade: number): Promise<WorkerOutcome | undefined> {
    let captured: WorkerOutcome | undefined;
    const processor = wrapWorkerProcessor(
      async () => ({ log: makeLog() }),
      async () => {
        throw new Error('boom');
      },
      {
        errorMeta: () => ({}),
        errorAlert: async () => {},
        finally: async (_ctx, _job, outcome) => {
          captured = outcome;
        },
      }
    );
    await processor(makeJob(attempts, attemptsMade)).catch(() => {});
    return captured;
  }

  it('reports willRetry=true while attempts remain', async () => {
    const outcome = await runFailing(3, 0);
    assert.ok(outcome);
    assert.equal(outcome.failed, true);
    assert.equal(outcome.willRetry, true);
  });

  it('reports willRetry=true on the penultimate attempt', async () => {
    const outcome = await runFailing(3, 1);
    assert.ok(outcome);
    assert.equal(outcome.willRetry, true);
  });

  it('reports willRetry=false on the final attempt', async () => {
    const outcome = await runFailing(3, 2);
    assert.ok(outcome);
    assert.equal(outcome.failed, true);
    assert.equal(outcome.willRetry, false);
  });

  it('reports failed=false on success', async () => {
    let captured: WorkerOutcome | undefined;
    const processor = wrapWorkerProcessor(
      async () => ({ log: makeLog() }),
      async () => ({ ok: true }),
      {
        errorMeta: () => ({}),
        errorAlert: async () => {},
        finally: async (_ctx, _job, outcome) => {
          captured = outcome;
        },
      }
    );
    await processor(makeJob(3, 0));
    assert.ok(captured);
    assert.equal(captured.failed, false);
    assert.equal(captured.willRetry, false);
  });

  it('reports willRetry=false for UnrecoverableError', async () => {
    let captured: WorkerOutcome | undefined;
    const processor = wrapWorkerProcessor(
      async () => ({ log: makeLog() }),
      async () => {
        const err = new Error('unrecoverable');
        err.name = 'UnrecoverableError';
        throw err;
      },
      {
        errorMeta: () => ({}),
        errorAlert: async () => {},
        finally: async (_ctx, _job, outcome) => {
          captured = outcome;
        },
      }
    );
    await processor(makeJob(3, 0)).catch(() => {});
    assert.ok(captured);
    assert.equal(captured.failed, true);
    assert.equal(captured.willRetry, false);
  });
});

describe('reapWorkDir', () => {
  it('removes an existing directory recursively', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'reap-'));
    const target = path.join(base, 'tenant', 'vod-123');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'file.mp4'), 'data');

    await reapWorkDir(target, makeLog());

    await assert.rejects(fs.access(target), 'target dir should have been removed');
    await fs.rm(base, { recursive: true, force: true });
  });

  it('is a no-op when workDir is undefined', async () => {
    await assert.doesNotReject(reapWorkDir(undefined, makeLog()));
  });

  it('is a no-op when the directory does not exist', async () => {
    await assert.doesNotReject(reapWorkDir(path.join(os.tmpdir(), 'does-not-exist-xyz'), makeLog()));
  });
});
