/**
 * EL COMBINADOR DE DOS PROVEEDORES + LA LECTURA DEL BINDING — WKH-314.
 *
 * **Todo este archivo es PURO: cero red, cero DB, cero reloj.** Recibe lo que ya
 * leyeron los proveedores y decide. Que sea puro es lo que hace testeable la tabla de
 * precedencia entera sin un solo mock de RPC.
 *
 * ── POR QUE DOS PROVEEDORES (DT-10) ─────────────────────────────────────────
 *
 * Un `unknown` tiene que ser CARO de provocar. Con un solo nodo, cualquiera que pueda
 * tirar abajo (o simplemente saturar) ese endpoint convierte todos los cobros en
 * `unknown`. Con dos, hace falta voltear los dos.
 * ⚠️ Y por eso el runbook exige que el fallback sea **un proveedor distinto**: dos
 * llamadas al mismo nodo caído no son dos opiniones, son la misma.
 *
 * ── LAS CUATRO REGLAS QUE EL COMBINADOR NO PUEDE ROMPER ─────────────────────
 *
 * 1. **`terms_mismatch` es PEGAJOSO y le gana a `finalized_ok`.** Dos parseos de la
 *    MISMA firma no pueden discrepar legítimamente sobre los números: la transacción
 *    es inmutable. Si discrepan, es una anomalía —un nodo mintiendo, un nodo con datos
 *    corruptos— y ante una anomalía sobre dinero se deniega.
 * 2. **Un `absent` solo, contradicho por un `unknown`, NO es una negativa.** Hacen
 *    falta DOS nodos que hayan buscado en su histórico y no la conozcan. Un nodo que
 *    no contesta no vota.
 * 3. **La ausencia de fallback nunca convierte un `unknown` en un grant.** Sin
 *    `SOLANA_RPC_URL_FALLBACK`, el veredicto del primario se usa TAL CUAL.
 * 4. El monto se compara en unidades ATOMICAS y con `>=` (eso vive en
 *    `inbound-presence.ts`, que es quien mide).
 */

import type { SolanaInboundBinding, SolanaInboundPresence } from '../types.js';

/**
 * PRECEDENCIA de los estados de presencia. El `switch` es EXHAUSTIVO a propósito:
 * agregar un estado a `SolanaInboundPresence` sin decidir dónde entra **no compila**.
 * Un estado nuevo que cayera por default en cualquier lado sería una decisión de
 * dinero tomada por omisión.
 */
function presenceRank(state: SolanaInboundPresence['state']): number {
  switch (state) {
    case 'terms_mismatch':
      return 0;
    case 'finalized_ok':
      return 1;
    case 'landed_failed':
      return 2;
    case 'not_finalized':
      return 3;
    case 'absent':
      return 4;
    case 'unknown':
      return 5;
  }
}

/**
 * Combina el veredicto de los dos proveedores. `fallback === null` significa **no hay
 * segundo proveedor configurado**, y entonces el del primario se usa tal cual (regla 3).
 *
 * ⚠️ `fallback === null` NO es lo mismo que un fallback que dijo `unknown`: el primero
 * es "no preguntamos", el segundo es "preguntamos y no supo". El segundo SI puede
 * degradar un `absent` a `unknown` (regla 2); el primero no toca nada.
 */
export function combineInboundPresence(
  primary: SolanaInboundPresence,
  fallback: SolanaInboundPresence | null,
): SolanaInboundPresence {
  if (fallback === null) return primary;
  const winner =
    presenceRank(primary.state) <= presenceRank(fallback.state)
      ? primary
      : fallback;
  const other = winner === primary ? fallback : primary;
  // Regla 2: la ausencia exige DOS testigos que hayan buscado.
  if (winner.state === 'absent' && other.state !== 'absent') {
    return {
      state: 'unknown',
      detail: `one provider reports the signature as absent and the other could not answer (${other.state}) — absence needs two nodes that searched their history`,
    };
  }
  return winner;
}

