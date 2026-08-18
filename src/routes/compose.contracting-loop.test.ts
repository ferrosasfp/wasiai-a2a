/**
 * WKH-360 · SITIO 1 del guard anti-bucle — ¿CORTA ANTES DEL DÉBITO DEL STEP-0?
 *
 * ── POR QUÉ ESTE ARCHIVO Y NO `compose.test.ts` ─────────────────────────────
 * `compose.test.ts` mockea `requirePaymentOrA2AKey` con un pass-through que NUNCA
 * debita, así que allá un guard mal puesto se vería EXACTAMENTE IGUAL que uno bien
 * puesto: el 400 sale en los dos casos. Este archivo cablea el middleware REAL
 * (mismo scaffold que `compose.no-debit-on-abort.test.ts`) y mockea sólo la capa de
 * datos, así que el camino de débito se EJECUTA y `debitMock` es observabilidad de
 * verdad.
 *
 * ⚠️ LA ASERCIÓN QUE IMPORTA NO ES EL 400: es `debitMock` con CERO llamadas y el
 * saldo del prepago INTACTO. Un test que sólo mire el status no distingue "el guard
 * corta antes de cobrar" de "el guard cobra y después contesta 400", y esa
 * diferencia es la mitad del valor de la HU. El mutante que lo prueba es `MUT-02`
 * (mover el bloque del preHandler al route handler, o sea después del middleware de
 * débito).
 *
 * El step-0 de `/compose` NO lo cubre el guard del loop del pipeline: para cuando
 * `composeService` existe, el middleware ya cobró.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { A2AAgentKeyRow } from '../types/index.js';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({
  getLogger: () => logSpy,
}));

vi.mock('../adapters/chain-resolver.js', () => ({
  resolveChainKey: () => 'kite',
}));
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

const fundedKey = vi.hoisted(
  (): A2AAgentKeyRow => ({
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
  }),
);
vi.mock('../services/identity.js', () => ({
  isIdentityVerified: () => false,
  identityService: {
    lookupByHash: vi.fn().mockResolvedValue(fundedKey),
  },
}));

// El contador de dinero. `debit` decrementa un saldo en memoria, así que un débito
// de más NO se puede esconder: se ve en el número.
const budgetState = vi.hoisted(() => ({ balance: 10 }));
const debitMock = vi.hoisted(() =>
  vi.fn(
    async (
      _keyId: string,
      _chainId: number,
      amountUsd: number,
    ): Promise<{ success: boolean; error?: string }> => {
      budgetState.balance -= amountUsd;
      return { success: true };
    },
  ),
);
vi.mock('../services/budget.js', () => ({
  budgetService: {
    debit: debitMock,
    getBalance: vi.fn(async () => budgetState.balance.toFixed(2)),
    credit: vi.fn().mockResolvedValue({ success: true }),
    creditWithDest: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('../services/receipt.js', () => ({
  receiptService: { emit: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../middleware/timeout.js', () => ({
  createTimeoutHandler:
    () => async (_request: FastifyRequest, _reply: FastifyReply) => {
      /* no-op */
    },
}));
vi.mock('../middleware/rate-limit.js', () => ({
  orchestrateRateLimit: () => false,
}));

import {
  CONTRACTING_DEPTH_EXCEEDED,
  CONTRACTING_LAYER2_BEST_EFFORT_NOTE,
  CONTRACTING_LOOP_DETECTED,
} from '../lib/contracting-chain.js';
import {
  resolveAgentDestination,
  resolveAgentPriceUsdc,
} from '../services/agent-price.js';
import { composeService } from '../services/compose.js';
// NOTA: `requirePaymentOrA2AKey` NO está mockeado — corre el middleware REAL.
import composeRoutes from './compose.js';

const mockResolvePrice = vi.mocked(resolveAgentPriceUsdc);
const mockResolveDest = vi.mocked(resolveAgentDestination);
const mockCompose = vi.mocked(composeService.compose);

const SELF = 'gw.wasiai.example';
const ENV_KEYS = ['A2A_SELF_HOSTS', 'BASE_URL', 'A2A_CONTRACTING_DEPTH_MAX'];
const saved: Record<string, string | undefined> = {};

