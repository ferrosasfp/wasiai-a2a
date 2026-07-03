/**
 * Event Service — WKH-133 hook tests (W4).
 *
 * Cubre AC-2/CD-5 (flag OFF → onSettledEvent NUNCA invocado; track() retorna la
 * fila normal) y AC-7/CD-1 (fire-and-forget: track() resuelve aunque
 * onSettledEvent cuelgue o rechace — no-await, no bloquea el hot-path). Mockea
 * supabase + el gate del writer + el service de write-back. CI-determinista.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────
vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn() },
}));
vi.mock('../adapters/erc8004-reputation-writer.js', () => ({
  isWritebackEnabled: vi.fn(),
}));
vi.mock('./reputation-writeback.js', () => ({
  reputationWritebackService: { onSettledEvent: vi.fn() },
}));

import { isWritebackEnabled } from '../adapters/erc8004-reputation-writer.js';
import { supabase } from '../lib/supabase.js';
import { eventService } from './event.js';
import { reputationWritebackService } from './reputation-writeback.js';

const mockFrom = vi.mocked(supabase.from);
const mockEnabled = vi.mocked(isWritebackEnabled);
const mockOnSettled = vi.mocked(reputationWritebackService.onSettledEvent);

// track(): from('a2a_events').insert(row).select().single() → { data, error }.
function setupInsert(row: Record<string, unknown>) {
  const single = vi.fn().mockResolvedValue({ data: row, error: null });
  const mock: Record<string, unknown> = {
    insert: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    single,
  };
  for (const k of ['insert', 'select']) {
    (mock[k] as ReturnType<typeof vi.fn>).mockReturnValue(mock);
  }
  mockFrom.mockReturnValue(mock as unknown as ReturnType<typeof supabase.from>);
}

function insertedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-uuid-1',
    event_type: 'compose_step',
    agent_id: 'weather-agent',
    agent_name: 'Weather',
    registry: 'wasiai',
    status: 'success',
    latency_ms: 12,
    cost_usdc: 0.05,
    tx_hash: null,
    goal: null,
    metadata: {},
    created_at: '2026-07-03T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('eventService.track — WKH-133 write-back hook', () => {
  // T-AC2-flag: flag OFF → onSettledEvent NUNCA; track retorna la fila.
  it('T-AC2-flag: flag OFF → onSettledEvent never called, returns the event', async () => {
    mockEnabled.mockReturnValue(false);
    setupInsert(insertedRow());

    const result = await eventService.track({
      eventType: 'compose_step',
      agentId: 'weather-agent',
      status: 'success',
      costUsdc: 0.05,
    });

    expect(result.id).toBe('evt-uuid-1');
    expect(result.status).toBe('success');
    expect(mockOnSettled).not.toHaveBeenCalled();
  });

  // T-AC7: flag ON but onSettledEvent REJECTS → track() still resolves normally
  // (fire-and-forget, no-await — CD-1). No unhandled rejection.
  it('T-AC7: track() resolves even if onSettledEvent rejects (fire-and-forget)', async () => {
    mockEnabled.mockReturnValue(true);
    mockOnSettled.mockRejectedValue(new Error('writeback boom'));
    setupInsert(insertedRow());

    const result = await eventService.track({
      eventType: 'compose_step',
      agentId: 'weather-agent',
      status: 'success',
      costUsdc: 0.05,
    });

    expect(result.id).toBe('evt-uuid-1');
    expect(mockOnSettled).toHaveBeenCalledTimes(1);
    // Deja drenar el microtask del .catch para evitar unhandled rejection.
    await Promise.resolve();
  });

  // T-AC7 (hang): onSettledEvent que nunca resuelve NO bloquea track().
  it('T-AC7-hang: track() resolves even if onSettledEvent never settles', async () => {
    mockEnabled.mockReturnValue(true);
    mockOnSettled.mockReturnValue(new Promise<void>(() => {})); // never settles
    setupInsert(insertedRow());

    const result = await eventService.track({
      eventType: 'compose_step',
      agentId: 'weather-agent',
      status: 'success',
      costUsdc: 0.05,
    });

    expect(result.id).toBe('evt-uuid-1');
    expect(mockOnSettled).toHaveBeenCalledTimes(1);
  });
});