/**
 * PRECEDENCIA del binding. También exhaustivo, por el mismo motivo.
 *
 * Las dos negativas (`reference_absent`, `outside_window`) son MEDICIONES sobre una
 * transacción inmutable, así que son pegajosas: si un nodo midió que la referencia no
 * está y el otro dice que sí, hay una anomalía y se deniega.
 */
function bindingRank(state: SolanaInboundBinding['state']): number {
  switch (state) {
    case 'reference_absent':
      return 0;
    case 'outside_window':
      return 1;
    case 'bound':
      return 2;
    case 'unknown':
      return 3;
  }
}

export function combineInboundBinding(
  primary: SolanaInboundBinding,
  fallback: SolanaInboundBinding | null,
): SolanaInboundBinding {
  if (fallback === null) return primary;
  return bindingRank(primary.state) <= bindingRank(fallback.state)
    ? primary
    : fallback;
}

/** Forma mínima de una transacción parseada, leída SIEMPRE a la defensiva. */
interface ParsedShape {
  blockTime?: number | null;
  transaction?: { message?: { accountKeys?: unknown } } | undefined;
  meta?: { loadedAddresses?: unknown } | null | undefined;
  version?: unknown;
}

/** Una entrada de `accountKeys` puede venir como `PublicKey` o como `{pubkey,…}`. */
function addressOf(entry: unknown): string | undefined {
  if (entry === undefined || entry === null) return undefined;
  if (typeof entry === 'string') return entry;
  const pk = (entry as { pubkey?: { toBase58?: () => string } }).pubkey;
  if (typeof pk?.toBase58 === 'function') return pk.toBase58();
  const direct = entry as { toBase58?: () => string };
  if (typeof direct.toBase58 === 'function') return direct.toBase58();
  return undefined;
}

/**
 * P5 — ¿esta transacción es LA de este challenge?
 *
 * Dos preguntas, y las dos tienen que dar que sí:
 *   · la `reference` aparece entre las cuentas de la transacción
 *     (`transaction.message.accountKeys` ∪ `meta.loadedAddresses`);
 *   · el `blockTime` cae dentro de `[issuedAt, expiresAt]`.
 *
 * ⚠️ LA REGLA QUE NO SE PUEDE ROMPER: **si las cuentas no se pueden enumerar POR
 * COMPLETO, el veredicto es `unknown`, JAMAS "la referencia no está".**
 *
 * El caso concreto: una transacción **v0** puede referir cuentas a través de Address
 * Lookup Tables. Si el nodo no resolvió `meta.loadedAddresses`, la lista que tenemos
 * está INCOMPLETA, y buscar en una lista incompleta y no encontrar algo no prueba que
 * no esté. Responder `reference_absent` ahí sería rechazar un pago real por no poder
 * leerlo — y encima con un código que le dice al pagador que se equivocó él.
 * *Esto sería falso si*: una tx v0 con `loadedAddresses` ausente devolviera
 * `reference_absent` — ahí un pago legítimo hecho con una lookup table se rechazaría
 * como fraudulento.
 *
 * ⚠️ Y EL `blockTime` AUSENTE TAMBIEN ES `unknown`. Es opcional en el tipo del SDK: su
 * ausencia significa que no podemos ubicar la tx en el tiempo, no que haya caído fuera
 * de la ventana.
 */
