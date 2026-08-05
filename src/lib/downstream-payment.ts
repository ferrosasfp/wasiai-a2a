/**
 * Downstream x402 Payment — chain-aware thin orchestrator (WKH-112 / BASE-07).
 *
 * Resolves the destination chain from `agent.payment.chain` via `normalizeChainSlug`,
 * validates it is initialized in the registry (fail-loud `CHAIN_NOT_SUPPORTED`), and
 * delegates sign + verify + settle to `getPaymentAdapter(chainKey)`. The EIP-3009
 * signature is owned by the adapter (per-chain EIP-712 domain) — NEVER reimplemented
 * inline (CD-9). NEVER throws (CD-7): every async step is wrapped and returns `null`
 * with a skip-code.
 */
import { createPublicClient, erc20Abi, formatUnits, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  classifyDestinationEnvironment,
  findChainEnvironmentDrift,
  getCanonicalChainId,
  isAmbiguousChainAlias,
  type LegDestination,
  normalizeChainSlug,
} from '../adapters/chain-resolver.js';
import {
  hasBroadcastEvidence,
  readSettleValueDisposition,
} from '../adapters/errors.js';
import {
  getAdaptersBundle,
  getInitializedChainKeys,
  getPaymentAdapter,
  getPaymentAdapterOrUnion,
} from '../adapters/registry.js';
// WKH-302: `readPayoutCode` lee el código POR FORMA (typeof === 'string'), nunca
// por `instanceof`, por el mismo motivo documentado en `adapters/errors.ts`.
import { readPayoutCode } from '../adapters/solana/facilitator-settle.js';
import type { ChainKey, SolanaPaymentAdapter } from '../adapters/types.js';
import type { Agent, DownstreamLogger } from '../types/index.js';
// AR MENOR-5: mismo helper de conversión USD→atómico que los 5 adapters de pago
// (fix-pack P1, hallazgo 3). Este módulo es la pata OUTBOUND (lo que el gateway
// paga); usaba `parseUnits(String(...))` y divergía de la pata inbound.
import { usdToAtomicUnits } from './atomic-amount.js';
import { noteSkip } from './downstream-skip-code.js';
import { isValidSolanaAddress, isValidWallet } from './wallet-format.js';

// Fix-pack P1 (hallazgo 4): la taxonomía de skip-codes y su traducción al
// vocabulario público se movieron a un módulo LEAF (`downstream-skip-code.ts`)
// para no romper las suites que mockean ESTE módulo completo. Se re-exporta
// `DownstreamSkipCode` por back-compat (mismo patrón que `DownstreamLogger`).
export type {
  DownstreamSkipCode,
  PublicDownstreamSkipCode,
  SkipCodeSink,
} from './downstream-skip-code.js';
export {
  createSkipCapturingLogger,
  toPublicSkipCode,
} from './downstream-skip-code.js';
// Re-export for backward-compat: callers historically import
// `DownstreamLogger` from this module (e.g. compose.ts). The canonical
// definition now lives in `types/index.ts` (TD-WKH-55-4 / CR-MNR-3).
export type { DownstreamLogger };

// CD-NEW-SDD-3: read the flag ONCE at module load
const DOWNSTREAM_FLAG = process.env.WASIAI_DOWNSTREAM_X402 === 'true';

/**
 * WKH-235a — warn-once del skip `FLAG_OFF`. Era el ÚNICO skip-code que
 * retornaba `null` sin dejar rastro (hallazgo F4 de WKH-241): el campo
 * `downstream` desaparecía del output de `/compose` sin explicación. El flag se
 * lee una sola vez al cargar el módulo, así que un log por proceso alcanza
 * (mismo patrón warn-once que `avalanche/payment.ts` / `discovery.ts`) — se
 * evita ruido por cada leg de cada request.
 */
let _warnedFlagOff = false;

/**
 * EIP-3009 authorization window (`validBefore`) in seconds, passed to
 * `adapter.sign({ ..., timeoutSeconds })`. Reproduces the legacy
 * `VALID_BEFORE_SECONDS = 300` so the Avalanche path keeps its observable 300s
 * window (CD-1). The adapter default is 60s — omitting this regressed the
 * window (AR BLQ-MED-1).
 */
const DOWNSTREAM_AUTH_WINDOW_SECONDS = 300;

/**
 * Maps each `ChainKey` to the env-var NAME that holds its RPC URL (DT-3).
 * This is NOT a hardcode of chain (CD-3 tolerates env-var names): the actual
 * URL comes from the process env at runtime. The `Record<ChainKey, string>`
 * covers all 6 keys to satisfy TS strict, even though only the 3 testnets are
 * exercised in this HU (mainnet is Scope OUT).
 */
const RPC_ENV_BY_CHAIN: Record<ChainKey, string> = {
  'avalanche-fuji': 'FUJI_RPC_URL',
  'avalanche-mainnet': 'AVALANCHE_RPC_URL',
  'base-sepolia': 'BASE_TESTNET_RPC_URL',
  'base-mainnet': 'BASE_MAINNET_RPC_URL',
  'kite-ozone-testnet': 'KITE_RPC_URL',
  'kite-mainnet': 'KITE_MAINNET_RPC_URL',
  // WKH-090 — cuarto rail (testnet-only, flag-gated OFF). Requerido para
  // exhaustividad del Record<ChainKey, string>; dead code con el flag OFF (el
  // rail nunca inicializa un bundle → CHAIN_NOT_SUPPORTED antes de llegar acá).
  'tempo-testnet': 'TEMPO_TESTNET_RPC_URL',
  // WKH-234 — Solana rail. Requerido para exhaustividad del Record<ChainKey>;
  // el settle Solana no usa este env viem-oriented (usa SOLANA_RPC_URL vía el
  // adapter), pero el nombre canónico coincide.
  'solana-devnet': 'SOLANA_RPC_URL',
};

// ─── Public types ───────────────────────────────────────────────────

/**
 * Recibo del ledger para un leg settleado en una familia NO-EVM (hoy sólo
 * Solana). Los dos campos van JUNTOS o no van — de ahí que sean un objeto y no
 * dos opcionales sueltos.
 *
 * Fix-pack CR-MNR-1 (defecto de TIPOS, no de lógica): antes esto eran
 * `settleCaip2?: string` y `settledAmountUsd?: number`, dos opcionales
 * INDEPENDIENTES. La rama Solana los poblaba siempre juntos y la EVM nunca, pero
 * el tipo permitía el tercer estado (uno sin el otro), y `compose` decidía si
 * escribir el recibo por el PRIMERO (`settleCaip2`) y tomaba el monto del
 * SEGUNDO con un `?? stepDebitedUsd`. Un rail nuevo que poblara sólo el CAIP-2
 * habría reescrito `amount_usd = 0` al lado de una firma on-chain REAL, en
 * silencio: exactamente el bug que FIX 3 arregló, representable de nuevo por
 * tipos. Con un único campo anidado el estado inválido no compila y el `??`
 * desaparece del call-site (`compose.ts` → `recordSolanaLegIfAny`).
 */
