import { LRUCache } from 'lru-cache';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Number of failures before opening the circuit */
  failureThreshold: number;
  /** Time in ms to wait before testing recovery (half-open) */
  recoveryTimeout: number;
}

export interface CircuitBreakerState {
  state: CircuitState;
  failureCount: number;
  failureThreshold: number;
  recoveryTimeout: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
}

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  recoveryTimeout: 30_000,
};

const DEFAULT_CACHE_MAX = 5000;
const DEFAULT_CACHE_TTL_MS = 120_000;

export class CircuitBreaker {
  private readonly cache: LRUCache<string, CircuitBreakerState>;

  constructor(options?: { max?: number; ttl?: number }) {
    this.cache = new LRUCache({
      max: options?.max ?? DEFAULT_CACHE_MAX,
      ttl: options?.ttl ?? DEFAULT_CACHE_TTL_MS,
      allowStale: false,
    });
  }

  private getOrCreateBreaker(key: string, opts?: Partial<CircuitBreakerOptions>): CircuitBreakerState {
    let state = this.cache.get(key);

    if (!state) {
      state = {
        state: 'closed',
        failureCount: 0,
        failureThreshold: opts?.failureThreshold ?? DEFAULT_OPTIONS.failureThreshold,
        recoveryTimeout: opts?.recoveryTimeout ?? DEFAULT_OPTIONS.recoveryTimeout,
        lastFailureTime: null,
        lastSuccessTime: null,
      };
      this.cache.set(key, state);
    }

    return state;
  }

  getState(key: string, opts?: Partial<CircuitBreakerOptions>): CircuitState {
    const state = this.getOrCreateBreaker(key, opts);

    if (state.state === 'open' && state.lastFailureTime != null) {
      const elapsed = Date.now() - state.lastFailureTime;
      if (elapsed >= state.recoveryTimeout) {
        state.state = 'half-open';
        return 'half-open';
      }
    }

    return state.state;
  }

  recordSuccess(key: string, opts?: Partial<CircuitBreakerOptions>): void {
    const state = this.getOrCreateBreaker(key, opts);
    state.failureCount = 0;
    state.lastSuccessTime = Date.now();
    state.state = 'closed';
  }

  recordFailure(key: string, opts?: Partial<CircuitBreakerOptions>): void {
    const state = this.getOrCreateBreaker(key, opts);

    state.failureCount += 1;
    state.lastFailureTime = Date.now();
    if (state.failureCount >= state.failureThreshold) {
      state.state = 'open';
    }
  }

  isCircuitOpen(key: string, opts?: Partial<CircuitBreakerOptions>): boolean {
    return this.getState(key, opts) === 'open';
  }

  isCircuitHalfOpen(key: string, opts?: Partial<CircuitBreakerOptions>): boolean {
    return this.getState(key, opts) === 'half-open';
  }

  clearCircuit(key: string): void {
    this.cache.delete(key);
  }

  clearAllCircuits(): void {
    this.cache.clear();
  }

  clearCircuitsMatching(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }
}

export const defaultCircuitBreaker = new CircuitBreaker();