export function readInboundBinding(
  parsed: ParsedShape | null | undefined,
  args: { reference: string; issuedAt: number; expiresAt: number },
): SolanaInboundBinding {
  if (!parsed) {
    return {
      state: 'unknown',
      detail: 'no parsed transaction to read the binding from',
    };
  }
  const rawKeys: unknown = parsed.transaction?.message?.accountKeys;
  if (!Array.isArray(rawKeys)) {
    return {
      state: 'unknown',
      detail:
        'the parsed transaction carries no account key list — the reference can be neither found nor ruled out',
    };
  }
  const staticKeys = rawKeys.map(addressOf);
  if (staticKeys.some((k) => k === undefined)) {
    return {
      state: 'unknown',
      detail:
        'an account key entry could not be resolved to an address — the account list is not fully readable',
    };
  }

  // Las direcciones cargadas por lookup table. `undefined` cuando el nodo no las
  // mandó; `{writable, readonly}` cuando sí.
  const loaded: unknown = parsed.meta?.loadedAddresses;
  const loadedKeys: string[] = [];
  let loadedResolved = true;
  if (loaded !== undefined && loaded !== null) {
    const w: unknown = (loaded as { writable?: unknown }).writable;
    const r: unknown = (loaded as { readonly?: unknown }).readonly;
    for (const bucket of [w, r]) {
      if (bucket === undefined || bucket === null) continue;
      if (!Array.isArray(bucket)) {
        loadedResolved = false;
        continue;
      }
      for (const entry of bucket) {
        const addr = addressOf(entry);
        if (addr === undefined) {
          loadedResolved = false;
          continue;
        }
        loadedKeys.push(addr);
      }
    }
  }

  const all = [...(staticKeys as string[]), ...loadedKeys];
  const found = all.includes(args.reference);

  if (!found) {
    // ⚠️ ACA VIVE LA REGLA. Antes de poder decir "no está", hay que poder afirmar que
    // la lista está COMPLETA.
    if (!loadedResolved) {
      return {
        state: 'unknown',
        detail:
          'the reference is not among the account keys, but this transaction loads addresses that this node did not resolve — the list is incomplete and absence cannot be asserted',
      };
    }
    if (isVersionedWithoutLoadedAddresses(parsed, loaded)) {
      return {
        state: 'unknown',
        detail:
          'the reference is not among the account keys, but this is a versioned (v0) transaction with no loaded-address list — lookup-table accounts may be missing from the list',
      };
    }
    return {
      state: 'reference_absent',
      detail:
        'the challenge reference is not among the accounts of this transaction (the full account list was readable)',
    };
  }

  const blockTime = parsed.blockTime;
  if (typeof blockTime !== 'number' || !Number.isFinite(blockTime)) {
    return {
      state: 'unknown',
      detail:
        'the transaction carries no usable blockTime — it cannot be placed inside or outside the challenge window',
    };
  }
  if (blockTime < args.issuedAt || blockTime > args.expiresAt) {
    return {
      state: 'outside_window',
      detail: `the transaction landed at ${blockTime}, outside the challenge window [${args.issuedAt}, ${args.expiresAt}]`,
    };
  }
  return { state: 'bound', blockTime };
}

/**
 * ¿Es una transacción versionada (v0) que NO trajo lista de direcciones cargadas?
 *
 * Se trata aparte de `loadedResolved` porque son dos ignorancias distintas: allá el
 * nodo mandó la lista y no se pudo leer; acá directamente no la mandó, y en una v0 eso
 * puede significar "no usa lookup tables" o "no te las resolví". Desde la respuesta no
 * se distinguen, así que se asume lo caro.
 *
 * ⚠️ SOLO `version === 'legacy'` CUENTA COMO LEGACY. Un `version` ausente **no** se
 * lee como legacy: sería exactamente el `?? []` de WKH-315 en su versión de metadatos
 * —convertir "el nodo no lo dijo" en "es del tipo que no tiene lookup tables"— y el
 * precio sería un `reference_absent` sobre un pago real. Medido contra devnet el
 * 2026-08-19: `getParsedTransaction` con `maxSupportedTransactionVersion: 0` devuelve
 * `version: 0` en las transacciones de USDC devnet que se inspeccionaron, así que el
 * campo llega; asumirlo igual sería gratis y no lo es.
 */
function isVersionedWithoutLoadedAddresses(
  parsed: ParsedShape,
  loaded: unknown,
): boolean {
  const isLegacy = parsed.version === 'legacy';
  const hasLoaded = loaded !== undefined && loaded !== null;
  return !isLegacy && !hasLoaded;
}
