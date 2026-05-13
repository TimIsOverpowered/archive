import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { SettingsSchema, TwitchSchema, YoutubeSchema, KickSchema } from '../../src/config/schemas.js';
import type { SelectableTenants } from '../../src/db/meta-types.js';
import { RedisService } from '../../src/utils/redis-service.js';

// Hoist mock functions so we can alter their implementations in specific tests
const mockGetAllTenants = mock.fn<() => Promise<SelectableTenants[]>>(async () => []);
const mockGetTenantById = mock.fn<(id: string) => Promise<SelectableTenants | undefined>>(async () => undefined);

// Mock modules that have side effects (DB, encryption)
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

const { buildTenantConfig, configService } = await import('../../src/config/tenant-config.js');

const VALID_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function setupBaseEnv(): void {
  Object.keys(process.env).forEach((key) => delete process.env[key]);
  process.env.REDIS_URL = 'redis://localhost';
  process.env.META_DATABASE_URL = 'postgresql://meta';
  process.env.PGBOUNCER_URL = 'postgresql://bouncer';
  process.env.ENCRYPTION_MASTER_KEY = VALID_KEY;
  process.env.NODE_ENV = 'test';
  process.env.TWITCH_CLIENT_ID = 'test-twitch-client-id';
  process.env.TWITCH_CLIENT_SECRET = 'test-twitch-client-secret';
  process.env.YOUTUBE_CLIENT_ID = 'test-youtube-client-id';
  process.env.YOUTUBE_CLIENT_SECRET = 'test-youtube-client-secret';
}

setupBaseEnv();

