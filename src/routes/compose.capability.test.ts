/**
 * HU-208 — `/compose` con steps declarados por CAPACIDAD, end-to-end de la ruta.
 *
 * POR QUÉ ESTE ARCHIVO CORRE EL MIDDLEWARE DE PAGO REAL: el hermano
 * `compose.test.ts` moquea `requirePaymentOrA2AKey` con un pass-through que
 * NUNCA debita, así que no puede observar un cobro. Acá corre el middleware de
 * verdad sobre un balance en memoria, que es lo único que permite afirmar "no se
 * cobró" en vez de sólo "devolvió 422". Mismo patrón que
 * `compose.no-charge-on-validation-error.test.ts`.
 *
 * Las dos direcciones de cada guard:
 *   · la capacidad RESUELVE  → se elige el mejor por el criterio, se cotiza y se
 *     ejecuta ESE agente;
 *   · la capacidad NO RESUELVE → 4xx, y nada se ejecuta NI se cobra.
 *
 * Naming: T-CAPROUTE-01..T-CAPROUTE-10.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
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
import type { A2AAgentKeyRow, Agent } from '../types/index.js';

vi.mock('../lib/logger.js', () => ({
  getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

vi.mock('../adapters/chain-resolver.js', async (orig) => {
  const actual = await orig<typeof import('../adapters/chain-resolver.js')>();
  return { ...actual, resolveChainKey: () => 'kite' };
});
vi.mock('../adapters/registry.js', () => ({
  getDefaultChainKey: () => 'kite',
  getInitializedChainKeys: () => ['kite'],
  getAdaptersBundle: () => ({
    chainConfig: { chainId: 2368 },
    payment: { supportedTokens: [{ symbol: 'USDC' }] },
  }),
}));

vi.mock('../services/agent-price.js', () => ({
  resolveAgentPriceUsdc: vi.fn(),
  resolveAgentDestination: vi.fn().mockResolvedValue(null),
}));

vi.mock('../services/compose.js', () => ({
  composeService: { compose: vi.fn() },
}));

// El pool de candidatos que ve la resolución por capacidad.
const discoverMock = vi.hoisted(() => vi.fn());
vi.mock('../services/discovery.js', () => ({
  discoveryService: { discover: discoverMock, getAgent: vi.fn() },
}));

const fundedKey = vi.hoisted(
  (): A2AAgentKeyRow =>
    ({
      id: 'k1',
      owner_ref: 'o1',
      key_hash: 'hash',
      display_name: null,
      budget: { '2368': '10.00' },
      daily_limit_usd: null,
      daily_spent_usd: '0',
      daily_reset_at: new Date(Date.now() + 86_400_000).toISOString(),
      allowed_registries: null,
      allowed_agent_slugs: null,
      allowed_categories: null,
      max_spend_per_call_usd: null,
      is_active: true,
      last_used_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      erc8004_identity: null,
      kite_passport: null,
      agentkit_wallet: null,
      funding_wallet: null,
      metadata: {},
      require_signature: false,
    }) as A2AAgentKeyRow,
);
const keyState = vi.hoisted(() => ({ row: null as A2AAgentKeyRow | null }));
const lookupByHashMock = vi.hoisted(() => vi.fn(async () => keyState.row));
vi.mock('../services/identity.js', () => ({
  isIdentityVerified: () => false,
  identityService: { lookupByHash: lookupByHashMock },
}));

const budgetState = vi.hoisted(() => ({ balance: 10 }));
const debitMock = vi.hoisted(() =>
  vi.fn(async (_k: string, _c: number, amountUsd: number) => {
    budgetState.balance -= amountUsd;
    return { success: true };
  }),
);
vi.mock('../services/budget.js', () => ({
  budgetService: {
    debit: debitMock,
    getBalance: vi.fn(async () => budgetState.balance.toFixed(2)),
    credit: vi.fn(async (_k: string, _c: number, amountUsd: number) => {
      budgetState.balance += amountUsd;
      return { success: true, reverted: true };
    }),
    creditWithDest: vi
      .fn()
      .mockResolvedValue({ success: true, reverted: true }),
    creditDelegation: vi
      .fn()
      .mockResolvedValue({ success: true, reverted: true }),
    creditSession: vi.fn().mockResolvedValue({ success: true, reverted: true }),
  },
}));

vi.mock('../services/receipt.js', () => ({
  receiptService: { emit: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../services/refund-outbox.js', () => ({
  refundOutbox: { enqueueRefund: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../middleware/rate-limit.js', () => ({
  orchestrateRateLimit: () => false,
}));
vi.mock('../middleware/timeout.js', () => ({
  createTimeoutHandler:
    () => async (_r: FastifyRequest, _p: FastifyReply) => {},
}));

import { resolveAgentPriceUsdc } from '../services/agent-price.js';
import { composeService } from '../services/compose.js';
import composeRoutes from './compose.js';

const mockResolvePrice = vi.mocked(resolveAgentPriceUsdc);
const mockCompose = vi.mocked(composeService.compose);
const KEY_HEADER = { 'x-a2a-key': 'wasi_a2a_funded_master_key' };
const STEP0_PRICE = 0.5;

function makeAgent(slug: string, over: Partial<Agent> = {}): Agent {
  return {
    id: slug,
    name: slug,
    slug,
    description: '',
    capabilities: ['fx-quote'],
    priceUsdc: 1,
    registry: 'wasiai',
    registry_id: 'wasiai',
    invokeUrl: `https://x.test/${slug}`,
    invocationNote: '',
    verified: false,
    status: 'active',
    metadata: {},
    ...over,
  };
}

/** Respuesta de `discover` con el conjunto YA ordenado (como lo entrega el pipeline). */
function discovered(agents: Agent[], excluded?: { scope: number }) {
  return {
    agents,
    total: agents.length,
    registries: ['wasiai'],
    ...(excluded ? { excluded } : {}),
  };
}

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  app = Fastify();
  await app.register(composeRoutes, { prefix: '/compose' });
  await app.ready();
});
afterAll(() => app.close());

