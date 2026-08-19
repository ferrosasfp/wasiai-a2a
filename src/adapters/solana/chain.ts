import { Connection, Keypair } from '@solana/web3.js';
import { getLogger } from '../../lib/logger.js';
import { base58DecodeToBytes } from './base58.js';

/**
 * Solana devnet chain registration (WKH-234).
 *
 * Resuelve cluster / RPC / CAIP-2 / mint / decimals / commitment / sentinel
 * desde env (opts > env > default documentado, CD-3) — espejo de
 * `avalanche/chain.ts`. Devnet-only (CD-4): NO hay variante `-mainnet`.
 *
 * `SOLANA_OPERATOR_PRIVATE_KEY` se decodifica acá y NUNCA se loguea (CD-3).
 */

const log = getLogger('solana');

export type SolanaNetwork = 'devnet';

// ── Defaults documentados (mirror del bloque .env.example, CD-3) ──────────
const DEFAULT_RPC_URL = 'https://api.devnet.solana.com';
const DEFAULT_USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const DEFAULT_USDC_DECIMALS = 6;
const DEFAULT_COMMITMENT = 'confirmed';
const DEFAULT_CAIP2_CHAIN_ID = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const DEFAULT_SYNTHETIC_CHAIN_ID = 900001;

// ── Module-level lazy state (per-process, no per-instance) ────────────────
let _connection: Connection | null = null;
let _operator: Keypair | null = null;

export function getSolanaNetwork(_opts?: {
  network?: SolanaNetwork;
}): SolanaNetwork {
  // Devnet-only (CD-4). El slug `SOLANA_CLUSTER` se lee para telemetría/consistencia
  // pero la única red soportada es devnet.
  return 'devnet';
}

export function getSolanaRpcUrl(): string {
  return process.env.SOLANA_RPC_URL ?? DEFAULT_RPC_URL;
}

export function getSolanaCommitment(): 'processed' | 'confirmed' | 'finalized' {
  const raw = process.env.SOLANA_COMMITMENT ?? DEFAULT_COMMITMENT;
  return raw === 'processed' || raw === 'finalized' ? raw : 'confirmed';
}

export function getSolanaUsdcMint(): string {
  return process.env.SOLANA_USDC_MINT_DEVNET ?? DEFAULT_USDC_MINT_DEVNET;
}

export function getSolanaUsdcDecimals(): number {
  const raw = process.env.SOLANA_USDC_DECIMALS;
  if (raw === undefined || raw === '') return DEFAULT_USDC_DECIMALS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_USDC_DECIMALS;
}

export function getSolanaCaip2(): string {
  return process.env.SOLANA_CAIP2_CHAIN_ID ?? DEFAULT_CAIP2_CHAIN_ID;
}

export function getSolanaSyntheticChainId(): number {
  const raw = process.env.SOLANA_SYNTHETIC_CHAIN_ID;
  if (raw === undefined || raw === '') return DEFAULT_SYNTHETIC_CHAIN_ID;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_SYNTHETIC_CHAIN_ID;
}

/** Connection cacheada por proceso (mirror del wallet-client cache EVM). */
export function getSolanaConnection(): Connection {
  if (_connection) return _connection;
  _connection = new Connection(getSolanaRpcUrl(), getSolanaCommitment());
  return _connection;
}

/**
 * Operator `Keypair` desde `SOLANA_OPERATOR_PRIVATE_KEY` (base58 ed25519 secret).
 * Cacheado por proceso. NUNCA loguea el secret ni lo incluye en mensajes de error
 * (CD-3) — solo la pubkey es segura de exponer.
 */
