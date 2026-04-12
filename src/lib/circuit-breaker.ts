/**
 * Circuit Breaker — In-memory state machine for resilience
 * WKH-18: Hardening — AC-5 (Anthropic), AC-6 (per-registry)
 *
 * States: closed -> open -> half_open -> closed (on success) or open (on failure)
 */

// ── Types ─────────────────────────────────────────────────────

export interface CircuitBreakerConfig {
  name: string;
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
}

export type CircuitState = 'closed' | 'open' | 'half_open';

// ── CircuitOpenError ──────────────────────────────────────────

export class CircuitOpenError extends Error {
  readonly code = 'CIRCUIT_OPEN' as const;
  readonly statusCode = 503;

  constructor(name: string) {
    super(`Circuit breaker "${name}" is open`);
    this.name = 'CircuitOpenError';
  }
}

// ── CircuitBreaker Class ──────────────────────────────────────

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastFailureTime = 0;
  private windowStart = 0;
  private readonly config: CircuitBreakerConfig;

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();

    if (this.state === 'open') {
      if (now - this.lastFailureTime >= this.config.cooldownMs) {
        // Cooldown expired: transition to half_open
        this.state = 'half_open';
      } else {
        throw new CircuitOpenError(this.config.name);
      }
    }

    if (this.state === 'half_open') {
      try {
        const result = await fn();
        // Success: transition to closed, reset
        this.state = 'closed';
        this.failures = 0;
        this.windowStart = 0;
        this.lastFailureTime = 0;
        return result;
      } catch (err) {
        // Failure: back to open, reset cooldown
        this.state = 'open';
        this.lastFailureTime = Date.now();
        throw err;
      }
    }

    // state === 'closed'
    try {
      const result = await fn();
      // Success in closed: check if window expired, reset if so
      if (
        this.windowStart > 0 &&
        now - this.windowStart >= this.config.windowMs
      ) {
        this.failures = 0;
        this.windowStart = 0;
      }
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  private recordFailure(): void {
    const now = Date.now();

    // If window expired, start a new window
    if (
      this.windowStart === 0 ||
      now - this.windowStart >= this.config.windowMs
    ) {
      this.failures = 1;
      this.windowStart = now;
    } else {
      this.failures++;
    }

    this.lastFailureTime = now;

    if (this.failures >= this.config.failureThreshold) {
      this.state = 'open';
    }
  }

  getState(): {
    state: CircuitState;
    failures: number;
    lastFailureTime: number;
  } {
    return {
      state: this.state,
      failures: this.failures,
      lastFailureTime: this.lastFailureTime,
    };
  }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.lastFailureTime = 0;
    this.windowStart = 0;
  }
}

// ── Singleton Instances ───────────────────────────────────────

export const anthropicCircuitBreaker = new CircuitBreaker({
  name: 'anthropic',
  failureThreshold: parseInt(process.env.CB_ANTHROPIC_FAILURES ?? '5', 10),
  windowMs: parseInt(process.env.CB_ANTHROPIC_WINDOW_MS ?? '60000', 10),
  cooldownMs: parseInt(process.env.CB_ANTHROPIC_COOLDOWN_MS ?? '30000', 10),
});

const registryBreakers = new Map<string, CircuitBreaker>();

export function getRegistryCircuitBreaker(
  registryName: string,
): CircuitBreaker {
  let cb = registryBreakers.get(registryName);
  if (!cb) {
    cb = new CircuitBreaker({
      name: `registry:${registryName}`,
      failureThreshold: parseInt(process.env.CB_REGISTRY_FAILURES ?? '5', 10),
      windowMs: parseInt(process.env.CB_REGISTRY_WINDOW_MS ?? '60000', 10),
      cooldownMs: parseInt(process.env.CB_REGISTRY_COOLDOWN_MS ?? '30000', 10),
    });
    registryBreakers.set(registryName, cb);
  }
  return cb;
}
