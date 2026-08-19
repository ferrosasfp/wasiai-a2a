/**
 * Published Agent Service — `Agent.payment` de agentes self-published (WKH-241).
 *
 * Cierra el gap de LECTURA: `mapRowToAgent` no exponía el payment spec que el
 * agente declara en `metadata.payment`, así que un agente Solana-native
 * (`remit-*-solana`) cobraba su fee por la chain default del gateway en vez de
 * Solana. Se testea vía el service REAL (`listAsAgents`/`getBySlugAsAgent`) con
 * supabase mockeado, y se prueba que el lector es UNO SOLO compartido con el
 * mapper de registries externos (`discovery.ts` `mapAgent`) — AC-4/CD-1.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistryConfig } from '../types/index.js';

const { state, readerSpy, logSpy, mockLookup } = vi.hoisted(() => ({
  state: {
    row: null as Record<string, unknown> | null,
    listData: [] as Record<string, unknown>[],
    // WKH-316 — fila que devuelve el `.single()` de un INSERT/UPDATE. Separada
    // de `state.row` a propósito: `getRow` usa `.maybeSingle()` y en `publish`
    // TIENE que devolver `null` (pre-check de colisión de slug), mientras que el
    // `.single()` del insert tiene que devolver la fila escrita.
    writeResult: null as Record<string, unknown> | null,
    insertArg: null as Record<string, unknown> | null,
    updateArg: null as Record<string, unknown> | null,
  },
  readerSpy: vi.fn(),
  logSpy: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  mockLookup: vi.fn(),
}));

// `publish` corre el validador SSRF REAL, que resuelve DNS de verdad. Sin este
// mock, cada test de alta muere con ENOTFOUND antes de llegar al insert.
vi.mock('node:dns', () => ({
  promises: { lookup: (...args: unknown[]) => mockLookup(...args) },
}));

vi.mock('../lib/supabase.js', () => {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder,
    eq: () => builder,
    not: () => builder,
    order: () => Promise.resolve({ data: state.listData, error: null }),
    maybeSingle: () => Promise.resolve({ data: state.row, error: null }),
    single: () =>
      Promise.resolve({ data: state.writeResult ?? state.row, error: null }),
    insert: (arg: Record<string, unknown>) => {
      state.insertArg = arg;
      return builder;
    },
    update: (arg: Record<string, unknown>) => {
      state.updateArg = arg;
      return builder;
    },
  });
  return { supabase: { from: () => builder } };
});

/**
 * 🔴 WKH-316 — este archivo llama al service REAL, así que `publish`/`update`
 * ejercitan la defense-in-depth y llegan a `validatePaymentBlock`. Sin este mock
 * el registry está SIN inicializar, `getAdaptersBundle` devuelve `undefined` para
 * toda chain, y TODO bloque `payment` sería rechazado en el paso 3: los tests de
 * persistencia verían un `throw new Error('Invalid payment')` en vez de un
 * insert. El bug estaría en este mock, nunca en el guard.
 */
const INITIALIZED_CHAINS = ['solana-devnet', 'avalanche-fuji'];
vi.mock('../adapters/registry.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../adapters/registry.js')>();
  return {
    ...actual,
    getInitializedChainKeys: () => INITIALIZED_CHAINS,
    getAdaptersBundle: (chainKey?: string) =>
      chainKey !== undefined && INITIALIZED_CHAINS.includes(chainKey)
        ? { payment: { supportedTokens: [{ symbol: 'USDC' }] } }
        : undefined,
  };
});

vi.mock('../lib/operator-address.js', () => ({
  resolveOperatorAddress: () => Promise.resolve(null),
}));

// El log de auditoría se emite desde `payment-spec-writer`, que crea su propio
// `getLogger('payment-writer')`. `importOriginal` + spread porque `discovery.ts`
// —que este archivo también ejercita— importa otras cosas de este módulo.
vi.mock('../lib/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/logger.js')>();
  return { ...actual, getLogger: () => logSpy };
});

// AC-4: se espía el módulo LEAF compartido delegando en la implementación REAL
// (comportamiento intacto). Si algún mapper tuviera su propio validador
// paralelo, el spy no registraría su llamada y el test falla.
vi.mock('../lib/payment-spec-reader.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../lib/payment-spec-reader.js')>();
  readerSpy.mockImplementation(actual.readPaymentSpec);
  return {
    readPaymentSpec: (raw: Record<string, unknown>) => readerSpy(raw),
  };
});

