import { strict as assert } from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';
import { createMockTenantConfig, setupBaseEnv } from '../helpers/worker-test-setup.ts';

setupBaseEnv();

// Mock meta DB access so config cache misses never touch Postgres.
mock.module('../../src/services/meta-tenants.service.js', {
  namedExports: {
    getTenantByIdRaw: async () => null,
    getAllTenantsRaw: async () => [],
  },
});
mock.module('../../src/db/meta-client.js', {
  namedExports: {
    initMetaClient: () => {},
  },
});

// Mock the BullMQ queues (direct dependency of chat.job.js) and capture adds.
const enqueuedJobs: any[] = [];

function makeMockQueue(platform: string) {
  return {
    name: platform,
    getJob: async () => null,
    isPaused: async () => false,
    add: async (_jobName: string, data: unknown, options: unknown) => {
      enqueuedJobs.push({ platform, data, options });
      return { id: (options as { jobId: string }).jobId };
    },
  };
}

mock.module('../../src/workers/queues/queue.js', {
  namedExports: {
    getKickChatDownloadQueue: () => makeMockQueue('kick'),
    getTwitchChatDownloadQueue: () => makeMockQueue('twitch'),
  },
});

// System Under Test — dynamically imported AFTER mock.module registrations.
const { triggerChatDownload } = await import('../../src/workers/jobs/chat.job.ts');
const { configService } = await import('../../src/config/tenant-config.ts');

const baseOpts = {
  tenantId: 'test-tenant',
  platformUserId: 'platform-user-1',
  platformUsername: 'blame',
  dbId: 7,
  vodId: 'kick-vod-123',
  platform: 'kick' as const,
  duration: 3600,
};

describe('triggerChatDownload', () => {
  beforeEach(() => {
    enqueuedJobs.length = 0;
    configService.reset();
  });

  it('skips enqueue when chatDownload is false', async () => {
    configService.seed([createMockTenantConfig({ settings: { chatDownload: false } })]);

    const jobId = await triggerChatDownload(baseOpts);

    assert.strictEqual(jobId, null);
    assert.strictEqual(enqueuedJobs.length, 0);
  });

  it('enqueues to the kick queue when chatDownload is true', async () => {
    configService.seed([createMockTenantConfig({ settings: { chatDownload: true } })]);

    const jobId = await triggerChatDownload(baseOpts);

    assert.strictEqual(jobId, 'chat_kick-vod-123');
    assert.strictEqual(enqueuedJobs.length, 1);
    assert.strictEqual(enqueuedJobs[0].platform, 'kick');
  });

  it('enqueues to the twitch queue for twitch platform', async () => {
    configService.seed([createMockTenantConfig({ settings: { chatDownload: true } })]);

    const jobId = await triggerChatDownload({ ...baseOpts, platform: 'twitch', vodId: 'tw-vod-1' });

    assert.strictEqual(jobId, 'chat_tw-vod-1');
    assert.strictEqual(enqueuedJobs.length, 1);
    assert.strictEqual(enqueuedJobs[0].platform, 'twitch');
  });

  it('enqueues when chatDownload setting is missing (defaults to enabled)', async () => {
    const cfg = createMockTenantConfig();
    delete (cfg.settings as Record<string, unknown>).chatDownload;
    configService.seed([cfg]);

    const jobId = await triggerChatDownload(baseOpts);

    assert.strictEqual(jobId, 'chat_kick-vod-123');
    assert.strictEqual(enqueuedJobs.length, 1);
  });

  it('fails open and enqueues when tenant config is unavailable', async () => {
    const jobId = await triggerChatDownload(baseOpts);

    assert.strictEqual(jobId, 'chat_kick-vod-123');
    assert.strictEqual(enqueuedJobs.length, 1);
  });
});
