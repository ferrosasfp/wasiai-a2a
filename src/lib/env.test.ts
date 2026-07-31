/**
 * Env helpers Tests — F-08 (audit 2026-06-29): boot-time required-secret
 * assertion. `assertRequiredEnv` must throw (listing ALL missing vars) when a
 * required secret is absent IN PRODUCTION, and be a no-op outside production.
 */

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertDepositMinimumEnv,
  assertRequiredEnv,
  parseTrustProxy,
} from './env.js';

const KEYS = [
  'NODE_ENV',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'OPERATOR_PRIVATE_KEY',
  'A2A_DEPOSIT_MIN_USDC',
] as const;
const ORIGINAL: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) ORIGINAL[k] = process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});

describe('assertRequiredEnv — F-08', () => {
  it('is a no-op outside production even when secrets are missing', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.OPERATOR_PRIVATE_KEY;
    expect(() => assertRequiredEnv()).not.toThrow();
  });

  it('does not throw in production when all required secrets are present', () => {
    process.env.NODE_ENV = 'production';
    process.env.SUPABASE_URL = 'https://x.supabase.co';
    process.env.SUPABASE_SERVICE_KEY = 'service-key';
    process.env.OPERATOR_PRIVATE_KEY = '0xabc';
    expect(() => assertRequiredEnv()).not.toThrow();
  });

  it('throws in production listing ALL missing required secrets', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    process.env.OPERATOR_PRIVATE_KEY = '0xabc';
    expect(() => assertRequiredEnv()).toThrow(/SUPABASE_URL/);
    expect(() => assertRequiredEnv()).toThrow(/SUPABASE_SERVICE_KEY/);
  });

  it('treats an empty/whitespace value as missing in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.SUPABASE_URL = 'https://x.supabase.co';
    process.env.SUPABASE_SERVICE_KEY = '   ';
    process.env.OPERATOR_PRIVATE_KEY = '0xabc';
    expect(() => assertRequiredEnv()).toThrow(/SUPABASE_SERVICE_KEY/);
  });
});

/**
 * assertDepositMinimumEnv — fix-pack AR 2026-07-31.
 *
 * ANTES: un `A2A_DEPOSIT_MIN_USDC` mal escrito no se notaba al arrancar. El proceso
 * subia normal y la primera noticia era un 503 en el primer deposito de un tercero.
 *
 * OJO CON EL ATAJO QUE NO FUNCIONA: agregar el nombre a la lista de
 * `assertRequiredEnv()` NO atrapa nada de esto. Esa funcion chequea PRESENCIA, y
 * `'1,5'` esta presente y no vacia. Por eso el chequeo EVALUA el valor con la misma
 * funcion que usa el guard.
 */