import { publishedAgentService } from './agent.js';
import { discoveryService } from './discovery.js';

// pubkey base58 de 32 bytes — payTo del agente Solana-native (WKH-235/236).
const SOL_PAYTO = 'So11111111111111111111111111111111111111112';
const EVM_PAYTO = '0x000000000000000000000000000000000000aBcD';

function makeRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'remit-corridor-fx-solana',
    name: 'Remit Corridor FX (Solana)',
    description: 'FX quote',
    capabilities: ['fx'],
    agent_url: 'https://remit-agents.example/fx',
    price_usdc: 0.02,
    metadata: null,
    enabled: true,
    owner_ref: 'tenant-A',
    created_at: new Date().toISOString(),
    ...o,
  };
}

function makeRegistry(): RegistryConfig {
  return {
    id: 'reg-1',
    name: 'test-registry',
    discoveryEndpoint: 'https://example.com/agents',
    invokeEndpoint: 'https://example.com/invoke/{slug}',
    schema: { discovery: {}, invoke: { method: 'POST' } },
    enabled: true,
    createdAt: new Date(),
    ownerRef: 'system',
  };
}

const SOLANA_SPEC = {
  method: 'x402',
  chain: 'solana-devnet',
  contract: SOL_PAYTO,
  asset: 'USDC',
};

