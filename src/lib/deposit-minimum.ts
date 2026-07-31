/**
 * Minimo de deposito del CAMINO DE DEPOSITO (no de una cadena).
 *
 * QUE DECIDE
 * Un unico numero, `A2A_DEPOSIT_MIN_USDC`, chain-agnostico. Se compara contra el
 * monto YA VERIFICADO en cadena, en unidades atomicas y con enteros. Si el monto
 * queda por debajo, el deposito no acredita.
 *
 * POR QUE EXISTE (es disponibilidad, no optimizacion)
 * Antes de este guard el piso efectivo era 1 unidad atomica: `USDC_MINIMUM_TRANSFER_WEI_DEFAULT = '1'`
 * en `src/adapters/avalanche/gasless.ts` y `src/adapters/base/gasless.ts`, y en Solana
 * el criterio de aceptacion pasaba vacio. O sea que se aceptaba y se verificaba un
 * deposito de 0.000001 USDC.
 *
 * Cada intento de deposito Solana gasta DOS llamadas al RPC PUBLICO, una de ellas
 * `getSignatureStatuses` con `searchTransactionHistory: true`, que es de las mas
 * restringidas del endpoint publico; y `register_a2a_key_deposit` toma `FOR UPDATE`
 * sobre la fila de la clave (`src/services/budget.ts`), asi que los depositos de una
 * misma clave se serializan.
 *
 * AFIRMACION FALSABLE, con su limite explicito:
 * este guard elimina la RECOMPENSA de inundar el camino de deposito con polvo (un
 * deposito por debajo del minimo nunca acredita y nunca llega a tomar el `FOR UPDATE`,
 * porque el chequeo corre ANTES de la RPC a Postgres). NO reemplaza un rate limit: un
 * atacante que solo quiera quemar el cupo de RPC manda firmas invalidas y gasta
 * exactamente lo mismo, porque el gasto de RPC ocurre en la VERIFICACION, que es
 * anterior a este guard. Si alguien mide "el minimo bajo la carga de RPC", esa
 * medicion tiene que dar que NO baja.
 *
 * FAIL-CLOSED
 * Sin env, o con env mal escrita, el deposito se RECHAZA. No se adivina un minimo.
 * Es la misma decision que ya se tomo al borrar el default de `TRANSFI_BASE_URL`, y
 * la que este ecosistema repite en `wasiai-remittance-agents` con `TRANSFI_USDC_NETWORK`.
 * Un default silencioso seria un minimo que nadie eligio protegiendo plata real.
 *
 * PROHIBIDO EL FLOTANTE
 * USDC tiene 6 decimales y `0.1 + 0.2 !== 0.3`. Todo lo que pasa por aca se convierte
 * UNA sola vez a micro-dolares (enteros, 1e-6 USD) y se compara `bigint` contra
 * `bigint`. Cero `Number`, cero `parseFloat`, cero `parseUnits` (que ademas redondea
 * los decimales sobrantes y lanza con notacion cientifica).
 */

/** Decimales de la grilla de comparacion: micro-dolares (la grilla de USDC). */
const SCALE_DECIMALS = 6;
const SCALE = 1_000_000n;

/**
 * Decimal plano y NO NEGATIVO, con parte entera obligatoria y como mucho un punto.
 * Rechaza por construccion: `''`, `'-1'`, `'+1'`, `'1e6'`, `'0x1'`, `'NaN'`,
 * `'Infinity'`, `'1,5'`, `'.5'` y `'1.'`.
 */
const PLAIN_DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/**
 * Convierte un decimal plano no negativo a micro-dolares, TRUNCANDO los decimales
 * que sobren de la grilla de 6.
 *
 * El truncado (no el redondeo) es deliberado: es la direccion fail-closed. Un token
 * de 18 decimales puede entregar `'0.999999999999999999'`; truncar da `999999`, que
 * queda por debajo de `1.000000`. Redondear lo subiria a `1000000` y dejaria pasar un
 * monto que no llega al minimo.
 *
 * Devuelve `null` si la cadena no es un decimal plano no negativo.
 */
function toMicroUsd(raw: string): bigint | null {
  const match = PLAIN_DECIMAL_RE.exec(raw);
  if (match === null) return null;
  const intPart = match[1] ?? '';
  const fracPart = (match[2] ?? '')
    .slice(0, SCALE_DECIMALS)
    .padEnd(SCALE_DECIMALS, '0');
  return BigInt(intPart) * SCALE + BigInt(fracPart);
}

/**
 * Micro-dolares de vuelta a decimal canonico, para poder DECIR el minimo.
 *
 * Exportada (fix-pack AR 2026-07-31) porque `GET /auth/deposit-info` tiene que
 * PUBLICAR el mismo numero que el guard aplica, y con el mismo formateo. Si el
 * endpoint formateara por su cuenta, el contrato publicado y el guard podrian
 * decir cosas distintas del mismo `bigint`.
 */