beforeEach(() => {
  vi.clearAllMocks();
  budgetState.balance = 10;
  keyState.row = { ...fundedKey };
  mockResolvePrice.mockResolvedValue(STEP0_PRICE);
  mockCompose.mockResolvedValue({
    success: true,
    output: {},
    steps: [],
    totalCostUsdc: STEP0_PRICE,
    totalLatencyMs: 1,
  });
});

// ══════════════════════════════════════════════════════════════
// La capacidad RESUELVE
// ══════════════════════════════════════════════════════════════

describe('HU-208 · una capacidad que resuelve', () => {
  it('T-CAPROUTE-01: elige el MEJOR por el criterio, no el primero del arreglo', async () => {
    // Armado para que NO pase por casualidad: hay tres candidatos y el mejor
    // está ÚLTIMO. Discovery entrega la lista ya ordenada (verified primero),
    // así que el ganador es 'premium'. Si la ruta tomara "el primero que
    // aparece" del arreglo crudo, elegiría 'barato-1'.
    discoverMock.mockResolvedValue(
      discovered([
        makeAgent('premium', { verified: true, priceUsdc: 3 }),
        makeAgent('barato-1', { priceUsdc: 0.2 }),
        makeAgent('barato-2', { priceUsdc: 0.1 }),
      ]),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { steps: [{ capability: 'fx-quote', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    // El pipeline que se EJECUTA lleva el agente resuelto...
    const executed = mockCompose.mock.calls[0]?.[0];
    expect(executed?.steps[0]?.agent).toBe('premium');
    expect(executed?.steps[0]?.registry).toBe('wasiai');
    // ...y el precio se cotizó sobre ESE mismo agente (el que se debita).
    expect(mockResolvePrice).toHaveBeenCalledWith('premium', 'wasiai');
  });

  it('T-CAPROUTE-02: el agente resuelto queda registrado en el step (procedencia)', async () => {
    discoverMock.mockResolvedValue(discovered([makeAgent('elegido')]));

    await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { steps: [{ capability: 'fx-quote', input: {} }] },
    });

    const executed = mockCompose.mock.calls[0]?.[0];
    expect(executed?.steps[0]?.resolvedFrom).toEqual({
      capability: 'fx-quote',
    });
  });

  it('T-CAPROUTE-03: se resuelve UNA sola vez — el ejecutor recibe slug, nunca la capacidad', async () => {
    // La garantía central del precio: si `capability` sobreviviera hasta
    // `composeService`, la resolución correría por SEGUNDA vez, ya cobrado el
    // step-0, y podría devolver otro agente.
    discoverMock.mockResolvedValue(discovered([makeAgent('unico')]));

    await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: {
        steps: [
          { capability: 'fx-quote', input: {} },
          { capability: 'fx-quote', input: {} },
        ],
      },
    });

    const executed = mockCompose.mock.calls[0]?.[0];
    for (const step of executed?.steps ?? []) {
      expect(typeof step.agent).toBe('string');
    }
    // Dos steps con la MISMA capacidad → un solo discover (memo por request) y
    // el mismo agente en ambos: el pipeline no puede quedar inconsistente.
    expect(discoverMock).toHaveBeenCalledTimes(1);
    expect(executed?.steps[0]?.agent).toBe(executed?.steps[1]?.agent);
  });

  it('T-CAPROUTE-04: el alcance de la credencial recorta los candidatos (WAS-187 AC-7)', async () => {
    keyState.row = { ...fundedKey, allowed_agent_slugs: ['permitido'] };
    discoverMock.mockResolvedValue(discovered([makeAgent('permitido')]));

    await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { steps: [{ capability: 'fx-quote', input: {} }] },
    });

    // El alcance viaja a discovery como filtro PRE-SORT, con la fila efectiva
    // de la key del llamador (no un shape propio): así el predicado del selector
    // es el MISMO que el del ejecutor.
    const q = discoverMock.mock.calls[0]?.[0];
    expect(q.scope?.allowed_agent_slugs).toEqual(['permitido']);
  });
});