export interface NonEvmSettleReceipt {
  /**
   * CAIP-2 del leg (`solana:<cluster>`), tal como lo reporta el adapter. Es la
   * señal de que este leg va al ledger de settles no-EVM (AC-8 de WKH-234).
   */
  caip2: string;
  /**
   * Monto REALMENTE settleado al agente, en USD, derivado del atómico que se
   * transfirió + los decimals del token del adapter (round-trip exacto de
   * `parseUnits`). Fix-pack AR-profundo FIX 3: el débito del caller
   * (`stepDebitedUsd` en compose) NO sirve como monto del recibo — vale 0 para
   * el step 0 (lo debita el middleware) e incluye el gas overhead del gateway,
   * que nunca se le paga al agente.
   */
  amountUsd: number;
}

export interface DownstreamResult {
  // WKH-234: namespace-aware. EVM = `0x${string}` (tx hash); Solana = firma
  // base58 del SPL-transfer. Widened a `string` para alojar ambas familias.
  txHash: string;
  blockNumber?: number; // opcional — el adapter SettleResult no lo expone (TD-WKH-112-01)
  settledAmount: string; // atomic units; = value.toString()
  /**
   * Presente SOLO cuando el settle fue en una familia no-EVM (hoy: la rama
   * Solana). Ausente en legs EVM → la rama EVM queda byte-idéntica y `compose`
   * no toca el ledger de settles no-EVM.
   */
  nonEvmSettle?: NonEvmSettleReceipt;
}

// ─── Internal helpers ───────────────────────────────────────────────

/**
 * Fix-pack AR-profundo FIX 1(b) — opt-in EXPLÍCITO para settlear un leg
 * downstream contra una chain MAINNET (dinero real).
 *
 * Contexto del hallazgo: la chain del leg es agent-controlled por diseño (el
 * agente declara `payment.chain` en su card). `base-mainnet` / `kite-mainnet` /
 * `avalanche-mainnet` estaban en `SUPPORTED_CHAINS` SIN gate, a diferencia de
 * `tempo-testnet` / `solana-devnet` (flag-gated en `registry.getSupportedChains`),
 * y el control que la documentación de operación prometía
 * (`WASIAI_DOWNSTREAM_NETWORK`) no lo lee NADIE — era un control muerto.
 *
 * Política (FAIL-CLOSED, default seguro):
 *   - `WASIAI_DOWNSTREAM_MAINNET_ALLOW` ausente o vacía → NINGUNA mainnet
 *     permitida en el leg downstream → skip-code `MAINNET_NOT_ALLOWED`.
 *   - CSV de slugs (acepta cualquier alias que el resolver conozca, incluidos
 *     los numéricos: `avalanche-mainnet`, `43114`, `base-mainnet`, `8453`, …) →
 *     sólo esas mainnets pueden settlear.
 *
 * NO afecta ningún entorno actual (todo el deploy es testnet-only) y NO toca el
 * rail INBOUND: los slugs mainnet siguen en `SUPPORTED_CHAINS` y el debit de
 * budget inbound sigue funcionando igual. Es estrictamente más restrictivo que
 * hoy en la única dirección donde el gateway MUEVE fondos del operador.
 *
 * La env se lee POR LLAMADA (no cacheada al cargar el módulo, a diferencia de
 * `DOWNSTREAM_FLAG`): así el operador puede revertir el opt-in con un redeploy
 * de variables sin depender del orden de import, y el gate es testeable sin
 * `vi.resetModules()`. El costo es una lectura de `process.env` por leg.
 */
function isDownstreamMainnetAllowed(chainKey: ChainKey): boolean {
  const raw = process.env.WASIAI_DOWNSTREAM_MAINNET_ALLOW;
  if (typeof raw !== 'string' || raw.trim().length === 0) return false;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .some((entry) => normalizeChainSlug(entry) === chainKey);
}

/**
 * Valida el payTo del leg DOWNSTREAM y rechaza la zero-address (mitigación R-1).
 * Devuelve `{ ok: true, addr }` o `{ ok: false, code }`.
 *
 * Fix-pack it2 BLQ-BAJO-1: el criterio de FORMATO EVM es `isValidWallet`
 * (`wallet-format.ts`, la ÚNICA fuente de verdad del regex `0x`+40hex — CD-1 de
 * WKH-143b). Esta función NO repite el regex: le agrega encima el rechazo de la
 * zero-address, que es una regla propia del leg downstream.
 *
 * ⚠️ ALCANCE (fix-pack CR-MNR-4). Esta función es INTERNA a este módulo y hoy
 * cubre el ÚNICO leg de salida que existe.
 *
 * HU-DOUBLE-PAY: el docstring anterior describía una asimetría deliberada entre
 * "este gate" y un segundo camino que firmaba sin rechazar la zero-address (el
 * mal llamado "sign INBOUND" de `compose.invokeAgent`, guard
 * `inboundVmUnsupported`), trackeada como `TD-INBOUND-ZERO-PAYTO`. Ese camino
 * era un SEGUNDO pago de salida del wallet del operador y se borró, así que la
 * asimetría desapareció con él: ya no hay ningún settle del gateway que acepte
 * un payTo `0x0`, y la deuda queda CERRADA por eliminación del otro lado.
 */
function validatePayTo(
  contract: string,
):
  | { ok: true; addr: `0x${string}` }
  | { ok: false; code: 'INVALID_PAY_TO_FORMAT' | 'ZERO_PAY_TO' } {
  // `isValidWallet` narrowea a `` `0x${string}` `` (CR-MNR-4) → sin cast crudo.
  if (!isValidWallet(contract)) {
    return { ok: false, code: 'INVALID_PAY_TO_FORMAT' };
  }
  if (contract.toLowerCase() === '0x0000000000000000000000000000000000000000') {
    return { ok: false, code: 'ZERO_PAY_TO' };
  }
  return { ok: true, addr: contract };
}

