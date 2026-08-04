/**
 * EL MAPEO REAL adapter Solana → leg: ¿qué `code` publica `settleSolanaLeg` para
 * lo que el adapter LANZA DE VERDAD?
 *
 * ── POR QUÉ ESTE ARCHIVO EXISTE (y por qué no alcanzaba con los que ya había) ──
 *
 * La regla que se mide vive en `downstream-payment.ts` (catch de `adapter.settle`
 * en `settleSolanaLeg`): lee la disposición del throw con
 * `readSettleValueDisposition` y emite `SETTLE_UNKNOWN` o `SETTLE_FAILED`. Ese
 * `code` NO es sólo un log: `createSkipCapturingLogger` lo levanta y `compose.ts`
 * lo serializa como `steps[].downstreamSettle = "skipped:<código público>"`, y el
 * vocabulario público define `SETTLE_FAILED` como «no se pagó (al caller no se le
 * cobra por este leg)» contra `SETTLE_UNKNOWN` = «puede haberse pagado, NO se
 * reintenta solo» (`downstream-skip-code.ts`).
 *
 * Hasta acá NINGÚN test ejercitaba esa regla sobre un error REAL del adapter, y
 * las dos suites que parecían hacerlo tienen el mismo agujero por dos motivos
 * distintos:
 *
 *   · `downstream-payment.test.ts` mockea `../adapters/registry.js` entero, así
 *     que el `solanaAdapter` que entra al leg es un doble y sus throws los fabrica
 *     el propio test. Prueba que el leg clasifica bien un error INVENTADO; no que
 *     el adapter produzca uno clasificable.
 *   · `adapters/solana/intent-dedup.test.ts` sí usa el adapter real, pero afirma
 *     contra un `legCodeFor()` local (`intent-dedup.test.ts:222`) que
 *     **RE-IMPLEMENTA** el ternario de `downstream-payment.ts:503-508`. Es un guard
 *     que se compara consigo mismo: si el leg dejara de leer la disposición, ese
 *     helper seguiría devolviendo `SETTLE_UNKNOWN` y sus tests seguirían verdes.
 *
 *     ⚠️ DEUDA CONOCIDA, SIN DUEÑO — `TD-LEGCODE-SELFREF`. `legCodeFor()` sigue
 *     en pie y sigue siendo self-referential; NO se tocó en este cambio (es la
 *     batería de otra HU, ya cerrada). MEDIDO: mutar
 *     `downstream-payment.ts:503-508` para que ignore la disposición pone en rojo
 *     4 tests de ESTE archivo y **0 de los 64** de `intent-dedup.test.ts`. Ése es
 *     el motivo por el que el bug de los cuatro sitios sobrevivió a un AR, un CR
 *     y un F4. Mientras el helper exista, sus aserciones `legCodeFor(...)` no
 *     cuentan como cobertura del mapeo.
 *
 * Acá NO se mockea el adapter ni se re-implementa la regla: se mockean los SEAMS
 * de abajo del adapter (conexión RPC, ledger, spl-token) y el error viaja
 * `SolanaPaymentAdapter.settle()` → `settleSolanaLeg()` → `logger.warn({ code })`.
 * Lo que se afirma es el `code` que sale del logger, que es exactamente el dato
 * que llega al caller.
 *
 * ── LA CONTRACARA ES PARTE DE LA MEDICIÓN ──
 * `T-MAP-04` fija que un veredicto MEDIDO (`landed_mismatch` — la cadena contestó
 * y el delta no cubre el monto) siga siendo `SETTLE_FAILED`. Sin él, convertir
 * todo throw en `'unknown'` pasaría los otros cuatro y ningún leg volvería a
 * reportarse como impago.
 *
 * ── LOS CUATRO SITIOS, UN TEST CADA UNO ──
 * `payment.ts` tiene CUATRO throws cuyo marcador declara una indeterminación, y
 * cada uno tiene su propio test porque cada uno es una rama distinta del adapter:
 *
 *   | sitio                          | rama                                   | test     |
 *   |--------------------------------|----------------------------------------|----------|
 *   | `SETTLE_PRESENCE_UNKNOWN`      | fila `confirmed`, probe mudo           | T-MAP-01 |
 *   | `SETTLE_IN_FLIGHT_UNRESOLVED`  | fila `signed`, probe mudo              | T-MAP-02 |
 *   | `SETTLE_IN_FLIGHT_UNRESOLVED`  | `landed_failed` + blockhash VIVO       | T-MAP-03 |
 *   | `SETTLE_SIGNED_UNRESOLVED`     | `absent` + SIN cota de expiración      | T-MAP-05 |
 *
 * Los cuatro escenarios son disjuntos: revertir uno solo a `Error` pelado pone en
 * rojo un único test (medido, no supuesto).
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `DOWNSTREAM_FLAG` se lee UNA VEZ al cargar `downstream-payment.ts`, así que la
// env tiene que estar puesta antes de que se evalúen los imports. `vi.hoisted`
// corre antes que los `vi.mock` hoisteados y que los `import`, que es la única
// ventana que sirve. (El pool de vitest aísla por archivo: no se filtra a otras
// suites.)
vi.hoisted(() => {
  process.env.WASIAI_DOWNSTREAM_X402 = 'true';
  delete process.env.SOLANA_SETTLE_VIA_FACILITATOR;
  delete process.env.SOLANA_RPC_LEDGER_HISTORY_DECLARED_SUFFICIENT;
});

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const PAY_TO = 'So11111111111111111111111111111111111111112';
/** Keypair REAL: `tx.serialize()` verifica las firmas (ver `intent-dedup.test.ts`). */
const OPERATOR_KEYPAIR = Keypair.generate();
/** CAIP-2 de un cluster NO mainnet ⟹ el gate de mainnet del leg no corta. */
const CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

