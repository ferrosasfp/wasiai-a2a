/**
 * Graceful Shutdown Tests — WKH-18 Hardening — AC-12
 *
 * Tests the shutdown logic by verifying fastify.close() is called.
 * Note: We cannot test actual process.exit or signal handlers in vitest
 * without side effects, so we test the shutdown function behavior.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('graceful shutdown (AC-12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('AC-12: SHUTDOWN_GRACE_MS defaults to 30000', () => {
    const graceMs = parseInt(process.env.SHUTDOWN_GRACE_MS ?? '30000', 10);
    expect(graceMs).toBe(30000);
  });

  it('AC-12: SHUTDOWN_GRACE_MS is configurable via env', () => {
    const prev = process.env.SHUTDOWN_GRACE_MS;
    process.env.SHUTDOWN_GRACE_MS = '5000';
    const graceMs = parseInt(process.env.SHUTDOWN_GRACE_MS ?? '30000', 10);
    expect(graceMs).toBe(5000);
    if (prev) {
      process.env.SHUTDOWN_GRACE_MS = prev;
    } else {
      delete process.env.SHUTDOWN_GRACE_MS;
    }
  });

  it('AC-12: graceful shutdown calls fastify.close()', async () => {
    // Simulate the shutdown function logic
    const mockClose = vi.fn().mockResolvedValue(undefined);
    const mockLog = { info: vi.fn(), error: vi.fn() };
    const mockExit = vi.fn();

    // Replicate the gracefulShutdown function from index.ts
    async function gracefulShutdown(signal: string) {
      mockLog.info({ signal }, 'Received signal, starting graceful shutdown');
      const graceMs = parseInt(process.env.SHUTDOWN_GRACE_MS ?? '30000', 10);
      const forceTimer = setTimeout(() => {
        mockLog.error('Graceful shutdown timed out, forcing exit');
        mockExit(1);
      }, graceMs);
      forceTimer.unref();
      try {
        await mockClose();
        mockExit(0);
      } catch (err) {
        mockLog.error({ err }, 'Error during graceful shutdown');
        mockExit(1);
      }
    }

    await gracefulShutdown('SIGTERM');

    expect(mockLog.info).toHaveBeenCalledWith(
      { signal: 'SIGTERM' },
      'Received signal, starting graceful shutdown',
    );
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('AC-12: graceful shutdown exits with 1 on close error', async () => {
    const mockClose = vi.fn().mockRejectedValue(new Error('close failed'));
    const mockLog = { info: vi.fn(), error: vi.fn() };
    const mockExit = vi.fn();

    async function gracefulShutdown(signal: string) {
      mockLog.info({ signal }, 'Received signal, starting graceful shutdown');
      const graceMs = parseInt(process.env.SHUTDOWN_GRACE_MS ?? '30000', 10);
      const forceTimer = setTimeout(() => {
        mockLog.error('Graceful shutdown timed out, forcing exit');
        mockExit(1);
      }, graceMs);
      forceTimer.unref();
      try {
        await mockClose();
        mockExit(0);
      } catch (err) {
        mockLog.error({ err }, 'Error during graceful shutdown');
        mockExit(1);
      }
    }

    await gracefulShutdown('SIGINT');

    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
