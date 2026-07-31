/**
 * Minimo de deposito: la lectura de la env y la comparacion en enteros.
 *
 * Este archivo cubre la UNIDAD (`src/lib/deposit-minimum.ts`). Que el guard este
 * efectivamente CABLEADO en el unico acreditador de depositos se prueba en
 * `src/services/budget.test.ts`, y que su superficie HTTP no se colapse contra otros
 * codigos, en `auth.escrow.test.ts` (EVM) y `auth.solana-deposit.test.ts` (Solana).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkDepositMinimum,
  resolveDepositMinimumMicroUsd,
} from './deposit-minimum.js';

const ENV = 'A2A_DEPOSIT_MIN_USDC';

const SRC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.'))
      out.push(full);
  }
  return out;
}

/**
 * DRIFT: el guard es unico porque el ACREDITADOR es unico.
 *
 * Toda la afirmacion "aplica a todas las cadenas por construccion" descansa en que
 * `budgetService.registerDeposit` sea el unico lugar del repo que llama a la RPC
 * `register_a2a_key_deposit` (que a su vez es el unico INSERT en `a2a_key_deposits`
 * y la unica suma al budget por deposito). Enunciarlo en un comentario no alcanza:
 * este test lo vuelve mecanico. Si alguien agrega una cadena con su propio camino de
 * credito, aparece un segundo llamador y esto se pone rojo ANTES de que esa cadena
 * nazca sin minimo.
 */