// ─── Seam 1: la conexión RPC ─────────────────────────────────────────
/** Lo que devuelve `getSignatureStatuses` (`null` = ausente tras buscar histórico). */
const presenceState: { value: { err: unknown } | null } = {
  value: { err: null },
};

const fakeConnection = {
  getParsedTransaction: vi.fn(
    (..._a: unknown[]): Promise<unknown> => Promise.resolve(null),
  ),
  getTokenAccountBalance: vi.fn(
    (..._a: unknown[]): Promise<unknown> =>
      Promise.resolve({ value: { amount: '1000000000' } }),
  ),
  getLatestBlockhash: vi.fn((..._a: unknown[]) =>
    Promise.resolve({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1000,
    }),
  ),
  sendRawTransaction: vi.fn((..._a: unknown[]) => Promise.resolve('sent')),
  confirmTransaction: vi.fn((..._a: unknown[]) =>
    Promise.resolve({ value: { err: null } }),
  ),
  getBlockHeight: vi.fn((..._a: unknown[]) => Promise.resolve(900)),
  getSlot: vi.fn((..._a: unknown[]) => Promise.resolve(200_000_000)),
  getFirstAvailableBlock: vi.fn((..._a: unknown[]) => Promise.resolve(1)),
  getSignatureStatuses: vi.fn((..._a: unknown[]) =>
    Promise.resolve({ value: [presenceState.value] }),
  ),
};

vi.mock('../adapters/solana/chain.js', () => ({
  getSolanaConnection: vi.fn(() => fakeConnection),
  getSolanaOperatorKeypair: vi.fn(() => OPERATOR_KEYPAIR),
  getSolanaUsdcMint: vi.fn(() => MINT),
  getSolanaUsdcDecimals: vi.fn(() => 6),
  getSolanaCommitment: vi.fn(() => 'confirmed'),
  getSolanaCaip2: vi.fn(() => CAIP2),
}));

vi.mock('@solana/spl-token', () => ({
  getOrCreateAssociatedTokenAccount: vi.fn(() =>
    Promise.resolve({ address: new PublicKey(PAY_TO) }),
  ),
  createTransferInstruction: vi.fn(() => ({
    keys: [],
    programId: new PublicKey(MINT),
    data: Buffer.alloc(0),
  })),
  getAssociatedTokenAddressSync: vi.fn(
    () => new PublicKey(OPERATOR_KEYPAIR.publicKey.toBase58()),
  ),
}));

