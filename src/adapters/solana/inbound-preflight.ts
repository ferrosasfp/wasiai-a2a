/**
 * PREFLIGHT DEL COBRO INBOUND EN SOLANA — WKH-314.
 *
 * Verifica, UNA vez por proceso y de forma perezosa, las precondiciones que el camino
 * de cobro necesita y que `isSolanaX402InboundConfigured()` **no puede** ver: aquélla
 * es pura y síncrona (la consume `/capabilities`), y estas cuatro cosas exigen red y
 * base de datos.
 *
 * ── FAIL-CLOSED, CON MOTIVOS DISTINGUIBLES ─────────────────────────────────
 *
 * Cada motivo manda a un lugar distinto: `table_missing` manda a aplicar la migración,
 * `probe_failed` manda a mirar la base y se reintenta solo, `payto_collides_with_deposit`
 * manda a cambiar una env. Colapsarlos en un `false` haría que el operador probara al
 * azar.
 *
 * ── LAS CUATRO COMPROBACIONES ──────────────────────────────────────────────
 *
 *  1. **El store resuelve** — la tabla y las funciones están, y son LAS NUEVAS (prueba
 *     POSITIVA con `p_probe`). Sin esto no hay uso único, y sin uso único una sola
 *     transferencia compra el servicio para siempre.
 *  2. **El RPC retiene histórico** — reusa el símbolo de `schema-preflight.ts`, no lo
 *     duplica. Es la precondición de la que depende `absent`: un nodo sin histórico
 *     responde `null` sobre una tx que SI existe, y desde la respuesta no hay forma de
 *     distinguirlo. Acá el precio de creerle es rechazar un pago real.
 *  3. **La `payTo` NO es la cuenta de depósito de WKH-315** — ver abajo, es lo más
 *     caro de esta lista.
 *  4. **El fallback no apunta a mainnet** — un segundo nodo en otra red no corrobora
 *     nada; sus respuestas son sobre otro ledger.
 *
 * Y una CERO, que va antes que todas y por eso lleva ese número: **el RPC PRIMARIO
 * tampoco apunta a mainnet**. Es la que faltaba (AR de WKH-314, BLQ-MED-3): el guard
 * anti-mainnet existía sólo para el fallback, que es OPCIONAL, mientras `SOLANA_RPC_URL`
 * —obligatoria, y la que decide TODOS los veredictos— no se validaba en ningún lado.
 * Se enforcea desde acá y no desde `getSolanaConnection()` a propósito: esa `Connection`
 * la comparte el leg de salida, que esta HU no toca.
 *
 * Y dos señales que **no** fallan cerrado, a propósito:
 *  · (5) cuántas cuentas de token tiene la `payTo` para el mint. El crédito se mide
 *    SUMANDO sobre todas las cuentas del destinatario, así que dos cuentas son un caso
 *    que el código maneja bien. Apagar el rail por eso sería romperlo por una condición
 *    correcta.
 *  · (6) si hay segundo proveedor, y si no es el mismo que el primero. Un solo
 *    proveedor es una config válida que falla en la dirección segura; lo que no puede
 *    ser es que sea SILENCIOSA.
 *
 * ── POR QUE (3) EXISTE — EL COBRO DOBLE QUE NADIE VERIA ────────────────────
 *
 * WKH-315 acredita SALDO PREPAGO cuando una firma Solana transfiere USDC a la ATA de
 * depósito, y lleva su propio uso único en `a2a_key_deposits`. Esta HU lleva el suyo en
 * otra tabla. **Si las dos direcciones fueran la misma, UNA sola transferencia se
 * podría cobrar DOS VECES**: una por `POST /auth/deposit` (crédito de saldo) y otra
 * como prueba x402 (servicio). Ningún store mira al otro, así que no habría nada que
 * lo detectara después.
 * *Esto sería falso si*: `resolveSolanaDepositAta()` devolviera siempre `null` — sólo
 * lo devuelve cuando `A2A_DEPOSIT_OWNER_SOLANA` está ausente, y en ese caso no hay
 * colisión posible, que es justamente el caso que el guard debe dejar pasar.
 */