export function formatMicroUsd(micro: bigint): string {
  const intPart = (micro / SCALE).toString();
  const fracPart = (micro % SCALE).toString().padStart(SCALE_DECIMALS, '0');
  const trimmed = fracPart.replace(/0+$/, '');
  return trimmed === '' ? intPart : `${intPart}.${trimmed}`;
}

/**
 * El minimo configurado, en micro-dolares, o `null` si la env falta o esta mal escrita.
 *
 * Choke-point unico: NADIE mas lee `A2A_DEPOSIT_MIN_USDC`. Es una funcion y no una
 * constante de modulo a proposito, para que se evalue en cada request (mismo criterio
 * que `isProduction()` en `src/lib/env.ts`) y para que un test pueda cambiarla sin
 * pelearse con el cache de modulos.
 *
 * Se rechaza `0` (y `0.000000`): un minimo de cero no es un minimo, es el guard
 * apagado. Apagarlo tiene que costar un cambio de codigo, no un typo en una env.
 * Tambien se rechaza mas de 6 decimales: `'1.0000001'` es sub-grilla y no hay una
 * lectura obvia de cual de las dos vecinas quiso decir el operador, asi que se
 * rechaza en vez de elegir por el.
 */
export function resolveDepositMinimumMicroUsd(): bigint | null {
  const raw = process.env.A2A_DEPOSIT_MIN_USDC;
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  const micro = toMicroUsd(trimmed);
  if (micro === null || micro <= 0n) return null;
  return micro;
}

/**
 * Estado de la env del minimo, con la CAUSA separada (fix-pack AR 2026-07-31).
 *
 * `resolveDepositMinimumMicroUsd()` devuelve `null` para dos situaciones que el
 * operador arregla en lugares distintos: "no la puse" y "la puse mal". Colapsarlas
 * manda a buscar donde no es (el AR lo midio: hoy son la misma rama).
 *
 * NO DUPLICA LA DECISION. Quien decide si el valor sirve sigue siendo
 * `resolveDepositMinimumMicroUsd()`; esta funcion solo lee el crudo para partir su
 * `null` en dos causas. Si manana cambia el criterio de validez, cambia en un solo
 * lugar y esto lo sigue.
 */
export type DepositMinimumEnvStatus =
  | { state: 'configured'; microUsd: bigint; usdc: string }
  | { state: 'absent' }
  | { state: 'invalid'; raw: string };

export function classifyDepositMinimumEnv(): DepositMinimumEnvStatus {
  const micro = resolveDepositMinimumMicroUsd();
  if (micro !== null) {
    return {
      state: 'configured',
      microUsd: micro,
      usdc: formatMicroUsd(micro),
    };
  }
  const raw = process.env.A2A_DEPOSIT_MIN_USDC;
  if (raw === undefined || raw.trim() === '') return { state: 'absent' };
  return { state: 'invalid', raw: raw.trim() };
}

/**
 * Veredicto del guard. Union discriminada, sin booleano: un `boolean` colapsaria
 * "no llega al minimo" con "no se cual es el minimo", que son dos causas distintas
 * y tienen que poder distinguirse en la telemetria.
 */
export type DepositMinimumVerdict =
  | { ok: true }
  | { ok: false; reason: 'DEPOSIT_MINIMUM_NOT_CONFIGURED' }
  | { ok: false; reason: 'DEPOSIT_AMOUNT_INVALID' }
  | { ok: false; reason: 'DEPOSIT_BELOW_MINIMUM'; minimumUsdc: string };

/**
 * Evalua un monto YA VERIFICADO en cadena contra el minimo.
 *
 * @param amountUsd monto en dolares como decimal plano. Es lo que producen los tres
 *   verificadores (`formatUnits(atomic, decimals)` en `deposit-verifier.ts`,
 *   `escrow-verifier.ts` y `solana/deposit-verifier.ts`), nunca el monto declarado
 *   por el caller.
 *
 * El borde va PARA ADENTRO: exactamente el minimo acredita (`>=`).
 *
 * El orden de los chequeos importa: la env se evalua ANTES que el monto, para que
 * "falta configurar el minimo" nunca se reporte como "tu deposito es chico".
 */
export function checkDepositMinimum(amountUsd: string): DepositMinimumVerdict {
  const minimum = resolveDepositMinimumMicroUsd();
  if (minimum === null) {
    return { ok: false, reason: 'DEPOSIT_MINIMUM_NOT_CONFIGURED' };
  }
  const amount = toMicroUsd(amountUsd);
  if (amount === null) {
    // No lo puede provocar un caller: los tres verificadores devuelven
    // `formatUnits(...)`, que siempre es decimal plano no negativo. Existe para que
    // un verificador futuro que devuelva basura falle RUIDOSO en vez de acreditar.
    return { ok: false, reason: 'DEPOSIT_AMOUNT_INVALID' };
  }
  if (amount < minimum) {
    return {
      ok: false,
      reason: 'DEPOSIT_BELOW_MINIMUM',
      minimumUsdc: formatMicroUsd(minimum),
    };
  }
  return { ok: true };
}
