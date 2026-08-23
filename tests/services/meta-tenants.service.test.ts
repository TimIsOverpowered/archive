import { strict as assert } from 'node:assert';
import { afterEach, describe, it, mock } from 'node:test';
import type { SelectableTenants } from '../../src/db/meta-types.ts';
import { decryptObject, decryptScalar, encryptObject, encryptScalar } from '../../src/utils/encryption.ts';

// Hoisted mock for the meta client (covers both the internal getTenantByIdRaw read
// and the updateTenant write, since both call getMetaClient()).
const mockGetMetaClient = mock.fn<() => any>();

mock.module('../../src/db/meta-client.js', {
  namedExports: {
    getMetaClient: mockGetMetaClient,
  },
});

const { updateTenant } = await import('../../src/services/meta-tenants.service.ts');

function makeTenant(overrides: Partial<SelectableTenants> = {}): SelectableTenants {
  return {
    id: 't1',
    display_name: 'Test Tenant',
    profile_image_url: null,
    banner_image_url: null,
    background_image_url: null,
    twitch: null,
    youtube: null,
    kick: null,
    social_media: null,
    database_name: 'testdb',
    settings: { domainName: 'example.com', timezone: 'UTC' },
    status: 'active',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

/** Build a fake Kysely client that records the .set() payload and the where id. */
function makeMetaDb(existing: SelectableTenants | undefined, updatedRow: SelectableTenants | undefined) {
  const captured = {
    setArg: undefined as Record<string, unknown> | undefined,
    whereId: undefined as string | undefined,
  };
  const db = {
    selectFrom: (_table: string) => ({
      selectAll: () => ({
        where: () => ({
          executeTakeFirst: async () => existing,
        }),
      }),
    }),
    updateTable: (_table: string) => ({
      set: (obj: Record<string, unknown>) => {
        captured.setArg = obj;
        return {
          where: (_col: string, _op: string, val: string) => {
            captured.whereId = val;
            return {
              returning: () => ({
                executeTakeFirst: async () => updatedRow,
              }),
            };
          },
        };
      },
    }),
  };
  return { db, captured };
}

describe('meta-tenants.service: updateTenant', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('preserves the existing encrypted apiKey when the update omits it (no double-encryption)', async () => {
    const encKey = encryptScalar('ORIGINAL_KEY');
    const existing = makeTenant({ youtube: { vodUpload: true, apiKey: encKey } });
    const { db, captured } = makeMetaDb(existing, existing);
    mockGetMetaClient.mock.mockImplementation(() => db);

    await updateTenant('t1', { youtube: { vodUpload: false } } as any);

    const parsed = JSON.parse(captured.setArg!.youtube as string);
    assert.strictEqual(parsed.apiKey, encKey, 'apiKey must be the same encrypted value, not re-encrypted');
    assert.strictEqual(decryptScalar(parsed.apiKey), 'ORIGINAL_KEY', 'apiKey must still decrypt to the original');
    assert.strictEqual(parsed.vodUpload, false, 'incoming field is applied');
  });

  it('encrypts a newly provided apiKey exactly once', async () => {
    const existing = makeTenant({ youtube: { vodUpload: true } });
    const { db, captured } = makeMetaDb(existing, existing);
    mockGetMetaClient.mock.mockImplementation(() => db);

    await updateTenant('t1', { youtube: { apiKey: 'NEW_KEY' } } as any);

    const parsed = JSON.parse(captured.setArg!.youtube as string);
    assert.notStrictEqual(parsed.apiKey, 'NEW_KEY', 'apiKey must be encrypted, not stored in plaintext');
    assert.strictEqual(decryptScalar(parsed.apiKey), 'NEW_KEY', 'single decryption recovers the new key');
  });

  it('preserves the existing encrypted auth when the update omits it', async () => {
    const authObj = { refresh_token: 'RT', expiry_date: 123 };
    const encAuth = encryptObject(authObj);
    const existing = makeTenant({ youtube: { upload: true, auth: encAuth } });
    const { db, captured } = makeMetaDb(existing, existing);
    mockGetMetaClient.mock.mockImplementation(() => db);

    await updateTenant('t1', { youtube: { upload: false } } as any);

    const parsed = JSON.parse(captured.setArg!.youtube as string);
    assert.strictEqual(parsed.auth, encAuth, 'auth must be the same encrypted value, not re-encrypted');
    assert.deepStrictEqual(decryptObject(parsed.auth), authObj, 'auth must still decrypt to the original');
    assert.strictEqual(parsed.upload, false, 'incoming field is applied');
  });

  it('encrypts a newly provided auth object exactly once', async () => {
    const existing = makeTenant({ youtube: { upload: true } });
    const { db, captured } = makeMetaDb(existing, existing);
    mockGetMetaClient.mock.mockImplementation(() => db);

    const newAuth = { refresh_token: 'NEW_RT', expiry_date: 999 };
    await updateTenant('t1', { youtube: { auth: newAuth } } as any);

    const parsed = JSON.parse(captured.setArg!.youtube as string);
    assert.notStrictEqual(JSON.stringify(parsed.auth), JSON.stringify(newAuth), 'auth must be encrypted');
    assert.deepStrictEqual(decryptObject(parsed.auth), newAuth, 'single decryption recovers the new auth');
  });

  it('merges non-youtube JSONB fields so sub-keys are not lost', async () => {
    const existing = makeTenant({ twitch: { enabled: true, username: 'old', id: '123' } });
    const { db, captured } = makeMetaDb(existing, existing);
    mockGetMetaClient.mock.mockImplementation(() => db);

    await updateTenant('t1', { twitch: { enabled: false } } as any);

    assert.deepStrictEqual(captured.setArg!.twitch, { enabled: false, username: 'old', id: '123' });
  });

  it('sets non-JSONB fields, updated_at, and the where id', async () => {
    const existing = makeTenant({ display_name: 'Old Name' });
    const { db, captured } = makeMetaDb(existing, existing);
    mockGetMetaClient.mock.mockImplementation(() => db);

    await updateTenant('t1', { display_name: 'New Name' });

    assert.strictEqual(captured.setArg!.display_name, 'New Name');
    assert.ok(captured.setArg!.updated_at instanceof Date);
    assert.strictEqual(captured.whereId, 't1');
  });
});
