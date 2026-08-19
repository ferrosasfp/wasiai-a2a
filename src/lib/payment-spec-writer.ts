/**
 * Payment Spec Writer — WKH-316 · el lado ESCRITOR del bloque `payment`.
 *
 * WKH-241 construyó el LECTOR (`payment-spec-reader.ts`) y corre en producción;
 * el escritor nunca existió, así que hasta esta HU un tercero que publicaba por
 * API no podía declarar en qué red cobra. Este módulo es el ÚNICO validador de
 * ese bloque: lo llaman `routes/agents.ts` (para devolver el 422) y
 * `services/agent.ts` (para PRODUCIR el objeto que se persiste). Está prohibido
 * re-implementar cualquiera de sus 7 chequeos en cualquiera de los dos (CD-9).
 *
 * Módulo LEAF, igual que su gemelo lector: importa el resolver puro, el registry
 * de adapters, el validador de formato de wallet y el resolutor de la address del
 * operador. **Cero imports de servicios** — `services/agent.ts` importa de acá, y
 * al revés sería un ciclo.
 *
 * ⚠️ NO ESCRIBE UN SOLO VALIDADOR PROPIO (CD-2). `normalizeChainSlug`,
 * `getChainVmFamily`, `getAdaptersBundle`, `getInitializedChainKeys` e
 * `isValidPayoutWallet` ya existen y ya son los que usa el money-path. Un `Set`
 * de slugs, un regex de address o un decoder base58 nuevos acá significarían dos
 * criterios que nada obliga a moverse juntos, y el desacuerdo aparecería como un
 * rechazo inexplicable en el settle.
 *
 * ⚠️ LO QUE ESTE MÓDULO NO HACE. No re-valida bloques YA persistidos: sólo mira
 * lo que llega por el write path. `readStoredPaymentBlock` (abajo) es un
 * narrowing de lectura, no un guard — una fila sembrada con una chain que este
 * gateway no conoce se sigue leyendo como se leía.
 */

import crypto from 'node:crypto';
import {
  type ChainVmFamily,
  getChainVmFamily,
  normalizeChainSlug,
} from '../adapters/chain-resolver.js';
import {
  getAdaptersBundle,
  getInitializedChainKeys,
} from '../adapters/registry.js';
import type { ChainKey } from '../adapters/types.js';
import type { AgentPaymentSpecInput } from '../types/index.js';
import { getLogger } from './logger.js';
import { resolveOperatorAddress } from './operator-address.js';
import { isValidPayoutWallet } from './wallet-format.js';

const log = getLogger('payment-writer');

/** El único método de pago que este gateway sabe cobrar (AC-10). */
const SUPPORTED_METHOD = 'x402';

/** Zero address EVM, en minúsculas. La comparación baja la caja del candidato. */
const EVM_ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

/**
 * Pubkey Solana de todos ceros (el System Program).
 *
 * ⚠️ MEDIDO, y es el motivo de que AC-5 exista aparte de AC-4:
 * `isValidSolanaAddress('1'.repeat(32))` devuelve **`true`** — decodifica a 32
 * bytes exactos, así que el guard de FORMATO la acepta. Sin este chequeo un
 * agente podría publicar un payTo que quema todos sus cobros.
 */
const SOLANA_ZERO_PUBKEY = '1'.repeat(32);

export type PaymentBlockRejectionCode =
  | 'INVALID_PAYMENT_BLOCK'
  | 'UNSUPPORTED_PAYMENT_METHOD'
  | 'INVALID_PAYMENT_CHAIN'
  | 'PAYMENT_CHAIN_NOT_INITIALIZED'
  | 'INVALID_PAYMENT_PAYTO_FORMAT'
  | 'ZERO_PAYMENT_PAYTO'
  | 'PAYTO_IS_OPERATOR'
  | 'PAYMENT_ASSET_MISMATCH';

export type PaymentBlockRejection =
  | { code: 'INVALID_PAYMENT_BLOCK'; field: 'payment' }
  | { code: 'UNSUPPORTED_PAYMENT_METHOD'; field: 'payment.method' }
  | { code: 'INVALID_PAYMENT_CHAIN'; field: 'payment.chain' }
  | {
      code: 'PAYMENT_CHAIN_NOT_INITIALIZED';
      field: 'payment.chain';
      initializedChains: string[];
    }
  | { code: 'INVALID_PAYMENT_PAYTO_FORMAT'; field: 'payment.contract' }
  | { code: 'ZERO_PAYMENT_PAYTO'; field: 'payment.contract' }
  | { code: 'PAYTO_IS_OPERATOR'; field: 'payment.contract' }
  | { code: 'PAYMENT_ASSET_MISMATCH'; field: 'payment.asset' };