import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { getLogger } from '../../lib/logger.js';
import { probeInboundProofStore } from '../../services/solana-inbound-proof.js';
import {
  getSolanaConnection,
  getSolanaFallbackConnection,
  getSolanaInboundPayTo,
  getSolanaRpcUrl,
  getSolanaUsdcMint,
  inboundPrimaryRpcMainnetViolation,
  isSolanaX402InboundConfigured,
} from './chain.js';
import { resolveSolanaDepositAta } from './deposit-account.js';
import { probeRpcHistoryRetention } from './schema-preflight.js';

const log = getLogger('solana-inbound-preflight');

/** Cuánto se cachea un veredicto NEGATIVO antes de volver a intentar. */
const RETRY_MS_DEFAULT = 60_000;

export type SolanaInboundPreflightFailure =
  | 'not_configured'
  | 'store_table_missing'
  | 'store_rpc_missing'
  | 'store_probe_failed'
  | 'rpc_history_unmeasurable'
  | 'rpc_history_insufficient'
  | 'fallback_rpc_invalid'
  /** El RPC PRIMARIO (`SOLANA_RPC_URL`) se declara de mainnet. Ver (0). */
  | 'primary_rpc_is_mainnet'
  | 'payto_collides_with_deposit';

export type SolanaInboundPreflightVerdict =
  | { ok: true }
  | { ok: false; failure: SolanaInboundPreflightFailure; detail: string };

let _cached: SolanaInboundPreflightVerdict | null = null;
let _cachedAt = 0;
let _inFlight: Promise<SolanaInboundPreflightVerdict> | null = null;

function retryMs(): number {
  const raw = process.env.SOLANA_INBOUND_PREFLIGHT_RETRY_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : RETRY_MS_DEFAULT;
}

/** TEST-ONLY — limpia el cache memoizado. */
export function _resetSolanaInboundPreflight(): void {
  _cached = null;
  _cachedAt = 0;
  _inFlight = null;
}

/**
 * (3) La colisión con la cuenta de depósito. Sin red: la ATA es una PDA derivada.
 *
 * Se comparan las DOS formas en que las cuentas podrían coincidir: la `payTo` misma
 * contra la ATA de depósito, y la ATA DERIVADA de `payTo` contra la ATA de depósito.
 * La segunda es la que importa de verdad —una transferencia SPL aterriza en la ATA, no
 * en la wallet— y la primera cubre al operador que puso directamente la ATA en la env.
 */
function collidesWithDepositAccount(payTo: string): string | null {
  const depositAta = resolveSolanaDepositAta();
  // `null` = no hay cuenta de depósito configurada ⇒ no hay colisión posible.
  if (depositAta === null) return null;
  if (payTo === depositAta) {
    return 'SOLANA_X402_INBOUND_PAY_TO is the deposit ATA itself';
  }
  let inboundAta: string;
  try {
    inboundAta = getAssociatedTokenAddressSync(
      new PublicKey(getSolanaUsdcMint()),
      new PublicKey(payTo),
    ).toBase58();
  } catch {
    // Un mint o una payTo que `PublicKey` rechaza. No se puede descartar la colisión,
    // y no poder descartarla no es lo mismo que descartarla.
    return 'the inbound ATA could not be derived, so a collision with the deposit account cannot be ruled out';
  }
  if (inboundAta === depositAta) {
    return 'the ATA derived from SOLANA_X402_INBOUND_PAY_TO is the deposit ATA';
  }
  return null;
}

/**
 * (6) La OTRA señal al operador, y también avisa sin fallar: el estado del segundo
 * proveedor (MNR-1 del AR de WKH-314).
 *
 * Sin `SOLANA_RPC_URL_FALLBACK` el diseño DT-10 queda degradado a un solo proveedor —
 * que es una configuración válida y falla en la dirección segura (más `unknown`, nunca
 * un grant), pero que hasta acá era **silenciosa**: nada en el arranque lo decía, y el
 * rechazo `PROOF_ABSENT` afirmaba "dos nodos buscaron" igual. No apaga el rail porque
 * apagarlo por una config válida sería romperlo de gusto.
 *
 * Y si el fallback es la MISMA URL que el primario, el segundo proveedor no existe:
 * dos llamadas al mismo nodo no son dos opiniones. `.env.example` lo pide en prosa, y
 * la prosa no chequea nada.
 */
