import { strict as assert } from 'node:assert';
import { after, beforeEach, before, describe, it, mock } from 'node:test';

// Mock admin auth so requests are not rejected.
mock.module('../../../../src/api/middleware/admin-api-key.js', {
  exports: { default: async () => {} },
});

// Mock the tenant middleware so handlers receive a tenant context with a mock db.
let mockDb: any = null;
mock.module('../../../../src/api/middleware/tenant-platform.js', {
  exports: {
    default: undefined,
    requireTenant: (req: any) => req.tenant,
    tenantMiddleware: async (req: any) => {
      req.tenant = { tenantId: 't1', config: { twitch: { enabled: true } }, db: mockDb };
    },
    asTenantPlatformContext: (ctx: any) => ctx,
    platformValidationMiddleware: async () => {},
  },
});

// Silence the auto-tenant logger (needs a configured global pino instance).
mock.module('../../../../src/utils/auto-tenant-logger.js', {
  exports: {
    createAutoLogger: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
    }),
  },
});

let unlinkKeys: string[] = [];
let publishCalls: { channel: string; message: string }[] = [];
const redisMock = {
  unlink: async (...keys: string[]) => {
    unlinkKeys.push(...keys);
  },
  scan: async () => ['0', []],
  sscan: async () => ['0', []],
  del: async () => {},
  publish: async (channel: string, message: string) => {
    publishCalls.push({ channel, message });
  },
};

const { default: contentManagementRoutes } = await import(
  '../../../../src/api/routes/admin/content-management.routes.ts'
);
const { RedisService } = await import('../../../../src/utils/redis-service.ts');
const { buildTestServer } = await import('../../../helpers/build-test-server.ts');

function makeDb(opts: { missingVod?: boolean; missingChild?: boolean } = {}): any {
  const selectRow = (table: string) => {
    if (table === 'vods') {
      return opts.missingVod ? null : { id: 100, platform: 'twitch', platform_vod_id: 'p1' };
    }
    return opts.missingChild ? null : { id: 5, vod_id: 100 };
  };

  return {
    selectFrom: (table: string) => ({
      select: (_c: any) => ({
        where: (_a: any, _op: any, _v: any) => ({
          executeTakeFirst: async () => selectRow(table),
        }),
      }),
    }),
    insertInto: (_table: string) => ({
      values: (v: any) => ({
        returning: (_cols: any) => ({ executeTakeFirst: async () => ({ ...v, id: 5 }) }),
        onConflict: (_cb: any) => ({ execute: async () => ({ numAffectedRows: 1 }) }),
      }),
    }),
    updateTable: (_table: string) => ({
      set: (patch: any) => ({
        where: (_a: any, _op: any, _v: any) => ({
          returning: (_cols: any) => ({ executeTakeFirst: async () => ({ ...patch, id: 5, vod_id: 100 }) }),
        }),
      }),
    }),
    deleteFrom: (_table: string) => ({
      where: (_a: any, _op: any, _v: any) => ({ execute: async () => ({ numAffectedRows: 1 }) }),
    }),
  };
}

describe('admin content-management routes', () => {
  let server: any;
  let close: () => Promise<void>;

  before(async () => {
    (RedisService as any)._instance = { client: redisMock };
    const built = await buildTestServer();
    server = built.server;
    close = built.close;
    await server.register(
      async (instance: any) => {
        await instance.register(contentManagementRoutes);
      },
      { prefix: '/:tenantId/admin' }
    );
    await server.ready();
  });

  after(async () => {
    (RedisService as any)._instance = null;
    await close();
    mock.restoreAll();
  });

  beforeEach(() => {
    unlinkKeys = [];
    publishCalls = [];
    mockDb = makeDb();
  });

  it('creates a chapter and invalidates the VOD platform cache', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/t1/admin/chapters',
      payload: { vod_id: 100, name: 'Intro', start: 0, duration: 10, end: 10 },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json().data.name, 'Intro');
    assert.ok(unlinkKeys.includes('swr:vod:platform:{t1}:twitch:p1'), 'clears the platform detail cache');
  });

  it('returns 404 when the parent VOD is missing on create', async () => {
    mockDb = makeDb({ missingVod: true });
    const res = await server.inject({
      method: 'POST',
      url: '/t1/admin/games',
      payload: { vod_id: 100, start: 0, end: 5, game_id: 'g', game_name: 'G' },
    });
    assert.strictEqual(res.statusCode, 404);
  });

  it('updates a chapter', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: '/t1/admin/chapters/5',
      payload: { name: 'Renamed' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json().data.name, 'Renamed');
  });

  it('returns 400 when updating a chapter with no fields', async () => {
    const res = await server.inject({ method: 'PATCH', url: '/t1/admin/chapters/5', payload: {} });
    assert.strictEqual(res.statusCode, 400);
  });

  it('returns 404 when the chapter does not exist', async () => {
    mockDb = makeDb({ missingChild: true });
    const res = await server.inject({ method: 'DELETE', url: '/t1/admin/chapters/999', payload: {} });
    assert.strictEqual(res.statusCode, 404);
  });

  it('returns 400 for a non-numeric row id', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/t1/admin/chapters/abc', payload: {} });
    assert.strictEqual(res.statusCode, 400);
  });

  it('deletes a vod_upload', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/t1/admin/vod-uploads/5', payload: {} });
    assert.strictEqual(res.statusCode, 200);
  });

  it('replaces emotes for a VOD', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/t1/admin/vods/100/emotes',
      payload: {
        ffz_emotes: [{ id: '1', code: 'KEKW' }],
        bttv_emotes: [],
        seventv_emotes: [],
      },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(
      unlinkKeys.some((k) => k.includes('emotes:{t1}:100')),
      'clears the emote cache'
    );
  });

  it('returns 404 when the emote target VOD does not exist', async () => {
    mockDb = makeDb({ missingVod: true });
    const res = await server.inject({ method: 'PUT', url: '/t1/admin/vods/100/emotes', payload: {} });
    assert.strictEqual(res.statusCode, 404);
  });
});
