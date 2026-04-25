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

  if (state.state === 'open' && state.lastFailureTime != null) {
    const elapsed = Date.now() - state.lastFailureTime;
    if (elapsed >= (opts?.recoveryTimeout ?? DEFAULT_OPTIONS.recoveryTimeout)) {
      const nextState: CircuitBreakerState = { ...state, state: 'half-open' };
      breakerCache.set(key, nextState);
      return 'half-open';
    }
  }

  return state.state;
}

export function recordSuccess(key: string, opts?: Partial<CircuitBreakerOptions>): void {
  const state = getOrCreateBreaker(key, opts);
  const nextState: CircuitBreakerState = {
    ...state,
    failureCount: 0,
    lastSuccessTime: Date.now(),
    state: 'closed',
  };
  breakerCache.set(key, nextState);
}

export function recordFailure(key: string, opts?: Partial<CircuitBreakerOptions>): void {
  const state = getOrCreateBreaker(key, opts);

  const newFailureCount = state.failureCount + 1;
  const threshold = opts?.failureThreshold ?? DEFAULT_OPTIONS.failureThreshold;
  const nextState: CircuitBreakerState = {
    ...state,
    failureCount: newFailureCount,
    lastFailureTime: Date.now(),
    state: newFailureCount >= threshold ? 'open' : state.state,
  };
  breakerCache.set(key, nextState);
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