describe('assertDepositMinimumEnv — fix-pack AR 2026-07-31', () => {
  // Presente pero ilegible → el proceso NO arranca. Es el caso en el que el operador
  // CREE tener un minimo puesto.
  it.each([
    '1,5',
    '1 USDC',
    '1.0000001',
    '0',
    '0.000000',
    '1e6',
    '-1',
    '.5',
    '1.',
  ])('un minimo mal escrito (%s) hace fallar el arranque, y el mensaje trae el valor', (raw) => {
    process.env.A2A_DEPOSIT_MIN_USDC = raw;
    expect(() => assertDepositMinimumEnv()).toThrow(/MAL ESCRITA/);
    expect(() => assertDepositMinimumEnv()).toThrow(
      new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });

  it.each([
    '1',
    '1.0',
    '0.5',
    '2.5',
    '0.000001',
    '  1  ',
  ])('un minimo valido (%s) deja arrancar sin warning', (raw) => {
    process.env.A2A_DEPOSIT_MIN_USDC = raw;
    expect(assertDepositMinimumEnv()).toBeNull();
  });

  // Ausente → NO tumba el gateway (hace muchas cosas que no son depositar), pero
  // devuelve el warning para que el arranque lo grite.
  it.each([
    undefined,
    '',
    '   ',
  ])('con la env ausente/vacia (%s) no lanza y devuelve un warning ruidoso', (raw) => {
    if (raw === undefined) delete process.env.A2A_DEPOSIT_MIN_USDC;
    else process.env.A2A_DEPOSIT_MIN_USDC = raw;

    const warning = assertDepositMinimumEnv();

    expect(warning).not.toBeNull();
    expect(warning).toMatch(/NO ESTA CONFIGURADA/);
    expect(warning).toMatch(/A2A_DEPOSIT_MIN_USDC/);
  });

  // El AR lo pidio explicito: hoy las dos causas son la misma rama y mandan al
  // operador a buscar donde no es. Un mensaje que no las separa no sirve.
  it('separa AUSENTE de MAL ESCRITA: ninguno de los dos textos sirve para el otro caso', () => {
    delete process.env.A2A_DEPOSIT_MIN_USDC;
    const absent = assertDepositMinimumEnv() as string;

    process.env.A2A_DEPOSIT_MIN_USDC = '1,5';
    let malformed = '';
    try {
      assertDepositMinimumEnv();
    } catch (err) {
      malformed = (err as Error).message;
    }

    expect(malformed).not.toBe('');
    // El de ausente no acusa un valor que no existe.
    expect(absent).not.toMatch(/MAL ESCRITA/);
    // El de mal escrita no dice "falta": la variable esta, lo que falla es el valor.
    expect(malformed).not.toMatch(/NO ESTA CONFIGURADA/);
    expect(malformed).toContain('1,5');
    expect(absent).not.toContain('1,5');
  });
});

// H3 (audit 2026-07-01): trustProxy env parsing + Fastify wiring regression.
// Without trustProxy `request.ip` (the default rate-limit key) collapses to the
// TCP peer (Railway edge) for ALL callers → one shared bucket → trivial
// unauthenticated DoS. These pin the parse + that trustProxy ON makes Fastify
// resolve request.ip from X-Forwarded-For (per-client bucket).
describe('parseTrustProxy — H3', () => {
  it('returns false when unset/empty (default, unchanged behavior)', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('   ')).toBe(false);
  });

  it('parses boolean strings (case/space-insensitive)', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('TRUE')).toBe(true);
    expect(parseTrustProxy(' true ')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('parses an integer hop count', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
  });

  it('parses a comma-separated subnet/IP list into an array', () => {
    expect(parseTrustProxy('10.0.0.0/8,127.0.0.1')).toEqual([
      '10.0.0.0/8',
      '127.0.0.1',
    ]);
  });

  it('passes a single IP/subnet/keyword through as a string', () => {
    expect(parseTrustProxy('loopback')).toBe('loopback');
    expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
  });
});

describe('Fastify trustProxy wiring — H3 regression', () => {
  async function ipFor(
    trustProxy: ReturnType<typeof parseTrustProxy>,
    xff: string,
  ): Promise<string> {
    const app = Fastify({ trustProxy });
    app.get('/ip', async (req) => ({ ip: req.ip }));
    const res = await app.inject({
      method: 'GET',
      url: '/ip',
      headers: { 'x-forwarded-for': xff },
    });
    await app.close();
    return res.json().ip as string;
  }

  it('trustProxy ON → request.ip resolves from X-Forwarded-For (per-client bucket)', async () => {
    const ipA = await ipFor(parseTrustProxy('true'), '203.0.113.7');
    const ipB = await ipFor(parseTrustProxy('true'), '198.51.100.42');
    expect(ipA).toBe('203.0.113.7');
    expect(ipB).toBe('198.51.100.42');
    expect(ipA).not.toBe(ipB);
  });

  it('trustProxy OFF (default) → request.ip does NOT reflect X-Forwarded-For (shared bucket)', async () => {
    const ipA = await ipFor(parseTrustProxy(undefined), '203.0.113.7');
    const ipB = await ipFor(parseTrustProxy(undefined), '198.51.100.42');
    expect(ipA).not.toBe('203.0.113.7');
    expect(ipA).toBe(ipB);
  });
});