export function getSolanaOperatorKeypair(): Keypair {
  if (_operator) return _operator;
  const raw = process.env.SOLANA_OPERATOR_PRIVATE_KEY;
  if (!raw) {
    throw new Error(
      'SOLANA_OPERATOR_PRIVATE_KEY not set — solana settle signing disabled',
    );
  }
  const secret = base58DecodeToBytes(raw.trim());
  const keypair = Keypair.fromSecretKey(secret);
  const operatorPubkey = keypair.publicKey.toBase58();
  log.info({ operator: operatorPubkey }, 'solana operator loaded');

  // ── WKH-315 (§4.4) — COHERENCIA CUENTA-DE-DEPOSITO ↔ OPERADOR ──────────────
  //
  // El riesgo que cierra: si `A2A_DEPOSIT_OWNER_SOLANA` apunta a una pubkey que el
  // operador NO controla, el dinero del usuario aterriza en una cuenta desde la que
  // no se puede pagar. Nadie se enteraría hasta querer gastarlo, y el depósito ya
  // estaría acreditado en el saldo.
  //
  // ⚠️ POR QUE LA ASERCION VIVE ACA Y NO EN EL CAMINO DE DEPOSITO. Comprobarlo
  // requiere la PUBKEY DEL OPERADOR, o sea cargar el `Keypair` — y AC-12/CD-4
  // prohíben que el camino de depósito lo toque (un depósito no necesita que el
  // gateway firme nada, y hacerlo ataría un proceso que sólo RECIBE a la llave que
  // FIRMA). Tampoco puede ir en `createSolanaAdapters`: esa factory hoy NO carga el
  // keypair, y hacerlo rompería el arranque de un proceso que sólo quiere recibir
  // depósitos. Acá el keypair ya está cargado: cero dependencia de arranque nueva.
  //
  // ⚠️ TRADE-OFF DECLARADO: un error de config del DEPOSITO deja de settlear la
  // SALIDA. Es ruidoso, inmediato y reversible en un minuto (setear la env bien, o
  // declarar la cuenta dedicada), contra un dinero perdido que no lo es. Cuando los
  // dos errores no cuestan lo mismo, el default va del lado barato.
  //
  // La salida es una AFIRMACION DEL OPERADOR, no un apagador del control (exemplar:
  // `SOLANA_RPC_LEDGER_HISTORY_DECLARED_SUFFICIENT` en `schema-preflight.ts`): quien
  // usa deliberadamente una cuenta de depósito distinta lo DECLARA con
  // `A2A_DEPOSIT_OWNER_IS_DEDICATED_SOLANA=true` y se hace responsable de barrerla.
  //
  // ⚠️ Y LA ASERCION SOLO CORRE CON EL CAMINO DE DEPOSITO ENCENDIDO (fix-pack AR ·
  // BLQ-BAJO-1). Sin esta condición, seguir el orden de activación que el propio
  // `.env.example` declara —migración, después el owner, y el flag AL FINAL— y
  // olvidarse de la env de cuenta dedicada **tiraba TODO settle Solana de SALIDA**
  // (`payment.ts`) con el depósito todavía APAGADO, o sea sin que existiera un solo
  // depósito que proteger. El runbook correcto no puede ser el que rompe producción.
  //
  // Se lee la env directamente en vez de llamar a `isSolanaDepositEnabled()`:
  // `deposit-account.ts` importa `getSolanaUsdcMint` de ESTE módulo, así que la
  // llamada crearía un ciclo de imports en el camino de firma. La comparación es la
  // misma comparación literal contra `'true'`, y el choke-point del depósito sigue
  // siendo único — acá el flag es una PRECONDICION de la aserción, no una decisión
  // sobre si el camino de entrada está abierto.
  const depositPathOn = process.env.A2A_DEPOSIT_ENABLED_SOLANA === 'true';
  const declaredOwner = process.env.A2A_DEPOSIT_OWNER_SOLANA?.trim();
  if (
    depositPathOn &&
    declaredOwner !== undefined &&
    declaredOwner !== '' &&
    declaredOwner !== operatorPubkey &&
    process.env.A2A_DEPOSIT_OWNER_IS_DEDICATED_SOLANA !== 'true'
  ) {
    // El mensaje nombra las dos envs (accionable) y NO incluye ningún secreto: las
    // dos pubkeys son públicas por definición.
    throw new Error(
      `A2A_DEPOSIT_OWNER_SOLANA (${declaredOwner}) is not the solana operator pubkey (${operatorPubkey}) — deposits would land in an account this process cannot pay from. Point the env at the operator, or set A2A_DEPOSIT_OWNER_IS_DEDICATED_SOLANA=true to declare the deposit account is deliberately separate.`,
    );
  }

  // ⚠️ EL CACHE VA DESPUES DE LA ASERCION, A PROPOSITO. Si se cacheara antes, el
  // primer llamado lanzaría y el SEGUNDO devolvería el keypair del cache sin
  // re-chequear: un guard que se saltea con un simple reintento no es un guard.
  _operator = keypair;
  return keypair;
}

// ── WKH-314 — x402 INBOUND Solana (bloque ADITIVO) ────────────────────────
//
// Todo lo de acá abajo es config del camino de ENTRADA: el gateway COBRA en Solana.
// Ni una de estas funciones toca `getSolanaOperatorKeypair()` ni ninguna clave
// privada, y no pueden hacerlo: el gateway es TESTIGO de un pago que firma el
// pagador, no tesorero (AC-9 / DT-16). `SOLANA_X402_INBOUND_PAY_TO` es una PUBKEY que
// se lee de env, **nunca** derivada de un secreto.

/** Longitud mínima del secreto del HMAC de la referencia. */
const INBOUND_CHALLENGE_SECRET_MIN_LENGTH = 32;

