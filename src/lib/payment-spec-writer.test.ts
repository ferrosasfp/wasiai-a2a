/**
 * payment-spec-writer — WKH-316 · el grueso de los ACs a nivel de módulo.
 * T-316-04..10, 19, 21, 22, 23, 26.
 *
 * ⚠️ EL MOCK DEL REGISTRY NO ES DECORACIÓN: SIN ÉL NINGÚN TEST DE CAMINO FELIZ
 * PUEDE PASAR. `getAdaptersBundle` arranca con `if (!_initialized) return
 * undefined;`, y en una suite unitaria el registry nunca se inicializa. O sea que
 * **todo** bloque `payment` caería en el paso 3 (`PAYMENT_CHAIN_NOT_INITIALIZED`)
 * y un 422 donde se espera un `ok: true` parecería un bug del validador. No lo es:
 * es este mock faltando. Está prohibido tocar el orden o la condición de los
 * guards para que un test pase.
 *
 * El factory usa `importOriginal` + spread: sin el spread, todo export que no se
 * overridee queda `undefined` y la suite explota por un motivo ajeno al que se
 * está midiendo.
 *
 * Y el override **sigue devolviendo `undefined` para al menos una chain conocida**
 * (`kite-ozone-testnet`) a propósito: si mockeáramos "todo inicializado", el test
 * de AC-3 no podría ponerse rojo nunca.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('./logger.js', () => ({ getLogger: () => logSpy }));

/** Símbolo que el riel mockeado declara. Lo mueven los tests de AC-12/DT-STORY-1. */
const rail = vi.hoisted(() => ({ tokens: [{ symbol: 'USDC' }] as unknown[] }));

/** Chains que el registry mockeado declara INICIALIZADAS. */
const INITIALIZED = ['solana-devnet', 'avalanche-fuji'];

vi.mock('../adapters/registry.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../adapters/registry.js')>();
  return {
    ...actual,
    getInitializedChainKeys: () => INITIALIZED,
    getAdaptersBundle: (chainKey?: string) =>
      chainKey !== undefined && INITIALIZED.includes(chainKey)
        ? { payment: { supportedTokens: rail.tokens } }
        : undefined,
  };
});

/** La address del operador que ve el paso 7. `null` = "no se pudo resolver". */
const operator = vi.hoisted(() => ({
  evm: null as string | null,
  solana: null as string | null,
}));
vi.mock('./operator-address.js', () => ({
  resolveOperatorAddress: (family: 'evm' | 'solana') =>
    Promise.resolve(family === 'evm' ? operator.evm : operator.solana),
}));

// ⚠️ Espías que DELEGAN EN EL REAL (T-316-23). El comportamiento queda intacto;
// lo único que agregan es poder afirmar "nadie escribió un validador paralelo".
const chainSpy = vi.hoisted(() => ({ normalize: vi.fn() }));
vi.mock('../adapters/chain-resolver.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../adapters/chain-resolver.js')>();
  return {
    ...actual,
    normalizeChainSlug: (raw: string) => {
      chainSpy.normalize(raw);
      return actual.normalizeChainSlug(raw);
    },
  };
});

const walletSpy = vi.hoisted(() => ({ isValid: vi.fn() }));
vi.mock('./wallet-format.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./wallet-format.js')>();
  return {
    ...actual,
    isValidPayoutWallet: (w: string, ns: 'evm' | 'solana') => {
      walletSpy.isValid(w, ns);
      return actual.isValidPayoutWallet(w, ns);
    },
  };
});

import {
  logPaymentBlockChange,
  PAYMENT_REJECTION_REASON,
  readStoredPaymentBlock,
  validatePaymentBlock,
} from './payment-spec-writer.js';

// ── Fixtures ────────────────────────────────────────────────────────
//
// ⚠️ NC-1: NO se usa `64KKjZFSMZRucKPqTpGydrUFeFdLHDhbHTJVGmEaXS6z` (el
// `contract` de los 3 agentes Solana vivos) como payTo aceptado. No está
// determinado si esa pubkey ES el operador Solana del gateway, y usarla como
// fixture de "válido" fijaría por accidente la respuesta a esa pregunta abierta.
/** Pubkey base58 de 32 bytes, con caja MEZCLADA (importa para T-316-07). */
const SOL_PAYTO = 'So11111111111111111111111111111111111111112';
const EVM_PAYTO = '0x000000000000000000000000000000000000aBcD';

