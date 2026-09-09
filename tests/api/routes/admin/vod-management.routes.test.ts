import { strict as assert } from 'node:assert';
import { after, beforeEach, before, describe, it, mock } from 'node:test';

mock.module('../../../../src/api/middleware/admin-api-key.js', {
  exports: { default: async () => {} },
});

let mockDb: any = null;
let mockConfig: any = { twitch: { enabled: true }, kick: { enabled: true } };
mock.module('../../../../src/api/middleware/tenant-platform.js', {
  exports: {
    default: undefined,
    requireTenant: (req: any) => req.tenant,
    tenantMiddleware: async (req: any) => {
      req.tenant = { tenantId: 't1', config: mockConfig, db: mockDb };
    },
    asTenantPlatformContext: (ctx: any) => ctx,
    platformValidationMiddleware: async () => {},
  },
});

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
const redisMock = {
  unlink: async (...keys: string[]) => {
    unlinkKeys.push(...keys);
  },
  scan: async () => ['0', []],
  sscan: async () => ['0', []],
  del: async () => {},
  publish: async () => {},
};

const { default: vodManagementRoutes } = await import('../../../../src/api/routes/admin/vod-management.routes.ts');
const { RedisService } = await import('../../../../src/utils/redis-service.ts');
const { buildTestServer } = await import('../../../helpers/build-test-server.ts');

function makeDb(opts: { missingVod?: boolean; platform?: string; platformVodId?: string } = {}): any {
  const row = opts.missingVod
    ? null
    : {
        id: 100,
        platform: opts.platform ?? 'twitch',
        platform_vod_id: opts.platformVodId ?? 'p1',
        title: 'Old',
        duration: 10,
        is_live: false,
        created_at: new Date('2026-01-01T00:00:00Z'),
      };

  const chain: any = {
    where: () => chain,
    executeTakeFirst: async () => row,
  };

  return {
    selectFrom: (_table: string) => ({
      select: (_c: any) => chain,
      selectAll: () => chain,
    }),
    updateTable: (_table: string) => ({
      set: (patch: any) => ({
        where: () => ({
          returning: (_cols: any) => ({
            executeTakeFirst: async () => ({ ...row, ...patch }),
          }),
        }),
      }),
    }),
  };
}

describe('admin vod-management: update VOD', () => {
  let server: any;
  let close: () => Promise<void>;

  before(async () => {
    (RedisService as any)._instance = { client: redisMock };
    const built = await buildTestServer();
    server = built.server;
    close = built.close;
    await server.register(
      async (instance: any) => {
        await instance.register(vodManagementRoutes);
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
    mockConfig = { twitch: { enabled: true }, kick: { enabled: true } };
    mockDb = makeDb();
  });

  it('updates a VOD by dbId and invalidates the platform cache', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: '/t1/admin/vods',
      payload: { dbId: 100, title: 'New Title', is_live: false },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json().data.title, 'New Title');
    assert.ok(unlinkKeys.includes('swr:vod:platform:{t1}:twitch:p1'), 'clears the platform detail cache');
    assert.ok(unlinkKeys.includes('swr:vod:{t1}:100'), 'clears the detail-by-id cache');
  });

  it('updates a VOD identified by platform + platform VOD ID', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: '/t1/admin/vods',
      payload: { platform: 'twitch', vodId: 'p1', duration: 99 },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json().data.duration, 99);
  });

  it('invalidates both old and new platform keys when platform_vod_id changes', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: '/t1/admin/vods',
      payload: { dbId: 100, platform_vod_id: 'p2' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(unlinkKeys.includes('swr:vod:platform:{t1}:twitch:p2'), 'clears the new platform key');
    assert.ok(unlinkKeys.includes('swr:vod:platform:{t1}:twitch:p1'), 'clears the previous platform key');
  });

  it('rejects when both dbId and platform+vodId are supplied', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: '/t1/admin/vods',
      payload: { dbId: 100, platform: 'twitch', vodId: 'p1', title: 'x' },
    });
    assert.strictEqual(res.statusCode, 400);
  });

  it('rejects when no identifier is supplied', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: '/t1/admin/vods',
      payload: { title: 'x' },
    });
    assert.strictEqual(res.statusCode, 400);
  });

  it('rejects when there are no updatable fields', async () => {
    const res = await server.inject({ method: 'PATCH', url: '/t1/admin/vods', payload: { dbId: 100 } });
    assert.strictEqual(res.statusCode, 400);
  });

  it('returns 404 when the VOD does not exist', async () => {
    mockDb = makeDb({ missingVod: true });
    const res = await server.inject({ method: 'PATCH', url: '/t1/admin/vods', payload: { dbId: 100, title: 'x' } });
    assert.strictEqual(res.statusCode, 404);
  });

  it('rejects an update to a platform that is not enabled', async () => {
    mockConfig = { twitch: { enabled: true }, kick: { enabled: false } };
    const res = await server.inject({
      method: 'PATCH',
      url: '/t1/admin/vods',
      payload: { dbId: 100, platform: 'kick', title: 'x' },
    });
    assert.strictEqual(res.statusCode, 400);
  });
});