describe('mapRowToAgent — payment spec declarado (WKH-241)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readerSpy.mockClear();
    state.row = null;
    state.listData = [];
    state.writeResult = null;
    state.insertArg = null;
    state.updateArg = null;
    logSpy.info.mockClear();
    logSpy.warn.mockClear();
  });

  // ── AC-1 ─────────────────────────────────────────────────────────
  it('AC-1: self-published con metadata.payment (solana-devnet) → Agent.payment expuesto con payTo base58 y esa chain', async () => {
    state.listData = [makeRow({ metadata: { payment: SOLANA_SPEC } })];

    const [agent] = await publishedAgentService.listAsAgents();

    expect(agent?.payment).toEqual({
      method: 'x402',
      chain: 'solana-devnet',
      contract: SOL_PAYTO,
      asset: 'USDC',
      // Derivados por el gateway (etiqueta de red del catálogo público). El slug
      // declarado por el agente sale intacto.
      resolvedChain: 'solana-devnet',
      network: 'testnet',
    });
    // El payTo es el base58 declarado — NO una address EVM ni la chain default.
    expect(agent?.payment?.contract).toBe(SOL_PAYTO);
    expect(agent?.payment?.chain).toBe('solana-devnet');
  });

  it('AC-1: getBySlugAsAgent expone el MISMO payment que listAsAgents', async () => {
    state.row = makeRow({ metadata: { payment: SOLANA_SPEC } });

    const agent = await publishedAgentService.getBySlugAsAgent(
      'remit-corridor-fx-solana',
    );

    expect(agent?.payment).toEqual({
      method: 'x402',
      chain: 'solana-devnet',
      contract: SOL_PAYTO,
      asset: 'USDC',
      // Derivados por el gateway (etiqueta de red del catálogo público). El slug
      // declarado por el agente sale intacto.
      resolvedChain: 'solana-devnet',
      network: 'testnet',
    });
  });

  // ── AC-2 ─────────────────────────────────────────────────────────
  it('AC-2: self-published SIN payment spec → payment ausente y JSON byte-idéntico (sin la key "payment")', async () => {
    state.listData = [
      makeRow({ slug: 'plain-agent', metadata: null }),
      makeRow({
        slug: 'schema-agent',
        metadata: { inputSchema: { type: 'object' }, discoverable: true },
      }),
    ];

    const agents = await publishedAgentService.listAsAgents();

    for (const a of agents) {
      expect(a.payment).toBeUndefined();
      // /discover serializa con JSON.stringify: una prop `undefined` se omite,
      // así que la respuesta es byte-idéntica al comportamiento pre-WKH-241.
      expect(JSON.stringify(a)).not.toContain('payment');
      expect(Object.keys(JSON.parse(JSON.stringify(a)))).not.toContain(
        'payment',
      );
    }
  });

  // ── AC-3 ─────────────────────────────────────────────────────────
  it('AC-3: chain no resoluble (polygon / basura) → payment omitido, SIN fallback a la chain default', async () => {
    state.listData = [
      makeRow({
        slug: 'polygon-agent',
        metadata: {
          payment: { method: 'x402', chain: 'polygon', contract: EVM_PAYTO },
        },
      }),
      makeRow({
        slug: 'garbage-agent',
        metadata: {
          payment: {
            method: 'x402',
            chain: '../../etc/passwd',
            contract: SOL_PAYTO,
          },
        },
      }),
      makeRow({
        slug: 'solana-mainnet-agent',
        metadata: {
          payment: {
            method: 'x402',
            chain: 'solana-mainnet',
            contract: SOL_PAYTO,
          },
        },
      }),
    ];

    const agents = await publishedAgentService.listAsAgents();

    expect(agents).toHaveLength(3);
    for (const a of agents) {
      expect(a.payment, `slug=${a.slug}`).toBeUndefined();
    }
  });

  // ── AC-4 ─────────────────────────────────────────────────────────
  it('AC-4: self-published y registries externos derivan payment con LA MISMA función (sin validador paralelo)', async () => {
    state.listData = [makeRow({ metadata: { payment: SOLANA_SPEC } })];
    const [selfPublished] = await publishedAgentService.listAsAgents();
    const callsAfterSelfPublished = readerSpy.mock.calls.length;

    const external = discoveryService.mapAgent(makeRegistry(), {
      id: 'ext-1',
      slug: 'ext-agent',
      name: 'External',
      description: 'd',
      capabilities: ['fx'],
      price: 0.02,
      status: 'active',
      payment: SOLANA_SPEC,
    });

    // Ambos mappers pasaron por el ÚNICO lector compartido (CD-1).
    expect(callsAfterSelfPublished).toBeGreaterThan(0);
    expect(readerSpy.mock.calls.length).toBeGreaterThan(
      callsAfterSelfPublished,
    );
    // Y el spec resultante es idéntico para el mismo input declarado.
    expect(selfPublished?.payment).toEqual(external.payment);
  });

  // ── AC-5 (DT-3) ──────────────────────────────────────────────────
  it('AC-5/DT-3: contract malformado se expone tal cual (pass-through) — el rechazo vive en settle-time', async () => {
    state.listData = [
      makeRow({
        metadata: {
          payment: { method: 'x402', chain: 'solana-devnet', contract: 'abc' },
        },
      }),
    ];

    const [agent] = await publishedAgentService.listAsAgents();

    // No se agrega un segundo guard de formato en discovery (Scope OUT/CD-1);
    // `settleSolanaLeg` (downstream-payment.ts:132) lo skipea con
    // INVALID_PAY_TO_FORMAT sin mover fondos — ver downstream-payment.test.ts
    // (T-234-AC3c / T-241-AC5).
    expect(agent?.payment?.contract).toBe('abc');
  });

  // ── AC-6 + CD-3 ──────────────────────────────────────────────────
  it('AC-6: agentes EVM existentes (remit-* Fuji sin spec) siguen sin payment → fee por la chain default, sin cambios', async () => {
    state.listData = [
      makeRow({
        slug: 'remit-kyc-validator',
        metadata: { discoverable: true },
        payout_chain: 'avalanche-fuji',
        payout_wallet: EVM_PAYTO,
      }),
    ];

    const [agent] = await publishedAgentService.listAsAgents();

    expect(agent?.payment).toBeUndefined();
    expect(agent?.priceUsdc).toBe(0.02);
    expect(agent?.status).toBe('active');
  });

  it('CD-3/DT-2: payout_wallet/payout_chain NUNCA derivan payment (son del creator-split del 1%)', async () => {
    state.listData = [
      makeRow({
        slug: 'payout-only-agent',
        metadata: null,
        payout_chain: 'solana-devnet',
        payout_wallet: SOL_PAYTO,
      }),
    ];

    const [agent] = await publishedAgentService.listAsAgents();

    expect(agent?.payment).toBeUndefined();
    expect(JSON.stringify(agent)).not.toContain(SOL_PAYTO);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// WKH-316 — el lado ESCRITOR. Service REAL + supabase espiado.
// ══════════════════════════════════════════════════════════════════════════

const PUBLISH_INPUT = {
  name: 'Mi Agente',
  agentUrl: 'https://mi-agente.example/a',
  capabilities: ['fx'],
};

/**
 * Bloque `payment` "sucio": las 4 keys legales MÁS los dos campos que el gateway
 * DERIVA (`resolvedChain`, `network`) y una key inventada. Es el input que un
 * caller malicioso —o simplemente uno que copió el shape de `/discover`— manda.
 *
 * ⚠️ NC-1: el `contract` NO es la pubkey de los 3 agentes Solana vivos. No está
 * determinado si esa address es el operador Solana del gateway, y usarla como
 * fixture de "payTo aceptado" fijaría por accidente la respuesta a esa pregunta.
 */
const DIRTY_PAYMENT = {
  method: 'x402',
  chain: 'solana-devnet',
  contract: SOL_PAYTO,
  asset: 'USDC',
  resolvedChain: 'avalanche-mainnet',
  network: 'mainnet',
  sarasa: 1,
};

const CLEAN_KEYS = ['asset', 'chain', 'contract', 'method'];

function insertedMetadata(): Record<string, unknown> | null {
  return (state.insertArg as { metadata: Record<string, unknown> | null })
    .metadata;
}
function updatedMetadata(): Record<string, unknown> | null {
  return (state.updateArg as { metadata: Record<string, unknown> | null })
    .metadata;
}

describe('publish() — persistencia del bloque payment (WKH-316)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.row = null; // getRow → sin colisión de slug
    state.writeResult = makeRow({ slug: 'mi-agente' });
    state.insertArg = null;
    state.updateArg = null;
    logSpy.info.mockClear();
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  it('T-316-02 · CD-10: un input SUCIO se persiste con EXACTAMENTE las 4 keys', async () => {
    await publishedAgentService.publish(
      { ...PUBLISH_INPUT, payment: DIRTY_PAYMENT },
      'tenant-A',
    );

    const meta = insertedMetadata();
    expect(meta).not.toBeNull();
    const persisted = (meta as { payment: Record<string, unknown> }).payment;
    // `Object.keys` y no `toMatchObject`: lo que se fija es que no haya nada DE
    // MÁS. Con un spread del raw, `resolvedChain: 'avalanche-mainnet'` quedaría
    // envenenado dentro del JSONB — `/discover` no cambiaría (el lector los
    // recomputa siempre) pero el valor sobreviviría para todo consumidor del
    // bloque crudo, incluido `mapRowToRecord`.
    expect(Object.keys(persisted).sort()).toEqual(CLEAN_KEYS);
    expect(persisted.resolvedChain).toBeUndefined();
    expect(persisted.network).toBeUndefined();
    expect(persisted.sarasa).toBeUndefined();
  });

  it('T-316-20 · AC-11: publish SIN payment → metadata null y record.payment undefined', async () => {
    const record = await publishedAgentService.publish(
      PUBLISH_INPUT,
      'tenant-A',
    );

    // Byte-idéntico a antes de esta HU: sin ningún otro campo de metadata, la
    // columna se escribe NULL, no `{}`.
    expect(insertedMetadata()).toBeNull();
    expect(record.payment).toBeUndefined();
    expect(record).not.toHaveProperty('payment');
    // Y no se ensucia el log de auditoría con altas que no declararon nada.
    expect(logSpy.info).not.toHaveBeenCalled();
  });

  it('AC-11: publish sin payment PERO con inputSchema → metadata sin la key payment', async () => {
    await publishedAgentService.publish(
      { ...PUBLISH_INPUT, inputSchema: { type: 'object' } },
      'tenant-A',
    );

    expect(insertedMetadata()).toEqual({ inputSchema: { type: 'object' } });
    expect(Object.keys(insertedMetadata() ?? {})).not.toContain('payment');
  });

  it('un bloque inválido hace FALLAR el publish y no llega ningún insert (defense-in-depth)', async () => {
    // El route ya devolvió 422 antes; esto es la segunda barrera, por si alguien
    // llama al service sin pasar por el route.
    await expect(
      publishedAgentService.publish(
        { ...PUBLISH_INPUT, payment: { ...DIRTY_PAYMENT, chain: 'polygon' } },
        'tenant-A',
      ),
    ).rejects.toThrow('Invalid payment');
    expect(state.insertArg).toBeNull();
  });

  it('T-316-14: el alta emite el log de auditoría con prev null y el owner HASHEADO', async () => {
    await publishedAgentService.publish(
      { ...PUBLISH_INPUT, payment: DIRTY_PAYMENT },
      'tenant-secreto-A',
    );

    expect(logSpy.info).toHaveBeenCalledTimes(1);
    const payload = logSpy.info.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.op).toBe('publish');
    expect(payload.prev).toBeNull();
    expect(payload.next).toEqual({
      chain: 'solana-devnet',
      contract: SOL_PAYTO,
    });
    // El owner_ref NUNCA en claro; su hash, 16 hex.
    expect(JSON.stringify(payload)).not.toContain('tenant-secreto-A');
    expect(payload.ownerRefHash).toMatch(/^[0-9a-f]{16}$/);
    // El contract SÍ en claro: es la billetera de cobro, ya pública en
    // `/discover`, y hashearla destruiría el único valor del log.
    expect(JSON.stringify(payload)).toContain(SOL_PAYTO);
  });
});