/** Bytes exactos de una pubkey ed25519 de Solana. */
const SOLANA_PUBKEY_BYTES = 32;

/** Connection de FALLBACK cacheada por proceso (DT-10). `null` = no configurada. */
let _fallbackConnection: Connection | null = null;

/**
 * ¿Este string es una pubkey base58 de 32 bytes exactos?
 *
 * ⚠️ Se exige la LONGITUD DECODIFICADA, no el largo del string ni un regex del
 * alfabeto. Un base58 de 31 o 33 bytes pasa cualquier regex y **no es una cuenta
 * Solana**: publicarlo como `payTo` en un challenge mandaría al pagador a transferir a
 * una dirección que no existe, y esa plata no la recupera nadie.
 */
function isBase58Pubkey(raw: string): boolean {
  try {
    return base58DecodeToBytes(raw).length === SOLANA_PUBKEY_BYTES;
  } catch {
    // `base58DecodeToBytes` lanza con un mensaje que nombra la env del OPERADOR
    // (es su call-site original). Se traga acá a propósito: dejarlo salir hablaría
    // de un secreto que este camino ni siquiera lee.
    return false;
  }
}

/**
 * La wallet que RECIBE el cobro inbound, o `null` si no está configurada o no es una
 * pubkey base58 de 32 bytes.
 *
 * ⚠️ NUNCA se deriva de `SOLANA_OPERATOR_PRIVATE_KEY`. Que el operador y el receptor
 * puedan coincidir es una decisión del despliegue; DERIVARLA ataría un camino que sólo
 * RECIBE a la llave que FIRMA, que es exactamente lo que AC-9 prohíbe.
 */
export function getSolanaInboundPayTo(): string | null {
  const raw = process.env.SOLANA_X402_INBOUND_PAY_TO?.trim();
  if (raw === undefined || raw === '') return null;
  return isBase58Pubkey(raw) ? raw : null;
}

/**
 * El secreto del HMAC de la referencia, o `null` si falta o es demasiado corto.
 *
 * NUNCA se loguea, NUNCA viaja en un mensaje de error, NUNCA sale en el 402. El
 * challenge publica la referencia DERIVADA, que es pública por construcción (es una
 * cuenta de la transacción del pagador).
 */
export function getSolanaInboundChallengeSecret(): string | null {
  const raw = process.env.SOLANA_X402_INBOUND_CHALLENGE_SECRET;
  if (raw === undefined) return null;
  return raw.length >= INBOUND_CHALLENGE_SECRET_MIN_LENGTH ? raw : null;
}

/**
 * ¿El camino de cobro inbound en Solana está CONFIGURADO? Pura y síncrona.
 *
 * Las CUATRO cosas juntas: el adapter Solana encendido **Y** el flag propio del
 * inbound **Y** una `payTo` que es una pubkey de verdad **Y** un secreto de largo
 * suficiente. Comparación LITERAL contra `'true'`: cualquier otro valor deja el camino
 * apagado.
 *
 * El flag es PROPIO y va ANDeado, no reusado: el rail de SALIDA (pagarle a un agente)
 * y un camino de ENTRADA de dinero son dos decisiones distintas, y quien enciende el
 * primero no está diciendo nada sobre el segundo.
 *
 * ⚠️ LIMITACION DECLARADA, no escondida: esto dice **"configurado"**, no *"la DB y el
 * RPC están sanos"*. `GET /capabilities` es síncrono y no puede esperar un probe de
 * red. La salud se enforcea perezosamente en la verificación (preflight inbound), y lo
 * que importa se cumple igual: con la config incompleta el valor publicado es `false`
 * y el camino está cerrado.
 * *Esto sería falso si*: con `SOLANA_X402_INBOUND_PAY_TO` vacío esta función
 * devolviera `true` — entonces `/capabilities` publicaría una capacidad que el
 * middleware no puede servir.
 */
export function isSolanaX402InboundConfigured(): boolean {
  if (process.env.SOLANA_ADAPTER_ENABLED !== 'true') return false;
  if (process.env.SOLANA_X402_INBOUND_ENABLED !== 'true') return false;
  if (getSolanaInboundPayTo() === null) return false;
  return getSolanaInboundChallengeSecret() !== null;
}

/**
 * ¿Esta URL de RPC se declara de MAINNET? (CD-5)
 *
 * ⚠️ ACOTA, NO CIERRA — y decirlo importa. Caza el caso ETIQUETADO
 * (`api.mainnet-beta.solana.com`, `...mainnet.rpcpool.com`, el `?cluster=mainnet` de
 * un proxy), que es la forma en que este error se comete de verdad: copiar la URL del
 * cluster equivocado. **NO puede** cazar un endpoint de mainnet con un hostname
 * opaco —un proveedor con la red en el api-key— porque desde la URL no hay nada que
 * medir. Para eso está el resto del diseño devnet-only, no esta función.
 * *Esto sería falso si*: alguien pusiera `https://rpc.example.com/k/abc` apuntando a
 * mainnet — pasa este guard, y esta función NO afirma lo contrario.
 */