export type PaymentBlockResult =
  | { ok: true; block: AgentPaymentSpecInput; operatorCheckSkipped: boolean }
  | { ok: false; rejection: PaymentBlockRejection };

/**
 * Mensaje al cliente por código. **ESTÁTICOS a propósito (CD-8)**: ninguno
 * refleja el valor recibido, y AR/MNR-1 lo saca también del log del route (que
 * loguea sólo `{ field, code }`). Mismo patrón que el guard de `payoutWallet`.
 *
 * Vive acá y no en el route para que los dos callers del validador no puedan
 * divergir en el texto que publican como contrato.
 */
export const PAYMENT_REJECTION_REASON: Record<
  PaymentBlockRejectionCode,
  string
> = {
  INVALID_PAYMENT_BLOCK:
    'payment must be an object with string method, chain and contract',
  UNSUPPORTED_PAYMENT_METHOD: 'payment.method must be exactly "x402"',
  INVALID_PAYMENT_CHAIN:
    'payment.chain must be a chain slug this gateway knows',
  PAYMENT_CHAIN_NOT_INITIALIZED:
    'payment.chain is not an active rail in this deployment',
  INVALID_PAYMENT_PAYTO_FORMAT:
    'payment.contract must be a valid payout address for its chain family',
  ZERO_PAYMENT_PAYTO: 'payment.contract must not be the zero address',
  PAYTO_IS_OPERATOR:
    'payment.contract must not be the gateway operator address',
  PAYMENT_ASSET_MISMATCH:
    'payment.asset does not match the token this rail settles',
};

function reject(rejection: PaymentBlockRejection): PaymentBlockResult {
  return { ok: false, rejection };
}

/** String no vacío tras `trim()`, o `undefined`. No muta la caja. */
function readRequiredString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  return v.trim().length > 0 ? v : undefined;
}

/**
 * ¿Es `payTo` la dirección cero de su familia?
 *
 * Dos ramas, no una, y la asimetría es deliberada (CD-3):
 *  · **EVM**: se baja la caja de los DOS lados. El formato hex ya lo garantizó el
 *    paso 4, y una address EVM es case-insensitive por EIP-55.
 *  · **Solana**: comparación EXACTA. base58 es case-sensitive, y bajarle la caja
 *    a una pubkey produce otra cadena — medido: `isValidPayoutWallet` acepta
 *    `'so111…112'` igual que `'So111…112'`, o sea que un `toLowerCase()` acá no
 *    fallaría ruidosamente, **produciría otra billetera**.
 */
function isZeroPayTo(payTo: string, family: ChainVmFamily): boolean {
  if (family === 'evm') return payTo.toLowerCase() === EVM_ZERO_ADDRESS;
  return payTo === SOLANA_ZERO_PUBKEY;
}

