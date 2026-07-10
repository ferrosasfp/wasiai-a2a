/**
 * Agents Routes — auth-only integration (WKH-173 · MNR-3).
 *
 * Test de integración sobre la ruta REAL `POST /agents` con el middleware REAL
 * `requireA2AKey` (NO mockeado, a diferencia de agents.publish.test.ts). Cierra
 * el vector "dinero-real-perdido" a nivel RUTA: un caller x402-anónimo que manda
 * `x-payment` pero SIN a2a-key debe ser rechazado con `403 A2A_KEY_REQUIRED`
 * ANTES de tocar el adapter de pago x402 (que NUNCA debe invocarse — de lo
 * contrario pagaría on-chain y luego sería rechazado).
 *
 * Estrategia: se mockea `../lib/supabase.js` (única dependencia de módulo de los
 * services que el middleware real importa) + `../adapters/registry.js` para
 * espiar `getPaymentAdapter` (el adapter de pago x402). El middleware NO se
 * mockea.
 */

import Fastify from 'fastify';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// supabase mock — los services que el middleware real importa (identity/budget/
// delegation/key-session/receipt/x402-nonce/agent) lo cargan a nivel módulo.
vi.mock('../lib/supabase.js', () => {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder,
    eq: () => builder,
    order: () => Promise.resolve({ data: [], error: null }),
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    insert: () => builder,
    single: () => Promise.resolve({ data: {}, error: null }),
    update: () => builder,
    delete: () => builder,
  });
  return { supabase: { from: () => builder } };
});

// registry mock — expone `getPaymentAdapter` como spy (proxy del adapter de pago
// x402). El resto de getters devuelven stubs mínimos para que el import del
// módulo real del middleware/x402 no rompa.
vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: vi.fn(),
  getChainConfig: vi.fn(),
  getAttestationAdapter: vi.fn(),
  getGaslessAdapter: vi.fn(),
  getIdentityBindingAdapter: vi.fn(),
  initAdapters: vi.fn(),
  _resetRegistry: vi.fn(),
  getAdaptersBundle: vi.fn(() => undefined),
  getInitializedChainKeys: vi.fn(() => []),
  getDefaultChainKey: vi.fn(() => null),
}));

import { getPaymentAdapter } from '../adapters/registry.js';
import agentsRoutes from './agents.js';

const mockGetPaymentAdapter = vi.mocked(getPaymentAdapter);

// x-payment válido (base64) — irrelevante para el resultado (requireA2AKey ni lo
// lee), pero replica el vector real: caller con intención de pago x402.
const X_PAYMENT = Buffer.from(
  JSON.stringify({ scheme: 'exact', network: 'eip155:2368', payload: {} }),
).toString('base64');

const VALID_BODY = {
  name: 'My Weather Agent',
  agentUrl: 'https://api.myweather.example/agent',
  capabilities: ['weather', 'geo'],
  priceUsdc: 0.02,
};

describe('agents routes — auth-only route integration (WKH-173 MNR-3)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(agentsRoutes, { prefix: '/agents' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── T-RT-01 ──────────────────────────────────────────────────────
  it('T-RT-01: POST /agents with x-payment but NO a2a-key → 403 A2A_KEY_REQUIRED, x402 payment adapter NEVER invoked', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { 'x-payment': X_PAYMENT },
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('A2A_KEY_REQUIRED');
    // Vector "dinero-real-perdido": el adapter de pago x402 NUNCA se toca.
    expect(mockGetPaymentAdapter).not.toHaveBeenCalled();
  });
});