// ─── Seam 2: el ledger durable ───────────────────────────────────────
const claimMock = vi.hoisted(() => vi.fn());
const readMock = vi.hoisted(() => vi.fn());
const recordSignedMock = vi.hoisted(() => vi.fn());
const recordConfirmedMock = vi.hoisted(() => vi.fn());
const reclaimMock = vi.hoisted(() => vi.fn());
const probeMock = vi.hoisted(() => vi.fn());

vi.mock('../adapters/solana/settle-ledger.js', () => ({
  claimSettleIntent: claimMock,
  recordSignedIntent: recordSignedMock,
  recordConfirmedIntent: recordConfirmedMock,
  reclaimExpiredIntent: reclaimMock,
  readSettleIntent: readMock,
  probeSettleLedger: probeMock,
}));

// ⚠️ `schema-preflight.js` NO se mockea: corre el real sobre el `probeSettleLedger`
// y la conexión de arriba, igual que en `intent-dedup.test.ts`.

// ─── Seam 3: el registry, con el adapter REAL adentro ────────────────
//
// ESTE es el punto del archivo. `downstream-payment.ts` resuelve el adapter por
// `getPaymentAdapterOrUnion`; en vez de devolver un doble, se devuelve una
// instancia de la clase de producción.
import {
  _resetSolanaClients,
  SolanaPaymentAdapter,
} from '../adapters/solana/payment.js';

const realSolanaAdapter = new SolanaPaymentAdapter();

vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: (chainKey?: string) =>
    chainKey === 'solana-devnet' ? realSolanaAdapter : undefined,
  getPaymentAdapterOrUnion: (chainKey?: string) =>
    chainKey === 'solana-devnet' ? realSolanaAdapter : undefined,
  getAdaptersBundle: (chainKey?: string) =>
    chainKey === 'solana-devnet'
      ? {
          chainConfig: {
            name: 'Solana Devnet',
            // Sentinel sintético (DT-8): para Solana el id autoritativo es el
            // CAIP-2 del adapter, no este número.
            chainId: 900001,
            explorerUrl: 'https://example/explorer',
          },
        }
      : undefined,
  getInitializedChainKeys: () => ['solana-devnet'],
}));

import type { Agent, DownstreamLogger } from '../types/index.js';
import { signAndSettleDownstream } from './downstream-payment.js';

// ─── Fixtures ────────────────────────────────────────────────────────

function makeAgent(): Agent {
  return {
    id: 'a1',
    slug: 'solana-agent',
    name: 'Solana Agent',
    description: 'd',
    endpoint: 'https://agent.example/x',
    capabilities: ['test'],
    priceUsdc: 3,
    payment: {
      method: 'x402',
      asset: 'USDC',
      chain: 'solana-devnet',
      contract: PAY_TO,
    },
  } as unknown as Agent;
}

/**
 * Corre el leg REAL y devuelve el código terminal + el detalle logueado.
 *
 * El detalle se devuelve para poder afirmar POR QUÉ RAMA del adapter salió el
 * error: sin eso, dos escenarios distintos que dieran `SETTLE_UNKNOWN` por el
 * motivo equivocado pasarían igual.
 */