/**
 * WKH-234 — settle de UN leg Solana (settle-only, operator-signed). Espejo
 * funcional de la rama EVM pero SIN el dance sign→verify→settle: el adapter
 * Solana hace build+sign+broadcast+confirm (idempotente por `intentId`, AC-7).
 * NEVER-throws (CD-10): retorna `null` + skip-code, nunca lanza. Monto atómico
 * decimals-aware desde el adapter (CD-9).
 *
 * CR-2 (WKH-234): antes de settlear corre un pre-flight de balance del operador
 * (mismo skip-code `INSUFFICIENT_BALANCE` que la rama EVM), fail-soft si el
 * balance no se puede leer — ver el comentario del bloque.
 *
 * NOTA (fix-pack AR-MNR-2): el settle FRESCO confía en la confirmación de
 * `sendAndConfirmTransaction` (commitment configurado); el `verify()` on-chain
 * del adapter sólo corre en el camino idempotente-hit (re-lee una firma previa
 * antes de reusarla). Este helper NO invoca verify() en el settle fresco.
 */
async function settleSolanaLeg(
  agent: Agent,
  adapter: SolanaPaymentAdapter,
  logger: DownstreamLogger,
  // WKH-307 (DT-9): OBLIGATORIO. Ver el guard de abajo — el fallback derivado que
  // vivia aca era una trampa que un store durable vuelve permanente.
  intentId: string | undefined,
): Promise<DownstreamResult | null> {
  // payTo base58 (CD-9) — NO 0x. Validador puro (sin web3.js).
  const payTo = agent.payment?.contract ?? '';
  if (!isValidSolanaAddress(payTo)) {
    logger.warn(
      { agentSlug: agent.slug, code: 'INVALID_PAY_TO_FORMAT' },
      '[Downstream] solana payTo is not a valid base58 pubkey',
    );
    return null;
  }

  // priceUsdc guard (mismo criterio que la rama EVM).
  if (!Number.isFinite(agent.priceUsdc) || agent.priceUsdc <= 0) {
    logger.warn(
      {
        agentSlug: agent.slug,
        code: 'INVALID_PRICE',
        priceUsdc: agent.priceUsdc,
      },
      '[Downstream] priceUsdc must be a finite positive number',
    );
    return null;
  }

  // Monto atómico decimals-aware desde el mint del adapter (CD-9, nunca 1e6/1e18).
  const token = adapter.supportedTokens[0];
  if (!token) {
    logger.warn(
      { agentSlug: agent.slug, code: 'INVALID_PRICE' },
      '[Downstream] solana adapter has no supported tokens',
    );
    return null;
  }
  // AR MENOR-5 (extendido): la pata Solana tenía el MISMO
  // `parseUnits(String(priceUsdc))` que el sitio EVM de abajo. El AR marcó un solo
  // sitio, pero el bug es de clase — se alinean los dos por el helper compartido.
  let amountAtomic: string;
  try {
    amountAtomic = usdToAtomicUnits(agent.priceUsdc, token.decimals);
  } catch (e) {
    logger.warn(
      { agentSlug: agent.slug, code: 'INVALID_PRICE', detail: String(e) },
      '[Downstream] atomic amount conversion failed (solana)',
    );
    return null;
  }
  // Fail-closed idéntico al del sitio EVM: no se broadcastea un transfer de 0.
  if (amountAtomic === '0') {
    logger.warn(
      {
        agentSlug: agent.slug,
        code: 'INVALID_PRICE',
        priceUsdc: agent.priceUsdc,
        decimals: token.decimals,
      },
      '[Downstream] priceUsdc rounds to 0 atomic units for this mint (solana)',
    );
    return null;
  }

  // Idempotency key determinístico del leg (AC-7). Fallback si el caller no lo
  // pasó: `<slug>:<payTo>` (estable por leg). Canónico: `contextId:stepIndex:payTo`.
  //
  // Fix-pack AR-profundo FIX 2: se resuelve ANTES del pre-flight de balance. El
  // orden importa: un intent YA settleado no necesita fondos. Con el pre-check
  // primero, el hit idempotente del adapter era inalcanzable exactamente cuando
  // el balance del operador había bajado del precio del leg — que es lo que pasa
  // DESPUÉS de haber pagado ese mismo leg ⇒ el retry devolvía `null` con
  // `INSUFFICIENT_BALANCE`, sin recibo ni `settle_signature` en el ledger, y el
  // log afirmaba lo contrario de la verdad (un pago SPL real reportado como no
  // pagado).
  // ⚠️ WKH-307 (DT-9) — ACA VIVIA `intentId ?? `${agent.slug}:${payTo}``, Y SE ELIMINO.
  //
  // Ese fallback derivaba la clave de idempotencia del NOMBRE del agente y su
  // DIRECCION DE COBRO: una clave IDENTICA para todos los pagos a ese agente, para
  // siempre. Con el `Map` + TTL era casi inocuo (deduplicaba ~50 min y expiraba).
  //
  // Con el registro DURABLE significa que **el agente cobra una sola vez en su vida**:
  // el primer pago queda `confirmed`, y todo pago futuro encuentra la fila, re-verifica
  // la firma vieja on-chain (que es valida, porque ese pago SI ocurrio), la devuelve, y
  // NO transfiere un centavo — reportando EXITO. El agente trabaja gratis y nadie se
  // entera.
  //
  // Hoy es inalcanzable (los dos call-sites de produccion pasan `${composeRunId}:${i}`),
  // y por eso mismo se elimina: es el ejemplo canonico de una linea inofensiva que se
  // vuelve catastrofica cuando arreglas otra cosa. Dejarla "por las dudas" ES el bug.
  //
  // Tampoco se deriva un `randomUUID()`: un identificador distinto en cada intento
  // DESACTIVA la idempotencia entera y convierte cualquier retry en un pago nuevo.
  if (intentId === undefined || intentId.length === 0) {
    logger.warn(
      { agentSlug: agent.slug, code: 'MISSING_INTENT_ID' },
      '[Downstream] solana leg refused — no idempotency key was supplied; without a stable intentId a retry cannot be told apart from a new payment',
    );
    return null;
  }
  const legIntentId = intentId;

  // WKH-307: el peek es ASINCRONO y discriminado. `settled`/`in_progress` SONDEAN
  // (no cortan); `none` y `unknown` GATEAN — y `unknown` con su propio codigo, porque
  // "el store no contesta" no es "no se pago".
  const prior = await adapter.getSettledSignature(legIntentId);
  if (prior.state === 'unknown') {
    logger.warn(
      {
        agentSlug: agent.slug,
        code: 'SETTLE_LEDGER_UNAVAILABLE',
        intentId: legIntentId,
      },
      '[Downstream] solana leg refused — the settle ledger did not answer, so the gateway cannot tell whether this intent was already paid (fail-closed)',
    );
    return null;
  }

  // Pre-flight de balance del operador — paridad de observabilidad con la rama
  // EVM (CR-2 de WKH-234). Corta temprano con el MISMO skip-code
  // `INSUFFICIENT_BALANCE` que el paso 9 del path EVM, en vez de dejar que el
  // settle falle-soft con un `SETTLE_FAILED` genérico que no distingue "no hay
  // fondos" de "falló el RPC" o "la tx se rechazó".
  //
  // NO BLOQUEA cuando el intent ya tiene firma (FIX 2): el settle de abajo va a
  // tomar el camino idempotente (verify on-chain de la firma previa + retorno
  // sin re-broadcast), que no mueve fondos nuevos.
  //
  // ASIMETRÍA DELIBERADA vs EVM: si el balance NO se puede leer, acá NO se
  // bloquea el settle (la rama EVM sí corta con `BALANCE_READ_FAILED`). El
  // pre-check es una optimización de observabilidad, NO un gate nuevo: en Solana
  // la lectura del ATA del operador lanza tanto por RPC caído como porque la
  // cuenta todavía no existe, y ambas son indistinguibles a este nivel →
  // tratarlas como "fondos insuficientes" bloquearía settles legítimos (falso
  // negativo). Se degrada a "balance desconocido, intentá el settle" y el error
  // real, si lo hay, sigue apareciendo como `SETTLE_FAILED`.
  //
  // Fix-pack it2 MNR-1: en el replay idempotente el pre-check pasa de GATE a
  // SONDA (se lee el balance, pero un balance bajo NUNCA corta).
  //
  // ⚠️ WKH-307 CORRIGIÓ ESTE COMENTARIO. Decía que `settle()` podía tomar un camino
  // SELF-HEAL que «borra la firma del seam y re-broadcastea FRESCO». **Eso ya no
  // existe**: con el registro durable, una firma registrada que la cadena no respalda
  // hace que `settle()` RECHACE (ver `solana/payment.ts`, rama `confirmed`), porque
  // sus causas —contabilidad corrupta, un RPC mintiendo, o un fork— no se arreglan
  // pagando de nuevo.
  //
  // El motivo de que la sonda siga siendo sonda y no vuelva a ser gate es OTRO, y
  // sigue en pie: un intent ya reclamado puede terminar re-firmando por una vía
  // legítima (la firma anterior expiró sin aterrizar, o aterrizó con error), y ahí un
  // corte por fondos perdería la distinguibilidad `INSUFFICIENT_BALANCE` vs
  // `SETTLE_FAILED` en los logs. La sonda la conserva sin reintroducir el falso
  // negativo que el FIX 2 arregló (un leg YA pagado jamás se reporta como no pagado).
  // `settled` (ya pagado) e `in_progress` (reclamado, sin confirmar) SONDEAN: los dos
  // pueden terminar en el camino idempotente de `settle()`, y si no, `settle()`
  // fail-closea igual. `none` GATEA, como siempre.
  const isIdempotentReplay =
    prior.state === 'settled' || prior.state === 'in_progress';

  // WKH-302 — UNA SOLA lectura de la bandera para todo este leg, a una const, y la
  // MISMA const se usa en los dos lugares (pre-check y clasificación del catch).
  // Con la bandera ON el gateway deja de tener autoridad sobre esa wallet: la
  // relevante es la del facilitator, así que este pre-check se saltea ENTERO (ni
  // siquiera se llama a `getOperatorSplBalance()`, que resuelve el keypair local).
  // La distinguibilidad `INSUFFICIENT_BALANCE` no se pierde: se recupera del error,
  // cuando el adapter lanza con `payoutCode === 'PAYOUT_FUNDING_LOW'` (ver el catch).
  const viaFacilitator = process.env.SOLANA_SETTLE_VIA_FACILITATOR === 'true';

  let operatorBalance: bigint | undefined;
  if (!viaFacilitator) {
    try {
      operatorBalance = BigInt(await adapter.getOperatorSplBalance());
    } catch (e) {
      logger.info(
        {
          agentSlug: agent.slug,
          code: 'BALANCE_PRECHECK_SKIPPED',
          detail: String(e),
          ...(isIdempotentReplay ? { intentId: legIntentId } : {}),
        },
        '[Downstream] solana balance pre-check skipped (operator SPL balance unreadable)',
      );
    }
  }
  const insufficient =
    operatorBalance !== undefined && operatorBalance < BigInt(amountAtomic);
  if (insufficient && isIdempotentReplay) {
    // NO corta: el intent ya tiene firma. Si el settle termina re-broadcasteando
    // fresco (self-heal) y falla, este log explica POR QUÉ (fondos), en vez de
    // dejar sólo un `SETTLE_FAILED` genérico.
    logger.info(
      {
        agentSlug: agent.slug,
        code: 'BALANCE_LOW_ON_IDEMPOTENT_REPLAY',
        intentId: legIntentId,
        balance: operatorBalance?.toString(),
        required: amountAtomic,
      },
      '[Downstream] solana operator SPL balance below the leg amount, but the intent is already settled — replay allowed (a self-heal re-broadcast would fail on-chain)',
    );
  } else if (insufficient) {
    logger.warn(
      {
        agentSlug: agent.slug,
        code: 'INSUFFICIENT_BALANCE',
        balance: operatorBalance?.toString(),
        required: amountAtomic,
      },
      '[Downstream] insufficient solana operator SPL balance',
    );
    return null;
  }

  // settle: build+sign+broadcast+confirm + verify-before-trust interno.
  let settleRes: Awaited<ReturnType<typeof adapter.settle>>;
  try {
    settleRes = await adapter.settle({
      payTo,
      amountAtomic,
      intentId: legIntentId,
    });
  } catch (e) {
    // ⚑ BLOQUE CONVERGENTE — WKH-302 (AC-10) y WKH-308 escribieron ESTE MISMO cambio
    // por separado, desde repos distintos y con motivaciones distintas, y llegaron a
    // la misma línea. Se conservan los dos razonamientos porque son complementarios:
    // uno explica por qué hacía falta, el otro por qué era urgente.
    //
    // WKH-308 (el daño que ya existía): este catch COLAPSABA todo throw en
    // `SETTLE_FAILED`, o sea que le afirmaba al caller "el leg no se pagó" incluso
    // cuando el adapter acababa de decir que NO PUDO COMPROBARLO. Un settle que sí
    // ocurrió quedaba registrado como impago, y ese dato falso es el insumo de
    // cualquier job futuro que trate esas filas como pendientes.
    //
    // WKH-302 (por qué empeora al mudar el transporte): `SETTLE_FAILED` dispara
    // reembolso y/o re-envío del hop. Aplanar era tolerable mientras la firma era
    // LOCAL (si `sendAndConfirmTransaction` tiraba, casi siempre era determinístico),
    // pero al pasar a una llamada HTTP el leg hereda fallas de red que ocurren
    // DESPUÉS de que el facilitator pudo haber transmitido.
    //
    // Espejo EXACTO del leg EVM (ver el catch de `adapter.settle` más abajo).
    // `SETTLE_UNKNOWN` NO es vocabulario nuevo: ya existe, ya es público sin
    // genericizar (`downstream-skip-code.ts`) y los callers ya lo reciben hoy por EVM.
    //
    // Con la bandera OFF, `readSettleValueDisposition` devuelve `undefined` para los
    // errores del camino legado y el resultado es EXACTAMENTE el de hoy — que es lo
    // que mantiene AC-4 en pie.
    const disposition = readSettleValueDisposition(e);
    const payoutCode = readPayoutCode(e);
    const code =
      payoutCode === 'PAYOUT_FUNDING_LOW'
        ? 'INSUFFICIENT_BALANCE'
        : disposition === 'unknown'
          ? 'SETTLE_UNKNOWN'
          : 'SETTLE_FAILED';
    logger.warn(
      {
        agentSlug: agent.slug,
        code,
        ...(disposition ? { valueDisposition: disposition } : {}),
        detail: String(e),
      },
      code === 'SETTLE_UNKNOWN'
        ? '[Downstream] solana adapter.settle threw with UNKNOWN value disposition — the leg may already be paid on-chain; do NOT retry blindly'
        : '[Downstream] solana adapter.settle threw',
    );
    return null;
  }
  if (!settleRes.success || !settleRes.txHash) {
    logger.warn(
      { agentSlug: agent.slug, code: 'SETTLE_FAILED', error: settleRes.error },
      '[Downstream] solana adapter.settle returned success=false',
    );
    return null;
  }

  return {
    txHash: settleRes.txHash, // firma base58 del SPL-transfer
    settledAmount: amountAtomic,
    // Fix-pack AR-BLQ-1 + FIX 3, unificados en UN campo (CR-MNR-1): el CAIP-2
    // del adapter y el monto settleado en USD van SIEMPRE juntos, porque son las
    // dos mitades del mismo recibo del ledger (AC-8 — settle_caip2 +
    // settle_signature + amount_usd). El monto se deriva del MISMO atómico que se
    // transfirió y de los decimals del mint del adapter (round-trip exacto de
    // `parseUnits`), no del débito del caller.
    nonEvmSettle: {
      caip2: adapter.caip2ChainId,
      amountUsd: Number(formatUnits(BigInt(amountAtomic), token.decimals)),
    },
  };
}

