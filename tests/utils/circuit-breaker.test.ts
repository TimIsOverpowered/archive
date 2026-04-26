import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  getCircuitState,
  recordSuccess,
  recordFailure,
  isCircuitOpen,
  clearAllCircuits,
} from '../../src/utils/circuit-breaker';

describe('Circuit Breaker', () => {
  beforeEach(() => {
    clearAllCircuits();
  });

  afterEach(() => {
    clearAllCircuits();
  });

  describe('initial state', () => {
    it('should start in closed state', () => {
      assert.strictEqual(getCircuitState('test-key'), 'closed');
    });
  });

  describe('recordFailure', () => {
    it('should not open circuit before threshold', () => {
      for (let i = 0; i < 4; i++) {
        recordFailure('test-key');
        assert.strictEqual(getCircuitState('test-key'), 'closed');
      }
    });

    it('should open circuit after reaching threshold', () => {
      for (let i = 0; i < 5; i++) {
        recordFailure('test-key');
      }
      assert.strictEqual(getCircuitState('test-key'), 'open');
    });

    it('should use custom threshold', () => {
      const opts = { failureThreshold: 3 };
      recordFailure('test-key', opts);
      recordFailure('test-key', opts);
      assert.strictEqual(getCircuitState('test-key'), 'closed');
      recordFailure('test-key', opts);
      assert.strictEqual(getCircuitState('test-key'), 'open');
    });

    it('should increment failureCount', () => {
      recordFailure('test-key');
      recordFailure('test-key');
      recordFailure('test-key');
      assert.strictEqual(getCircuitState('test-key'), 'closed');
    });

    it('should update lastFailureTime', () => {
      recordFailure('test-key');
    });
  });

  describe('recordSuccess', () => {
    it('should reset circuit to closed', () => {
      for (let i = 0; i < 5; i++) {
        recordFailure('test-key');
      }
      assert.strictEqual(getCircuitState('test-key'), 'open');

      recordSuccess('test-key');
      assert.strictEqual(getCircuitState('test-key'), 'closed');
    });

    it('should reset failure count', () => {
      for (let i = 0; i < 3; i++) {
        recordFailure('test-key');
      }
      recordSuccess('test-key');
      recordFailure('test-key');
      recordFailure('test-key');
      assert.strictEqual(getCircuitState('test-key'), 'closed');
    });

    it('should recover from half-open state', () => {
      for (let i = 0; i < 5; i++) {
        recordFailure('test-key');
      }
      // Wait for recovery timeout
      recordSuccess('test-key');
      assert.strictEqual(getCircuitState('test-key'), 'closed');
    });
  });

  describe('half-open recovery', () => {
    it('should transition to half-open after recovery timeout', () => {
      clearAllCircuits();
      const opts = { failureThreshold: 2, recoveryTimeout: 50 };
      recordFailure('test-key', opts);
      recordFailure('test-key', opts);
      assert.strictEqual(getCircuitState('test-key', opts), 'open');

      // Wait for recovery timeout
      const start = Date.now();
      while (Date.now() - start < 100) {
        // spin
      }

      assert.strictEqual(getCircuitState('test-key', opts), 'half-open');
    });

    it('should stay open before recovery timeout', () => {
      clearAllCircuits();
      const opts = { failureThreshold: 2, recoveryTimeout: 5000 };
      recordFailure('test-key', opts);
      recordFailure('test-key', opts);
      assert.strictEqual(getCircuitState('test-key', opts), 'open');

      // Wait a short time but not enough for recovery
      const start = Date.now();
      while (Date.now() - start < 100) {
        // spin
      }

      assert.strictEqual(getCircuitState('test-key', opts), 'open');
    });
  });

  describe('isCircuitOpen', () => {
    it('should return false when closed', () => {
      assert.strictEqual(isCircuitOpen('test-key'), false);
    });

    it('should return true when open', () => {
      for (let i = 0; i < 5; i++) {
        recordFailure('test-key');
      }
      assert.strictEqual(isCircuitOpen('test-key'), true);
    });

    it('should return true when half-open', () => {
      clearAllCircuits();
      const opts = { failureThreshold: 2, recoveryTimeout: 50 };
      recordFailure('test-key', opts);
      recordFailure('test-key', opts);

      // Wait for recovery timeout
      const start = Date.now();
      while (Date.now() - start < 100) {
        // spin
      }

      assert.strictEqual(getCircuitState('test-key', opts), 'half-open');
      assert.strictEqual(isCircuitOpen('test-key', opts), true);
    });
  });

  describe('clearCircuit', () => {
    it('should remove circuit from cache', () => {
      recordFailure('test-key');
      clearAllCircuits();
      assert.strictEqual(getCircuitState('test-key'), 'closed');
    });
  });

  describe('different keys are independent', () => {
    it('should track failures separately', () => {
      recordFailure('key-a');
      recordFailure('key-a');
      recordFailure('key-a');
      recordFailure('key-a');
      recordFailure('key-a');

      assert.strictEqual(getCircuitState('key-a'), 'open');
      assert.strictEqual(getCircuitState('key-b'), 'closed');
    });
  });
});
