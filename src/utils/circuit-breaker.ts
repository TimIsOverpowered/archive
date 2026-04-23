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
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
}

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  recoveryTimeout: 30_000,
};

export const breakerCache = new LRUCache<string, CircuitBreakerState>({
  max: 5000,
  ttl: 120_000,
  allowStale: false,
});

function getOrCreateBreaker(key: string, _opts?: Partial<CircuitBreakerOptions>): CircuitBreakerState {
  let state = breakerCache.get(key);

  if (!state) {
    state = {
      state: 'closed',
      failureCount: 0,
      lastFailureTime: null,
      lastSuccessTime: null,
    };
    breakerCache.set(key, state);
  }

  return state;
}

export function getCircuitState(key: string, opts?: Partial<CircuitBreakerOptions>): CircuitState {
  const state = getOrCreateBreaker(key, opts);

  if (state.state === 'open' && state.lastFailureTime) {
    const elapsed = Date.now() - state.lastFailureTime;
    if (elapsed >= (opts?.recoveryTimeout ?? DEFAULT_OPTIONS.recoveryTimeout)) {
      state.state = 'half-open';
    }
  }

  return state.state;
}

export function recordSuccess(key: string, opts?: Partial<CircuitBreakerOptions>): void {
  const state = getOrCreateBreaker(key, opts);
  state.failureCount = 0;
  state.lastSuccessTime = Date.now();
  state.state = 'closed';
}

export function recordFailure(key: string, opts?: Partial<CircuitBreakerOptions>): void {
  const state = getOrCreateBreaker(key, opts);

  state.failureCount++;
  state.lastFailureTime = Date.now();
  if (state.failureCount >= (opts?.failureThreshold ?? DEFAULT_OPTIONS.failureThreshold)) {
    state.state = 'open';
  }
}

export function isCircuitOpen(key: string, opts?: Partial<CircuitBreakerOptions>): boolean {
  const state = getCircuitState(key, opts);
  return state === 'open' || state === 'half-open';
}

export function clearCircuit(key: string): void {
  breakerCache.delete(key);
}

export function clearAllCircuits(): void {
  breakerCache.clear();
}