// ─── Public API (SINGLE functional export) ──────────────────────────

/**
 * Resolve the destination chain, delegate sign + verify + settle to its adapter.
 * NEVER throws (CD-7).
 *
 * Returns `null` in any of these cases (each logged with its skip-code):
 *  - flag `WASIAI_DOWNSTREAM_X402` is not 'true'        → FLAG_OFF (warn-once)
 *  - agent.payment absent                               → NO_PAYMENT_FIELD
 *  - method !== 'x402'                                  → METHOD_NOT_SUPPORTED
 *  - chain unrecognized or not initialized in registry  → CHAIN_NOT_SUPPORTED
 *  - slug ↔ real destination disagree on testnet/mainnet → CHAIN_ENVIRONMENT_DRIFT
 *    (fix-pack CR-MNR-5: código PROPIO; NO se opta-in, se bloquea siempre)
 *  - chain is MAINNET without explicit env opt-in       → MAINNET_NOT_ALLOWED
 *  - payTo invalid or zero                              → INVALID_PAY_TO_FORMAT / ZERO_PAY_TO
 *  - priceUsdc not a finite positive number             → INVALID_PRICE
 *  - operator balance < required value                  → INSUFFICIENT_BALANCE
 *  - balance read RPC failure (EVM only)                → BALANCE_READ_FAILED
 *  - adapter.sign throws                                → SIGNING_FAILED
 *  - adapter.verify throws or returns valid=false       → VERIFY_FAILED
 *  - adapter.settle throws or returns success=false     → SETTLE_FAILED
 *  - adapter.settle throws con valueDisposition 'unknown' → SETTLE_UNKNOWN
 *    (HU-198: el hop al facilitator no contestó ⇒ el leg PUEDE estar pagado
 *    on-chain. NO es "no se pagó" y NO se reintenta a ciegas.)
 *
 * Códigos que se emiten SIN cortar el leg (observabilidad — el catálogo anterior
 * los omitía aunque salen en el mismo campo `code`; fix-pack CR-MNR-5):
 *  - no RPC env (EVM, paso 9 `if (!rpc)`) o ATA ilegible (Solana)
 *                                                       → BALANCE_PRECHECK_SKIPPED
 *  - replay idempotente Solana con balance bajo         → BALANCE_LOW_ON_IDEMPOTENT_REPLAY
 *
 * ⚠️ `BALANCE_PRECHECK_SKIPPED` NO es benigno en mainnet: significa que el leg va
 * a FIRMAR sin haber verificado fondos. Para que el pre-check EVM corra hacen falta
 * DOS cosas: `RPC_ENV_BY_CHAIN[chainKey]` seteada (ver el mapa arriba: el rail
 * `avalanche-mainnet` lee `AVALANCHE_RPC_URL`, NO `AVALANCHE_MAINNET_RPC_URL` — esa
 * última es del facilitator) **y** un `OPERATOR_PRIVATE_KEY` que empiece con `0x`.
 * ⚠️ Pero el CÓDIGO sólo se emite por la primera: si falta la PK, el pre-check se
 * saltea EN SILENCIO (re-CR MENOR-4 — antes este catálogo prometía una señal que no
 * existe). Ver la nota completa en `DownstreamSkipCode`, arriba.
 *
 * Returns `DownstreamResult` ONLY when the adapter confirmed `success: true`.
 */