// ══════════════════════════════════════════════════════════════
// La capacidad NO resuelve — 4xx, y NADA se ejecuta ni se cobra
// ══════════════════════════════════════════════════════════════

describe('HU-208 · una capacidad que no resuelve', () => {
  it('T-CAPROUTE-05: 422 `no_agent_match` y el balance NO se mueve', async () => {
    discoverMock.mockResolvedValue(discovered([]));
    const balanceBefore = budgetState.balance;

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { steps: [{ capability: 'no-existe', input: {} }] },
    });

    // LAS ASERCIONES DE DINERO PRIMERO — el status por sí solo no prueba nada.
    expect(budgetState.balance).toBe(balanceBefore);
    expect(debitMock).not.toHaveBeenCalled();
    // Nada se ejecutó...
    expect(mockCompose).not.toHaveBeenCalled();
    // ...y ni siquiera se llegó a cotizar: el 422 corta ANTES del preHandler de
    // precio y por lo tanto antes del middleware de pago.
    expect(mockResolvePrice).not.toHaveBeenCalled();

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('no_agent_match');
    expect(res.json().capability).toBe('no-existe');
    expect(res.json().step).toBe(0);
  });

  it('T-CAPROUTE-06: NUNCA cae a un agente arbitrario cuando la capacidad no matchea', async () => {
    // El anti-patrón que esta HU no replica del lado del servidor: si no
    // encuentra lo pedido, elegir el primero de la lista. Acá hay candidatos en
    // el catálogo pero el conjunto FILTRADO vino vacío.
    discoverMock.mockResolvedValue(discovered([]));

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { steps: [{ capability: 'no-existe', input: {} }] },
    });

    expect(res.statusCode).toBe(422);
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('T-CAPROUTE-07: un pipeline a medias NO se ejecuta (falla el step 1 de 2)', async () => {
    // El step 0 resuelve bien y el 1 no. Si el corte no fuera atómico, el
    // pipeline arrancaría y settlearía el prefijo válido antes de morir.
    discoverMock.mockImplementation(async (q: { capabilities?: string[] }) =>
      q.capabilities?.[0] === 'buena'
        ? discovered([makeAgent('ok')])
        : discovered([]),
    );
    const balanceBefore = budgetState.balance;

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: {
        steps: [
          { capability: 'buena', input: {} },
          { capability: 'mala', input: {} },
        ],
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().step).toBe(1);
    expect(budgetState.balance).toBe(balanceBefore);
    expect(debitMock).not.toHaveBeenCalled();
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('T-CAPROUTE-08: el 422 dice si fue el ALCANCE, no un "no hay agente" a secas', async () => {
    discoverMock.mockResolvedValue(discovered([], { scope: 2 }));

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { steps: [{ capability: 'fx-quote', input: {} }] },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().reason).toBe('excluded_by_scope');
    expect(res.json().error).toContain("key's scope");
  });
});

