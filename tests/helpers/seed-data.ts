import { TenantConfig } from '../../src/config/types.js';

export function createMockTenantConfig(overrides: Partial<TenantConfig> = {}): TenantConfig {
  return {
    id: 'test-tenant',
    displayName: 'Test Streamer',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    database: {
      url: 'postgresql://test:test@localhost:5432/test',
    },
    settings: {
      domainName: 'test.example.com',
      timezone: 'UTC',
      vodPath: '/tmp/test-vods',
      saveMP4: false,
      saveHLS: false,
      saveChat: true,
    },
    twitch: {
      enabled: true,
      userId: '12345',
      username: 'teststreamer',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
    },
    kick: {
      enabled: false,
    },
    youtube: {
      public: false,
      upload: false,
      vodUpload: false,
      liveUpload: false,
      multiTrack: false,
      splitDuration: 60,
      perGameUpload: false,
      restrictedGames: [],
      description: '',
    },
    discord: {
      alertsEnabled: false,
    },
    ...overrides,
  };
}
