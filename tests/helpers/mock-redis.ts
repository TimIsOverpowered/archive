import { EventEmitter } from 'node:events';

export interface MockRedisOptions {
  data?: Map<string, string>;
  pubSub?: boolean;
}

export class MockRedisClient extends EventEmitter {
  private data: Map<string, string>;
  private expires: Map<string, number>;
  private subscriptions: Map<string, Set<(channel: string, message: string) => void>>;
  private isConnected: boolean;

  constructor(options?: MockRedisOptions) {
    super();
    this.data = options?.data ?? new Map();
    this.expires = new Map();
    this.subscriptions = new Map();
    this.isConnected = false;
  }

  async connect(): Promise<this> {
    this.isConnected = true;
    this.emit('connect');
    return this;
  }

  async quit(): Promise<void> {
    this.isConnected = false;
    this.emit('end');
  }

  async ping(): Promise<'PONG'> {
    return 'PONG';
  }

  async get(key: string): Promise<string | null> {
    const expiry = this.expires.get(key);
    if (expiry && Date.now() > expiry) {
      this.data.delete(key);
      this.expires.delete(key);
      return null;
    }
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string, mode?: 'EX' | 'PX', ttl?: number): Promise<'OK'> {
    this.data.set(key, value);
    if (mode === 'EX' && ttl) {
      this.expires.set(key, Date.now() + ttl * 1000);
    } else if (mode === 'PX' && ttl) {
      this.expires.set(key, Date.now() + ttl);
    }
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.data.delete(key) ? 1 : 0;
  }

  async incr(key: string): Promise<number> {
    const current = parseInt(this.data.get(key) ?? '0', 10);
    const next = current + 1;
    this.data.set(key, String(next));
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (!this.data.has(key)) return 0;
    this.expires.set(key, Date.now() + seconds * 1000);
    return 1;
  }

  async publish(channel: string, message: string): Promise<number> {
    const subs = this.subscriptions.get(channel);
    let count = 0;
    if (subs) {
      for (const cb of subs) {
        cb(channel, message);
        count++;
      }
    }
    this.emit('message', channel, message);
    return count;
  }

  async subscribe(channel: string): Promise<this> {
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
    }
    return this;
  }

  async unsubscribe(channel: string): Promise<this> {
    this.subscriptions.delete(channel);
    return this;
  }

  duplicate(): MockRedisClient {
    const clone = new MockRedisClient({ data: this.data });
    if (this.isConnected) clone.connect();
    return clone;
  }

  pipeline(): MockRedisPipeline {
    return new MockRedisPipeline(this);
  }

  async scan(_cursor: number, _option: string, pattern: string): Promise<[string, string[]]> {
    const matches = [...this.data.keys()].filter((k) => k.includes(pattern.replace('{', '').replace('}', '')));
    return ['0', matches];
  }

  async unlink(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.data.delete(key)) count++;
    }
    return count;
  }

  reset(): void {
    this.data.clear();
    this.expires.clear();
    this.subscriptions.clear();
  }
}

export class MockRedisPipeline {
  private commands: Array<{ cmd: string; args: unknown[] }> = [];

  constructor(private client: MockRedisClient) {}

  set(key: string, value: string, mode?: string, ttl?: number): this {
    this.commands.push({ cmd: 'set', args: [key, value, mode, ttl] });
    return this;
  }

  incr(key: string): this {
    this.commands.push({ cmd: 'incr', args: [key] });
    return this;
  }

  expire(key: string, seconds: number): this {
    this.commands.push({ cmd: 'expire', args: [key, seconds] });
    return this;
  }

  del(key: string): this {
    this.commands.push({ cmd: 'del', args: [key] });
    return this;
  }

  async exec(): Promise<Array<null | Error | unknown>> {
    const results: Array<null | Error | unknown> = [];
    for (const { cmd, args } of this.commands) {
      let result: unknown;
      switch (cmd) {
        case 'set':
          result = await this.client.set(args[0] as string, args[1] as string, args[2] as 'EX' | 'PX' | undefined, args[3] as number | undefined);
          break;
        case 'incr':
          result = await this.client.incr(args[0] as string);
          break;
        case 'expire':
          result = await this.client.expire(args[0] as string, args[1] as number);
          break;
        case 'del':
          result = await this.client.del(args[0] as string);
          break;
        default:
          result = null;
      }
      results.push(result);
    }
    this.commands = [];
    return results;
  }
}

export function createMockRedis(options?: MockRedisOptions): MockRedisClient {
  return new MockRedisClient(options);
}