describe('update() — merge, borrado y el agujero del PATCH (WKH-316)', () => {
  const OWNER = 'tenant-A';

  beforeEach(() => {
    vi.clearAllMocks();
    state.insertArg = null;
    state.updateArg = null;
    logSpy.info.mockClear();
  });

  function seed(metadata: Record<string, unknown> | null): void {
    state.row = makeRow({ slug: 'mi-agente', owner_ref: OWNER, metadata });
    state.writeResult = state.row;
  }

  it('T-316-25 · CD-10 vía PATCH: `updates.payment` CRUDO no se persiste — el bloque lo produce el SERVICE', async () => {
    // 🔴 EL TEST QUE CIERRA EL AGUJERO. El route le pasa el `body` CRUDO a
    // `update()` (a diferencia del POST, que arma un `input` con whitelist), y el
    // sistema de tipos NO lo detiene: `Record<string, unknown>` es asignable a
    // `UpdateAgentInput` porque todas sus props son opcionales. Si el service
    // persistiera `updates.payment`, este PATCH escribiría `resolvedChain` y
    // `network` en el JSONB y NINGÚN otro test de esta HU se pondría rojo.
    seed({ inputSchema: { type: 'object' } });

    await publishedAgentService.update(
      'mi-agente',
      { payment: DIRTY_PAYMENT },
      OWNER,
    );

    const persisted = (
      updatedMetadata() as { payment: Record<string, unknown> }
    ).payment;
    expect(Object.keys(persisted).sort()).toEqual(CLEAN_KEYS);
    expect(persisted.resolvedChain).toBeUndefined();
    expect(persisted.network).toBeUndefined();
  });

  it('T-316-13 · AC-7 · CD-7: un PATCH sólo de payment NO borra los otros campos de metadata', async () => {
    seed({
      inputSchema: { type: 'object' },
      outputSchema: { type: 'string' },
      discoverable: true,
    });

    await publishedAgentService.update(
      'mi-agente',
      {
        payment: {
          method: 'x402',
          chain: 'solana-devnet',
          contract: SOL_PAYTO,
        },
      },
      OWNER,
    );

    // Las 4 keys. Escribir el objeto `metadata` desde cero borraría en silencio
    // los schemas de todo agente que ya los tenga.
    expect(Object.keys(updatedMetadata() ?? {}).sort()).toEqual([
      'discoverable',
      'inputSchema',
      'outputSchema',
      'payment',
    ]);
    expect((updatedMetadata() as Record<string, unknown>).inputSchema).toEqual({
      type: 'object',
    });
  });

  it('T-316-15 · AC-8: `payment: null` borra SÓLO esa key y deja el resto byte-idéntico', async () => {
    const inputSchema = {
      type: 'object',
      properties: { a: { type: 'number' } },
    };
    seed({ inputSchema, payment: SOLANA_SPEC });

    await publishedAgentService.update('mi-agente', { payment: null }, OWNER);

    expect(updatedMetadata()).toEqual({ inputSchema });
    expect(Object.keys(updatedMetadata() ?? {})).not.toContain('payment');
  });

  it('T-316-16 · AC-8 · R-7: borrar la ÚNICA key de metadata escribe null, no `{}`', async () => {
    seed({ payment: SOLANA_SPEC });

    await publishedAgentService.update('mi-agente', { payment: null }, OWNER);

    // La columna usa `null` para "sin metadata" (`buildMetadata` ya lo hace en el
    // alta). Un `{}` sería un tercer estado que ningún lector espera.
    expect(updatedMetadata()).toBeNull();
  });

  it('R-7 es INALCANZABLE por los otros campos: un PATCH de discoverable nunca colapsa a null', async () => {
    // Los otros tres campos sólo ASIGNAN, nunca borran, así que esta rama no
    // cambia el comportamiento de ningún PATCH que existiera antes de la HU.
    seed({ payment: SOLANA_SPEC });

    await publishedAgentService.update(
      'mi-agente',
      { discoverable: false },
      OWNER,
    );

    expect(updatedMetadata()).toEqual({
      payment: SOLANA_SPEC,
      discoverable: false,
    });
  });

  it('AC-7: `payment` ausente NO toca el bloque existente ni dispara el merge', async () => {
    seed({ payment: SOLANA_SPEC });

    await publishedAgentService.update('mi-agente', { priceUsdc: 3 }, OWNER);

    // Tres estados distintos: ausente no escribe `metadata` en absoluto.
    expect(state.updateArg).not.toHaveProperty('metadata');
    expect(logSpy.info).not.toHaveBeenCalled();
  });

  it('T-316-14: el borrado se audita con op delete, prev poblado y next null', async () => {
    state.row = makeRow({
      slug: 'mi-agente',
      owner_ref: 'tenant-secreto-B',
      metadata: { payment: SOLANA_SPEC },
    });
    state.writeResult = state.row;

    await publishedAgentService.update(
      'mi-agente',
      { payment: null },
      'tenant-secreto-B',
    );

    const payload = logSpy.info.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.op).toBe('delete');
    expect(payload.prev).toEqual({
      chain: 'solana-devnet',
      contract: SOL_PAYTO,
    });
    expect(payload.next).toBeNull();
    expect(JSON.stringify(payload)).not.toContain('tenant-secreto-B');
  });

  it('T-316-14: un reemplazo se audita con las DOS billeteras — la vieja y la nueva', async () => {
    // Ésta es la única pregunta que este log existe para contestar: "¿a qué
    // billetera se re-apuntó, y cuándo?", el día que un cobro aparezca donde no
    // debe.
    const OTRA = 'Vote111111111111111111111111111111111111111';
    seed({ payment: SOLANA_SPEC });

    await publishedAgentService.update(
      'mi-agente',
      { payment: { method: 'x402', chain: 'solana-devnet', contract: OTRA } },
      OWNER,
    );

    const payload = logSpy.info.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.op).toBe('update');
    expect(payload.prev).toEqual({
      chain: 'solana-devnet',
      contract: SOL_PAYTO,
    });
    expect(payload.next).toEqual({ chain: 'solana-devnet', contract: OTRA });
  });

  it('un bloque inválido en el PATCH hace fallar el update y no llega ningún UPDATE', async () => {
    seed({ inputSchema: { type: 'object' } });

    await expect(
      publishedAgentService.update(
        'mi-agente',
        { payment: { ...DIRTY_PAYMENT, contract: '1'.repeat(32) } },
        OWNER,
      ),
    ).rejects.toThrow('Invalid payment');
    expect(state.updateArg).toBeNull();
  });
});