const solBlock = (over: Record<string, unknown> = {}) => ({
  method: 'x402',
  chain: 'solana-devnet',
  contract: SOL_PAYTO,
  ...over,
});
const evmBlock = (over: Record<string, unknown> = {}) => ({
  method: 'x402',
  chain: 'avalanche-fuji',
  contract: EVM_PAYTO,
  ...over,
});

beforeEach(() => {
  rail.tokens = [{ symbol: 'USDC' }];
  operator.evm = null;
  operator.solana = null;
  logSpy.info.mockClear();
  logSpy.warn.mockClear();
  chainSpy.normalize.mockClear();
  walletSpy.isValid.mockClear();
});

// ── Paso 0 — shape ──────────────────────────────────────────────────

describe('validatePaymentBlock — paso 0: shape', () => {
  it.each([
    ['null', null],
    ['un array', [{ method: 'x402' }]],
    ['un string', 'x402'],
    ['un número', 7],
    ['sin method', { chain: 'solana-devnet', contract: SOL_PAYTO }],
    ['sin chain', { method: 'x402', contract: SOL_PAYTO }],
    ['sin contract', { method: 'x402', chain: 'solana-devnet' }],
    ['method vacío', solBlock({ method: '   ' })],
    ['chain vacía', solBlock({ chain: '' })],
    ['contract sólo espacios', solBlock({ contract: '  ' })],
    ['contract numérico', solBlock({ contract: 12345 })],
  ])('%s → INVALID_PAYMENT_BLOCK', async (_label, input) => {
    const r = await validatePaymentBlock(input);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe('INVALID_PAYMENT_BLOCK');
    expect(r.rejection.field).toBe('payment');
  });

  // Gemelo anti-vacuidad: sin esto, un `return reject(...)` incondicional en el
  // paso 0 pasaría los 11 casos de arriba.
  it('gemelo positivo: el bloque mínimo válido pasa el paso 0', async () => {
    const r = await validatePaymentBlock(solBlock());
    expect(r.ok).toBe(true);
  });
});

// ── T-316-19 · AC-10 — method ───────────────────────────────────────