export async function signAndSettleDownstream(
  agent: Agent,
  logger: DownstreamLogger,
  // WKH-234: idempotency key para el leg Solana (AC-7). Solo lo consume la rama
  // Solana; la rama EVM lo ignora (usa el nonce EIP-3009). Ausente → derivado
  // del leg (agent.slug:payTo). Formato canónico: `contextId:stepIndex:payTo`.
  intentId?: string,
): Promise<DownstreamResult | null> {
  // 1. Flag check (zero overhead when off). WKH-235a: observabilidad warn-once
  //    del skip — el comportamiento NO cambia (sigue devolviendo `null` sin
  //    resolver ningún adapter).
  if (!DOWNSTREAM_FLAG) {
    // Fix-pack P1 (hallazgo 4): el `code` se registra en CADA request, aparte
    // del log. El log es warn-once por proceso (WKH-235a), así que a partir del
    // 2º request el decorador de logger no vería nada y la respuesta HTTP
    // perdería la señal de skip. El comportamiento del LOG no cambia.
    noteSkip(logger, 'FLAG_OFF');
    if (!_warnedFlagOff) {
      _warnedFlagOff = true;
      logger.info(
        { agentSlug: agent.slug, code: 'FLAG_OFF' },
        '[Downstream] WASIAI_DOWNSTREAM_X402 not enabled — downstream settle skipped (logged once per process)',
      );
    }
    return null;
  }

  // 2. agent.payment presence
  if (!agent.payment) {
    logger.info(
      { agentSlug: agent.slug, code: 'NO_PAYMENT_FIELD' },
      '[Downstream] agent.payment absent — skipped',
    );
    return null;
  }

  // 3. method check
  if (agent.payment.method !== 'x402') {
    logger.info(
      {
        agentSlug: agent.slug,
        method: agent.payment.method,
        code: 'METHOD_NOT_SUPPORTED',
      },
      `[Downstream] method=${agent.payment.method} not supported — skipped`,
    );
    return null;
  }

  // 4. Resolve the chain ONCE (CD-6). Fail-loud if unrecognized or not
  //    initialized in the registry — PROHIBITED to fall back to a default
  //    or cross-chain (CD-4 / AC-4).
  const chainKey = normalizeChainSlug(agent.payment.chain);
  const bundle = chainKey ? getAdaptersBundle(chainKey) : undefined;
  if (!chainKey || !bundle) {
    logger.warn(
      {
        agentSlug: agent.slug,
        chain: agent.payment.chain,
        code: 'CHAIN_NOT_SUPPORTED',
        initialized: getInitializedChainKeys(),
      },
      `[Downstream] chain=${agent.payment.chain} not supported/initialized — skipped`,
    );
    return null;
  }

  // 4-bis. Alias AMBIGUO — telemetría, NO rechazo (primera mitad de la postura
  //        C, ver `isAmbiguousChainAlias`). El agente nombró la red sin decir su
  //        entorno (`base` / `avalanche` / `tempo` / `solana`). Desde el fix de
  //        simetría TODOS esos alias resuelven a testnet, así que el leg es
  //        seguro; esto sólo cuenta quién los usa para poder migrarlos antes de
  //        pasar a rechazarlos. NO corta el settle a propósito: 16 de los 25
  //        agentes del catálogo vivo declaran `avalanche`.
  //
  //        ⚠️ SOBRE-CUENTA CONOCIDA (`TD-CHAIN-ALIAS-AMBIGUO`): el colapso
  //        legacy CD-2 de `readPaymentSpec` reescribe el slug EXPLÍCITO
  //        `avalanche-testnet` → `avalanche`, así que un agente que declaró
  //        bien igual aparece acá. Este contador mide lo que LLEGA al leg, no lo
  //        que el agente declaró. Antes de pasar a rechazar hay que medir en el
  //        reader (sobre el string crudo) o sacar el colapso; si no, el rechazo
  //        rompería agentes que hicieron lo correcto.
  if (isAmbiguousChainAlias(agent.payment.chain)) {
    logger.warn(
      {
        agentSlug: agent.slug,
        declared: agent.payment.chain,
        resolvedChain: chainKey,
        code: 'AMBIGUOUS_CHAIN_ALIAS',
      },
      `[Downstream] chain='${agent.payment.chain}' does not state its environment — resolved to '${chainKey}' (testnet). Declare an explicit slug; ambiguous aliases will be rejected in a future release`,
    );
  }

  // 4a. WKH-234 — resolución del adapter (lectura del Map del registry, NO mueve
  //     fondos). Se hace ANTES del gate de mainnet porque el gate necesita el id
  //     AUTORITATIVO del destino de cada familia (chainId EVM vs CAIP-2 Solana).
  const adapterUnion = getPaymentAdapterOrUnion(chainKey);

  // 4b. Fix-pack AR-profundo FIX 1(b) + it2 BLQ-ALTO-1 — gate FAIL-CLOSED de
  //     mainnet. La chain del leg la declara el AGENTE; sin opt-in explícito por
  //     env, un agent card podía dirigir el settle (fondos del operador) a una
  //     chain de dinero real. Sin `WASIAI_DOWNSTREAM_MAINNET_ALLOW` NINGUNA
  //     mainnet settlea. NO toca el rail inbound (los slugs siguen soportados).
  //
  //     ⚠️ El mainnet-ness se decide por el DESTINO REAL del leg, NO por el
  //     string del slug (bug it2 BLQ-ALTO-1): el bundle de `kite-ozone-testnet`
  //     se construye sin `opts` y `getKiteChain()` lee `KITE_NETWORK` en
  //     call-time, así que con `KITE_NETWORK=mainnet` ese slug "testnet" apunta a
  //     chainId 2366 (USDC.e de Kite MAINNET) y el gate por slug lo dejaba pasar
  //     con la env vacía. Ahora se clasifica `bundle.chainConfig.chainId` (EVM) /
  //     `adapter.caip2ChainId` (Solana) contra un mapa exhaustivo; un chainId sin
  //     clasificar cuenta como mainnet (fail-closed).
  const destination: LegDestination =
    adapterUnion.vmFamily === 'solana'
      ? { vmFamily: 'solana', caip2ChainId: adapterUnion.caip2ChainId }
      : { vmFamily: 'evm', chainId: bundle.chainConfig.chainId };

  // 4b-i. Incoherencia slug ↔ destino: se bloquea SIEMPRE, sin opt-in posible
  //       (el opt-in se expresa por slug, y un slug que miente sobre su entorno
  //       no puede ser la llave de nada). `initAdapters` además rompe al
  //       arrancar ante esta misma condición — este guard es la red por-leg.
  const drift = findChainEnvironmentDrift({ chainKey, destination });
  if (drift) {
    logger.warn(
      {
        agentSlug: agent.slug,
        chain: chainKey,
        declared: agent.payment.chain,
        // Fix-pack CR-MNR-5: código PROPIO. Antes esto se logueaba como
        // `MAINNET_NOT_ALLOWED` + `reason`, y eso metía en el mismo contador dos
        // cosas distintas: "el agente pidió mainnet sin opt-in" (sano) y
        // "nuestra config es incoherente" — que incluye el caso
        // declared=mainnet/actual=testnet, donde permitir mainnet no tiene nada
        // que ver. El drift NO admite opt-in (ver 4b-i), así que tampoco debe
        // compartir el código con el gate que SÍ lo admite.
        code: 'CHAIN_ENVIRONMENT_DRIFT',
        declaredEnvironment: drift.declared,
        actualEnvironment: drift.actual,
        expectedChainId: getCanonicalChainId(chainKey),
        ...(destination.vmFamily === 'evm'
          ? { actualChainId: destination.chainId }
          : { actualCaip2: destination.caip2ChainId }),
      },
      `[Downstream] chain=${chainKey} declares ${drift.declared} but its bundle points to a ${drift.actual} destination — incoherent config, settle skipped`,
    );
    return null;
  }

  if (
    classifyDestinationEnvironment(destination) === 'mainnet' &&
    !isDownstreamMainnetAllowed(chainKey)
  ) {
    logger.warn(
      {
        agentSlug: agent.slug,
        chain: chainKey,
        declared: agent.payment.chain,
        code: 'MAINNET_NOT_ALLOWED',
        reason: 'NO_OPT_IN',
        ...(destination.vmFamily === 'evm'
          ? { actualChainId: destination.chainId }
          : { actualCaip2: destination.caip2ChainId }),
      },
      `[Downstream] chain=${chainKey} is MAINNET and not opted-in via WASIAI_DOWNSTREAM_MAINNET_ALLOW — settle skipped`,
    );
    return null;
  }

  // 4c. WKH-234 — narrow por vmFamily. El leg Solana es settle-only (SPL
  //     transfer operator-signed): NO el dance EVM sign→verify→settle. Tiene su
  //     propia validación base58 + atómico decimals-aware. La rama EVM (pasos
  //     5-13) queda INTACTA byte-idéntica (AC-4). NEVER-throws preservado (CD-10).
  if (adapterUnion.vmFamily === 'solana') {
    return settleSolanaLeg(agent, adapterUnion, logger, intentId);
  }
  if (adapterUnion.vmFamily !== 'evm') {
    // Exhaustividad (CD-5): unión discriminada agotada.
    const _never: never = adapterUnion;
    return _never;
  }

  // 5. payTo validation (R-1)
  const payToCheck = validatePayTo(agent.payment.contract);
  if (!payToCheck.ok) {
    logger.warn(
      {
        agentSlug: agent.slug,
        contract: agent.payment.contract,
        code: payToCheck.code,
      },
      '[Downstream] payTo validation failed',
    );
    return null;
  }

  // 6. priceUsdc guard (non-finite / non-positive)
  if (!Number.isFinite(agent.priceUsdc) || agent.priceUsdc <= 0) {
    logger.warn(
      {
        agentSlug: agent.slug,
        code: 'INVALID_PRICE',
        priceUsdc: agent.priceUsdc,
      },
      '[Downstream] priceUsdc must be a finite positive number',
    );
    return null;
  }

  // 7. Resolve the adapter (same chainKey — CD-6). `getPaymentAdapter` could
  //    throw if the registry were uninitialized, but step 4 already validated
  //    `getAdaptersBundle(chainKey) !== undefined`.
  const adapter = getPaymentAdapter(chainKey);

  // 8. Compute the atomic value with the ADAPTER's decimals (CD-8). Kite/PYUSD
  //    is 18-dec — using a fixed 6 would sign a 10^12× wrong value.
  const primaryToken = adapter.supportedTokens[0];
  if (!primaryToken) {
    logger.warn(
      { agentSlug: agent.slug, code: 'INVALID_PRICE' },
      '[Downstream] adapter has no supported tokens',
    );
    return null;
  }
  const decimals = primaryToken.decimals;
  // AR MENOR-5: 6º sitio de conversión USD → atómico, ahora por el MISMO helper
  // que los 5 adapters (hallazgo 3). Antes era `parseUnits(String(priceUsdc))`:
  // esta pata (OUTBOUND, lo que el gateway PAGA) y la pata inbound (el challenge
  // 402) convertían distinto para precios en notación científica —
  // `priceUsdc = 1e-7` daba challenge `0` (el helper expande el exponente) y acá
  // `INVALID_PRICE` (`parseUnits` LANZA con `'1e-7'`). El fix del hallazgo 3
  // alineó los 5 adapters entre sí; esto cierra la divergencia inbound↔outbound.
  //
  // Dato a favor de que es seguro: esta línea NUNCA tuvo el artefacto de
  // `toFixed` (usaba `String`), así que para todo precio con representación
  // decimal plana el resultado es byte-idéntico — `toPlainDecimalString` es
  // `String()` salvo cuando hay exponente.
  let value: bigint;
  try {
    value = BigInt(usdToAtomicUnits(agent.priceUsdc, decimals));
  } catch (e) {
    logger.warn(
      { agentSlug: agent.slug, code: 'INVALID_PRICE', detail: String(e) },
      '[Downstream] atomic amount conversion failed',
    );
    return null;
  }
  // Guard fail-closed del cambio de arriba: un precio sub-grilla que ANTES
  // lanzaba (notación científica) ahora convierte, y para 6 decimales puede
  // redondear a 0 unidades atómicas. Broadcastear un transfer de 0 quema gas y
  // deja un recibo que dice que se pagó cuando no se movió nada. Se trata como
  // precio inválido (mismo código que el guard de `priceUsdc <= 0`).
  if (value === 0n) {
    logger.warn(
      {
        agentSlug: agent.slug,
        code: 'INVALID_PRICE',
        priceUsdc: agent.priceUsdc,
        decimals,
      },
      '[Downstream] priceUsdc rounds to 0 atomic units for this token',
    );
    return null;
  }

  // 9. Pre-flight balance check, chain-aware (DT-3). Ephemeral public client
  //    derived from the bundle chainId + the RPC env for this chain. Fail-soft
  //    when no RPC is configured (the facilitator will still settle).
  const rpc = process.env[RPC_ENV_BY_CHAIN[chainKey]];
  if (!rpc) {
    logger.info(
      {
        agentSlug: agent.slug,
        chain: chainKey,
        code: 'BALANCE_PRECHECK_SKIPPED',
      },
      `[Downstream] balance pre-check skipped (no RPC for ${chainKey})`,
    );
  } else {
    const pk = process.env.OPERATOR_PRIVATE_KEY;
    if (pk?.startsWith('0x')) {
      const operator = privateKeyToAccount(pk as `0x${string}`).address;
      const publicClient = createPublicClient({
        chain: {
          id: bundle.chainConfig.chainId,
          name: bundle.chainConfig.name,
          nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: { default: { http: [rpc] } },
        },
        transport: http(rpc),
      });
      let balance: bigint;
      try {
        balance = (await publicClient.readContract({
          address: adapter.getToken(),
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [operator],
        })) as bigint;
      } catch (e) {
        logger.warn(
          {
            agentSlug: agent.slug,
            code: 'BALANCE_READ_FAILED',
            detail: String(e),
          },
          '[Downstream] balance read RPC failed',
        );
        return null;
      }
      if (balance < value) {
        logger.warn(
          {
            agentSlug: agent.slug,
            code: 'INSUFFICIENT_BALANCE',
            balance: balance.toString(),
            required: value.toString(),
          },
          '[Downstream] insufficient balance',
        );
        return null;
      }
    }
  }

  // 10-12. Delegate sign + verify + settle to the adapter (CD-9). The whole
  //         block is wrapped to preserve NEVER-throws (CD-7): adapter.verify /
  //         adapter.settle CAN throw (e.g. Kite pieverse network error).
  try {
    // 10. Sign EIP-3009 via the adapter (per-chain EIP-712 domain).
    let signed: Awaited<ReturnType<typeof adapter.sign>>;
    try {
      signed = await adapter.sign({
        to: payToCheck.addr,
        value: value.toString(),
        // CD-1 / AR BLQ-MED-1: preserve the legacy 300s EIP-3009 window.
        timeoutSeconds: DOWNSTREAM_AUTH_WINDOW_SECONDS,
      });
    } catch (e) {
      logger.warn(
        { agentSlug: agent.slug, code: 'SIGNING_FAILED', detail: String(e) },
        '[Downstream] adapter.sign failed',
      );
      return null;
    }

    // The network for verify/settle comes from the SAME signed.paymentRequest
    // (coherence chain — CD-6 / AC-5). Fall back to adapter.getNetwork() only
    // to satisfy TS strict (network is string|undefined in the type, but the
    // adapters always populate it); both resolve to the SAME chain.
    const network = signed.paymentRequest.network ?? adapter.getNetwork();
    const proof = {
      authorization: signed.paymentRequest.authorization,
      signature: signed.paymentRequest.signature,
      network,
    };

    // 11. Verify via the adapter.
    let verifyRes: Awaited<ReturnType<typeof adapter.verify>>;
    try {
      verifyRes = await adapter.verify(proof);
    } catch (e) {
      logger.warn(
        { agentSlug: agent.slug, code: 'VERIFY_FAILED', detail: String(e) },
        '[Downstream] adapter.verify threw',
      );
      return null;
    }
    if (!verifyRes.valid) {
      logger.warn(
        {
          agentSlug: agent.slug,
          code: 'VERIFY_FAILED',
          error: verifyRes.error,
        },
        '[Downstream] adapter.verify returned valid=false',
      );
      return null;
    }

    // 12. Settle via the adapter.
    let settleRes: Awaited<ReturnType<typeof adapter.settle>>;
    try {
      settleRes = await adapter.settle(proof);
    } catch (e) {
      // HU-198: un settle que TIRÓ no siempre es un settle que no pagó. Si el
      // adapter transporta `valueDisposition: 'unknown'` (el hop al facilitator no
      // contestó y el broadcast pudo haber salido), el leg NO se puede reportar como
      // "no se pagó": se emite `SETTLE_UNKNOWN`, que es el código que le dice al
      // operador que hay que reconciliar contra la cadena antes de reintentar.
      const disposition = readSettleValueDisposition(e);
      const code =
        disposition === 'unknown' ? 'SETTLE_UNKNOWN' : 'SETTLE_FAILED';
      logger.warn(
        {
          agentSlug: agent.slug,
          code,
          ...(disposition ? { valueDisposition: disposition } : {}),
          detail: String(e),
        },
        disposition === 'unknown'
          ? '[Downstream] adapter.settle threw with UNKNOWN value disposition — the leg may already be paid on-chain; do NOT retry blindly'
          : '[Downstream] adapter.settle threw',
      );
      return null;
    }
    if (!settleRes.success || !settleRes.txHash) {
      // HU-201 (AR BLQ-BAJO-1): este `if` no distinguía lo que el `catch` de arriba SÍ
      // distingue. `SETTLE_FAILED` significa, en el catálogo público de códigos,
      // literalmente "no se pagó" — y un `success:false` que viene CON un txHash es
      // justo el caso en el que eso puede ser falso (pieverse devuelve la respuesta del
      // facilitator verbatim, así que el hash es de un broadcast real). Se emite el
      // MISMO `SETTLE_UNKNOWN` que el catch, que es el código que le dice al operador
      // que hay que mirar la cadena antes de reintentar.
      const settleUnknown = hasBroadcastEvidence(settleRes.txHash);
      logger.warn(
        {
          agentSlug: agent.slug,
          code: settleUnknown ? 'SETTLE_UNKNOWN' : 'SETTLE_FAILED',
          ...(settleUnknown
            ? { valueDisposition: 'unknown', settleTxHash: settleRes.txHash }
            : {}),
          error: settleRes.error,
        },
        settleUnknown
          ? '[Downstream] adapter.settle returned success=false BUT with a broadcast tx hash — the leg may already be paid on-chain; do NOT retry blindly'
          : '[Downstream] adapter.settle returned success=false',
      );
      return null;
    }

    // 13. Success. blockNumber is OMITTED — SettleResult does not expose it
    //     (DT-1 opción C / TD-WKH-112-01). txHash intact.
    return {
      // Fix-pack CR-MNR-1: sin cast — `txHash` es `string` (aloja firmas base58
      // y hashes 0x). El campo ya es del tipo correcto.
      txHash: settleRes.txHash,
      settledAmount: value.toString(),
    };
  } catch (e) {
    // Defensive outer catch (CD-7): nothing in the inner blocks should reach
    // here, but if anything unexpected throws, we still return null.
    logger.warn(
      { agentSlug: agent.slug, code: 'SETTLE_FAILED', detail: String(e) },
      '[Downstream] unexpected error during sign/verify/settle',
    );
    return null;
  }
}
