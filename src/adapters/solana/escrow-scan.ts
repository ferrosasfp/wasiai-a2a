/**
 * WKH-365 — cuánta plata sigue trabada en escrows de Solana devnet.
 *
 * SOLO LECTURA: un `getProgramAccounts` y un `getAccountInfo` del sysvar Clock,
 * en un único POST JSON-RPC batcheado. No firma, no manda transacciones, no
 * toca Supabase.
 *
 * ⛔ NO usa `Connection` de `@solana/web3.js` (CD-7). `Connection` reintenta
 * internamente ante un 429 con backoff y no admite un timeout por llamada, así
 * que el modo de falla que esta tarjeta existe para reportar —"el RPC me está
 * tirando 429"— se convertiría en una request colgada. Acá es `fetch` crudo con
 * `AbortSignal.timeout`, sin reintento y sin SEGUNDO INTENTO contra otra URL: un
 * tablero no puede duplicar la carga del RPC. (La cadena de variables de
 * `getEscrowScanRpcUrl` elige UNA antes de salir; no reintenta con las otras.)
 */

import { formatUnits } from 'viem';
import { getLogger } from '../../lib/logger.js';
import type { SinDatoReason, TableroEscrowsCard } from '../../types/index.js';
import { base58Encode } from './base58.js';
import {
  getSolanaCommitment,
  getSolanaUsdcDecimals,
  getSolanaUsdcMint,
} from './chain.js';

const log = getLogger('tablero-escrow-scan');

/** Default documentado (mismo patrón que los defaults de `chain.ts`). */
const DEFAULT_ESCROW_PROGRAM_ID =
  'DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x';

/**
 * Discriminador Anchor de la cuenta `EscrowState`, o sea los primeros 8 bytes de
 * `sha256("account:EscrowState")`. Va como constante para no pagar un hash por
 * corrida, y `escrow-scan.test.ts` lo RECOMPUTA en cada `npm test`: una errata
 * de un byte pone la suite en rojo.
 */
export const ESCROW_STATE_DISCRIMINATOR = new Uint8Array([
  19, 90, 148, 111, 55, 130, 229, 108,
]);

/**
 * Layout de `EscrowState`, offsets desde el byte 0 de la cuenta:
 *
 *   0   8   discriminador Anchor
 *   8   32  sender
 *   40  32  beneficiary
 *   72  32  authority
 *   104 32  mint
 *   136 8   amount    (u64 LE)
 *   144 8   deadline  (i64 LE, unix ts)
 *   152 1   status    (0 Deposited / 1 Released / 2 Refunded)
 *   153 1   bump
 */
export const ESCROW_STATE_SIZE = 154;
const OFFSET_MINT = 104;
const OFFSET_AMOUNT = 136;
const OFFSET_DEADLINE = 144;
const OFFSET_STATUS = 152;
const STATUS_DEPOSITED = 0;

/** El reloj del CLUSTER. `unix_timestamp` es un i64 LE en el offset 32. */
const CLOCK_SYSVAR_ADDRESS = 'SysvarC1ock11111111111111111111111111111111';
const OFFSET_CLOCK_UNIX_TIMESTAMP = 32;

const RPC_TIMEOUT_MS = 8_000;

function sinDato(reason: SinDatoReason): TableroEscrowsCard {
  return { status: 'sin_dato', reason };
}

function getEscrowProgramId(): string {
  const raw = process.env.SOLANA_ESCROW_PROGRAM_ID;
  return raw === undefined || raw === '' ? DEFAULT_ESCROW_PROGRAM_ID : raw;
}