function looksLikeMainnetRpc(url: string): boolean {
  return url.toLowerCase().includes('mainnet');
}

/**
 * ¿El RPC **PRIMARIO** se declara de mainnet? Devuelve el motivo, o `null` si no.
 *
 * ⚠️ POR QUE EXISTE, Y POR QUE NO VIVE EN `getSolanaConnection()` (AR de WKH-314,
 * BLQ-MED-3). `looksLikeMainnetRpc` tenía UN solo call-site —el fallback, que es
 * OPCIONAL— mientras `SOLANA_RPC_URL` (obligatoria, la que construye la `Connection`
 * primaria en `getSolanaConnection`) no se validaba en ningún lado. Con
 * `SOLANA_RPC_URL=https://api.mainnet-beta.solana.com` el preflight pasaba, el rail
 * arrancaba, y **toda la verificación de cobros se hacía contra mainnet**.
 *
 * No se mete el chequeo dentro de `getSolanaConnection()` a propósito: esa `Connection`
 * la comparte el leg de SALIDA (`payment.ts`, `facilitator-settle.ts`), que es
 * money-path recién shipeado y no se toca en esta HU. Hacerla lanzar sería cambiarle el
 * comportamiento a un camino que nadie pidió tocar. El guard lo aplica **quien tiene la
 * política**: el preflight del cobro inbound (`inbound-preflight.ts`), fail-closed.
 *
 * ⚠️ Y ACOTA, NO CIERRA — igual que `looksLikeMainnetRpc`, del que es un envoltorio: un
 * endpoint de mainnet con hostname opaco (la red en el api-key) pasa. Lo que esta
 * función afirma es *"la URL no se DECLARA de mainnet"*, no *"la URL es devnet"*.
 */
export function inboundPrimaryRpcMainnetViolation(): string | null {
  const url = getSolanaRpcUrl();
  if (!looksLikeMainnetRpc(url)) return null;
  return 'SOLANA_RPC_URL looks like a MAINNET endpoint — this rail is devnet-only (CD-5). It is the PRIMARY provider: every inbound payment would be verified against another ledger, so a signature that never existed on devnet could be honoured (or a real one denied). Point SOLANA_RPC_URL at a devnet endpoint.';
}

/**
 * El SEGUNDO proveedor de RPC (DT-10), cacheado por proceso. `null` cuando no hay
 * `SOLANA_RPC_URL_FALLBACK` configurada.
 *
 * ⚠️ LANZA si la URL se declara de mainnet. Es fail-closed de CONFIGURACION, no un
 * warn: un `unknown` de esta HU se resuelve preguntándole a un segundo nodo, y si ese
 * segundo nodo es de otra red sus respuestas son sobre otro ledger — un `absent` suyo
 * no es evidencia de nada. El preflight lo traduce a un veredicto negativo con motivo
 * propio, así que el operador lo ve al arrancar y no en el primer cobro.
 *
 * ⚠️ Y CACHEA DESPUES DE VALIDAR, a propósito: si cacheara antes, el primer llamado
 * lanzaría y el segundo devolvería la conexión del cache sin re-chequear. Un guard que
 * se saltea con un reintento no es un guard (misma lección que
 * `getSolanaOperatorKeypair`).
 */
export function getSolanaFallbackConnection(): Connection | null {
  if (_fallbackConnection) return _fallbackConnection;
  const raw = process.env.SOLANA_RPC_URL_FALLBACK?.trim();
  if (raw === undefined || raw === '') return null;
  if (looksLikeMainnetRpc(raw)) {
    throw new Error(
      'SOLANA_RPC_URL_FALLBACK looks like a MAINNET endpoint — this rail is devnet-only (CD-5). A fallback on another ledger cannot corroborate anything: its "absent" would be about transactions that were never supposed to be there. Point it at a SECOND devnet provider, different from SOLANA_RPC_URL.',
    );
  }
  _fallbackConnection = new Connection(raw, getSolanaCommitment());
  return _fallbackConnection;
}

/**
 * TEST-ONLY — limpia la Connection + operator cacheados (mirror
 * `_resetWalletClient`). CD-17.
 */
export function _resetSolanaChain(): void {
  _connection = null;
  _operator = null;
  // WKH-314: la del fallback también, o un test que cambia
  // `SOLANA_RPC_URL_FALLBACK` seguiría hablando con el endpoint del test anterior.
  _fallbackConnection = null;
}