describe('lectura del bloque persistido (WKH-316)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.row = null;
    state.listData = [];
    state.writeResult = null;
  });

  it('T-316-03: round-trip escritor → lector, SIN tocar el lector', async () => {
    // Lo que el escritor persiste (4 keys) sale por `readPaymentSpec` con los
    // DOS derivados agregados. Es el contrato entre las dos mitades de la HU.
    state.listData = [
      makeRow({
        metadata: {
          payment: {
            method: 'x402',
            chain: 'solana-devnet',
            contract: SOL_PAYTO,
            asset: 'USDC',
          },
        },
      }),
    ];

    const [agent] = await publishedAgentService.listAsAgents();

    expect(agent?.payment).toEqual({
      method: 'x402',
      chain: 'solana-devnet',
      contract: SOL_PAYTO,
      asset: 'USDC',
      resolvedChain: 'solana-devnet',
      network: 'testnet',
    });
    expect(readerSpy).toHaveBeenCalled();
  });

  it('T-316-18 · AC-9: un bloque sembrado con una chain desconocida NO se re-valida ni se reescribe', async () => {
    // `validatePaymentBlock` rechazaría `polygon`. El camino de LECTURA no lo
    // toca: el reader lo omite de `Agent.payment` (como siempre) y nada
    // reescribe la fila. Esa asimetría es deliberada — re-validar en lectura
    // sería reescribir de hecho lo que AC-9 prohíbe tocar.
    state.listData = [
      makeRow({
        metadata: {
          payment: { method: 'x402', chain: 'polygon', contract: EVM_PAYTO },
        },
      }),
    ];

    const [agent] = await publishedAgentService.listAsAgents();

    expect(agent?.payment).toBeUndefined();
    // Cero escrituras: leer no dispara ningún insert/update.
    expect(state.insertArg).toBeNull();
    expect(state.updateArg).toBeNull();
    // Y el metadata crudo sigue teniendo el bloque intacto.
    expect(
      (agent?.metadata as { payment: Record<string, unknown> }).payment,
    ).toEqual({ method: 'x402', chain: 'polygon', contract: EVM_PAYTO });
  });

  it('T-316-17 · AC-9 · CD-1: byte-identidad de /discover contra un literal escrito a mano', async () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
    state.listData = [
      makeRow({
        slug: 'sin-bloque',
        name: 'Sin Bloque',
        description: 'd',
        capabilities: ['fx'],
        agent_url: 'https://x.example/a',
        price_usdc: 0.02,
        metadata: { discoverable: true },
        created_at: createdAt,
      }),
      makeRow({
        slug: 'con-bloque',
        name: 'Con Bloque',
        description: 'd',
        capabilities: ['fx'],
        agent_url: 'https://x.example/b',
        price_usdc: 0.02,
        metadata: { payment: SOLANA_SPEC },
        created_at: createdAt,
      }),
    ];

    const agents = await publishedAgentService.listAsAgents();

    // Literal escrito a mano, no derivado del propio mapper: si el mapper
    // agregara una key, reordenara, o pusiera `payment: null` donde antes había
    // AUSENCIA, este `toBe` se pone rojo. Un `toMatchObject` no lo vería.
    expect(JSON.stringify(agents)).toBe(
      '[' +
        JSON.stringify({
          id: 'sin-bloque',
          name: 'Sin Bloque',
          slug: 'sin-bloque',
          description: 'd',
          capabilities: ['fx'],
          priceUsdc: 0.02,
          registry: 'self-published',
          registry_id: 'self-published',
          invokeUrl: 'https://x.example/a',
          invocationNote:
            'The invokeUrl is an internal reference. To invoke this agent, use POST /compose or POST /orchestrate on the WasiAI A2A gateway.',
          verified: false,
          status: 'active',
          metadata: { discoverable: true },
        }) +
        ',' +
        JSON.stringify({
          id: 'con-bloque',
          name: 'Con Bloque',
          slug: 'con-bloque',
          description: 'd',
          capabilities: ['fx'],
          priceUsdc: 0.02,
          registry: 'self-published',
          registry_id: 'self-published',
          invokeUrl: 'https://x.example/b',
          invocationNote:
            'The invokeUrl is an internal reference. To invoke this agent, use POST /compose or POST /orchestrate on the WasiAI A2A gateway.',
          verified: false,
          status: 'active',
          metadata: { payment: SOLANA_SPEC },
          payment: {
            method: 'x402',
            chain: 'solana-devnet',
            contract: SOL_PAYTO,
            asset: 'USDC',
            resolvedChain: 'solana-devnet',
            network: 'testnet',
          },
        }) +
        ']',
    );
    // Control de armado: el agente sin bloque NO trae la key `payment` — ni
    // siquiera como `null`.
    expect(JSON.parse(JSON.stringify(agents))[0]).not.toHaveProperty('payment');
  });

  it('AC-1: `mapRowToRecord` expone el bloque PERSISTIDO (4 keys), no el de discovery (6)', async () => {
    state.row = makeRow({
      slug: 'mi-agente',
      owner_ref: 'tenant-A',
      metadata: { payment: SOLANA_SPEC },
    });
    state.writeResult = state.row;

    const record = await publishedAgentService.update(
      'mi-agente',
      { priceUsdc: 1 },
      'tenant-A',
    );

    expect(record.payment).toEqual(SOLANA_SPEC);
    expect(record.payment).not.toHaveProperty('resolvedChain');
    expect(record.payment).not.toHaveProperty('network');
  });
});
