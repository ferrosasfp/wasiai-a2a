/**
 * Circuit Breaker Tests — WKH-18 Hardening
 * AC-5: Anthropic CB, AC-6: Per-registry CB
 * State machine: closed -> open -> half_open -> closed/open
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CircuitBreaker,
  CircuitOpenError,
  getRegistryCircuitBreaker,
} from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeCB(
    overrides: Partial<{
      failureThreshold: number;
      windowMs: number;
      cooldownMs: number;
    }> = {},
  ) {
    return new CircuitBreaker({
      name: 'test',
      failureThreshold: overrides.failureThreshold ?? 3,
      windowMs: overrides.windowMs ?? 10000,
      cooldownMs: overrides.cooldownMs ?? 5000,
    });
  }

  // ── State Machine Tests ─────────────────────────────────────

  it('starts in closed state', () => {
    const cb = makeCB();
    expect(cb.getState().state).toBe('closed');
    expect(cb.getState().failures).toBe(0);
  });

  it('stays closed when fn succeeds', async () => {
    const cb = makeCB();
    const result = await cb.execute(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
    expect(cb.getState().state).toBe('closed');
  });

  it('stays closed after failures below threshold', async () => {
    const cb = makeCB({ failureThreshold: 3 });
    const fail = () => Promise.reject(new Error('fail'));

    await expect(cb.execute(fail)).rejects.toThrow('fail');
    await expect(cb.execute(fail)).rejects.toThrow('fail');

    expect(cb.getState().state).toBe('closed');
    expect(cb.getState().failures).toBe(2);
  });

  it('transitions to open after reaching failure threshold within window', async () => {
    const cb = makeCB({ failureThreshold: 3, windowMs: 10000 });
    const fail = () => Promise.reject(new Error('fail'));

    await expect(cb.execute(fail)).rejects.toThrow('fail');
    await expect(cb.execute(fail)).rejects.toThrow('fail');
    await expect(cb.execute(fail)).rejects.toThrow('fail');

    expect(cb.getState().state).toBe('open');
  });

  it('rejects immediately with CircuitOpenError when open', async () => {
    const cb = makeCB({ failureThreshold: 1, cooldownMs: 5000 });
    const fail = () => Promise.reject(new Error('fail'));

    await expect(cb.execute(fail)).rejects.toThrow('fail');
    expect(cb.getState().state).toBe('open');

    await expect(cb.execute(() => Promise.resolve('ok'))).rejects.toThrow(
      CircuitOpenError,
    );
    await expect(cb.execute(() => Promise.resolve('ok'))).rejects.toThrow(
      'Circuit breaker "test" is open',
    );
  });

  it('CircuitOpenError has correct code and statusCode', async () => {
    const err = new CircuitOpenError('mybreaker');
    expect(err.code).toBe('CIRCUIT_OPEN');
    expect(err.statusCode).toBe(503);
    expect(err.message).toBe('Circuit breaker "mybreaker" is open');
  });

  it('transitions from open to half_open after cooldown expires', async () => {
    const cb = makeCB({ failureThreshold: 1, cooldownMs: 5000 });
    const fail = () => Promise.reject(new Error('fail'));

    await expect(cb.execute(fail)).rejects.toThrow('fail');
    expect(cb.getState().state).toBe('open');

    // Advance past cooldown
    vi.advanceTimersByTime(5001);

    // Next call should try (half_open), and if it succeeds, go to closed
    const result = await cb.execute(() => Promise.resolve('recovered'));
    expect(result).toBe('recovered');
    expect(cb.getState().state).toBe('closed');
  });

  it('transitions from half_open back to open on failure', async () => {
    const cb = makeCB({ failureThreshold: 1, cooldownMs: 5000 });
    const fail = () => Promise.reject(new Error('fail'));

    await expect(cb.execute(fail)).rejects.toThrow('fail');
    expect(cb.getState().state).toBe('open');

    vi.advanceTimersByTime(5001);

    // half_open: try and fail
    await expect(cb.execute(fail)).rejects.toThrow('fail');
    expect(cb.getState().state).toBe('open');
  });

  it('resets failure count when window expires during closed state', async () => {
    const cb = makeCB({ failureThreshold: 3, windowMs: 10000 });
    const fail = () => Promise.reject(new Error('fail'));

    // 2 failures within window
    await expect(cb.execute(fail)).rejects.toThrow();
    await expect(cb.execute(fail)).rejects.toThrow();
    expect(cb.getState().failures).toBe(2);

    // Advance past window
    vi.advanceTimersByTime(10001);

    // Next failure should start a new window
    await expect(cb.execute(fail)).rejects.toThrow();
    expect(cb.getState().failures).toBe(1); // reset to 1, not 3
    expect(cb.getState().state).toBe('closed');
  });

  it('reset() restores to initial state', async () => {
    const cb = makeCB({ failureThreshold: 1 });
    await expect(
      cb.execute(() => Promise.reject(new Error('fail'))),
    ).rejects.toThrow();
    expect(cb.getState().state).toBe('open');

    cb.reset();
    expect(cb.getState().state).toBe('closed');
    expect(cb.getState().failures).toBe(0);
    expect(cb.getState().lastFailureTime).toBe(0);
  });

  // ── AC-5 scenario: 5 consecutive failures within 60s window ──

  it('AC-5: opens after 5 failures within 60s window, rejects for 30s cooldown', async () => {
    const cb = new CircuitBreaker({
      name: 'anthropic',
      failureThreshold: 5,
      windowMs: 60000,
      cooldownMs: 30000,
    });
    const fail = () => Promise.reject(new Error('API error'));

    for (let i = 0; i < 5; i++) {
      await expect(cb.execute(fail)).rejects.toThrow('API error');
    }

    expect(cb.getState().state).toBe('open');

    // Should reject immediately
    await expect(cb.execute(() => Promise.resolve('ok'))).rejects.toThrow(
      CircuitOpenError,
    );

    // 15 seconds later: still open
    vi.advanceTimersByTime(15000);
    await expect(cb.execute(() => Promise.resolve('ok'))).rejects.toThrow(
      CircuitOpenError,
    );

    // 30 seconds later: should try (half_open)
    vi.advanceTimersByTime(15001);
    const result = await cb.execute(() => Promise.resolve('recovered'));
    expect(result).toBe('recovered');
    expect(cb.getState().state).toBe('closed');
  });

  // ── AC-6 scenario: per-registry isolation ─────────────────────

  it('AC-6: getRegistryCircuitBreaker returns isolated instances per registry', () => {
    const cb1 = getRegistryCircuitBreaker('wasiai');
    const cb2 = getRegistryCircuitBreaker('morpheus');
    const cb1Again = getRegistryCircuitBreaker('wasiai');

    expect(cb1).toBe(cb1Again); // same instance
    expect(cb1).not.toBe(cb2); // different registries
  });

  it('AC-6: failure in one registry does not affect another', async () => {
    const cb1 = getRegistryCircuitBreaker('registry-a-test');
    const cb2 = getRegistryCircuitBreaker('registry-b-test');
    cb1.reset();
    cb2.reset();

    const fail = () => Promise.reject(new Error('fail'));

    // Fail cb1 to threshold (using default 5)
    for (let i = 0; i < 5; i++) {
      await expect(cb1.execute(fail)).rejects.toThrow();
    }

    expect(cb1.getState().state).toBe('open');
    expect(cb2.getState().state).toBe('closed');

    // cb2 should still work
    const result = await cb2.execute(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  // ── Success resets window ─────────────────────────────────────

  it('success after window expires resets failure count in closed state', async () => {
    const cb = makeCB({ failureThreshold: 3, windowMs: 5000 });
    const fail = () => Promise.reject(new Error('fail'));

    await expect(cb.execute(fail)).rejects.toThrow();
    await expect(cb.execute(fail)).rejects.toThrow();
    expect(cb.getState().failures).toBe(2);

    // Window expires
    vi.advanceTimersByTime(5001);

    // Success should reset
    await cb.execute(() => Promise.resolve('ok'));
    expect(cb.getState().failures).toBe(0);
  });
});