describe('el guard es unico porque el acreditador es unico', () => {
  it('solo src/services/budget.ts invoca la RPC register_a2a_key_deposit', () => {
    const callers = sourceFiles(SRC_DIR).filter((f) => {
      const src = readFileSync(f, 'utf8');
      // La invocacion real, no la mencion en un comentario ni el tipo generado.
      return /\brpc\(\s*\n?\s*['"]register_a2a_key_deposit['"]/.test(src);
    });

    expect(callers.map((f) => f.replace(SRC_DIR, 'src'))).toEqual([
      'src/services/budget.ts',
    ]);
  });

  it('ningun modulo escribe a2a_key_deposits por PostgREST, esquivando la RPC', () => {
    const writers = sourceFiles(SRC_DIR).filter((f) =>
      /\.from\(\s*['"]a2a_key_deposits['"]/.test(readFileSync(f, 'utf8')),
    );
    expect(writers).toEqual([]);
  });

  it('la unica llamada a budgetService.registerDeposit vive en la ruta de deposito', () => {
    const callers = sourceFiles(SRC_DIR).filter((f) =>
      /budgetService\.registerDeposit\(/.test(readFileSync(f, 'utf8')),
    );
    expect(callers.map((f) => f.replace(SRC_DIR, 'src'))).toEqual([
      'src/routes/auth/deposit.ts',
    ]);
  });
});

describe('deposit-minimum', () => {
  const saved: { value: string | undefined } = { value: undefined };

  beforeEach(() => {
    saved.value = process.env[ENV];
    delete process.env[ENV];
  });

  afterEach(() => {
    if (saved.value === undefined) delete process.env[ENV];
    else process.env[ENV] = saved.value;
  });

  describe('resolveDepositMinimumMicroUsd: fail-closed ante env ausente o mal escrita', () => {
    it('env ausente => null', () => {
      expect(resolveDepositMinimumMicroUsd()).toBeNull();
    });

    // La tabla de basura. Cada fila es un valor que un operador podria escribir por
    // error, y NINGUNO puede producir un minimo adivinado.
    const MALFORMED: [string, string][] = [
      ['vacia', ''],
      ['solo espacios', '   '],
      ['tab y newline', '\t\n'],
      ['negativa', '-1'],
      ['negativa con decimales', '-0.5'],
      ['cero', '0'],
      ['cero con decimales', '0.000000'],
      ['no numerica', 'un dolar'],
      ['NaN literal', 'NaN'],
      ['Infinity literal', 'Infinity'],
      ['-Infinity literal', '-Infinity'],
      ['notacion cientifica', '1e6'],
      ['notacion cientifica chica', '1e-6'],
      ['hexadecimal', '0x1'],
      ['coma decimal', '1,5'],
      ['signo mas', '+1'],
      ['punto sin parte entera', '.5'],
      ['punto sin parte decimal', '1.'],
      ['dos puntos', '1.0.0'],
      ['con simbolo', '$1'],
      ['con unidad', '1 USDC'],
      ['sub-grilla: 7 decimales', '1.0000001'],
      ['espacio interno', '1 0'],
    ];

    it.each(MALFORMED)('%s (%j) => null', (_label, raw) => {
      process.env[ENV] = raw;
      expect(resolveDepositMinimumMicroUsd()).toBeNull();
    });

    // Las que SI se aceptan, con su valor exacto en micro-dolares.
    const WELL_FORMED: [string, bigint][] = [
      ['1', 1_000_000n],
      ['1.0', 1_000_000n],
      ['1.000000', 1_000_000n],
      ['0.5', 500_000n],
      ['0.000001', 1n],
      ['2.5', 2_500_000n],
      ['10', 10_000_000n],
      ['  1  ', 1_000_000n], // el trim es deliberado (mismo criterio que isProduction)
      ['0001', 1_000_000n],
    ];

    it.each(WELL_FORMED)('%j => %s micro-dolares', (raw, expected) => {
      process.env[ENV] = raw;
      expect(resolveDepositMinimumMicroUsd()).toBe(expected);
    });
  });

  describe('checkDepositMinimum: el borde y el orden de las causas', () => {
    it('sin env, un monto GRANDE igual se rechaza, y por NO CONFIGURADO (no por chico)', () => {
      const verdict = checkDepositMinimum('1000000');
      expect(verdict).toEqual({
        ok: false,
        reason: 'DEPOSIT_MINIMUM_NOT_CONFIGURED',
      });
    });

    it('sin env Y con monto ilegible, gana NO CONFIGURADO: la config se evalua primero', () => {
      // Fija el ORDEN de los chequeos. Si alguien mirara el monto antes que la env,
      // este caso contestaria DEPOSIT_AMOUNT_INVALID y el operador buscaria un bug
      // del verificador en vez de la variable que le falta poner.
      expect(checkDepositMinimum('NaN')).toEqual({
        ok: false,
        reason: 'DEPOSIT_MINIMUM_NOT_CONFIGURED',
      });
    });

    it('con env malformada, el monto no se llega a mirar', () => {
      process.env[ENV] = 'un dolar';
      expect(checkDepositMinimum('5')).toEqual({
        ok: false,
        reason: 'DEPOSIT_MINIMUM_NOT_CONFIGURED',
      });
    });

    it('EXACTAMENTE el minimo ACREDITA: el borde va para adentro', () => {
      process.env[ENV] = '1';
      expect(checkDepositMinimum('1')).toEqual({ ok: true });
      expect(checkDepositMinimum('1.000000')).toEqual({ ok: true });
    });

    it('UN ATOMO por debajo del minimo RECHAZA', () => {
      process.env[ENV] = '1';
      expect(checkDepositMinimum('0.999999')).toEqual({
        ok: false,
        reason: 'DEPOSIT_BELOW_MINIMUM',
        minimumUsdc: '1',
      });
    });

    it('un atomo POR ENCIMA acredita', () => {
      process.env[ENV] = '1';
      expect(checkDepositMinimum('1.000001')).toEqual({ ok: true });
    });

    it('muy por debajo (0.000001, el piso efectivo de antes de este guard) RECHAZA', () => {
      process.env[ENV] = '1';
      expect(checkDepositMinimum('0.000001')).toEqual({
        ok: false,
        reason: 'DEPOSIT_BELOW_MINIMUM',
        minimumUsdc: '1',
      });
    });

    it('cero RECHAZA', () => {
      process.env[ENV] = '1';
      expect(checkDepositMinimum('0')).toMatchObject({
        ok: false,
        reason: 'DEPOSIT_BELOW_MINIMUM',
      });
    });

    it('el veredicto LLEVA el minimo requerido, en forma canonica', () => {
      process.env[ENV] = '2.500000';
      const verdict = checkDepositMinimum('1');
      expect(verdict).toEqual({
        ok: false,
        reason: 'DEPOSIT_BELOW_MINIMUM',
        minimumUsdc: '2.5',
      });
    });

    // La razon de ser del bigint. Si la comparacion pasara por `Number`, estos casos
    // se irian al lado equivocado o dependerian de la representacion binaria.
    it('CERO FLOTANTE: montos que un double no representa exacto caen del lado correcto', () => {
      process.env[ENV] = '0.3';
      // 0.1 + 0.2 === 0.30000000000000004 en double. Como decimal exacto, 0.3 es
      // EXACTAMENTE el minimo y tiene que acreditar.
      expect(checkDepositMinimum('0.3')).toEqual({ ok: true });
      expect(checkDepositMinimum('0.299999')).toMatchObject({
        reason: 'DEPOSIT_BELOW_MINIMUM',
      });
    });

    it('montos enormes no desbordan ni pierden precision', () => {
      process.env[ENV] = '1';
      // 2^53 dolares: fuera del rango entero exacto de un double.
      expect(checkDepositMinimum('9007199254740993.000001')).toEqual({
        ok: true,
      });
    });

    it('un token de 18 decimales se TRUNCA a la grilla, no se redondea (fail-closed)', () => {
      process.env[ENV] = '1';
      // Redondear 0.999999999999999999 daria 1.000000 y acreditaria un monto que NO
      // llega al minimo. Truncar da 0.999999 y rechaza.
      expect(checkDepositMinimum('0.999999999999999999')).toMatchObject({
        reason: 'DEPOSIT_BELOW_MINIMUM',
      });
      expect(checkDepositMinimum('1.000000999999999999')).toEqual({ ok: true });
    });

    const UNPARSEABLE = [
      '',
      '   ',
      '-5',
      'NaN',
      'Infinity',
      '1e6',
      'abc',
      '1,5',
      '.5',
      '1.',
    ];

    it.each(
      UNPARSEABLE,
    )('monto ilegible %j => DEPOSIT_AMOUNT_INVALID (nunca acredita, y no miente diciendo que es chico)', (amount) => {
      process.env[ENV] = '1';
      expect(checkDepositMinimum(amount)).toEqual({
        ok: false,
        reason: 'DEPOSIT_AMOUNT_INVALID',
      });
    });
  });
});