function makeTenant(overrides: Partial<SelectableTenants> = {}): SelectableTenants {
  return {
    id: 'tenant-1',
    display_name: 'Test Tenant',
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

describe('buildTenantConfig parsing logic', () => {
  beforeEach(() => {
    configService.reset();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('SettingsSchema parsing', () => {
    it('should parse valid settings with all fields', () => {
      const tenant = makeTenant({
        settings: {
          domainName: 'example.com',
          timezone: 'America/New_York',
          saveMP4: true,
          saveHLS: true,
          vodDownload: false,
          chatDownload: false,
        },
      });

      const result = buildTenantConfig(tenant);
      assert.ok(result);
      assert.strictEqual(result.settings.domainName, 'example.com');
      assert.strictEqual(result.settings.timezone, 'America/New_York');
      assert.strictEqual(result.settings.saveMP4, true);
      assert.strictEqual(result.settings.saveHLS, true);
      assert.strictEqual(result.settings.vodDownload, false);
      assert.strictEqual(result.settings.chatDownload, false);
    });

    it('should apply default values for optional settings fields', () => {
      const tenant = makeTenant({
        settings: { domainName: 'example.com', timezone: 'UTC' },
      });

      const result = buildTenantConfig(tenant);
      assert.ok(result);
      assert.strictEqual(result.settings.saveMP4, false);
      assert.strictEqual(result.settings.saveHLS, false);
      assert.strictEqual(result.settings.vodDownload, true);
      assert.strictEqual(result.settings.chatDownload, true);
    });

    it('should throw when domainName is missing from settings', () => {
      const tenant = makeTenant({
        settings: { timezone: 'UTC' },
      });

      assert.throws(() => buildTenantConfig(tenant), /domainName/);
    });

    it('should throw when timezone is missing from settings', () => {
      const tenant = makeTenant({
        settings: { domainName: 'example.com' },
      });

      assert.throws(() => buildTenantConfig(tenant), /timezone/);
    });

    it('should handle settings as empty object when not provided', () => {
      const tenant = makeTenant({ settings: {} });

      assert.throws(() => buildTenantConfig(tenant), /domainName/);
    });

    it('should handle settings as non-object by treating it as empty object', () => {
      const tenant = makeTenant({ settings: 'not-an-object' as any });

      assert.throws(() => buildTenantConfig(tenant), /domainName/);
    });

    it('should handle settings as array by treating it as empty object', () => {
      const tenant = makeTenant({ settings: ['not-an-object'] as any });

      assert.throws(() => buildTenantConfig(tenant), /domainName/);
    });
  });

  describe('TwitchSchema parsing', () => {
    it('should parse valid Twitch config with all fields', () => {
      const tenant = makeTenant({
        twitch: {
          enabled: true,
          mainPlatform: true,
          username: 'streamer',
          id: '12345',
        },
      });

      const result = buildTenantConfig(tenant);
      assert.ok(result?.twitch);
      assert.strictEqual(result.twitch.enabled, true);
      assert.strictEqual(result.twitch.mainPlatform, true);
      assert.strictEqual(result.twitch.username, 'streamer');
      assert.strictEqual(result.twitch.id, '12345');
    });

    it('should apply Twitch defaults (enabled=false, mainPlatform=false)', () => {
      const tenant = makeTenant({ twitch: {} });

      const result = buildTenantConfig(tenant);
      assert.ok(result?.twitch);
      assert.strictEqual(result.twitch.enabled, false);
      assert.strictEqual(result.twitch.mainPlatform, false);
      assert.strictEqual(result.twitch.username, undefined);
      assert.strictEqual(result.twitch.id, undefined);
    });

    it('should normalize null username to undefined', () => {
      const tenant = makeTenant({ twitch: { enabled: true, username: null } });

      const result = buildTenantConfig(tenant);
      assert.ok(result?.twitch);
      assert.strictEqual(result.twitch.username, undefined);
    });

    it('should normalize null id to undefined', () => {
      const tenant = makeTenant({ twitch: { enabled: true, id: null } });

      const result = buildTenantConfig(tenant);
      assert.ok(result?.twitch);
      assert.strictEqual(result.twitch.id, undefined);
    });

    it('should return undefined when twitch is null', () => {
      const tenant = makeTenant({ twitch: null });

      const result = buildTenantConfig(tenant);
      assert.strictEqual(result?.twitch, undefined);
    });

    it('should return undefined when twitch is undefined', () => {
      const tenant = makeTenant({ twitch: undefined as any });

      const result = buildTenantConfig(tenant);
      assert.strictEqual(result?.twitch, undefined);
    });
  });

  describe('YouTubeSchema parsing', () => {
    it('should parse valid YouTube config with all fields', () => {
      const tenant = makeTenant({
        youtube: {
          public: false,
          upload: false,
          vodUpload: false,
          liveUpload: true,
          multiTrack: true,
          splitDuration: 3600,
          perGameUpload: true,
          restrictedGames: ['Game A', 'Game B'],
          description: 'My stream VODs',
        },
      });

      const result = buildTenantConfig(tenant);
      assert.ok(result?.youtube);
      assert.strictEqual(result.youtube.public, false);
      assert.strictEqual(result.youtube.upload, false);
      assert.strictEqual(result.youtube.vodUpload, false);
      assert.strictEqual(result.youtube.liveUpload, true);
      assert.strictEqual(result.youtube.multiTrack, true);
      assert.strictEqual(result.youtube.splitDuration, 3600);
      assert.strictEqual(result.youtube.perGameUpload, true);
      assert.deepStrictEqual(result.youtube.restrictedGames, ['Game A', 'Game B']);
      assert.strictEqual(result.youtube.description, 'My stream VODs');
    });

    it('should apply YouTube defaults', () => {
      const tenant = makeTenant({ youtube: {} });

      const result = buildTenantConfig(tenant);
      assert.ok(result?.youtube);
      assert.strictEqual(result.youtube.public, true);
      assert.strictEqual(result.youtube.upload, true);
      assert.strictEqual(result.youtube.vodUpload, true);
      assert.strictEqual(result.youtube.liveUpload, false);
      assert.strictEqual(result.youtube.multiTrack, false);
      assert.deepStrictEqual(result.youtube.restrictedGames, []);
      assert.strictEqual(result.youtube.description, '');
    });

    it('should return undefined when youtube is null', () => {
      const tenant = makeTenant({ youtube: null });

      const result = buildTenantConfig(tenant);
      assert.strictEqual(result?.youtube, undefined);
    });
  });

  describe('KickSchema parsing', () => {
    it('should parse valid Kick config', () => {
      const tenant = makeTenant({
        kick: {
          enabled: true,
          mainPlatform: true,
          username: 'kickstreamer',
          id: 'kick-999',
        },
      });

      const result = buildTenantConfig(tenant);
      assert.ok(result?.kick);
      assert.strictEqual(result.kick.enabled, true);
      assert.strictEqual(result.kick.mainPlatform, true);
      assert.strictEqual(result.kick.username, 'kickstreamer');
      assert.strictEqual(result.kick.id, 'kick-999');
    });

    it('should apply Kick defaults', () => {
      const tenant = makeTenant({ kick: {} });

      const result = buildTenantConfig(tenant);
      assert.ok(result?.kick);
      assert.strictEqual(result.kick.enabled, false);
      assert.strictEqual(result.kick.mainPlatform, false);
      assert.strictEqual(result.kick.username, undefined);
      assert.strictEqual(result.kick.id, undefined);
    });

    it('should return undefined when kick is null', () => {
      const tenant = makeTenant({ kick: null });

      const result = buildTenantConfig(tenant);
      assert.strictEqual(result?.kick, undefined);
    });
  });

  describe('asJsonObject normalization', () => {
    it('should handle twitch as a string (not an object)', () => {
      const tenant = makeTenant({ twitch: 'not-an-object' as any });

      const result = buildTenantConfig(tenant);
      assert.ok(result);
      assert.strictEqual(result?.twitch, undefined);
    });

    it('should handle youtube as an array (not an object)', () => {
      const tenant = makeTenant({ youtube: ['not-an-object'] as any });

      const result = buildTenantConfig(tenant);
      assert.ok(result);
      assert.strictEqual(result?.youtube, undefined);
    });

    it('should handle kick as a number (not an object)', () => {
      const tenant = makeTenant({ kick: 12345 as any });

      const result = buildTenantConfig(tenant);
      assert.ok(result);
      assert.strictEqual(result?.kick, undefined);
    });

    it('should handle twitch as empty object', () => {
      const tenant = makeTenant({ twitch: {} });

      const result = buildTenantConfig(tenant);
      assert.ok(result?.twitch);
      assert.strictEqual(result.twitch.enabled, false);
    });
  });

  describe('Partial platform configs', () => {
    it('should build config with only Twitch enabled', () => {
      const tenant = makeTenant({
        twitch: { enabled: true, username: 'twitchuser', id: '111' },
      });

      const result = buildTenantConfig(tenant);
      assert.ok(result);
      assert.ok(result?.twitch);
      assert.strictEqual(result?.youtube, undefined);
      assert.strictEqual(result?.kick, undefined);
    });

    it('should build config with only YouTube enabled', () => {
      const tenant = makeTenant({
        youtube: { public: false, upload: true },
      });

      const result = buildTenantConfig(tenant);
      assert.ok(result);
      assert.ok(result?.youtube);
      assert.strictEqual(result?.twitch, undefined);
      assert.strictEqual(result?.kick, undefined);
    });

    it('should build config with all platforms enabled', () => {
      const tenant = makeTenant({
        twitch: { enabled: true, username: 'twitchuser', id: '111' },
        youtube: { public: false, upload: true },
        kick: { enabled: true, username: 'kickuser', id: '222' },
      });

      const result = buildTenantConfig(tenant);
      assert.ok(result);
      assert.ok(result?.twitch);
      assert.ok(result?.youtube);
      assert.ok(result?.kick);
    });

    it('should build config with no platform configs', () => {
      const tenant = makeTenant();

      const result = buildTenantConfig(tenant);
      assert.ok(result);
      assert.strictEqual(result?.twitch, undefined);
      assert.strictEqual(result?.youtube, undefined);
      assert.strictEqual(result?.kick, undefined);
    });
  });

  describe('Base config building', () => {
    it('should preserve tenant id', () => {
      const tenant = makeTenant({ id: 'unique-tenant-id' });

      const result = buildTenantConfig(tenant);
      assert.ok(result);
      assert.strictEqual(result.id, 'unique-tenant-id');
    });

    it('should preserve display_name', () => {
      const tenant = makeTenant({ display_name: 'My Streamer' });

      const result = buildTenantConfig(tenant);
      assert.ok(result);
      assert.strictEqual(result.displayName, 'My Streamer');
    });

    it('should set display_name to undefined when null', () => {
      const tenant = makeTenant({ display_name: null });

      const result = buildTenantConfig(tenant);
      assert.ok(result);
      assert.strictEqual(result.displayName, undefined);
    });

    it('should preserve created_at as Date', () => {
      const created_at = new Date('2024-01-15T10:00:00Z');
      const tenant = makeTenant({ created_at });

      const result = buildTenantConfig(tenant);
      assert.ok(result);
      assert.strictEqual(result.createdAt.getTime(), created_at.getTime());
    });

    it('should include database name in config', () => {
      const tenant = makeTenant({ database_name: 'production' });

      const result = buildTenantConfig(tenant);
      assert.ok(result);
      assert.strictEqual(result.database.name, 'production');
    });

    it('should include all settings in config', () => {
      const tenant = makeTenant({
        settings: {
          domainName: 'example.com',
          timezone: 'UTC',
          saveMP4: true,
          saveHLS: true,
          vodDownload: false,
          chatDownload: false,
        },
      });

      const result = buildTenantConfig(tenant);
      assert.ok(result);
      assert.deepStrictEqual(result.settings, {
        domainName: 'example.com',
        timezone: 'UTC',
        saveMP4: true,
        saveHLS: true,
        vodDownload: false,
        chatDownload: false,
      });
    });
  });

  describe('database name handling', () => {
    it('should include database name in config', () => {
      const tenant = makeTenant({ database_name: 'encrypted' });

      const result = buildTenantConfig(tenant);
      assert.ok(result);
      assert.strictEqual(result.database.name, 'encrypted');
    });

    it('should return null when database_name is null', () => {
      const tenant = makeTenant({ database_name: null });

      const result = buildTenantConfig(tenant);
      assert.strictEqual(result, null);
    });
  });

  describe('ConfigService parsing integration', () => {
    it('should cache parsed config with all platform data', async () => {
      const tenant = makeTenant({
        id: 'full-tenant',
        twitch: { enabled: true, username: 'user', id: '1' },
        youtube: { public: false, upload: false },
        kick: { enabled: true, username: 'kuser', id: '2' },
      });

      // Implement the specific response for this test
      mockGetAllTenants.mock.mockImplementation(async () => [tenant]);

      configService.reset();
      const configs = await configService.loadAll();

      assert.strictEqual(configs.length, 1);
      assert.ok(configs[0]?.twitch);
      assert.ok(configs[0]?.youtube);
      assert.ok(configs[0]?.kick);
    });
  });
});

describe('ConfigService seed method', () => {
  beforeEach(() => {
    configService.reset();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('should seed configs into cache without hitting DB', () => {
    const mockConfig = {
      id: 'seeded-tenant',
      displayName: 'Seeded',
      createdAt: new Date(),
      database: { url: 'postgresql://test' },
      settings: { domainName: 'test.com', timezone: 'UTC', saveHLS: false, saveMP4: true },
      twitch: { enabled: true, username: 'seeded', id: '1' },
    };

    configService.seed([mockConfig as any]);

    const result = configService.getSync('seeded-tenant');
    assert.ok(result);
    assert.strictEqual(result.displayName, 'Seeded');
    assert.ok(result.twitch);
  });

  it('should return all seeded configs', () => {
    const configs = [
      {
        id: 't1',
        displayName: 'T1',
        createdAt: new Date(),
        database: { url: 'pg://t1' },
        settings: { domainName: 't1.com', timezone: 'UTC', saveHLS: false, saveMP4: true },
      },
      {
        id: 't2',
        displayName: 'T2',
        createdAt: new Date(),
        database: { url: 'pg://t2' },
        settings: { domainName: 't2.com', timezone: 'UTC', saveHLS: false, saveMP4: true },
      },
    ];

    configService.seed(configs as any);

    const all = configService.getAll();
    assert.strictEqual(all.length, 2);

    // Test that the array contains both configs regardless of their position
    const ids = all.map((c) => c.id);
    assert.ok(ids.includes('t1'));
    assert.ok(ids.includes('t2'));
  });
});

describe('ConfigService update methods', () => {
  let mockClient: any;

  beforeEach(() => {
    configService.reset();
    mockClient = {
      publish: async (_channel: string, _message: string) => {},
    };
    (RedisService as any)._instance = {
      getActiveClient: () => mockClient,
    };
  });

  afterEach(() => {
    (RedisService as any)._instance = null;
    mock.restoreAll();
  });

  it('should update YouTube auth in cached config', () => {
    configService.seed([
      {
        id: 't1',
        displayName: 'T1',
        createdAt: new Date(),
        database: { url: 'pg://t1' },
        settings: { domainName: 't1.com', timezone: 'UTC', saveHLS: false, saveMP4: true },
        youtube: { public: true, auth: { old: 'token' } },
      } as any,
    ]);

    configService.updateYoutubeAuth('t1', { refresh_token: 'new-refresh', expiry_date: 9999999999 });

    const updated = configService.getSync('t1');
    assert.ok(updated);
    assert.ok(updated.youtube);
    assert.strictEqual(updated.youtube.auth!.refresh_token, 'new-refresh');
  });
});

describe('Zod schema direct validation', () => {
  describe('SettingsSchema', () => {
    it('should reject settings with invalid timezone format', () => {
      const result = SettingsSchema.safeParse({
        domainName: 'example.com',
        timezone: '',
      });
      assert.strictEqual(result.success, false);
    });

    it('should reject settings with missing domainName', () => {
      const result = SettingsSchema.safeParse({ timezone: 'UTC' });
      assert.strictEqual(result.success, false);
    });

    it('should accept settings with only required fields', () => {
      const result = SettingsSchema.safeParse({ domainName: 'example.com', timezone: 'UTC' });
      assert.strictEqual(result.success, true);
    });

    it('should coerce vodDownload to boolean true by default', () => {
      const result = SettingsSchema.safeParse({ domainName: 'example.com', timezone: 'UTC' });
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.vodDownload, true);
      }
    });

    it('should coerce chatDownload to boolean true by default', () => {
      const result = SettingsSchema.safeParse({ domainName: 'example.com', timezone: 'UTC' });
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.chatDownload, true);
      }
    });
  });

  describe('TwitchSchema', () => {
    it('should accept empty Twitch config', () => {
      const result = TwitchSchema.safeParse({});
      assert.strictEqual(result.success, true);
    });

    it('should accept Twitch config with only enabled field', () => {
      const result = TwitchSchema.safeParse({ enabled: true });
      assert.strictEqual(result.success, true);
    });

    it('should reject Twitch config with invalid enabled type', () => {
      const result = TwitchSchema.safeParse({ enabled: 'yes' });
      assert.strictEqual(result.success, false);
    });
  });

  describe('YoutubeSchema', () => {
    it('should accept empty YouTube config', () => {
      const result = YoutubeSchema.safeParse({});
      assert.strictEqual(result.success, true);
    });

    it('should accept YouTube config with splitDuration', () => {
      const result = YoutubeSchema.safeParse({ splitDuration: 7200 });
      assert.strictEqual(result.success, true);
    });

    it('should reject YouTube config with invalid splitDuration type', () => {
      const result = YoutubeSchema.safeParse({ splitDuration: 'long' });
      assert.strictEqual(result.success, false);
    });
  });

  describe('KickSchema', () => {
    it('should accept empty Kick config', () => {
      const result = KickSchema.safeParse({});
      assert.strictEqual(result.success, true);
    });

    it('should accept Kick config with username only', () => {
      const result = KickSchema.safeParse({ username: 'testuser' });
      assert.strictEqual(result.success, true);
    });
  });
});
