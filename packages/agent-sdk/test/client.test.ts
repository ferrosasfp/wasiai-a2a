import { describe, expect, it, vi } from 'vitest';
import { A2AClient } from '../src/client.js';

interface JsonResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
function res(status: number, body: unknown): JsonResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('A2AClient x-payment-chain header (WKH-105)', () => {
  it('agrega x-payment-chain == network en requests cuando network está seteado', async () => {
    let headers: Record<string, string> | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return res(200, {});
    }) as unknown as typeof fetch;

    const client = new A2AClient({
      baseUrl: 'http://x',
      fetchImpl,
      key: 'wasi_a2a_test',
      network: 'base-sepolia',
    });
    await client.request('/compose', { body: { steps: [] } });

    expect(headers?.['x-payment-chain']).toBe('base-sepolia');
    expect(headers?.['x-a2a-key']).toBe('wasi_a2a_test');
  });

  it('NO agrega x-payment-chain cuando network es undefined', async () => {
    let headers: Record<string, string> | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return res(200, {});
    }) as unknown as typeof fetch;

    const client = new A2AClient({ baseUrl: 'http://x', fetchImpl });
    await client.request('/discover', { method: 'GET' });

    expect(headers?.['x-payment-chain']).toBeUndefined();
  });
});