interface JsonRpcEnvelope {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** El `data` de una cuenta viene como `[base64, 'base64']`. */
function accountBytes(account: unknown): Uint8Array | null {
  if (!isRecord(account)) return null;
  const data = account.data;
  if (!Array.isArray(data) || typeof data[0] !== 'string') return null;
  const bytes = new Uint8Array(Buffer.from(data[0], 'base64'));
  return bytes;
}

/**
 * Lo que hay que contar de cada cuenta viva. Se clasifica en JS y NO en el RPC
 * a propósito: filtrar `status` con un `memcmp` devolvería sólo las
 * `Deposited` y se perdería el denominador (cuántas de las que existen siguen
 * vivas).
 */
interface Tally {
  vivos: number;
  usdc: bigint;
  otrosMints: number;
  deadlines: bigint[];
}

function tally(accounts: unknown[]): Tally | null {
  const usdcMint = getSolanaUsdcMint();
  const out: Tally = { vivos: 0, usdc: 0n, otrosMints: 0, deadlines: [] };
  for (const entry of accounts) {
    if (!isRecord(entry)) return null;
    const bytes = accountBytes(entry.account);
    if (bytes === null || bytes.length !== ESCROW_STATE_SIZE) return null;
    if (bytes[OFFSET_STATUS] !== STATUS_DEPOSITED) continue;
    out.vivos += 1;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const mint = base58Encode(bytes.subarray(OFFSET_MINT, OFFSET_MINT + 32));
    if (mint === usdcMint) {
      out.usdc += view.getBigUint64(OFFSET_AMOUNT, true);
    } else {
      // Nunca se suma: sería sumar peras con manzanas.
      out.otrosMints += 1;
    }
    out.deadlines.push(view.getBigInt64(OFFSET_DEADLINE, true));
  }
  return out;
}

/**
 * El `unix_timestamp` del sysvar Clock, o EL MOTIVO por el que no se pudo leer.
 *
 * ⚠️ Devolver `null` a secas colapsaba dos causas que el resto de esta HU se
 * esfuerza en mantener separadas: "el RPC no contestó" y "el RPC contestó algo
 * que no se entiende". El sobre con `value: null` es un 200 con envelope
 * válido — la pantalla decía «el RPC no contestó» sobre un RPC que SÍ contestó.
 * El corte es el mismo que usa el resto del archivo: un `error` JSON-RPC es
 * `rpc_error`, un problema de FORMA es `respuesta_invalida`.
 */
type ClockLectura = { ts: bigint } | { reason: SinDatoReason };

function clockUnixTimestamp(
  envelope: JsonRpcEnvelope | undefined,
): ClockLectura {
  // El sobre del id 2 no vino en el batch: el RPC respondió, pero no lo que se
  // le pidió.
  if (envelope === undefined) return { reason: 'respuesta_invalida' };
  if (envelope.error !== undefined) return { reason: 'rpc_error' };
  const result = envelope.result;
  if (!isRecord(result)) return { reason: 'respuesta_invalida' };
  const bytes = accountBytes(result.value);
  if (bytes === null || bytes.length < OFFSET_CLOCK_UNIX_TIMESTAMP + 8) {
    return { reason: 'respuesta_invalida' };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { ts: view.getBigInt64(OFFSET_CLOCK_UNIX_TIMESTAMP, true) };
}

/**
 * Las variables de las que sale la URL de esta tarjeta, EN ORDEN de preferencia.
 * El orden es normativo y `escrow-scan.test.ts` lo fija: un test que sólo
 * verifique "usa alguna URL" no sirve, porque el defecto que esta lista existe
 * para evitar es elegir la EQUIVOCADA.
 */
const RPC_URL_ENV_VARS = [
  'SOLANA_RPC_URL_PROGRAM_ACCOUNTS',
  'SOLANA_RPC_URL_FALLBACK',
  'SOLANA_RPC_URL',
] as const;

/**
 * La URL contra la que se barre, o `null` si no hay ninguna configurada.
 *
 * ⚠️ ESTA TARJETA TIENE VARIABLE PROPIA (`SOLANA_RPC_URL_PROGRAM_ACCOUNTS`), y
 * no es capricho. Dos razones, las dos medidas:
 *
 * 1. `getProgramAccounts` NO está en todos los planes. El proveedor dedicado que
 *    hoy sirve a producción (Alchemy) lo excluye del plan gratuito —textual:
 *    "getProgramAccounts is not available on the Free tier"— y es exactamente el
 *    método que esta tarjeta necesita. Colgada de la URL del money-path, la
 *    tarjeta decía `sin_dato` PARA SIEMPRE: no porque no hubiera datos, sino
 *    porque le preguntaba a un endpoint que no contesta esa pregunta.
 * 2. Las otras dos URLs TIENEN DUEÑO, y su dueño es el camino del dinero.
 *    `SOLANA_RPC_URL` es el proveedor PRIMARIO del cobro inbound —`chain.ts:288`
 *    lo dice: contra otro ledger "a signature that never existed on devnet could
 *    be honoured"— y `SOLANA_RPC_URL_FALLBACK` es el SEGUNDO proveedor, que
 *    `chain.ts:312` exige que sea **distinto** del primero. Que un tablero se
 *    colgara de la primaria era un acoplamiento invisible en la dirección
 *    peligrosa: quien moviera esa variable por razones de PAGOS rompía el
 *    tablero sin enterarse, y quien la moviera por razones de TABLERO tocaría la
 *    variable de la que depende cada cobro.
 *
 * Por eso el orden es dedicada → fallback → primaria: primero la que no le
 * pertenece a nadie más, y sólo como último recurso las del dinero, que se leen
 * pero NUNCA se escriben desde acá.
 *
 * ⚠️ Se lee del entorno DIRECTO y no vía `getSolanaRpcUrl()`, cuyo default es el
 * endpoint público de devnet. ⛔ Y acá decía que ese público "devuelve 429
 * sostenido y no sirve como fuente": **eso quedó desmentido**. Medido con el
 * patrón real del tablero (1 llamada, esperar 12 s, repetir) da 5/5 exitosas a
 * ~300 ms; los 429 los produjo un diagnóstico que martillaba el endpoint, no
 * este tablero. El motivo real de no usar el default es otro: un default
 * silencioso convierte "nadie configuró nada" en una lectura que parece
 * configurada. Si el público ES la fuente que se quiere, se pone en
 * `SOLANA_RPC_URL_PROGRAM_ACCOUNTS` y se ve en el entorno. Ninguna configurada ⇒
 * `rpc_no_configurado`: se dice que no se pudo leer, no se finge.
 *
 * El `.trim()` no es cosmético: `chain.ts:308` ya trata un
 * `SOLANA_RPC_URL_FALLBACK` de puro espacio como ausente, y sin él esta cadena
 * leería la MISMA variable distinto que su dueño — un valor en blanco taparía
 * en silencio a la siguiente de la lista.
 */
function getEscrowScanRpcUrl(): string | null {
  for (const name of RPC_URL_ENV_VARS) {
    const raw = process.env[name]?.trim();
    if (raw !== undefined && raw !== '') return raw;
  }
  return null;
}

/** La tarjeta 3 del tablero. */
export async function scanEscrows(): Promise<TableroEscrowsCard> {
  const rpcUrl = getEscrowScanRpcUrl();
  if (rpcUrl === null) {
    return sinDato('rpc_no_configurado');
  }

  const body = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'getProgramAccounts',
      params: [
        getEscrowProgramId(),
        {
          encoding: 'base64',
          commitment: getSolanaCommitment(),
          filters: [
            { dataSize: ESCROW_STATE_SIZE },
            {
              memcmp: {
                offset: 0,
                bytes: base58Encode(ESCROW_STATE_DISCRIMINATOR),
              },
            },
          ],
        },
      ],
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'getAccountInfo',
      params: [CLOCK_SYSVAR_ADDRESS, { encoding: 'base64' }],
    },
  ];

  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (err) {
    // Timeout (`AbortError`) y error de red caen los dos acá.
    log.warn(
      { detail: err instanceof Error ? err.name : 'unknown' },
      'tablero escrow scan: el RPC no respondió',
    );
    return sinDato('rpc_error');
  }