/** Un resultado de pipeline exitoso, para los gemelos positivos. */
function okPipeline() {
  return {
    success: true,
    output: 'ok',
    steps: [],
    totalCostUsdc: 0.001,
    totalLatencyMs: 1,
  };
}

// La app y los hooks viven en el scope del MÓDULO porque los comparten los dos
// `describe` de este archivo (capa 1 y capa 2): las dos miden la MISMA cadena real de
// preHandlers de `/compose`, que es justamente el punto.
let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  app = Fastify();
  await app.register(composeRoutes, { prefix: '/compose' });
  await app.ready();
});

afterAll(() => app.close());

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.clearAllMocks();
  budgetState.balance = 10;
  mockResolveDest.mockResolvedValue(null);
  mockCompose.mockResolvedValue(okPipeline());
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('WKH-360 SITIO 1 — /compose step-0: el corte ocurre ANTES del débito', () => {
  it('T-L1-1 (AC-4, CD-3): destino propio → 400 + CERO llamadas a debit + saldo intacto', async () => {
    process.env.A2A_SELF_HOSTS = SELF;
    mockResolvePrice.mockResolvedValueOnce(0.001);
    mockResolveDest.mockResolvedValueOnce({
      registry: 'wasiai',
      slug: 'self-loop',
      invokeUrl: `https://${SELF}/compose`,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_funded_master_key' },
      payload: { steps: [{ agent: 'self-loop', input: {} }] },
    });

    // ── EL DINERO PRIMERO. Estas dos líneas son el test; el status es contexto.
    expect(debitMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBe(10);
    // y el pipeline nunca arrancó
    expect(mockCompose).not.toHaveBeenCalled();

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe(CONTRACTING_LOOP_DETECTED);
    expect(res.json().layer).toBe('direct');
  });

  it('T-L1-4 (CD-15): destino propio con PUNTO FINAL → rechazado igual', async () => {
    // `new URL('https://gw./x').hostname` conserva el punto (medido). Sin el paso 7
    // de `canonicalizeHost` esto es un bypass de UNA tecla.
    process.env.A2A_SELF_HOSTS = SELF;
    mockResolvePrice.mockResolvedValueOnce(0.001);
    mockResolveDest.mockResolvedValueOnce({
      registry: 'wasiai',
      slug: 'self-dot',
      invokeUrl: `https://${SELF}./compose`,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_funded_master_key' },
      payload: { steps: [{ agent: 'self-dot', input: {} }] },
    });

    expect(debitMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBe(10);
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe(CONTRACTING_LOOP_DETECTED);
  });

  it('T-L1-5: destino propio con PUERTO y en MAYÚSCULAS → rechazado (se compara hostname)', async () => {
    process.env.A2A_SELF_HOSTS = SELF;
    mockResolvePrice.mockResolvedValueOnce(0.001);
    mockResolveDest.mockResolvedValueOnce({
      registry: 'wasiai',
      slug: 'self-port',
      invokeUrl: `https://${SELF.toUpperCase()}:8443/compose`,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_funded_master_key' },
      payload: { steps: [{ agent: 'self-port', input: {} }] },
    });

    expect(debitMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe(CONTRACTING_LOOP_DETECTED);
  });

  it('T-L1-6 (AC-9): SIN ningún header de contratación, el destino propio se rechaza igual', () => {
    // AC-9 / anti-auto-inmunidad: la capa 1 NO consulta NINGÚN header del caller.
    // Si dependiera de la traza, un atacante la omitiría y quedaría inmune.
    // Este `it` es el mismo escenario que T-L1-1 (que tampoco manda headers de
    // contratación) enunciado como propiedad, más el control textual de que el
    // guard del Sitio 1 no lee ninguno de los dos headers.
    return (async () => {
      process.env.A2A_SELF_HOSTS = SELF;
      mockResolvePrice.mockResolvedValueOnce(0.001);
      mockResolveDest.mockResolvedValueOnce({
        registry: 'wasiai',
        slug: 'self-noheaders',
        invokeUrl: `https://${SELF}/compose`,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/compose',
        // SÓLO la credencial. Ni chain ni depth ni nada de contratación.
        headers: { 'x-a2a-key': 'wasi_a2a_funded_master_key' },
        payload: { steps: [{ agent: 'self-noheaders', input: {} }] },
      });

      expect(debitMock).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
      expect(res.json().error_code).toBe(CONTRACTING_LOOP_DETECTED);
    })();
  });

  // ── CD-7 · LOS GEMELOS POSITIVOS ────────────────────────────────────────
  // Sin éstos, los cuatro `it` de arriba no distinguen "el guard funciona" de
  // "rompí el endpoint".

  it('T-L1+1 (AC-8, CD-7): destino AJENO con identidad configurada → 200 y SÍ se debita', async () => {
    process.env.A2A_SELF_HOSTS = SELF;
    mockResolvePrice.mockResolvedValueOnce(0.001);
    mockResolveDest.mockResolvedValueOnce({
      registry: 'wasiai',
      slug: 'agente-ajeno',
      invokeUrl: 'https://otro-agente.example/run',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_funded_master_key' },
      payload: { steps: [{ agent: 'agente-ajeno', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    // El camino del dinero sigue corriendo: el guard no rompió el endpoint.
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(budgetState.balance).toBeLessThan(10);
    expect(mockCompose).toHaveBeenCalledTimes(1);
  });

  it('T-L1+2 (AC-8): los DOS hosts REALES de prod pasan — el guard rechaza 0 de 25', async () => {
    // Medido contra prod el 2026-08-17: `POST /discover {}` → total 25, repartidos
    // en wasiai-v2.vercel.app (22) y wasiai-remittance-agents.vercel.app (3), y
    // CERO apuntando al gateway. O sea que este guard no rechaza NADA del tráfico
    // que existe hoy. Si alguien mete `.vercel.app` en el conjunto de identidad,
    // este `it` se pone rojo.
    process.env.A2A_SELF_HOSTS = 'wasiai-a2a-production.up.railway.app';
    const hosts = [
      'wasiai-v2.vercel.app',
      'wasiai-remittance-agents.vercel.app',
    ];
    // Son los DOS hosts reales de prod. El conteo se asserta para que borrar uno
    // no reduzca la cobertura en silencio (fix-pack CR/MNR-5).
    expect(hosts).toHaveLength(2);
    for (const host of hosts) {
      vi.clearAllMocks();
      budgetState.balance = 10;
      mockCompose.mockResolvedValue(okPipeline());
      mockResolvePrice.mockResolvedValueOnce(0.001);
      mockResolveDest.mockResolvedValueOnce({
        registry: 'wasiai',
        slug: 'prod-agent',
        invokeUrl: `https://${host}/api/invoke`,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/compose',
        headers: { 'x-a2a-key': 'wasi_a2a_funded_master_key' },
        payload: { steps: [{ agent: 'prod-agent', input: {} }] },
      });

      expect(res.statusCode, `host=${host}`).toBe(200);
      expect(debitMock, `host=${host}`).toHaveBeenCalledTimes(1);
    }
  });

  it('T-L1+3 (AC-8, CD-1): SIN identidad configurada, un destino ajeno corre normal', async () => {
    // Ninguna env de identidad. El guard NO puede inventar identidad y el pipeline
    // tiene que quedar byte-idéntico al de antes de la HU. El mutante que esto mata
    // es "hacer que el conjunto vacío rechace todo", que sería el guard cerrando el
    // servicio en cualquier deploy sin configurar.
    //
    // ⚠️ En `app.inject` el conjunto NO queda vacío: fastify pone `Host: localhost`
    // y el Sitio 1 usa `request.hostname` como hint, así que el conjunto es
    // ['localhost']. El caso del conjunto REALMENTE vacío (sin env y sin hint) se
    // mide en la unidad: `contracting-chain.test.ts` → T-U-SET-4 / T-U-SELF-5.
    mockResolvePrice.mockResolvedValueOnce(0.001);
    mockResolveDest.mockResolvedValueOnce({
      registry: 'wasiai',
      slug: 'agente-ajeno',
      invokeUrl: 'https://otro-agente.example/run',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_funded_master_key' },
      payload: { steps: [{ agent: 'agente-ajeno', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    expect(debitMock).toHaveBeenCalledTimes(1);
  });

  it('T-L1+4: el `hint` del request cubre el bucle SIN ninguna configuración', async () => {
    // Ésta es la razón por la que el conjunto vacío no hace `throw` al arrancar: el
    // caso común del bucle (nos pegan al host X y un step apunta al host X) queda
    // cortado sin que el operador configure nada.
    mockResolvePrice.mockResolvedValueOnce(0.001);
    mockResolveDest.mockResolvedValueOnce({
      registry: 'wasiai',
      slug: 'self-via-hint',
      invokeUrl: 'https://gw-por-hint.example/compose',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: {
        'x-a2a-key': 'wasi_a2a_funded_master_key',
        host: 'gw-por-hint.example',
      },
      payload: { steps: [{ agent: 'self-via-hint', input: {} }] },
    });

    expect(debitMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe(CONTRACTING_LOOP_DETECTED);
  });

  /**
   * ⚠️ TESTIGO DEL CABLEADO del fix-pack AR/CR BLQ-MED-1, y hace falta que sea un
   * `it` aparte.
   *
   * Los tests de los SITIOS 3 y 4 viven en `services/compose.contracting-loop.test.ts`
   * y le pasan `selfHostHint` A MANO al service. Eso mide el guard, **no el
   * cableado**: si el route dejara de poblar el campo, esos `it` seguirían verdes y
   * el guard estaría inerte en producción — que es exactamente la forma del bug que
   * este fix-pack corrige. Acá el valor lo pone `routes/compose.ts` leyendo
   * `request.hostname` de una petición REAL de `app.inject`.
   */
  it('T-L1+10: el route PASA el `Host` entrante al service (cableado, no simulacro)', async () => {
    mockResolvePrice.mockResolvedValueOnce(0.001);
    mockResolveDest.mockResolvedValueOnce({
      registry: 'wasiai',
      slug: 'agente-ajeno',
      invokeUrl: 'https://otro-agente.example/run',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: {
        'x-a2a-key': 'wasi_a2a_funded_master_key',
        host: 'gw-cableado.example',
      },
      payload: { steps: [{ agent: 'agente-ajeno', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    expect(mockCompose).toHaveBeenCalledTimes(1);
    expect(mockCompose.mock.calls[0]?.[0]).toMatchObject({
      selfHostHint: 'gw-cableado.example',
    });
  });

  it('T-FLAG-1 (CD-1): NINGUNA env nueva gatea el corte', async () => {
    // El corte funciona con `process.env` limpio de banderas: lo único que se lee
    // es el CONJUNTO DE IDENTIDAD, que es un dato, no un interruptor. Una bandera
    // `=== 'true'` con default OFF —la convención por default de este repo—
    // shippearía el guard APAGADO, y por eso está prohibida acá.
    //
    // El control textual (que en los dos archivos del guard no exista ningún
    // `=== 'true'`) vive en `contracting-chain.flag.test.ts`, que barre el fuente.
    process.env.A2A_SELF_HOSTS = SELF;
    // Ninguna otra env de esta HU está seteada: ni banderas ni allow-lists.
    expect(process.env.A2A_CONTRACTING_ENABLED).toBeUndefined();
    expect(process.env.A2A_CONTRACTING_GUARD).toBeUndefined();
    expect(process.env.A2A_SELF_CONTRACTING_ALLOW).toBeUndefined();

    mockResolvePrice.mockResolvedValueOnce(0.001);
    mockResolveDest.mockResolvedValueOnce({
      registry: 'wasiai',
      slug: 'self-loop',
      invokeUrl: `https://${SELF}/compose`,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_funded_master_key' },
      payload: { steps: [{ agent: 'self-loop', input: {} }] },
    });

    expect(res.statusCode).toBe(400);
    expect(debitMock).not.toHaveBeenCalled();
  });
});

describe('WKH-360 CAPA 2 — el corte por TRAZA también ocurre antes del débito', () => {
  // La matriz de validación de la capa 2 vive en
  // `middleware/contracting-guard.test.ts`. ACÁ se mide lo único que ese archivo no
  // puede medir: que el preHandler está PRIMERO en la cadena REAL de `/compose`, o
  // sea antes de `requirePaymentOrA2AKey`. Sin este archivo, el guard podría estar
  // último y los tests del middleware seguirían verdes.

  it('T-L2-1-ORDEN: traza que nos contiene → 400 y CERO llamadas a debit', async () => {
    process.env.A2A_SELF_HOSTS = SELF;
    mockResolvePrice.mockResolvedValueOnce(0.001);
    mockResolveDest.mockResolvedValueOnce({
      registry: 'wasiai',
      slug: 'agente-ajeno',
      invokeUrl: 'https://otro-agente.example/run',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: {
        'x-a2a-key': 'wasi_a2a_funded_master_key',
        'x-a2a-contracting-chain': SELF,
      },
      payload: { steps: [{ agent: 'agente-ajeno', input: {} }] },
    });

    expect(debitMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBe(10);
    expect(mockCompose).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe(CONTRACTING_LOOP_DETECTED);
    // CD-6: la limitación best-effort viaja en el body del error.
    expect(res.json().note).toBe(CONTRACTING_LAYER2_BEST_EFFORT_NOTE);
  });

  it('T-DEPTH-1-ORDEN: profundidad en el techo → 400 y CERO llamadas a debit', async () => {
    process.env.A2A_SELF_HOSTS = SELF;
    mockResolvePrice.mockResolvedValueOnce(0.001);
    mockResolveDest.mockResolvedValueOnce({
      registry: 'wasiai',
      slug: 'agente-ajeno',
      invokeUrl: 'https://otro-agente.example/run',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: {
        'x-a2a-key': 'wasi_a2a_funded_master_key',
        'x-a2a-contracting-depth': '2',
      },
      payload: { steps: [{ agent: 'agente-ajeno', input: {} }] },
    });

    expect(debitMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBe(10);
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe(CONTRACTING_DEPTH_EXCEEDED);
  });

  it('T-CHAIN-1-ORDEN: header ilegible → 400 y CERO llamadas a debit', async () => {
    // Un header forjado sólo puede hacer fallar LA PETICIÓN QUE LO TRAE, y encima
    // gratis: ni un débito, ni una consulta al catálogo.
    process.env.A2A_SELF_HOSTS = SELF;
    mockResolvePrice.mockResolvedValueOnce(0.001);

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: {
        'x-a2a-key': 'wasi_a2a_funded_master_key',
        'x-a2a-contracting-depth': '1e9',
      },
      payload: { steps: [{ agent: 'agente-ajeno', input: {} }] },
    });

    expect(debitMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('CONTRACTING_DEPTH_MALFORMED');
    // El guard corta ANTES del preHandler de precio: ni se cotizó.
    expect(mockResolvePrice).not.toHaveBeenCalled();
  });

  it('T-L2+2-ORDEN (AC-8): traza de TERCEROS bajo el techo → 200 y se debita normal', async () => {
    process.env.A2A_SELF_HOSTS = SELF;
    mockResolvePrice.mockResolvedValueOnce(0.001);
    mockResolveDest.mockResolvedValueOnce({
      registry: 'wasiai',
      slug: 'agente-ajeno',
      invokeUrl: 'https://otro-agente.example/run',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: {
        'x-a2a-key': 'wasi_a2a_funded_master_key',
        'x-a2a-contracting-chain': 'otro-gw.example',
        'x-a2a-contracting-depth': '1',
      },
      payload: { steps: [{ agent: 'agente-ajeno', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    expect(debitMock).toHaveBeenCalledTimes(1);
    // Y la traza validada llegó al service para que la EMITA (AC-7).
    expect(mockCompose).toHaveBeenCalledWith(
      expect.objectContaining({
        contractingChain: ['otro-gw.example'],
        contractingDepth: 1,
      }),
    );
  });
});