function warnOnFallbackShape(): void {
  const fallback = process.env.SOLANA_RPC_URL_FALLBACK?.trim();
  if (fallback === undefined || fallback === '') {
    log.warn(
      'solana inbound preflight: SOLANA_RPC_URL_FALLBACK is not set. The rail works with a single RPC provider, and it fails in the SAFE direction (more X402_SETTLE_UNKNOWN, never a grant), but there is no second opinion: an outage of SOLANA_RPC_URL turns every charge into `unknown`, and an `absent` verdict rests on one node.',
    );
    return;
  }
  if (fallback === getSolanaRpcUrl()) {
    log.warn(
      'solana inbound preflight: SOLANA_RPC_URL_FALLBACK is the SAME url as SOLANA_RPC_URL. Two calls to the same node are not two opinions — DT-10 buys nothing in this configuration. Point it at a different devnet provider.',
    );
  }
}

/**
 * (5) La señal al operador. **No falla, avisa.** Una `payTo` con dos cuentas de token
 * del mismo mint funciona (el crédito se SUMA); con cero, la primera transferencia
 * tendrá que crear la cuenta. Las dos cosas el operador quiere saberlas al arrancar.
 */
async function warnOnTokenAccountShape(payTo: string): Promise<void> {
  try {
    const res = await getSolanaConnection().getTokenAccountsByOwner(
      new PublicKey(payTo),
      { mint: new PublicKey(getSolanaUsdcMint()) },
    );
    const n = Array.isArray(res?.value) ? res.value.length : -1;
    if (n !== 1) {
      log.warn(
        { tokenAccounts: n },
        'solana inbound preflight: the configured payTo does not have exactly one token account for the configured mint. This does NOT disable the rail (the credited amount is summed over every account of the recipient), but it is worth knowing: 0 means the first payment will have to create the account, and more than 1 usually means a misconfiguration.',
      );
    }
  } catch (err) {
    // No poder contar cuentas no apaga nada: no es un guard.
    log.warn(
      { detail: err instanceof Error ? err.message : String(err) },
      'solana inbound preflight: could not count the token accounts of the configured payTo (informational check only)',
    );
  }
}