describe('T-316-19 · AC-10 — method exacto', () => {
  it.each([
    'X402',
    ' x402 ',
    'x402 ',
    'eip3009',
    'X402 ',
  ])('%s → UNSUPPORTED_PAYMENT_METHOD', async (method) => {
    const r = await validatePaymentBlock(solBlock({ method }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe('UNSUPPORTED_PAYMENT_METHOD');
    expect(r.rejection.field).toBe('payment.method');
  });

  it('gemelo: x402 exacto pasa', async () => {
    const r = await validatePaymentBlock(solBlock({ method: 'x402' }));
    expect(r.ok).toBe(true);
  });
});

// ── T-316-04 · AC-2 — chain conocida ────────────────────────────────

describe('T-316-04 · AC-2 — chain que el gateway no conoce', () => {
  it("chain 'polygon' → INVALID_PAYMENT_CHAIN", async () => {
    const r = await validatePaymentBlock(solBlock({ chain: 'polygon' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe('INVALID_PAYMENT_CHAIN');
    expect(r.rejection.field).toBe('payment.chain');
  });

  // Gemelo anti-vacuidad: `'avalanche'` es un alias que el resolver SÍ conoce y
  // que resuelve a `avalanche-fuji`, que el registry mockeado declara viva. Si
  // el paso 2 rechazara todo, este caso lo delataría.
  it("gemelo: el alias 'avalanche' pasa el paso 2", async () => {
    const r = await validatePaymentBlock(
      evmBlock({ chain: 'avalanche', contract: EVM_PAYTO }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Y se persiste el alias DECLARADO, no el ChainKey resuelto: el vocabulario
    // del agente no lo reescribe el gateway.
    expect(r.block.chain).toBe('avalanche');
  });
});

// ── T-316-05 · AC-3 — riel no inicializado ──────────────────────────

describe('T-316-05 · AC-3 — chain conocida pero riel apagado', () => {
  it('kite-ozone-testnet (conocida, NO inicializada) → PAYMENT_CHAIN_NOT_INITIALIZED + initializedChains', async () => {
    const r = await validatePaymentBlock(
      evmBlock({ chain: 'kite-ozone-testnet' }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe('PAYMENT_CHAIN_NOT_INITIALIZED');
    expect(r.rejection.field).toBe('payment.chain');
    // La lista accionable: le dice al caller dónde SÍ puede declarar.
    if (r.rejection.code !== 'PAYMENT_CHAIN_NOT_INITIALIZED') return;
    expect(r.rejection.initializedChains).toContain('avalanche-fuji');
    expect(r.rejection.initializedChains).not.toContain('kite-ozone-testnet');
  });

  // Este es el guard que un dev apurado "arregla" cuando su test de camino feliz
  // da 422. El caso de arriba es lo que se rompe si lo hace.
  it('gemelo: una chain inicializada pasa el paso 3', async () => {
    const r = await validatePaymentBlock(evmBlock());
    expect(r.ok).toBe(true);
  });
});

// ── T-316-06 · AC-4 — cruce de familias ─────────────────────────────

describe('T-316-06 · AC-4 — el payTo tiene que ser de la familia de SU chain', () => {
  it('base58 en un slot EVM → INVALID_PAYMENT_PAYTO_FORMAT', async () => {
    const r = await validatePaymentBlock(evmBlock({ contract: SOL_PAYTO }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe('INVALID_PAYMENT_PAYTO_FORMAT');
    expect(r.rejection.field).toBe('payment.contract');
  });

  it('0x… en un slot Solana → INVALID_PAYMENT_PAYTO_FORMAT', async () => {
    const r = await validatePaymentBlock(solBlock({ contract: EVM_PAYTO }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe('INVALID_PAYMENT_PAYTO_FORMAT');
  });

  it('gemelo: cada payTo en el slot de su propia familia pasa', async () => {
    expect((await validatePaymentBlock(evmBlock())).ok).toBe(true);
    expect((await validatePaymentBlock(solBlock())).ok).toBe(true);
  });

  it('el payTo se trimea antes de validar (espacios del caller no lo rompen)', async () => {
    const r = await validatePaymentBlock(
      solBlock({ contract: `  ${SOL_PAYTO}  ` }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.block.contract).toBe(SOL_PAYTO);
  });
});

// ── T-316-07 · AC-4 · CD-3 — la caja del payTo no se toca ───────────

describe('T-316-07 · CD-3 — anti-caja', () => {
  it('un payTo Solana con caja mezclada se persiste carácter por carácter idéntico', async () => {
    const r = await validatePaymentBlock(solBlock({ contract: SOL_PAYTO }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.block.contract).toBe(SOL_PAYTO);
    // Redundante a propósito: si alguien mete un `toLowerCase()` en el write
    // path, `toBe` de arriba ya falla, pero esto nombra el porqué.
    expect(r.block.contract).not.toBe(SOL_PAYTO.toLowerCase());
  });

  it('MEDIDO — por qué CD-3 no es estética: la versión en minúsculas TAMBIÉN es una pubkey válida', async () => {
    // `so111…112` decodifica a 32 bytes igual que `So111…112`. O sea que un
    // `toLowerCase()` en el write path NO fallaría ruidosamente: aceptaría el
    // bloque y persistiría OTRA BILLETERA. Este test fija que las dos entradas
    // son aceptadas y que salen DISTINTAS.
    const lower = await validatePaymentBlock(
      solBlock({ contract: SOL_PAYTO.toLowerCase() }),
    );
    const mixed = await validatePaymentBlock(solBlock({ contract: SOL_PAYTO }));
    expect(lower.ok).toBe(true);
    expect(mixed.ok).toBe(true);
    if (!lower.ok || !mixed.ok) return;
    expect(lower.block.contract).not.toBe(mixed.block.contract);
  });

  it('la caja de un payTo EVM tampoco se reescribe', async () => {
    const r = await validatePaymentBlock(evmBlock({ contract: EVM_PAYTO }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.block.contract).toBe(EVM_PAYTO);
  });
});

// ── T-316-08 / T-316-09 · AC-5 — zero address ───────────────────────

describe('T-316-08 · AC-5 — la pubkey Solana de todos ceros', () => {
  it("'1'.repeat(32) → ZERO_PAYMENT_PAYTO (NO por formato)", async () => {
    const r = await validatePaymentBlock(
      solBlock({ contract: '1'.repeat(32) }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // ⚠️ SE ASSERTEA EL CÓDIGO, NO EL 422 (CD-A4). Ese valor **pasa**
    // `isValidSolanaAddress` (decodifica a 32 bytes exactos, medido), así que un
    // rojo por `INVALID_PAYMENT_PAYTO_FORMAT` sería una muerte FALSA: el testigo
    // habría muerto por la razón barata y el paso 5 podría no existir.
    expect(r.rejection.code).toBe('ZERO_PAYMENT_PAYTO');
    expect(r.rejection.field).toBe('payment.contract');
  });

  it('control de la premisa: el paso 4 SÍ acepta esa cadena (por eso el paso 5 existe)', async () => {
    await validatePaymentBlock(solBlock({ contract: '1'.repeat(32) }));
    // El validador de formato fue llamado con ese valor y no fue quien rechazó.
    expect(walletSpy.isValid).toHaveBeenCalledWith('1'.repeat(32), 'solana');
  });
});

describe('T-316-09 · AC-5 — la zero address EVM', () => {
  it("0x0000…0000 → ZERO_PAYMENT_PAYTO (y no 'formato': el paso 4 la acepta)", async () => {
    const r = await validatePaymentBlock(
      evmBlock({ contract: `0x${'0'.repeat(40)}` }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe('ZERO_PAYMENT_PAYTO');
    expect(r.rejection.field).toBe('payment.contract');
  });

  /**
   * ⚠️ CORRECCIÓN MEDIDA DEL DEV. El Story File pide para T-316-09
   * *"`0x0000…0000` en **3 cajas distintas** → `ZERO_PAYMENT_PAYTO` las 3 veces"*.
   * **Ese test no se puede escribir**, y las dos razones se midieron acá:
   *
   *  1. La zero address **no tiene un solo carácter con caja**: son 40 ceros.
   *     `'0x000…0'.toLowerCase()` es la MISMA cadena. El conjunto de "cajas
   *     distintas" del cuerpo tiene tamaño 1.
   *  2. Lo único que podría variar de caja es el prefijo, y `0X…` **no llega al
   *     paso 5**: `isValidWallet('0X' + '0'.repeat(40))` devuelve `false`
   *     (medido), así que lo rechaza el paso 4 con otro `error_code`.
   *
   * Consecuencia honesta, escrita acá para que nadie la descubra creyendo que
   * encontró un bug: **el `toLowerCase()` de la rama EVM del paso 5 no es
   * load-bearing**. Se mantiene porque lo manda el diseño y porque quedaría
   * correcto si el guard de formato se aflojara, pero ningún input que pase el
   * paso 4 cambia de valor al bajarle la caja Y además es la zero address.
   * Donde la insensibilidad a la caja EVM **sí** decide algo es en el paso 7
   * (comparación contra el operador), y eso lo fija T-316-10.
   */
  it('MEDIDO — 0X0000…0000 sale por el paso 4, no por el 5', async () => {
    const r = await validatePaymentBlock(
      evmBlock({ contract: `0X${'0'.repeat(40)}` }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Se assertea el código, no el 422 (CD-A4): si esto dijera sólo "rechaza",
    // el test parecería probar AC-5 y estaría probando AC-4.
    expect(r.rejection.code).toBe('INVALID_PAYMENT_PAYTO_FORMAT');
  });

  it('gemelo: una address EVM no-cero pasa', async () => {
    const r = await validatePaymentBlock(evmBlock({ contract: EVM_PAYTO }));
    expect(r.ok).toBe(true);
  });
});

// ── T-316-10 · AC-6 — el payTo no es el gateway ─────────────────────

describe('T-316-10 · AC-6 — PAYTO_IS_OPERATOR', () => {
  it('payTo == operador (solana) → PAYTO_IS_OPERATOR', async () => {
    operator.solana = SOL_PAYTO;
    const r = await validatePaymentBlock(solBlock());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe('PAYTO_IS_OPERATOR');
    expect(r.rejection.field).toBe('payment.contract');
  });

  it('payTo != operador (solana) → acepta', async () => {
    operator.solana = 'Vote111111111111111111111111111111111111111';
    const r = await validatePaymentBlock(solBlock());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.operatorCheckSkipped).toBe(false);
  });

  it('EVM: la MISMA address en otra caja también rechaza (EIP-55 es case-insensitive)', async () => {
    operator.evm = EVM_PAYTO.toLowerCase();
    const r = await validatePaymentBlock(evmBlock({ contract: EVM_PAYTO }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe('PAYTO_IS_OPERATOR');
  });

  it('SOLANA: la misma pubkey en otra caja NO rechaza — es otra billetera, no la misma', async () => {
    operator.solana = SOL_PAYTO.toLowerCase();
    const r = await validatePaymentBlock(solBlock({ contract: SOL_PAYTO }));
    expect(r.ok).toBe(true);
  });

  it('AC-6 degradado: operador irresoluble → ACEPTA y marca operatorCheckSkipped', async () => {
    operator.solana = null;
    const r = await validatePaymentBlock(solBlock());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.operatorCheckSkipped).toBe(true);
  });
});

// ── T-316-21 / T-316-26 · AC-12 · DT-STORY-1 — asset ────────────────

describe('T-316-21 · AC-12 — la etiqueta asset', () => {
  it("asset 'usdc' contra symbol 'USDC' → acepta (case-insensitive)", async () => {
    const r = await validatePaymentBlock(solBlock({ asset: 'usdc' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Se compara sin caja, pero se PERSISTE con la caja que mandó el caller.
    expect(r.block.asset).toBe('usdc');
  });

  it("asset 'PEN' contra symbol 'USDC' → PAYMENT_ASSET_MISMATCH", async () => {
    const r = await validatePaymentBlock(solBlock({ asset: 'PEN' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe('PAYMENT_ASSET_MISMATCH');
    expect(r.rejection.field).toBe('payment.asset');
  });

  it('asset ausente → acepta y no escribe la key', async () => {
    const r = await validatePaymentBlock(solBlock());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.block)).not.toContain('asset');
  });

  it('asset no-string (número, null) se descarta en silencio, como una key desconocida', async () => {
    for (const asset of [123, null, { s: 'USDC' }]) {
      const r = await validatePaymentBlock(solBlock({ asset }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(Object.keys(r.block)).not.toContain('asset');
    }
  });

  it('CONSECUENCIA ASUMIDA de que AC-12 sea estricto: el symbol lo fija el RIEL, no el caller', async () => {
    // `asset: "USDC"` es correcto en Solana y en avalanche-fuji, y sería un 422
    // en un riel cuyo adapter declare otro símbolo (kite usa
    // `X402_TOKEN_SYMBOL ?? 'PYUSD'`, tempo usa `'AlphaUSD'`). Acá se simula ese
    // riel moviendo el símbolo del bundle. Es correcto y es a propósito: `asset`
    // es decorativo —ningún camino de settle lo lee— así que rechazarlo no puede
    // mover un centavo; sólo evita que el catálogo mienta.
    rail.tokens = [{ symbol: 'PYUSD' }];
    const r = await validatePaymentBlock(solBlock({ asset: 'USDC' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe('PAYMENT_ASSET_MISMATCH');
  });
});

describe('T-316-26 · DT-STORY-1 — riel sin tokens declarados', () => {
  it('supportedTokens vacío + asset presente → ACEPTA y loguea PAYMENT_ASSET_CHECK_SKIPPED', async () => {
    rail.tokens = [];
    const r = await validatePaymentBlock(solBlock({ asset: 'USDC' }));

    // Ni lanza ni rechaza: `supportedTokens[0]` es `undefined` bajo
    // `noUncheckedIndexedAccess`, y la decisión fue degradar explícitamente en
    // vez de resolverlo con un `!` o un `as`.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.block.asset).toBe('USDC');

    const skips = logSpy.warn.mock.calls.filter(
      (c) => (c[0] as { code?: string }).code === 'PAYMENT_ASSET_CHECK_SKIPPED',
    );
    expect(skips).toHaveLength(1);
    expect((skips[0]?.[0] as { chainKey: string }).chainKey).toBe(
      'solana-devnet',
    );
  });

  it('gemelo: con tokens declarados NO se loguea el skip', async () => {
    rail.tokens = [{ symbol: 'USDC' }];
    await validatePaymentBlock(solBlock({ asset: 'USDC' }));
    const skips = logSpy.warn.mock.calls.filter(
      (c) => (c[0] as { code?: string }).code === 'PAYMENT_ASSET_CHECK_SKIPPED',
    );
    expect(skips).toHaveLength(0);
  });

  it('sin asset y sin tokens tampoco se loguea: el paso 6 ni se entra', async () => {
    rail.tokens = [];
    await validatePaymentBlock(solBlock());
    expect(logSpy.warn).not.toHaveBeenCalled();
  });
});

// ── T-316-22 · CD-10 · CD-11 — whitelist ────────────────────────────

describe('T-316-22 · CD-10/CD-11 — el bloque persistido es una whitelist de 4 keys', () => {
  it('los derivados y las keys desconocidas NO sobreviven', async () => {
    const r = await validatePaymentBlock(
      solBlock({
        asset: 'USDC',
        resolvedChain: 'avalanche-mainnet',
        network: 'mainnet',
        sarasa: 1,
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // `Object.keys` y no `toMatchObject`: lo que se está fijando es que NO haya
    // nada de más. Un `{ ...raw }` dejaría pasar `resolvedChain` y `network`, que
    // el gateway DERIVA — `/discover` no cambiaría porque el lector los recomputa
    // siempre, pero el valor envenenado quedaría persistido en el JSONB.
    expect(Object.keys(r.block).sort()).toEqual([
      'asset',
      'chain',
      'contract',
      'method',
    ]);
    expect(r.block).not.toHaveProperty('resolvedChain');
    expect(r.block).not.toHaveProperty('network');
    expect(r.block).not.toHaveProperty('sarasa');
  });

  it('chain y asset se trimean; la caja NO se toca en ninguno de los tres', async () => {
    const r = await validatePaymentBlock(
      solBlock({ chain: '  solana-devnet  ', asset: '  uSdC  ' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.block.chain).toBe('solana-devnet');
    expect(r.block.asset).toBe('uSdC');
    expect(r.block.contract).toBe(SOL_PAYTO);
  });
});

// ── T-316-23 · CD-2 — nadie escribió un validador paralelo ──────────

describe('T-316-23 · CD-2 — se usan los validadores que ya existen', () => {
  it('normalizeChainSlug e isValidPayoutWallet son llamados con lo que declaró el caller', async () => {
    const r = await validatePaymentBlock(solBlock());
    expect(r.ok).toBe(true);

    // Si alguien reemplazara el resolver por un `Set` de slugs propio, o el
    // validador de formato por un regex nuevo, estos espías no registrarían nada
    // y el comportamiento observable seguiría siendo idéntico. Ése es justo el
    // cambio que CD-2 prohíbe y que ningún assert de salida puede ver.
    expect(chainSpy.normalize).toHaveBeenCalledWith('solana-devnet');
    expect(walletSpy.isValid).toHaveBeenCalledWith(SOL_PAYTO, 'solana');
  });

  it('la familia sale de getChainVmFamily, no de adivinar por el formato', async () => {
    await validatePaymentBlock(evmBlock());
    expect(walletSpy.isValid).toHaveBeenCalledWith(EVM_PAYTO, 'evm');
  });
});

// ── Orden de los guards (CD-12) ─────────────────────────────────────

describe('CD-12 — el primero que falla gana, y el orden es normativo', () => {
  it('method inválido + chain inválida + payTo inválido → gana el method (paso 1)', async () => {
    const r = await validatePaymentBlock({
      method: 'X402',
      chain: 'polygon',
      contract: 'no-es-una-address',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe('UNSUPPORTED_PAYMENT_METHOD');
  });

  it('chain inválida + payTo inválido → gana la chain (paso 2)', async () => {
    const r = await validatePaymentBlock({
      method: 'x402',
      chain: 'polygon',
      contract: 'no-es-una-address',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Y no `INVALID_PAYMENT_PAYTO_FORMAT`: sin `chainKey` no hay familia contra
    // la cual validar el payTo, así que invertir el orden daría un `undefined`
    // en runtime o un `field` apuntando al campo equivocado.
    expect(r.rejection.code).toBe('INVALID_PAYMENT_CHAIN');
  });

  it('riel apagado + payTo cero → gana el riel (paso 3)', async () => {
    const r = await validatePaymentBlock({
      method: 'x402',
      chain: 'kite-ozone-testnet',
      contract: `0x${'0'.repeat(40)}`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe('PAYMENT_CHAIN_NOT_INITIALIZED');
  });

  it('payTo cero + asset que no matchea → gana el cero (paso 5 antes que el 6)', async () => {
    const r = await validatePaymentBlock(
      solBlock({ contract: '1'.repeat(32), asset: 'PEN' }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe('ZERO_PAYMENT_PAYTO');
  });

  it('asset que no matchea + payTo == operador → gana el asset (paso 6 antes que el 7)', async () => {
    operator.solana = SOL_PAYTO;
    const r = await validatePaymentBlock(solBlock({ asset: 'PEN' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe('PAYMENT_ASSET_MISMATCH');
  });
});

// ── CD-8 — los mensajes al cliente son estáticos ────────────────────

describe('CD-8 — ningún reason refleja el valor recibido', () => {
  it('hay un reason por código, y ninguno contiene el payTo ni la chain del caller', async () => {
    const codes = Object.keys(PAYMENT_REJECTION_REASON);
    expect(codes).toHaveLength(8);
    for (const reason of Object.values(PAYMENT_REJECTION_REASON)) {
      expect(reason).not.toContain(SOL_PAYTO);
      expect(reason).not.toContain(EVM_PAYTO);
      expect(reason).not.toContain('polygon');
    }
  });

  it('todo código que el validador puede devolver tiene su reason', async () => {
    const inputs: unknown[] = [
      null,
      solBlock({ method: 'X402' }),
      solBlock({ chain: 'polygon' }),
      evmBlock({ chain: 'kite-ozone-testnet' }),
      solBlock({ contract: EVM_PAYTO }),
      solBlock({ contract: '1'.repeat(32) }),
      solBlock({ asset: 'PEN' }),
    ];
    for (const input of inputs) {
      const r = await validatePaymentBlock(input);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(PAYMENT_REJECTION_REASON[r.rejection.code]).toBeTruthy();
    }
    // El octavo código sale con el operador resuelto.
    operator.solana = SOL_PAYTO;
    const op = await validatePaymentBlock(solBlock());
    expect(op.ok).toBe(false);
    if (op.ok) return;
    expect(PAYMENT_REJECTION_REASON[op.rejection.code]).toBeTruthy();
  });
});

// ── readStoredPaymentBlock ──────────────────────────────────────────

describe('readStoredPaymentBlock — narrowing de lo YA persistido', () => {
  it('devuelve las 4 keys y NADA más', () => {
    const block = readStoredPaymentBlock({
      payment: {
        method: 'x402',
        chain: 'solana-devnet',
        contract: SOL_PAYTO,
        asset: 'USDC',
        resolvedChain: 'solana-devnet',
        network: 'testnet',
      },
      inputSchema: { type: 'object' },
    });
    expect(block).toEqual({
      method: 'x402',
      chain: 'solana-devnet',
      contract: SOL_PAYTO,
      asset: 'USDC',
    });
  });

  it.each([
    ['sin key payment', {}],
    ['payment null', { payment: null }],
    ['payment array', { payment: [] }],
    ['payment string', { payment: 'x402' }],
    ['sin contract', { payment: { method: 'x402', chain: 'solana-devnet' } }],
  ])('%s → undefined (nunca null)', (_label, meta) => {
    const block = readStoredPaymentBlock(meta as Record<string, unknown>);
    expect(block).toBeUndefined();
    expect(block).not.toBeNull();
  });

  it('NO re-valida: un bloque sembrado con una chain que el gateway no conoce se devuelve tal cual', () => {
    // AC-9: lo ya persistido no se toca ni se normaliza. `validatePaymentBlock`
    // rechazaría `polygon`; este lector no, y esa asimetría es el punto.
    const block = readStoredPaymentBlock({
      payment: { method: 'x402', chain: 'polygon', contract: EVM_PAYTO },
    });
    expect(block).toEqual({
      method: 'x402',
      chain: 'polygon',
      contract: EVM_PAYTO,
    });
  });

  it('asset no-string se omite, sin romper la lectura del resto', () => {
    const block = readStoredPaymentBlock({
      payment: {
        method: 'x402',
        chain: 'solana-devnet',
        contract: SOL_PAYTO,
        asset: 42,
      },
    });
    expect(block).toEqual({
      method: 'x402',
      chain: 'solana-devnet',
      contract: SOL_PAYTO,
    });
  });
});

// ── logPaymentBlockChange ───────────────────────────────────────────

describe('logPaymentBlockChange — auditoría PII-safe', () => {
  it('hashea el owner_ref (16 hex) y deja el contract EN CLARO', () => {
    logPaymentBlockChange({
      op: 'update',
      slug: 'mi-agente',
      ownerRef: 'owner-secreto-123',
      prev: { method: 'x402', chain: 'avalanche', contract: EVM_PAYTO },
      next: { method: 'x402', chain: 'solana-devnet', contract: SOL_PAYTO },
    });

    expect(logSpy.info).toHaveBeenCalledTimes(1);
    const payload = logSpy.info.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.op).toBe('update');
    expect(payload.slug).toBe('mi-agente');
    // El owner_ref NO aparece en claro en ningún valor del payload.
    expect(JSON.stringify(payload)).not.toContain('owner-secreto-123');
    expect(payload.ownerRefHash).toMatch(/^[0-9a-f]{16}$/);
    // El contract SÍ, en los dos lados: es la billetera de cobro, ya pública en
    // `/discover`, y hashearla destruiría el único valor del log.
    expect(payload.prev).toEqual({ chain: 'avalanche', contract: EVM_PAYTO });
    expect(payload.next).toEqual({
      chain: 'solana-devnet',
      contract: SOL_PAYTO,
    });
  });

  it('el hash es determinista y distinto por owner', () => {
    logPaymentBlockChange({
      op: 'publish',
      slug: 'a',
      ownerRef: 'o1',
      prev: null,
      next: null,
    });
    logPaymentBlockChange({
      op: 'publish',
      slug: 'a',
      ownerRef: 'o1',
      prev: null,
      next: null,
    });
    logPaymentBlockChange({
      op: 'publish',
      slug: 'a',
      ownerRef: 'o2',
      prev: null,
      next: null,
    });
    const hashes = logSpy.info.mock.calls.map(
      (c) => (c[0] as { ownerRefHash: string }).ownerRefHash,
    );
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).not.toBe(hashes[2]);
  });

  it('un borrado se loguea con next null y prev poblado', () => {
    logPaymentBlockChange({
      op: 'delete',
      slug: 'a',
      ownerRef: 'o1',
      prev: { method: 'x402', chain: 'solana-devnet', contract: SOL_PAYTO },
      next: null,
    });
    const payload = logSpy.info.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.op).toBe('delete');
    expect(payload.next).toBeNull();
    expect(payload.prev).toEqual({
      chain: 'solana-devnet',
      contract: SOL_PAYTO,
    });
  });
});
