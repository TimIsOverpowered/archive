import { strict as assert } from 'node:assert';
import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';

// Mock the admin API key middleware so requests are not rejected during tests.
mock.module('../../../../src/api/middleware/admin-api-key.js', {
  exports: {
    default: async () => {},
  },
});

// Mock the meta-tenants service functions the routes call.
const mockCreateTenant = mock.fn<(...args: any[]) => any>();
const mockGetTenantById = mock.fn<(...args: any[]) => any>();
const mockGetAllTenants = mock.fn<(...args: any[]) => any>();
const mockUpdateTenant = mock.fn<(...args: any[]) => any>();
const mockDeleteTenant = mock.fn<(...args: any[]) => any>();
const mockGetTenantByIdRaw = mock.fn<(...args: any[]) => any>();
const mockGetAllTenantsRaw = mock.fn<(...args: any[]) => any>();

mock.module('../../../../src/services/meta-tenants.service.js', {
  exports: {
    createTenant: mockCreateTenant,
    getTenantById: mockGetTenantById,
    getAllTenants: mockGetAllTenants,
    updateTenant: mockUpdateTenant,
    deleteTenant: mockDeleteTenant,
    // Present so transitive imports (tenant-config) can resolve the full export surface.
    getTenantByIdRaw: mockGetTenantByIdRaw,
    getAllTenantsRaw: mockGetAllTenantsRaw,
  },
});

const { default: tenantsRoutes } = await import('../../../../src/api/routes/admin/tenants.routes.js');
const { configService } = await import('../../../../src/config/tenant-config.js');
const { buildTestServer } = await import('../../../helpers/build-test-server.js');

describe('admin tenants routes: config cache invalidation', () => {
  let server: any;
  let close: () => Promise<void>;

  before(async () => {
    const built = await buildTestServer();
    server = built.server;
    close = built.close;
    await server.register(tenantsRoutes);
    await server.ready();
  });

  after(async () => {
    await close();
  });

  beforeEach(() => {
    mockCreateTenant.mock.resetCalls();
    mockUpdateTenant.mock.resetCalls();
    mockDeleteTenant.mock.resetCalls();
    mockCreateTenant.mock.mockImplementation(async (data: any) => ({ id: data?.id ?? 'new-tenant' }));
    mockUpdateTenant.mock.mockImplementation(async (id: string) => ({ id }));
    mockDeleteTenant.mock.mockImplementation(async () => {});
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('reloads the config cache after creating a tenant', async () => {
    const reloadSpy = mock.method(configService, 'reloadTenant', async () => {});
    const publishSpy = mock.method(configService, 'publishConfigChanged', () => {});

    const res = await server.inject({ method: 'POST', url: '/admin/tenants', payload: { id: 'new-tenant' } });
    assert.strictEqual(res.statusCode, 200);

    assert.strictEqual(reloadSpy.mock.callCount(), 1, 'reloadTenant should be called once');
    assert.strictEqual(reloadSpy.mock.calls[0]!.arguments[0], 'new-tenant');
    assert.strictEqual(
      publishSpy.mock.callCount(),
      0,
      'create must not publish directly (reloadTenant handles fan-out)'
    );
  });

  it('reloads the config cache after updating a tenant', async () => {
    const reloadSpy = mock.method(configService, 'reloadTenant', async () => {});
    const publishSpy = mock.method(configService, 'publishConfigChanged', () => {});

    const res = await server.inject({ method: 'PUT', url: '/admin/tenants/t1', payload: { display_name: 'New' } });
    assert.strictEqual(res.statusCode, 200);

    assert.strictEqual(reloadSpy.mock.callCount(), 1, 'reloadTenant should be called once');
    assert.strictEqual(reloadSpy.mock.calls[0]!.arguments[0], 't1');
    assert.strictEqual(publishSpy.mock.callCount(), 0);
  });

  it('clears the local config and broadcasts after deleting a tenant', async () => {
    const reloadSpy = mock.method(configService, 'reloadTenant', async () => {});
    const publishSpy = mock.method(configService, 'publishConfigChanged', () => {});

    const res = await server.inject({ method: 'DELETE', url: '/admin/tenants/t1' });
    assert.strictEqual(res.statusCode, 200);

    assert.strictEqual(reloadSpy.mock.callCount(), 1, 'reloadTenant should clear the local cache');
    assert.strictEqual(reloadSpy.mock.calls[0]!.arguments[0], 't1');
    assert.deepStrictEqual(reloadSpy.mock.calls[0]!.arguments[1], { publish: false });
    assert.strictEqual(publishSpy.mock.callCount(), 1, 'delete must broadcast the change to other processes');
    assert.strictEqual(publishSpy.mock.calls[0]!.arguments[0], 't1');
  });
});