async function runLeg(): Promise<{
  result: unknown;
  code: string | undefined;
  detail: string;
}> {
  const logged: { code?: string; detail?: string }[] = [];
  const logger: DownstreamLogger = {
    warn: (obj: unknown) => logged.push(obj as { code?: string }),
    info: (obj: unknown) => logged.push(obj as { code?: string }),
  };
  const result = await signAndSettleDownstream(
    makeAgent(),
    logger,
    'compose-run-1:0',
  );
  const terminal = logged.filter(
    (l) => l.code === 'SETTLE_UNKNOWN' || l.code === 'SETTLE_FAILED',
  );
  return {
    result,
    code: terminal.at(-1)?.code,
    detail: String(terminal.at(-1)?.detail ?? ''),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  presenceState.value = { err: null };
  fakeConnection.getParsedTransaction.mockResolvedValue(null);
  fakeConnection.getTokenAccountBalance.mockResolvedValue({
    value: { amount: '1000000000' },
  });
  fakeConnection.getBlockHeight.mockResolvedValue(900);
  fakeConnection.getSlot.mockResolvedValue(200_000_000);
  fakeConnection.getFirstAvailableBlock.mockResolvedValue(1);
  fakeConnection.getSignatureStatuses.mockImplementation(() =>
    Promise.resolve({ value: [presenceState.value] }),
  );
  probeMock.mockResolvedValue({ probe: 'ok' });
  recordSignedMock.mockResolvedValue({ ok: true, attempts: 1 });
  recordConfirmedMock.mockResolvedValue({ ok: true });
  reclaimMock.mockResolvedValue({ ok: true });
  _resetSolanaClients();
});