async function runInboundPreflight(): Promise<SolanaInboundPreflightVerdict> {
  const payTo = getSolanaInboundPayTo();
  if (!isSolanaX402InboundConfigured() || payTo === null) {
    return {
      ok: false,
      failure: 'not_configured',
      detail:
        'the solana x402 inbound path is not fully configured (SOLANA_ADAPTER_ENABLED, SOLANA_X402_INBOUND_ENABLED, SOLANA_X402_INBOUND_PAY_TO and SOLANA_X402_INBOUND_CHALLENGE_SECRET must all be set)',
    };
  }

  // (0) EL RPC PRIMARIO. Va PRIMERO porque es el que decide todos los veredictos: si
  // apunta a otro ledger, el resto del preflight mide contra la red equivocada y sus
  // "ok" no significan nada. Ver `inboundPrimaryRpcMainnetViolation`.
  const primaryViolation = inboundPrimaryRpcMainnetViolation();
  if (primaryViolation !== null) {
    return {
      ok: false,
      failure: 'primary_rpc_is_mainnet',
      detail: primaryViolation,
    };
  }

  // (4) también local, no cuesta nada, y una config inválida acá invalida el resto.
  try {
    getSolanaFallbackConnection();
  } catch (err) {
    return {
      ok: false,
      failure: 'fallback_rpc_invalid',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  warnOnFallbackShape();

  // (3) también local (derivación de PDA), y es el que evita el cobro doble.
  const collision = collidesWithDepositAccount(payTo);
  if (collision !== null) {
    return {
      ok: false,
      failure: 'payto_collides_with_deposit',
      detail: `SOLANA_INBOUND_PAYTO_COLLIDES_WITH_DEPOSIT: ${collision}. One single transfer could then be charged TWICE — once as a balance deposit (WKH-315) and once as an x402 payment proof — and neither store looks at the other. Point SOLANA_X402_INBOUND_PAY_TO at a wallet that is NOT the deposit account.`,
    };
  }

  // (1) el store.
  const store = await probeInboundProofStore();
  switch (store.probe) {
    case 'table_missing':
      return {
        ok: false,
        failure: 'store_table_missing',
        detail: store.detail,
      };
    case 'rpc_missing':
      return { ok: false, failure: 'store_rpc_missing', detail: store.detail };
    case 'failed':
      return { ok: false, failure: 'store_probe_failed', detail: store.detail };
    case 'ok':
      break;
  }

  // (2) la retención de histórico del RPC. Se REUSA el símbolo del preflight de
  // salida: dos implementaciones de la misma medición pueden divergir, y ésta decide
  // si un `absent` significa algo.
  const history = await probeRpcHistoryRetention();
  if (history !== null && !history.ok) {
    const failure: SolanaInboundPreflightFailure =
      history.failure === 'rpc_history_insufficient'
        ? 'rpc_history_insufficient'
        : 'rpc_history_unmeasurable';
    return { ok: false, failure, detail: history.detail };
  }

  // (5) la señal. Deliberadamente DESPUES de todos los guards y sin poder cambiarlos.
  await warnOnTokenAccountShape(payTo);

  return { ok: true };
}

/**
 * Veredicto memoizado, con las llamadas concurrentes compartiendo el probe en vuelo
 * (single flight) — sin eso, el primer burst de cobros dispararía un probe por request.
 *
 * Política de cache, igual que el preflight del settle:
 *   · `ok:true`  → PARA SIEMPRE. Una migración aplicada no se des-aplica sola.
 *   · `ok:false` → por `SOLANA_INBOUND_PREFLIGHT_RETRY_MS` (default 60s). Cachearlo
 *     para siempre dejaría el cobro apagado hasta el próximo deploy por un timeout
 *     transitorio; no cachear nada haría un probe por request contra una base caída.
 */
export async function ensureSolanaInboundReady(): Promise<SolanaInboundPreflightVerdict> {
  if (_cached?.ok === true) return _cached;
  if (_cached && Date.now() - _cachedAt < retryMs()) return _cached;
  if (_inFlight) return _inFlight;

  const run = runInboundPreflight().then(
    (verdict) => {
      _cached = verdict;
      _cachedAt = Date.now();
      _inFlight = null;
      if (!verdict.ok) {
        log.error(
          { failure: verdict.failure, detail: verdict.detail },
          // El operador tiene que poder actuar sin leer el código.
          'SOLANA X402 INBOUND PREFLIGHT FAILED — the Solana inbound payment path is DISABLED (fail-closed). Callers get a 402 they cannot satisfy on this chain instead of a payment that is accepted without being verifiable. Apply 20260819000000_wkh314_solana_inbound_proofs.sql to this database and check the SOLANA_X402_INBOUND_* variables.',
        );
      }
      return verdict;
    },
    // `runInboundPreflight` ya es no-throw; esto es defensa en profundidad para que el
    // gate del money-path no pueda rechazar la promise NUNCA.
    (err: unknown) => {
      const verdict: SolanaInboundPreflightVerdict = {
        ok: false,
        failure: 'store_probe_failed',
        detail: err instanceof Error ? err.message : String(err),
      };
      _cached = verdict;
      _cachedAt = Date.now();
      _inFlight = null;
      return verdict;
    },
  );
  _inFlight = run;
  return run;
}

/**
 * Warm-up del arranque (`src/index.ts`). Fire-and-forget A PROPOSITO: el objetivo es
 * que la alarma suene al arrancar, NO que un blip de red impida levantar el servicio.
 * El gate real sigue siendo `ensureSolanaInboundReady()` dentro del handler.
 */
export function warmSolanaInboundPreflight(): void {
  void ensureSolanaInboundReady().catch(() => {});
}
