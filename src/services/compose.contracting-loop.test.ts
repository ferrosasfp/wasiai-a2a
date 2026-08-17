/**
 * WKH-360 · SITIOS 3 y 4 del guard anti-bucle.
 *
 *   · SITIO 3 — el loop de `execute`, steps 1..N. 💰 ES GUARD DE DINERO: corta antes
 *     del `budgetService.debit` per-step. Lo que se asserta NO es el rechazo: es
 *     que `debit` se llamó EXACTAMENTE para los steps anteriores y NO para el que
 *     apunta a nosotros. Mutante: `MUT-01` (mover el bloque debajo del débito).
 *
 *   · SITIO 4 — `invokeAgent`, pre-fetch. ⛔ NO ES GUARD DE DINERO (CD-17) y este
 *     archivo no lo presenta como tal. Corre DESPUÉS del débito del step, así que si
 *     dispara ya se cobró y el reembolso es best-effort. Su valor es bloquear la
 *     EMISIÓN, y su test es de ORDEN respecto del `fetch`, más el NIVEL del log
 *     (`error`, no `warn`) — el nivel es parte del contrato porque que esta rama
 *     dispare significa que un guard pre-débito no corrió.
 *
 * Se cuenta lo EJECUTADO, no la condición de un `if`: `debitMock` decrementa un
 * saldo en memoria y `mockFetch` registra cada URL, así que un débito de más o una
 * emisión de más se ven en un número.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2AAgentKeyRow, Agent } from '../types/index.js';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

vi.mock('./registry.js', () => ({
  registryService: { getEnabled: vi.fn().mockResolvedValue([]) },
  SYSTEM_OWNER_REF: 'system',
}));

vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: () => ({ sign: vi.fn(), settle: vi.fn() }),
}));

const mockGetAgent = vi.hoisted(() => vi.fn());
vi.mock('./discovery.js', () => ({
  discoveryService: {
    getAgent: mockGetAgent,
    discover: vi.fn().mockResolvedValue({ agents: [], total: 0 }),
  },
}));

vi.mock('./event.js', () => ({
  eventService: { track: vi.fn().mockResolvedValue({}) },
}));

vi.mock('../lib/downstream-payment.js', () => ({
  signAndSettleDownstream: vi.fn().mockResolvedValue(null),
}));

// El contador de dinero del per-step.
const budgetState = vi.hoisted(() => ({ balance: 100 }));
const debitMock = vi.hoisted(() =>
  vi.fn(async (_k: string, _c: number, amount: number) => {
    budgetState.balance -= amount;
    return { success: true };
  }),
);
vi.mock('./budget.js', () => ({
  budgetService: {
    debit: debitMock,
    credit: vi.fn().mockResolvedValue({ success: true }),
    creditWithDest: vi.fn().mockResolvedValue({ success: true }),
    getBalance: vi.fn(async () => budgetState.balance.toFixed(2)),
  },
}));

// `ssrfFetch` llama al `fetch` de undici, no al global: se rutean los dos al MISMO
// espía para que "no se emitió" sea una afirmación sobre lo ejecutado.
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.stubGlobal('fetch', mockFetch);
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

import { CONTRACTING_LOOP_DETECTED } from '../lib/contracting-chain.js';
import { composeService } from './compose.js';

const SELF = 'gw.wasiai.example';
const ENV_KEYS = ['A2A_SELF_HOSTS', 'BASE_URL', 'A2A_CONTRACTING_DEPTH_MAX'];
const saved: Record<string, string | undefined> = {};

function makeAgent(slug: string, invokeUrl: string, price = 0.01): Agent {
  return {
    id: `id-${slug}`,
    name: slug,
    slug,
    description: 'test',
    capabilities: ['test'],
    priceUsdc: price,
    registry: 'wasiai',
    registry_id: 'wasiai',
    invokeUrl,
    invocationNote: 'gateway-only',
    verified: true,
    status: 'active',
    metadata: {},
  };
}

const keyRow = {
  id: 'k1',
  owner_ref: 'o1',
} as unknown as A2AAgentKeyRow;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.clearAllMocks();
  budgetState.balance = 100;
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ result: 'ok' }),
  });
  // Sin allow-list de SSRF los hosts .example resolverían DNS de verdad; se
  // whitelistean para que el único guard bajo prueba sea el de identidad.
  process.env.DISCOVERY_SSRF_ALLOWLIST = `${SELF},a.example,b.example,c.example`;
});

/** Devuelve las URLs por las que EFECTIVAMENTE salió una invocación. */
function fetchedUrls(): string[] {
  return mockFetch.mock.calls.map((c) => String(c[0]));
}

