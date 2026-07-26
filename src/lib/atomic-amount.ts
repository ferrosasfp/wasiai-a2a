/**
 * Conversión USD (number) → unidades atómicas del token (fix-pack P1, hallazgo 3).
 *
 * ─── El bug que arregla ──────────────────────────────────────────────────
 * Los 5 adapters de pago hacían, cada uno por su cuenta:
 *
 *   parseUnits(amountUsd.toFixed(DECIMALS), DECIMALS)
 *
 * `Number.prototype.toFixed(n)` con `n` grande NO emite el decimal que el double
 * representa: emite su **expansión binaria**. Con 18 decimales (la chain default,
 * Kite/PYUSD) eso mete el error de representación completo en el monto atómico
 * del challenge 402:
 *
 *   (0.03).toFixed(18)  === '0.029999999999999999'   →  −1 wei
 *   (0.1).toFixed(18)   === '0.100000000000000006'   →  +6 wei
 *   (1.005).toFixed(18) === '1.004999999999999893'   →  −107 wei
 *
 * El drift **cambia de signo**: positivo = el caller firma y paga de más;
 * negativo = el guard de binding inbound (`middleware/x402.ts`,
 * `BigInt(auth.value) < BigInt(requiredAmount)`) queda más permisivo que el
 * precio real.
 *
 * ─── Por qué el `toFixed` estaba ahí y no se puede borrar sin reemplazo ───
 * `parseUnits` **LANZA** con notación científica:
 *   parseUnits('1e-7', 6) → 'Number `1e-7` is not a valid decimal number'
 * y `String(1e-7)` es `'1e-7'`. El `toFixed` garantizaba salida decimal plana.
 * Este helper mantiene esa garantía SIN pasar por la expansión binaria: expande
 * el exponente a mano a partir de la representación decimal MÁS CORTA con
 * round-trip (`String(n)`), que es el decimal que el número realmente pretende.
 *
 * ─── Invariante sobre el money-path de 6 decimales (ACOTADO AL RANGO PROBADO) ──
 * Para USDC (6 dec) y montos USD en **`[0, 100)`** el resultado es IDÉNTICO al
 * camino viejo: `toFixed(6)` redondea el valor real del double a 6 dp y un double
 * tiene ~15-17 dígitos significativos, así que ahí ambos caminos coinciden.
 * Verificado en `atomic-amount.test.ts` con 200.000 floats aleatorios de ese rango
 * + los precios reales del catálogo: **0 diferencias**. El happy path del
 * marketplace vive entero en ese rango.
 *
 * ⚠️ AR MENOR-3 — FUERA de ese rango el camino viejo y el nuevo NO son idénticos,
 * ni siquiera con 6 decimales. Los dos contraejemplos medidos, declarados para que
 * el cambio de comportamiento no quede tácito:
 *
 *   · `5e-7`  → viejo `0`  / nuevo `1`  (sub-grilla: `toFixed(6)` da `'0.000001'`
 *     o `'0.000000'` según el double; el helper preserva el decimal pretendido y
 *     `parseUnits` redondea). Precio 200× por debajo del mínimo del catálogo.
 *   · `>= 1e21` → viejo **LANZABA** (`String(1e21)` es `'1e+21'` y `parseUnits`
 *     rechaza notación científica ⇒ fail-closed, no se emitía challenge) / nuevo
 *     DEVUELVE el atómico expandido. Fijado por `T-SCI-2`. Es el precio del fix
 *     (expandir el exponente es lo que reemplaza al `toFixed`): un monto de 10^21
 *     USD deja de ser fail-closed. Sin impacto práctico —`/compose` valida el
 *     precio contra el budget del caller mucho antes— pero es un cambio de
 *     comportamiento, no una no-op.
 *
 * O sea: en el rango real de precios del marketplace el monto cobrado no cambia;
 * el fix mueve montos en tokens de > 6 decimales y en los dos bordes de arriba.
 */

import { parseUnits } from 'viem';

