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
import type { A2AAgentKeyRow, Agent, StepResult } from '../types/index.js';

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
function discovered(
  agents: Agent[],
  // WKH-313: los tres contadores del `excluded` real. Los que no interesan al
  // escenario van en 0 explícito, no ausentes: el resolver los distingue.
  excluded?: Partial<{
    scope: number;
    reputation: number;
    trialAvailable: number;
  }>,
) {
  return {
    agents,
    total: agents.length,
    registries: ['wasiai'],
    ...(excluded
      ? {
          excluded: {
            scope: 0,
            reputation: 0,
            trialAvailable: 0,
            ...excluded,
          },
        }
      : {}),
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

  // ── T-15b (WKH-313 / DT-10) ──────────────────────────────────────────
  it('T-CAPROUTE-08b: el 422 dice si fue el PISO DE REPUTACIÓN, no "no hay agente"', async () => {
    // Éste es el 422 que Chaski recibía en el leg de payout: el agente EXISTE y lo
    // excluye un piso de 2 que no puede alcanzar porque nunca trabajó. Como el
    // motivo volvía como `no_candidates`, el diagnóstico apuntaba al catálogo.
    discoverMock.mockResolvedValue(
      discovered([], { reputation: 1, trialAvailable: 1 }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: {
        steps: [
          {
            capability: 'remittance-payout',
            input: {},
            constraints: { min_reputation: 2 },
          },
        ],
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().reason).toBe('excluded_by_reputation');
    expect(res.json().error).toContain('min_reputation');
    // Y nombra la salida: hay un candidato a un flag de distancia.
    expect(res.json().error).toContain('allow_trial');
  });

  it('T-CAPROUTE-08c: `allow_trial: true` en un step es forma VÁLIDA y llega al pipeline', async () => {
    discoverMock.mockResolvedValue(discovered([makeAgent('nuevo')]));

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: {
        steps: [
          {
            capability: 'remittance-payout',
            input: {},
            constraints: { min_reputation: 2, allow_trial: true },
          },
        ],
      },
    });

    // Sin la clave en el allowlist de forma, esto era 400 `unsupported constraint`.
    expect(res.statusCode).not.toBe(400);
    expect(discoverMock).toHaveBeenCalledWith(
      expect.objectContaining({ minReputation: 2, allowTrial: true }),
    );
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

// ══════════════════════════════════════════════════════════════
// WKH-366 · AC-6 — el pin por slug, nivel N2 (el Coordinador rechaza)
//
// Estos tres corren sobre el middleware de pago REAL (ver el docblock de
// cabecera), que es lo único que permite afirmar "no se cobró" en vez de
// "devolvió 400". Su control positivo —que el impostor GANA cuando el guard no
// corre— vive en `services/capability-resolver.test.ts` (T-B4): sin ése, el
// verde de T-B3 podría venir de que su doble no arma ningún ataque.
// ══════════════════════════════════════════════════════════════

describe('WKH-366 · N2 — una capacidad que autoriza dinero exige agente pinado', () => {
  /**
   * El pool que un tercero puede montar HOY sin permiso de nadie: `verified` es la
   * PRIMERA clave del sort y la AUTO-REPORTA el candidato federado
   * (`services/discovery.ts:577-586`), y `registryService.getEnabled()` no filtra
   * por dueño, así que cualquier owner autenticado aporta candidatos al pool
   * global. Con `verified:true` + `reputation:100` + el precio más bajo posible,
   * este agente gana las tres claves del orden.
   */
  function poolConImpostor() {
    return discovered([
      makeAgent('evil-kyc', {
        capabilities: ['kyc-decision-read'],
        verified: true,
        reputation: 100,
        priceUsdc: 0.000001,
        registry: 'registro-de-un-tercero',
        registry_id: 'registro-de-un-tercero',
      }),
      makeAgent('remit-kyc-decision', {
        capabilities: ['kyc-decision-read'],
        priceUsdc: 0.02,
      }),
    ]);
  }

  it('T-B3: el impostor gana el ranking y aun así NO es consultado — 400 y ni un centavo', async () => {
    // El doble está ARMADO: si el guard no estuviera, `discover` devolvería a
    // `evil-kyc` de cabeza y el pipeline lo invocaría. T-B4 lo demuestra.
    discoverMock.mockResolvedValue(poolConImpostor());
    const balanceBefore = budgetState.balance;

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { steps: [{ capability: 'kyc-decision-read', input: {} }] },
    });

    // Primero lo que NO pasó, que es la afirmación cara (molde T-CAPROUTE-10):
    // el impostor no llegó a existir para este request.
    expect(discoverMock).not.toHaveBeenCalled();
    expect(mockCompose).not.toHaveBeenCalled();
    expect(debitMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBe(balanceBefore);

    // Y recién después el desenlace.
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('capability_requires_pinned_agent');
    expect(res.json().step).toBe(0);
  });

  it('T-B3b: lo mismo para `kyc-session-create`, y el rechazo nombra el step culpable', async () => {
    // La segunda capacidad del set no es una copia decorativa: sin este caso, un
    // arreglo que dejara `AUTHORIZATION_CAPABILITIES` con una sola entrada
    // seguiría verde.
    discoverMock.mockResolvedValue(discovered([makeAgent('evil-session')]));
    const balanceBefore = budgetState.balance;

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: {
        steps: [
          { agent: 'remit-corridor-fx', input: {} },
          { capability: 'kyc-session-create', input: {} },
        ],
      },
    });

    expect(discoverMock).not.toHaveBeenCalled();
    expect(mockCompose).not.toHaveBeenCalled();
    expect(debitMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBe(balanceBefore);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('capability_requires_pinned_agent');
    // El índice del step malo, no el 0 por defecto: un pipeline mixto se rechaza
    // ENTERO y el caller tiene que poder ver cuál arreglar.
    expect(res.json().step).toBe(1);
  });

  it('T-B7: el mismo trabajo PINADO por slug pasa el guard y se invoca normal', async () => {
    // La otra dirección del guard. Sin este caso, un predicado invertido
    // (`!requiresPinnedAgent`) rompería el camino bueno sin poner rojo nada.
    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { steps: [{ agent: 'remit-kyc-decision', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    expect(mockCompose).toHaveBeenCalled();
    // Nombrado por el llamador ⇒ el camino de resolución por capacidad no corre.
    expect(discoverMock).not.toHaveBeenCalled();
    const executed = mockCompose.mock.calls[0]?.[0];
    expect(executed?.steps[0]?.agent).toBe('remit-kyc-decision');
  });

  it('T-B7b: el guard NO mira `step.agent` — pinar un slug AJENO es legítimo y corre', async () => {
    // Escrito en el docblock del guard y medido acá: lo que se prohíbe es
    // DELEGAR LA ELECCIÓN, no elegir mal a propósito. Un guard que además
    // exigiera un slug de una allowlist sería otro contrato, y no es éste.
    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { steps: [{ agent: 'evil-kyc', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    expect(mockCompose).toHaveBeenCalled();
  });

  it('T-B8: el guard corre PRE-PAGO — ni débito ni lookup de la credencial', async () => {
    // Lo que mata la mutación "mover el guard al route handler": allá el
    // middleware de pago YA CORRIÓ, así que `lookupByHash` tendría 1 llamada y
    // el débito del step-0 habría salido. El contador es la afirmación; el
    // status no distingue las dos posiciones.
    discoverMock.mockResolvedValue(poolConImpostor());
    const balanceBefore = budgetState.balance;

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { steps: [{ capability: 'kyc-decision-read', input: {} }] },
    });

    expect(lookupByHashMock).not.toHaveBeenCalled();
    expect(debitMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBe(balanceBefore);
    expect(res.statusCode).toBe(400);
  });

  it('T-B9: la mayúscula no es un bypass — `KYC-Decision-Read` se rechaza igual', async () => {
    // `requiresPinnedAgent` normaliza con el MISMO `normalize` que
    // `classifyCapability`. Sin eso el guard se esquiva cambiando una letra.
    discoverMock.mockResolvedValue(poolConImpostor());

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { steps: [{ capability: '  KYC-Decision-Read ', input: {} }] },
    });

    expect(discoverMock).not.toHaveBeenCalled();
    expect(debitMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('capability_requires_pinned_agent');
  });

  it('T-B10: una capacidad PREEXISTENTE de KYC sigue resolviéndose por ranking (CD-18)', async () => {
    // El alcance del set, medido en la dirección que importa: cerrar de más
    // rompería con 400 a consumidores externos que este repo no puede enumerar.
    // `kyc-verification` es preexistente ⇒ NO entra al set ⇒ sigue funcionando.
    discoverMock.mockResolvedValue(
      discovered([makeAgent('remit-kyc-validator')]),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: { steps: [{ capability: 'kyc-verification', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    expect(discoverMock).toHaveBeenCalled();
    expect(mockCompose).toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════
// WKH-366 · el campo del RESPONSE del que cuelga un guard de OTRO repo
// ══════════════════════════════════════════════════════════════

/**
 * `steps[i].agent.invokeUrl` es CONTRATO PUBLICADO de `POST /compose`, no un
 * detalle interno del envelope. Este bloque existe porque hasta el fix-pack del
 * CR (MNR-5) **nada en este repo lo fijaba**: medido, `grep "agent.invokeUrl"
 * src/routes/compose*.test.ts` daba **0 hits** y `doc/INTEGRATION.md` no lo
 * nombraba. El campo viajaba sólo porque el handler responde `...result` sin
 * proyectar.
 *
 * ⚠️ NO RE-CORRAS ESE GREP ESPERANDO UN 0: hoy devuelve hits, y parte de ellos
 * **son este docblock**, que escribe el literal para poder contar la medición.
 * La lectura que NO se cuenta a sí misma: en los demás `compose*.test.ts` sigue
 * habiendo cero (medido: cero en cada uno), y en éste lo que no es prosa son el
 * título del `describe` y las aserciones de T-B11. Escribir acá el cardinal lo
 * habría vuelto falso la frase siguiente — pasó, y por eso se cuenta el
 * criterio y no el total.
 *
 * ── QUIÉN LO CONSUME Y PARA QUÉ ───────────────────────────────────────────
 *
 * `chaski-v3` lo lee en `src/infrastructure/a2a/gateway-client.ts:308-313`
 * (`readInvokeUrl`), lo publica en un arreglo PARALELO `invokeUrls[]` — aparte
 * de `agents[]` a propósito, porque `agents[]` se ecoa al browser y esta URL no
 * puede salir por HTTP — y lo usa en
 * `src/infrastructure/kyc/gateway-kyc-client.ts:235`:
 *
 *     if (!sameOrigin(r.invokeUrls[0], expectedAgentBaseUrl())) → rechaza
 *
 * Es el TERCER nivel del pin anti-suplantación de esta HU: el que comprueba que
 * el veredicto de KYC que va a autorizar un desembolso lo firmó **nuestro**
 * agente y no un tercero que ganó el ranking declarándose `verified: true`. Los
 * otros dos niveles (el `agent` pinado en el body y el guard N2 de más arriba)
 * viven en el pedido; éste es el único que mira la EJECUCIÓN.
 *
 * ── EL MODO DE FALLA QUE ESTE TEST EXISTE PARA CAZAR ──────────────────────
 *
 * Que alguien acá proyecte `agent` en la respuesta para no filtrar la URL
 * interna del agente. **Es un endurecimiento razonable, y Chaski tuvo ese
 * incidente exacto en esta misma HU** (por eso su lector vive aparte). Hecho de
 * este lado, el efecto es: `readInvokeUrl` devuelve `null` ⇒ `sameOrigin(null,…)`
 * es falso ⇒ **todos** los desembolsos por gateway contestan 502
 * `agent_origin_mismatch`… y los gates de los DOS repos quedan en verde, porque
 * ninguno mide el cable. Es la clase «una capacidad que cruza servicios no
 * existe hasta que los DOS la reconocen», que en este ecosistema ya costó 8 días
 * de caída.
 *
 * ⚠️ LO QUE ESTE TEST **NO** MIDE, para que nadie se apoye de más en su verde:
 *
 *  (a) **Que el service POBLE el campo.** Como todas las suites de esta ruta
 *      —las 9, medido—, ésta moquea `services/compose.js`, así que lo que se
 *      ejercita es el paso del resultado por el handler HTTP: la proyección de
 *      `routes/compose.ts`, que es justo donde el mutante de arriba entraría. La
 *      otra mitad tiene candado de COMPILACIÓN, no de test: `StepResult.agent`
 *      es `Agent` y `Agent.invokeUrl` es `string` NO opcional
 *      (`src/types/index.ts`), y el fixture de acá se tipa `StepResult` a
 *      propósito para heredarlo — volverlo `Partial` o un literal suelto
 *      desactivaría esa mitad en silencio.
 *  (b) **Que Chaski lo consuma bien.** Ningún test de este repo puede verlo. Del
 *      otro lado el testigo es `gateway-client.test.ts` + `agent-origin.test.ts`.
 *  (c) **Las tres citas cross-repo de arriba.** Este archivo no está en
 *      `CORTE_A_PATHS` (`test/cited-lines-guard.citations.ts:87-101`), y aunque
 *      lo estuviera, ese guardián sólo mira rutas de ESTE repo. Los números son
 *      del 2026-08-26 y envejecen sin que nada se ponga rojo; lo que no envejece
 *      son los símbolos (`readInvokeUrl`, `sameOrigin`, `invokeUrls`).
 */
describe('WKH-366 · `steps[].agent.invokeUrl` es contrato publicado', () => {
  /** Un step YA EJECUTADO, tipado para heredar el candado de compilación. */
  function ejecutado(slug: string): StepResult {
    return { agent: makeAgent(slug), output: {}, costUsdc: 1, latencyMs: 1 };
  }

  it('T-B11: el 200 de `/compose` trae la `invokeUrl` de CADA step ejecutado', async () => {
    // DOS steps y no uno: una proyección que preservara sólo el primero —o que
    // se aplicara a partir del segundo— pasaría un test de un solo step.
    mockCompose.mockResolvedValue({
      success: true,
      output: {},
      steps: [ejecutado('remit-kyc-session'), ejecutado('remit-kyc-decision')],
      totalCostUsdc: 2,
      totalLatencyMs: 2,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: KEY_HEADER,
      payload: {
        steps: [
          { agent: 'remit-kyc-session', input: {} },
          { agent: 'remit-kyc-decision', input: {} },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // El VALOR, no sólo la presencia: un `""` o un placeholder pasarían un
    // `toBeDefined()` y del otro lado `readInvokeUrl` los trata como ausencia.
    expect(body.steps[0].agent.invokeUrl).toBe(
      'https://x.test/remit-kyc-session',
    );
    expect(body.steps[1].agent.invokeUrl).toBe(
      'https://x.test/remit-kyc-decision',
    );
  });
});