describe('WKH-360 SITIO 3 — el loop del pipeline corta ANTES del débito per-step', () => {
  it('T-L1-2 (AC-4, CD-3): self en steps[2] de 3 → debit llamado 1 vez (step 1), NO 2', async () => {
    process.env.A2A_SELF_HOSTS = SELF;
    mockGetAgent.mockImplementation(async (slug: string) => {
      if (slug === 'a') return makeAgent('a', 'https://a.example/run');
      if (slug === 'b') return makeAgent('b', 'https://b.example/run');
      if (slug === 'self') return makeAgent('self', `https://${SELF}/compose`);
      return null;
    });

    const result = await composeService.compose({
      steps: [
        { agent: 'a', input: {} },
        { agent: 'b', input: {} },
        { agent: 'self', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      maxBudget: 50,
    });

    // ── EL ORDEN RESPECTO DEL DINERO ────────────────────────────────────
    // compose debita steps 1..N (el guard `i > 0` deja el step-0 al middleware),
    // así que en un pipeline de 3 los débitos posibles son i=1 e i=2. El guard
    // cortó en i=2 ANTES de su débito ⇒ exactamente UNA llamada.
    expect(debitMock).toHaveBeenCalledTimes(1);
    // Y NO se emitió la invocación del step propio.
    expect(fetchedUrls()).not.toContain(`https://${SELF}/compose`);
    expect(fetchedUrls()).toHaveLength(2);

    // El código sale por el `errorCode` CAMEL del resultado del pipeline
    // (familia 3), que es la superficie de este sitio.
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(CONTRACTING_LOOP_DETECTED);
  });

  it('T-L1-2b: self en steps[1] de 3 → CERO débitos y ninguna emisión del step propio', async () => {
    process.env.A2A_SELF_HOSTS = SELF;
    mockGetAgent.mockImplementation(async (slug: string) => {
      if (slug === 'a') return makeAgent('a', 'https://a.example/run');
      if (slug === 'self') return makeAgent('self', `https://${SELF}/compose`);
      if (slug === 'c') return makeAgent('c', 'https://c.example/run');
      return null;
    });

    const result = await composeService.compose({
      steps: [
        { agent: 'a', input: {} },
        { agent: 'self', input: {} },
        { agent: 'c', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      maxBudget: 50,
    });

    expect(debitMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBe(100);
    expect(fetchedUrls()).not.toContain(`https://${SELF}/compose`);
    expect(result.errorCode).toBe(CONTRACTING_LOOP_DETECTED);
  });

  it('T-L1+5 (AC-8, CD-7): pipeline de 5 steps AJENOS → 200, 4 débitos, 5 emisiones', async () => {
    // El gemelo positivo con `MAX_COMPOSE_STEPS` (=5). Sin esto, los dos `it` de
    // arriba no distinguen "el guard corta el bucle" de "rompí el pipeline".
    process.env.A2A_SELF_HOSTS = SELF;
    process.env.DISCOVERY_SSRF_ALLOWLIST = 'a.example';
    mockGetAgent.mockImplementation(async (slug: string) =>
      makeAgent(slug, `https://a.example/${slug}`),
    );

    const result = await composeService.compose({
      steps: [
        { agent: 's0', input: {} },
        { agent: 's1', input: {} },
        { agent: 's2', input: {} },
        { agent: 's3', input: {} },
        { agent: 's4', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      maxBudget: 50,
    });

    expect(result.success).toBe(true);
    expect(result.errorCode).toBeUndefined();
    // 5 steps, débito en i=1..4 (el step-0 lo cobra el middleware) ⇒ 4.
    expect(debitMock).toHaveBeenCalledTimes(4);
    expect(fetchedUrls()).toHaveLength(5);
  });

  it('T-L1+6 (AC-8): sin identidad configurada, el pipeline corre igual', async () => {
    process.env.DISCOVERY_SSRF_ALLOWLIST = 'a.example';
    mockGetAgent.mockImplementation(async (slug: string) =>
      makeAgent(slug, `https://a.example/${slug}`),
    );

    const result = await composeService.compose({
      steps: [
        { agent: 's0', input: {} },
        { agent: 's1', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      maxBudget: 50,
    });

    expect(result.success).toBe(true);
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(fetchedUrls()).toHaveLength(2);
  });
});

describe('WKH-360 SITIO 4 — invokeAgent: bloqueo de EMISIÓN (⛔ NO es guard de dinero)', () => {
  it('T-L1-7 (AC-4, CD-17): destino propio → NO se emite el fetch y se loguea a ERROR', async () => {
    // Se llama `invokeAgent` DIRECTAMENTE, que es el escenario "el Sitio 3 no
    // corrió" sin necesidad de stubearlo: este método es el que un camino futuro
    // podría alcanzar sin pasar por el loop.
    process.env.A2A_SELF_HOSTS = SELF;
    const agent = makeAgent('self', `https://${SELF}/compose`);

    let caught: unknown;
    try {
      await composeService.invokeAgent(agent, { q: 'hi' }, 'secret-a2a-key');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    // La petición saliente NO salió — que es lo único que este sitio garantiza.
    expect(mockFetch).not.toHaveBeenCalled();

    // ── EL NIVEL DEL LOG ES PARTE DEL CONTRATO (CD-17) ──────────────────
    // `error`, no `warn`: que esta rama dispare significa que un guard
    // pre-débito NO corrió, y eso es un defecto a investigar. Si esto fuera
    // `warn` se leería como una condición esperada.
    expect(logSpy.error).toHaveBeenCalled();
    expect(logSpy.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('blocked-at-emission'),
    );
    const msg = String(logSpy.error.mock.calls[0]?.[1] ?? '');
    expect(msg).toContain('blocked-at-emission');
    // El mensaje dice, en el log, que ya se cobró y que el reembolso es
    // best-effort: sin eso, un operador leería este error como "no pasó nada".
    expect(msg).toContain('best-effort');
  });

  it('T-L1+7 (CD-7): destino ajeno → invokeAgent emite normalmente', async () => {
    process.env.A2A_SELF_HOSTS = SELF;
    process.env.DISCOVERY_SSRF_ALLOWLIST = 'otro.example';
    const agent = makeAgent('otro', 'https://otro.example/run');

    const result = await composeService.invokeAgent(agent, { q: 'hi' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.output).toBe('ok');
  });
});