/** Igualdad de direcciones con el mismo criterio de caja que `isZeroPayTo`. */
function sameAddress(a: string, b: string, family: ChainVmFamily): boolean {
  if (family === 'evm') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/**
 * Valida el bloque `payment` declarado por el caller y, si pasa, devuelve el
 * objeto EXACTO que hay que persistir.
 *
 * ⚠️ EL ORDEN DE LOS 7 PASOS ES NORMATIVO (CD-12), y el motivo es mecánico, no
 * estético: los pasos 4-7 dependen del `chainKey` y del `bundle` que resuelven
 * los pasos 2-3. Invertirlos produce un `undefined` en runtime, o un `field` que
 * le apunta al campo equivocado en la respuesta 422. El primero que falla gana.
 *
 * ⚠️ Si un test de camino feliz da 422 inesperado, el bug está en el mock del
 * registry de ese test, no acá: `getAdaptersBundle` devuelve `undefined` para
 * TODA chain mientras el registry no esté inicializado, y el paso 3 rechaza.
 */
export async function validatePaymentBlock(
  raw: unknown,
): Promise<PaymentBlockResult> {
  // ── Paso 0 — shape ────────────────────────────────────────────────
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return reject({ code: 'INVALID_PAYMENT_BLOCK', field: 'payment' });
  }
  const obj = raw as Record<string, unknown>;
  const method = readRequiredString(obj.method);
  const chainRaw = readRequiredString(obj.chain);
  const contractRaw = readRequiredString(obj.contract);
  if (
    method === undefined ||
    chainRaw === undefined ||
    contractRaw === undefined
  ) {
    return reject({ code: 'INVALID_PAYMENT_BLOCK', field: 'payment' });
  }
  // `asset` es opcional y decorativo: presente SÓLO si vino como string. Un
  // `asset: 123` o `asset: null` se descarta en silencio, con el mismo criterio
  // que una key desconocida — rechazar la publicación entera por una etiqueta
  // que ningún camino de dinero lee rompería la compatibilidad hacia adelante de
  // una API pública de escritura.
  const asset = typeof obj.asset === 'string' ? obj.asset : undefined;

  // ── Paso 1 — method (AC-10) ───────────────────────────────────────
  // EXACTO: sin trim y sin lowercase. `'X402'` y `' x402 '` se rechazan. No es
  // pedantería: el método decide qué protocolo de cobro se anuncia, y aceptar
  // variantes obligaría a todo consumidor del catálogo a normalizar también.
  if (method !== SUPPORTED_METHOD) {
    return reject({
      code: 'UNSUPPORTED_PAYMENT_METHOD',
      field: 'payment.method',
    });
  }

  // ── Paso 2 — chain conocida (AC-2) ────────────────────────────────
  // `normalizeChainSlug` ya hace `trim().toLowerCase()` adentro, así que no se
  // repite antes de llamarlo.
  const chainKey: ChainKey | undefined = normalizeChainSlug(chainRaw);
  if (chainKey === undefined) {
    return reject({ code: 'INVALID_PAYMENT_CHAIN', field: 'payment.chain' });
  }

  // ── Paso 3 — riel vivo en ESTE proceso (AC-3) ─────────────────────
  // ⚠️ El `chainKey` va SIEMPRE explícito. `getAdaptersBundle()` sin argumento
  // cae al chain default del registry: un argumento olvidado haría pasar una
  // chain no inicializada usando el bundle de otra.
  const bundle = getAdaptersBundle(chainKey);
  if (bundle === undefined) {
    return reject({
      code: 'PAYMENT_CHAIN_NOT_INITIALIZED',
      field: 'payment.chain',
      // Accionable: le dice al caller en qué rieles SÍ puede declarar. No es
      // disclosure — `getInitializedChainKeys()` ya sale sin auth por
      // `GET /capabilities`.
      initializedChains: getInitializedChainKeys(),
    });
  }

  // ── Paso 4 — formato del payTo para SU familia (AC-4) ─────────────
  // `getChainVmFamily` devuelve `ChainVmFamily` e `isValidPayoutWallet` recibe
  // `WalletNamespace`: son la misma unión `'evm' | 'solana'`, así que casan sin
  // cast. Un `0x…` en un slot Solana y un base58 en un slot EVM caen los DOS acá.
  const family = getChainVmFamily(chainKey);
  const payTo = contractRaw.trim();
  if (!isValidPayoutWallet(payTo, family)) {
    return reject({
      code: 'INVALID_PAYMENT_PAYTO_FORMAT',
      field: 'payment.contract',
    });
  }

  // ── Paso 5 — no es la dirección cero (AC-5) ───────────────────────
  if (isZeroPayTo(payTo, family)) {
    return reject({ code: 'ZERO_PAYMENT_PAYTO', field: 'payment.contract' });
  }

  // ── Paso 6 — la etiqueta `asset` no miente (AC-12) ────────────────
  if (asset !== undefined) {
    // `supportedTokens[0]` es `TokenSpec | SolanaTokenSpec | undefined` porque el
    // repo compila con `noUncheckedIndexedAccess`. `symbol: string` existe en las
    // dos mitades de la unión, así que el `?.` alcanza y no hace falta narrowing
    // por familia — ni un `!`, ni un `as`.
    const symbol = bundle.payment.supportedTokens[0]?.symbol;
    if (symbol === undefined) {
      // Degradación EXPLÍCITA, mismo criterio que el paso 7: un riel sin tokens
      // declarados no puede decidir si la etiqueta miente, y no vamos a rechazar
      // una publicación legítima por una etiqueta decorativa. Queda en el log.
      log.warn(
        { code: 'PAYMENT_ASSET_CHECK_SKIPPED', chainKey },
        'payment.asset not checked: rail declares no supported tokens',
      );
    } else if (asset.trim().toLowerCase() !== symbol.toLowerCase()) {
      return reject({
        code: 'PAYMENT_ASSET_MISMATCH',
        field: 'payment.asset',
      });
    }
  }

  // ── Paso 7 — el payTo no es el gateway (AC-6) ─────────────────────
  // `resolveOperatorAddress` NUNCA lanza. `null` significa "no se pudo comparar",
  // no "no coincide": se ACEPTA y se marca, en vez de tumbar publicaciones
  // legítimas porque a este deploy le falta una env de firma.
  const operator = await resolveOperatorAddress(family);
  if (operator !== null && sameAddress(payTo, operator, family)) {
    return reject({ code: 'PAYTO_IS_OPERATOR', field: 'payment.contract' });
  }

  // ── Lo que se persiste — whitelist EXPLÍCITA de 4 keys (CD-10/CD-11) ──
  //
  // ⚠️ PROHIBIDO `{ ...obj }` acá. `AgentPaymentSpec` declara además
  // `resolvedChain` y `network` como DERIVADOS del gateway: con un spread, un
  // caller podría dejar `resolvedChain: 'avalanche-mainnet'` dentro del JSONB.
  // Hoy `/discover` no cambiaría —el lector los recomputa siempre— pero el valor
  // envenenado quedaría persistido para todo consumidor del bloque crudo.
  //
  // `trim()` sí, caja NO (CD-3). `normalizeChainSlug` trimea internamente, así
  // que `' avalanche '` resuelve igual y se persistiría con espacios: el valor
  // guardado divergiría del valor sobre el que el sistema actúa.
  const block: AgentPaymentSpecInput = {
    method,
    chain: chainRaw.trim(),
    contract: payTo,
  };
  // `exactOptionalPropertyTypes` está en `true`: `{ asset: undefined }` no
  // compila, por eso la key se agrega condicionalmente en vez de asignarse.
  if (asset !== undefined) block.asset = asset.trim();

  return { ok: true, block, operatorCheckSkipped: operator === null };
}