// ══════════════════════════════════════════════════════════════════════
describe('settleSolanaLeg — el mapeo REAL de lo que el adapter Solana lanza', () => {
  it('T-MAP-01: `settleAlreadyConfirmed` con la cadena incontestable ⟹ el leg publica SETTLE_UNKNOWN', async () => {
    // La fila dice `confirmed` y el probe no puede contestar. El adapter mide
    // "no pude comprobarlo"; si el leg publicara SETTLE_FAILED le estaría
    // afirmando al caller que un pago YA REGISTRADO no ocurrió.
    readMock.mockResolvedValue({ state: 'confirmed', signature: 'PriorSig' });
    claimMock.mockResolvedValue({
      outcome: 'confirmed',
      signature: 'PriorSig',
    });
    fakeConnection.getSignatureStatuses.mockRejectedValue(
      new Error('rpc is down'),
    );

    const { result, code, detail } = await runLeg();

    expect(result).toBeNull(); // el leg no settleó: eso no cambia
    expect(detail).toMatch(/SETTLE_PRESENCE_UNKNOWN/); // salió por ESA rama
    expect(code).toBe('SETTLE_UNKNOWN');
    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('T-MAP-02: `settleAlreadySigned` con la cadena incontestable ⟹ el leg publica SETTLE_UNKNOWN', async () => {
    // Rama distinta del adapter (fila `signed`, no `confirmed`) y por eso test
    // aparte: revertir UNA de las dos tiene que poner en rojo UNA sola.
    readMock.mockResolvedValue({ state: 'signed', signature: 'InFlightSig' });
    claimMock.mockResolvedValue({
      outcome: 'signed',
      signature: 'InFlightSig',
      lastValidBlockHeight: '100',
    });
    fakeConnection.getSignatureStatuses.mockRejectedValue(
      new Error('rpc is down'),
    );

    const { result, code, detail } = await runLeg();

    expect(result).toBeNull();
    expect(detail).toMatch(/SETTLE_IN_FLIGHT_UNRESOLVED/);
    expect(detail).toMatch(/presence unknown/);
    expect(code).toBe('SETTLE_UNKNOWN');
    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('T-MAP-03: tx previa NO settleada pero con el blockhash VIVO ⟹ el leg publica SETTLE_UNKNOWN', async () => {
    // TERCER sitio del marcador `SETTLE_IN_FLIGHT_UNRESOLVED`, el que quedó
    // `Error` pelado cuando WKH-319 arregló los otros dos. Acá la cadena SÍ
    // contestó (`landed_failed`), pero el blockhash todavía no expiró: esa firma
    // puede ejecutarse todavía, así que "no se pagó" es una afirmación que en
    // este punto nadie puede sostener.
    readMock.mockResolvedValue({
      state: 'signed',
      signature: 'FailedButAliveSig',
    });
    claimMock.mockResolvedValue({
      outcome: 'signed',
      signature: 'FailedButAliveSig',
      lastValidBlockHeight: '1500',
    });
    presenceState.value = { err: { InstructionError: [0, 'Custom'] } };
    fakeConnection.getBlockHeight.mockResolvedValue(900); // 900 <= 1500 ⟹ vivo

    const { result, code, detail } = await runLeg();

    expect(result).toBeNull();
    expect(detail).toMatch(/SETTLE_IN_FLIGHT_UNRESOLVED/);
    expect(code).toBe('SETTLE_UNKNOWN');
    // Y no se re-transmitió ni se archivó la firma vieja.
    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
    expect(reclaimMock).not.toHaveBeenCalled();
  });

  it('T-MAP-04 (CANDADO): un veredicto MEDIDO sigue siendo SETTLE_FAILED', async () => {
    // La contracara imprescindible. La cadena contestó, la tx se pudo parsear y
    // el delta acreditado (1) no cubre el monto del leg (3000000): eso es una
    // negativa DEMOSTRADA, no una incógnita. Si este test se pusiera verde con
    // `SETTLE_UNKNOWN`, el fix habría convertido la taxonomía entera en "no sé"
    // y `SETTLE_FAILED` dejaría de significar nada.
    readMock.mockResolvedValue({ state: 'signed', signature: 'MismatchSig' });
    claimMock.mockResolvedValue({
      outcome: 'signed',
      signature: 'MismatchSig',
      lastValidBlockHeight: '100',
    });
    presenceState.value = { err: null };
    fakeConnection.getParsedTransaction.mockResolvedValue({
      meta: {
        err: null,
        preTokenBalances: [
          {
            accountIndex: 1,
            owner: PAY_TO,
            mint: MINT,
            uiTokenAmount: { amount: '0' },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 1,
            owner: PAY_TO,
            mint: MINT,
            uiTokenAmount: { amount: '1' },
          },
        ],
      },
    });

    const { result, code, detail } = await runLeg();

    expect(result).toBeNull();
    expect(detail).toMatch(/SETTLE_SIGNED_TERMS_MISMATCH/);
    expect(code).toBe('SETTLE_FAILED');
    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('T-MAP-05: tx previa sin cota de expiración ⟹ el leg publica SETTLE_UNKNOWN', async () => {
    // CUARTO sitio del pasillo (`SETTLE_SIGNED_UNRESOLVED`). Escenario DISTINTO al
    // de T-MAP-03 a propósito: allá la cota existe y está viva; acá la cota NO
    // EXISTE (`lastValidBlockHeight: null`) y la cadena contestó `absent`. Los dos
    // llegan al mismo veredicto por caminos que no se solapan, así que revertir
    // uno no puede tapar al otro.
    //
    // `absent` sin prueba de expiración NO cierra la pregunta: la tx firmada puede
    // estar todavía en vuelo.
    readMock.mockResolvedValue({ state: 'signed', signature: 'NoHeightSig' });
    claimMock.mockResolvedValue({
      outcome: 'signed',
      signature: 'NoHeightSig',
      lastValidBlockHeight: null,
    });
    presenceState.value = null; // ausente: el nodo buscó su histórico

    const { result, code, detail } = await runLeg();

    expect(result).toBeNull();
    expect(detail).toMatch(/SETTLE_SIGNED_UNRESOLVED/);
    expect(detail).toMatch(/no last_valid_block_height/);
    expect(code).toBe('SETTLE_UNKNOWN');
    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
    expect(reclaimMock).not.toHaveBeenCalled();
  });

  it('T-MAP-06: el adapter que entra al leg es el REAL, no un doble', async () => {
    // El archivo entero depende de esta premisa; sin afirmarla, un `vi.mock`
    // agregado más adelante podría re-introducir el doble y los cuatro tests de
    // arriba seguirían verdes midiendo un fantasma.
    expect(realSolanaAdapter).toBeInstanceOf(SolanaPaymentAdapter);
    expect(realSolanaAdapter.vmFamily).toBe('solana');
    // `settle` NO es una `vi.fn()`: es el método de la clase de producción.
    expect(vi.isMockFunction(realSolanaAdapter.settle)).toBe(false);
    expect(Object.getPrototypeOf(realSolanaAdapter) as unknown).toBe(
      SolanaPaymentAdapter.prototype,
    );
  });
});