/**
 * Convierte un monto en USD a las unidades atómicas de un token, redondeando a
 * la grilla del token (mismo redondeo que ya hacía `parseUnits`).
 *
 * ─── Semántica de inputs patológicos: DELIBERADAMENTE igual a la de antes ──
 * NO se agrega guard para `NaN` / `Infinity` / negativos. El scope de este fix
 * es el artefacto de float y NADA más; cambiar el comportamiento en esos casos
 * ampliaría el blast radius sobre el money-path. Se preserva byte-idéntico:
 *
 *   · `NaN` / `±Infinity` → `parseUnits` LANZA
 *     ('Number `NaN` is not a valid decimal number'), igual que con `toFixed`.
 *     Fail-closed: no se emite challenge.
 *   · negativo → devuelve el atómico NEGATIVO (`-1` USD → `'-1000000'`), igual
 *     que antes.
 *
 * ⚠️ TD-189-3: el caso negativo es un agujero PREEXISTENTE, no introducido acá.
 * Un `maxAmountRequired` negativo hace que el guard de binding inbound
 * (`middleware/x402.ts`, `BigInt(auth.value) < BigInt(requiredAmount)`) sea
 * SIEMPRE falso → cualquier pago, incluso 0, pasaría. Merece su propio work item
 * con su propia batería de tests (un guard fail-closed en `quote()` o, mejor,
 * en el borde que produce el precio). NO se arregla en este commit para que el
 * fix del float siga siendo revertible por separado.
 *
 * @param amountUsd  Monto en USD (number).
 * @param decimals   Decimales del token (6 USDC, 18 PYUSD, 9 SOL-like, ...).
 * @returns Unidades atómicas como string decimal.
 */
export function usdToAtomicUnits(amountUsd: number, decimals: number): string {
  return parseUnits(toPlainDecimalString(amountUsd), decimals).toString();
}

/**
 * Representación decimal PLANA (sin exponente) de un número, derivada de su
 * representación decimal más corta con round-trip (`String`).
 *
 * `NaN`/`Infinity` pasan de largo como `'NaN'`/`'Infinity'` a propósito, para que
 * `parseUnits` lance igual que antes (ver la nota de inputs patológicos arriba).
 *
 * NO usa `toFixed`: `toFixed(d)` con `d` grande expone la expansión binaria del
 * double (ver el bug arriba). `String(n)` da el decimal más corto que
 * round-trippea al mismo double, que es exactamente "el número que se quiso
 * decir" — sólo hay que sacarle el exponente cuando aparece.
 */
function toPlainDecimalString(n: number): string {
  const s = String(n);
  const eIdx = s.search(/[eE]/);
  if (eIdx === -1) return s;

  // El signo se separa y se re-pega al final: la expansión del exponente razona
  // sólo sobre dígitos.
  const negative = s.startsWith('-');
  const body = negative ? s.slice(1) : s;
  return (negative ? '-' : '') + expandExponent(body);
}

/** Expande `<mantisa>e<exp>` (sin signo) a decimal plano. */
function expandExponent(s: string): string {
  const eIdx = s.search(/[eE]/);
  const mantissa = s.slice(0, eIdx);
  const exponent = Number.parseInt(s.slice(eIdx + 1), 10);
  const dotIdx = mantissa.indexOf('.');
  const intPart = dotIdx === -1 ? mantissa : mantissa.slice(0, dotIdx);
  const fracPart = dotIdx === -1 ? '' : mantissa.slice(dotIdx + 1);
  const digits = intPart + fracPart;
  // Posición del punto decimal medida desde el inicio de `digits`.
  const pointPos = intPart.length + exponent;

  if (pointPos <= 0) {
    // 1e-7 → digits='1', pointPos=-6 → '0.0000001'
    return `0.${'0'.repeat(-pointPos)}${digits}`;
  }
  if (pointPos >= digits.length) {
    // 1e21 → digits='1', pointPos=22 → '1' + 21 ceros
    return digits + '0'.repeat(pointPos - digits.length);
  }
  // 1.5e2 → digits='15', pointPos=3 → no ocurre con String() pero es correcto.
  return `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
}
