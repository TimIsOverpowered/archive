import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';

describe('Integration: Mock Redis', () => {
  let mock: Redis;

  beforeEach(async () => {
    mock = new RedisMock({ lazyConnect: true });
    await mock.connect();
  });

  it('should get/set values', async () => {
    await mock.set('key1', 'value1', 'EX', 60);
    const val = await mock.get('key1');
    assert.strictEqual(val, 'value1');
  });

  it('should return null for missing keys', async () => {
    const val = await mock.get('nonexistent');
    assert.strictEqual(val, null);
  });

  it('should increment values', async () => {
    await mock.set('counter', '0');
    const val = await mock.incr('counter');
    assert.strictEqual(val, 1);
  });

  it('should delete keys', async () => {
    await mock.set('delkey', 'value');
    const count = await mock.del('delkey');
    assert.strictEqual(count, 1);
    assert.strictEqual(await mock.get('delkey'), null);
  });

  it('should support pipeline', async () => {
    const results = (await mock.pipeline().set('a', '1').incr('b').exec())!;
    assert.deepStrictEqual(results[0], [null, 'OK']);
    assert.deepStrictEqual(results[1], [null, 1]);
  });

  it('should support publish/subscribe', async () => {
    let received: string | null = null;
    const subClient = new RedisMock({ lazyConnect: true });
    await subClient.connect();
    subClient.on('message', (_ch: string, msg: string) => {
      received = msg;
    });
    await subClient.subscribe('test-channel');
    await new Promise((resolve) => setImmediate(resolve));
    const pubClient = new RedisMock({ lazyConnect: true });
    await pubClient.connect();
    await pubClient.publish('test-channel', 'hello');
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(received, 'hello');
    await subClient.quit();
    await pubClient.quit();
  });

  it('should support duplicate for subscriber', async () => {
    const dup = mock.duplicate();
    await dup.subscribe('ch');
    assert.ok(dup);
    await dup.disconnect();
  });

  it('should reset all data', async () => {
    await mock.set('k1', 'v1');
    await mock.set('k2', 'v2');
    mock.flushdb();
    assert.strictEqual(await mock.get('k1'), null);
    assert.strictEqual(await mock.get('k2'), null);
  });
});
