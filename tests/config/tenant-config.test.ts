import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import type { SelectableTenants } from '../../src/db/meta-types.js';

// 1. Setup Hoisted Mocks
const mockGetAllTenants = mock.fn<() => Promise<SelectableTenants[]>>(async () => []);
const mockGetTenantById = mock.fn<(id: string) => Promise<SelectableTenants | undefined>>(async () => undefined);

mock.module('../../src/services/meta-tenants.service.js', {
  namedExports: {
    getAllTenants: mockGetAllTenants,
    getTenantById: mockGetTenantById,
  },
});

mock.module('../../src/db/meta-client.js', {
  namedExports: {
    initMetaClient: mock.fn(),
  },
});

// 2. Dynamically import the System Under Test AFTER mocks are registered
const { buildTenantConfig, configService } = await import('../../src/config/tenant-config.js');

function makeTenant(overrides: Partial<SelectableTenants> = {}): SelectableTenants {
  return {
    id: 'tenant-1',
    display_name: 'Test Tenant',
    profile_image_url: null,
    twitch: null,
    youtube: null,
    kick: null,
    database_name: 'test',
    settings: { domainName: 'example.com', timezone: 'UTC' },
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('buildTenantConfig', () => {
  it('returns null when database_name is null', () => {
    const tenant = makeTenant({ database_name: null });
    const result = buildTenantConfig(tenant);
    assert.strictEqual(result, null);
  });

  it('parses valid base config', () => {
    const tenant = makeTenant();
    const result = buildTenantConfig(tenant);

    assert.ok(result);
    assert.strictEqual(result?.id, 'tenant-1');
    assert.strictEqual(result?.displayName, 'Test Tenant');
    assert.strictEqual(result?.database.name, 'test');
    assert.strictEqual(result?.settings.domainName, 'example.com');
  });

  it('parses valid Twitch config', () => {
    const tenant = makeTenant({
      twitch: { enabled: true, username: 'testuser', id: '123' },
    });
    const result = buildTenantConfig(tenant);
    assert.ok(result?.twitch);
    assert.strictEqual(result.twitch?.enabled, true);
  });

  it('parses valid YouTube config', () => {
    const tenant = makeTenant({
      youtube: { public: true, upload: true, splitDuration: 1800 },
    });
    const result = buildTenantConfig(tenant);
    assert.ok(result?.youtube);
    assert.strictEqual(result.youtube?.splitDuration, 1800);
  });

  it('parses valid Kick config', () => {
    const tenant = makeTenant({
      kick: { enabled: true, username: 'kickuser', id: 'kick-123' },
    });
    const result = buildTenantConfig(tenant);
    assert.ok(result?.kick);
    assert.strictEqual(result.kick?.username, 'kickuser');
  });

  it('skips malformed configs safely without throwing', () => {
    const tenant = makeTenant({
      twitch: { enabled: 'not-a-boolean', username: 12345 },
      youtube: { public: 'yes', splitDuration: 'long' },
      kick: { enabled: 'true', username: 42 },
    });

    const result = buildTenantConfig(tenant);

    assert.ok(result);
    assert.strictEqual(result?.id, 'tenant-1');
    assert.strictEqual(result?.twitch, undefined);
    assert.strictEqual(result?.youtube, undefined);
    assert.strictEqual(result?.kick, undefined);
  });
});

describe('ConfigService', () => {
  let fakeAllTenants: SelectableTenants[] = [];
  let fakeById: ((id: string) => Promise<SelectableTenants | undefined>) | null = null;

  beforeEach(() => {
    configService.reset();
    fakeAllTenants = [];
    fakeById = null;

    mockGetAllTenants.mock.mockImplementation(async () => fakeAllTenants);
    mockGetTenantById.mock.mockImplementation(async (id) => fakeById?.(id));
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('loadAll', () => {
    it('returns empty array when no tenants exist', async () => {
      const result = await configService.loadAll();
      assert.strictEqual(result.length, 0);
    });

    it('loads valid tenants into cache', async () => {
      fakeAllTenants = [makeTenant({ id: 't1' }), makeTenant({ id: 't2' })];
      const result = await configService.loadAll();

      assert.strictEqual(result.length, 2);
      assert.ok(await configService.get('t1'));
    });
  });

  describe('reloadTenant', () => {
    it('replaces cached entry with fresh data from db', async () => {
      fakeAllTenants = [makeTenant({ id: 't1', display_name: 'Original' })];
      await configService.loadAll();

      fakeById = async (id) => (id === 't1' ? makeTenant({ id: 't1', display_name: 'Updated' }) : undefined);
      await configService.reloadTenant('t1');

      assert.strictEqual((await configService.get('t1'))?.displayName, 'Updated');
    });

    it('deletes cache entry when tenant no longer exists', async () => {
      fakeAllTenants = [makeTenant({ id: 't1' })];
      await configService.loadAll();

      fakeById = async () => undefined;
      await configService.reloadTenant('t1');

      assert.strictEqual(configService.getSync('t1'), undefined);
    });
  });
});