// ══════════════════════════════════════════════════════════════
// Compatibilidad y ambigüedad
// ══════════════════════════════════════════════════════════════

describe('HU-208 · compatibilidad con el contrato de siempre', () => {
  it('T-CAPROUTE-09: un step con `agent` explícito funciona idéntico y NO dispara discovery', async () => {
    // La propiedad de back-compat más fuerte que se puede afirmar: el camino
    // nuevo está gateado en la presencia de `capability`, así que un llamador de
    // los de hoy no paga ni una query extra.
    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { steps: [{ agent: 'kyc', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    expect(discoverMock).not.toHaveBeenCalled();
    // Y NI SIQUIERA se lee el alcance de la credencial: el camino nuevo entero
    // está gateado en la presencia de `capability`. El único lookup es el del
    // middleware de pago, el de siempre. Sin esta aserción, quitar el gate no
    // rompería ningún test aunque agregara una query por request (mutación M5).
    expect(lookupByHashMock).toHaveBeenCalledTimes(1);
    const executed = mockCompose.mock.calls[0]?.[0];
    expect(executed?.steps[0]?.agent).toBe('kyc');
    // Sin procedencia: no lo eligió el gateway.
    expect(executed?.steps[0]?.resolvedFrom).toBeUndefined();
    expect(mockResolvePrice).toHaveBeenCalledWith('kyc', undefined);
  });

  it('T-CAPROUTE-10: `agent` + `capability` → 400 `ambiguous_step`, sin cobrar', async () => {
    const balanceBefore = budgetState.balance;

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: {
        steps: [{ agent: 'kyc', capability: 'fx-quote', input: {} }],
      },
    });

    expect(budgetState.balance).toBe(balanceBefore);
    expect(debitMock).not.toHaveBeenCalled();
    expect(mockCompose).not.toHaveBeenCalled();
    expect(discoverMock).not.toHaveBeenCalled();

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('ambiguous_step');
  });
});

// ══════════════════════════════════════════════════════════════
// Defense-in-depth: nada sin resolver llega al ejecutor
// ══════════════════════════════════════════════════════════════

describe('HU-208 · guard de "nada se ejecuta sin resolver"', () => {
  it('T-CAPROUTE-11: un step que quedó sin `agent` NO se ejecuta y SE REEMBOLSA', async () => {
    // Esta rama es inalcanzable por construcción (el tipo `ResolvedComposeStep`
    // la vuelve un error de compilación, y el resolver siempre completa el
    // `agent`). Se la alcanza acá forzando al resolver a devolver un agente sin
    // slug — la forma más cercana a "alguien reordenó la cadena de preHandlers"
    // que se puede montar sin romper el tipo.
    //
    // Lo que se afirma no es sólo el 400: es que el débito del step-0 VUELVE. Un
    // 400 después del middleware de pago sin reembolso es "cobrado por nada", el
    // modo de fallo contra el que este archivo viene endurecido.
    discoverMock.mockResolvedValue(
      discovered([makeAgent(undefined as unknown as string)]),
    );
    const balanceBefore = budgetState.balance;

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { steps: [{ capability: 'fx-quote', input: {} }] },
    });

    expect(res.statusCode).toBe(400);
    expect(mockCompose).not.toHaveBeenCalled();
    // Débito aplicado y devuelto → neto cero. Sin el `refundComposeStep0` del
    // guard, el balance quedaría en `balanceBefore - STEP0_PRICE`.
    expect(budgetState.balance).toBe(balanceBefore);
  });
});