  if (!response.ok) {
    // 429 y 5xx: el RPC contestó, pero no con datos.
    log.warn(
      { httpStatus: response.status },
      'tablero escrow scan: el RPC respondió con error HTTP',
    );
    return sinDato('rpc_error');
  }

  const parsed = (await response.json().catch(() => null)) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== body.length) {
    return sinDato('respuesta_invalida');
  }
  const byId = new Map<unknown, JsonRpcEnvelope>();
  for (const entry of parsed) {
    if (!isRecord(entry)) return sinDato('respuesta_invalida');
    byId.set(entry.id, entry as JsonRpcEnvelope);
  }

  const accountsEnvelope = byId.get(1);
  if (accountsEnvelope === undefined) return sinDato('respuesta_invalida');
  if (accountsEnvelope.error !== undefined) {
    log.warn({}, 'tablero escrow scan: el RPC devolvió un error JSON-RPC');
    return sinDato('rpc_error');
  }
  if (!Array.isArray(accountsEnvelope.result)) {
    return sinDato('respuesta_invalida');
  }
  const counted = tally(accountsEnvelope.result);
  if (counted === null) return sinDato('respuesta_invalida');

  const base = {
    status: 'ok' as const,
    escrows_vivos: counted.vivos,
    // `formatUnits` es el de `viem`, el mismo que usan `deposit-verifier.ts` (el
    // vecino de esta carpeta), `escrow-verifier.ts`, `reconciliation.ts` y
    // `downstream-payment.ts`. Acá vivía una copia privada que rellenaba los
    // decimales: imprimía `12.000000` donde toda otra superficie del producto
    // imprime `12`. Mismo número, convención que sólo existía acá.
    usdc_bloqueado: formatUnits(counted.usdc, getSolanaUsdcDecimals()),
    otros_mints_count: counted.otrosMints,
  };

  // El reloj degrada SOLO: si no se leyó, `vencidos` va `null` CON motivo y el
  // conteo y la suma se muestran igual. ⛔ Nunca `0` por no haber podido leer, y
  // ⛔ nunca `Date.now()`: el reloj local da vuelta los veredictos de deadline.
  const reloj = clockUnixTimestamp(byId.get(2));
  if (!('ts' in reloj)) {
    return { ...base, vencidos: null, vencidos_reason: reloj.reason };
  }
  const now = reloj.ts;
  return {
    ...base,
    vencidos: counted.deadlines.filter((deadline) => deadline < now).length,
  };
}
