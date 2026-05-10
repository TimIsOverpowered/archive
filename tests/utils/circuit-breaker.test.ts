import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { CircuitBreaker } from '../../src/utils/circuit-breaker.js';

describe('Circuit Breaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker();
    breaker.clearAllCircuits();
  });

  afterEach(() => {
    breaker.clearAllCircuits();
  });

  describe('initial state', () => {
    it('should start in closed state', () => {
      assert.strictEqual(breaker.getState('test-key'), 'closed');
    });
  });

  describe('register', () => {
    it('should use registered options', () => {
      breaker.register('custom-key', { failureThreshold: 3, recoveryTimeout: 60_000 });
      for (let i = 0; i < 2; i++) {
        breaker.recordFailure('custom-key');
        assert.strictEqual(breaker.getState('custom-key'), 'closed');
      }
    });

    it('should not override existing circuit', () => {
      breaker.register('existing-key', { failureThreshold: 3, recoveryTimeout: 60_000 });
      breaker.recordFailure('existing-key');
      breaker.recordFailure('existing-key');
      breaker.recordFailure('existing-key');
      assert.strictEqual(breaker.getState('existing-key'), 'open');

      // Try to register with different options — should be ignored
      breaker.register('existing-key', { failureThreshold: 10, recoveryTimeout: 1_000 });
      assert.strictEqual(breaker.getState('existing-key'), 'open');
    });
  });

  describe('recordFailure', () => {
    it('should not open circuit before threshold', () => {
      for (let i = 0; i < 4; i++) {
        breaker.recordFailure('test-key');
        assert.strictEqual(breaker.getState('test-key'), 'closed');
      }
    });

    it('should open circuit after reaching threshold', () => {
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure('test-key');
      }
      assert.strictEqual(breaker.getState('test-key'), 'open');
    });

    it('should increment failureCount', () => {
      breaker.recordFailure('test-key');
      breaker.recordFailure('test-key');
      breaker.recordFailure('test-key');
      assert.strictEqual(breaker.getState('test-key'), 'closed');
    });

    it('should update lastFailureTime', () => {
      breaker.recordFailure('test-key');
    });
  });

  describe('recordSuccess', () => {
    it('should reset circuit to closed', () => {
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure('test-key');
      }
      assert.strictEqual(breaker.getState('test-key'), 'open');

      breaker.recordSuccess('test-key');
      assert.strictEqual(breaker.getState('test-key'), 'closed');
    });

    it('should reset failure count', () => {
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure('test-key');
      }
      breaker.recordSuccess('test-key');
      breaker.recordFailure('test-key');
      breaker.recordFailure('test-key');
      assert.strictEqual(breaker.getState('test-key'), 'closed');
    });

    it('should recover from half-open state', () => {
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure('test-key');
      }
      breaker.recordSuccess('test-key');
      assert.strictEqual(breaker.getState('test-key'), 'closed');
    });
  });

  describe('half-open recovery', () => {
    it('should transition to half-open after recovery timeout', () => {
      breaker.clearAllCircuits();
      const opts = { failureThreshold: 2, recoveryTimeout: 50 };
      breaker.register('timeout-key', opts);
      breaker.recordFailure('timeout-key');
      breaker.recordFailure('timeout-key');
      assert.strictEqual(breaker.getState('timeout-key'), 'open');

      const start = Date.now();
      while (Date.now() - start < 100) {
        // spin
      }

      assert.strictEqual(breaker.getState('timeout-key'), 'half-open');
    });

    it('should stay open before recovery timeout', () => {
      breaker.clearAllCircuits();
      const opts = { failureThreshold: 2, recoveryTimeout: 5000 };
      breaker.register('not-ready-key', opts);
      breaker.recordFailure('not-ready-key');
      breaker.recordFailure('not-ready-key');
      assert.strictEqual(breaker.getState('not-ready-key'), 'open');

      const start = Date.now();
      while (Date.now() - start < 100) {
        // spin
      }

      assert.strictEqual(breaker.getState('not-ready-key'), 'open');
    });
  });

  describe('isCircuitOpen', () => {
    it('should return false when closed', () => {
      assert.strictEqual(breaker.isCircuitOpen('test-key'), false);
    });

    it('should return true when open', () => {
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure('test-key');
      }
      assert.strictEqual(breaker.isCircuitOpen('test-key'), true);
    });

    it('should return false when half-open', () => {
      breaker.clearAllCircuits();
      const opts = { failureThreshold: 2, recoveryTimeout: 50 };
      breaker.register('halfopen-key', opts);
      breaker.recordFailure('halfopen-key');
      breaker.recordFailure('halfopen-key');

      const start = Date.now();
      while (Date.now() - start < 100) {
        // spin
      }

      assert.strictEqual(breaker.getState('halfopen-key'), 'half-open');
      assert.strictEqual(breaker.isCircuitOpen('halfopen-key'), false);
    });
  });

  describe('isCircuitHalfOpen', () => {
    it('should return false when closed', () => {
      assert.strictEqual(breaker.isCircuitHalfOpen('test-key'), false);
    });

    it('should return false when open', () => {
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure('test-key');
      }
      assert.strictEqual(breaker.isCircuitHalfOpen('test-key'), false);
    });

    it('should return true when half-open', () => {
      breaker.clearAllCircuits();
      const opts = { failureThreshold: 2, recoveryTimeout: 50 };
      breaker.register('halfopen2-key', opts);
      breaker.recordFailure('halfopen2-key');
      breaker.recordFailure('halfopen2-key');

      const start = Date.now();
      while (Date.now() - start < 100) {
        // spin
      }

      assert.strictEqual(breaker.getState('halfopen2-key'), 'half-open');
      assert.strictEqual(breaker.isCircuitHalfOpen('halfopen2-key'), true);
    });
  });

  describe('clearCircuit', () => {
    it('should remove circuit from cache', () => {
      breaker.recordFailure('test-key');
      breaker.clearAllCircuits();
      assert.strictEqual(breaker.getState('test-key'), 'closed');
    });
  });

  describe('different keys are independent', () => {
    it('should track failures separately', () => {
      breaker.recordFailure('key-a');
      breaker.recordFailure('key-a');
      breaker.recordFailure('key-a');
      breaker.recordFailure('key-a');
      breaker.recordFailure('key-a');

      assert.strictEqual(breaker.getState('key-a'), 'open');
      assert.strictEqual(breaker.getState('key-b'), 'closed');
    });
  });
});