/**
 * Narrowing acotado del bloque **tal como está PERSISTIDO**, para
 * `mapRowToRecord`. Gemelo de `readSchema` en `services/agent.ts`.
 *
 * ⚠️ NO es un segundo lector de discovery ni un guard de lectura. `readPaymentSpec`
 * (`payment-spec-reader.ts`) sigue siendo el ÚNICO productor de `Agent.payment`
 * (CD-6). Éste devuelve las 4 keys del INPUT, sin los derivados, y **no valida**:
 * una fila sembrada con una chain que este gateway no conoce se devuelve tal
 * cual, porque el contrato de `PublishedAgentRecord` es "lo que hay guardado", y
 * re-validar en lectura reescribiría de hecho lo que AC-9 prohíbe tocar.
 *
 * Devuelve `undefined` —nunca `null`— cuando no hay bloque: con
 * `exactOptionalPropertyTypes`, asignar `null` a una prop opcional es otro tipo.
 */
export function readStoredPaymentBlock(
  meta: Record<string, unknown>,
): AgentPaymentSpecInput | undefined {
  const p = meta.payment;
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return undefined;
  const obj = p as Record<string, unknown>;
  if (
    typeof obj.method !== 'string' ||
    typeof obj.chain !== 'string' ||
    typeof obj.contract !== 'string'
  ) {
    return undefined;
  }
  const block: AgentPaymentSpecInput = {
    method: obj.method,
    chain: obj.chain,
    contract: obj.contract,
  };
  if (typeof obj.asset === 'string') block.asset = obj.asset;
  return block;
}

/** Lo que se loguea de un bloque: a qué red y a qué billetera, nada más. */
interface PaymentBlockAudit {
  chain: string;
  contract: string;
}

function auditView(
  block: AgentPaymentSpecInput | undefined | null,
): PaymentBlockAudit | null {
  if (block === undefined || block === null) return null;
  return { chain: block.chain, contract: block.contract };
}

/**
 * Log de auditoría del cambio de bloque. Vive en este módulo y no en el service
 * porque `services/agent.ts` no importa ningún logger, y el precedente del repo
 * para loguear PII-safe desde fuera del service es `logOwnershipMismatch`
 * (`services/security/errors.ts`).
 *
 * ⚠️ POR QUÉ EL `contract` VA EN CLARO Y EL `owner_ref` HASHEADO. El `owner_ref`
 * es identidad de inquilino y el repo ya la hashea en todos sus logs. El
 * `contract` es la billetera de cobro, que este mismo gateway **ya publica sin
 * auth en `GET /discover`**: hashearlo no protegería nada y destruiría el único
 * valor del log, que es poder contestar "¿a qué billetera se re-apuntó, y
 * cuándo?" el día que un cobro aparezca donde no debe.
 */
export function logPaymentBlockChange(args: {
  op: 'publish' | 'update' | 'delete';
  slug: string;
  ownerRef: string;
  prev: AgentPaymentSpecInput | undefined | null;
  next: AgentPaymentSpecInput | undefined | null;
}): void {
  log.info(
    {
      op: args.op,
      // `slug` en claro: ya es público en `/discover`.
      slug: args.slug,
      ownerRefHash: crypto
        .createHash('sha256')
        .update(args.ownerRef)
        .digest('hex')
        .slice(0, 16),
      prev: auditView(args.prev),
      next: auditView(args.next),
      ts: new Date().toISOString(),
    },
    'agent payment block changed',
  );
}
