/**
 * Unit tests del quote freeze — WKH-303 (archivo #8, 11 tests)
 *
 *  - T-Q-U1  round-trip sign→verify; congela slug, registry y precio; exp - iat === 600
 *  - T-Q-U2  payload mutado con la firma vieja → QUOTE_INVALID
 *  - T-Q-U3  los dos lados del borde de expiración (599 s vive, 601 s expira)
 *  - T-Q-U4  binding a la credencial exacta (otro id, y mismo id con otro kind)
 *  - T-Q-U5  el módulo es stateless de verdad (sin imports de storage) y anda sin mocks
 *  - T-Q-U6  precio 0/negativo/NaN se rechaza AUNQUE la firma verifique
 *  - T-Q-U7  sin secreto: no se firma y no se acepta nada (fail-closed)
 *  - T-Q-U8  token por encima del techo de tamaño → QUOTE_INVALID sin tirar
 *  - T-Q-U9  `iat` en el futuro más allá del skew → QUOTE_INVALID
 *  - T-Q-U10 firmas y formas malformadas → QUOTE_INVALID, nunca throw
 *  - T-Q-U11 precedencia de resolveQuoteCaller: delegación > sesión > key
 *
 * CD-17: ningún test re-implementa el HMAC para compararlo contra sí mismo. Todos parten
 * de un token producido por `signQuote` y lo mutan, o firman con OTRA clave.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeQuoteBinding,
  QUOTE_MAX_TOKEN_CHARS,
  QUOTE_TTL_SECONDS,
  type QuoteCaller,
  type QuoteStepInput,
  quoteHmacKey,
  resolveQuoteCaller,
  signQuote,
  verifyQuote,
} from './orchestrate-quote.js';

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);
const CALLER: QuoteCaller = { kind: 'key', id: 'key-1' };
const STEPS: QuoteStepInput[] = [
  { agent: 'agent-alpha', registry: 'wasiai', priceUsdc: 0.05 },
  { agent: 'agent-beta', registry: null, priceUsdc: 0.06 },
];

// CD-16: la env se restaura en afterEach, NUNCA en la última línea del cuerpo del
// test — si el test falla antes, contaminaría todo el archivo.
let envSnapshot: string | undefined;
let receiptSecretSnapshot: string | undefined;
beforeEach(() => {
  envSnapshot = process.env.ORCHESTRATE_QUOTE_HMAC_KEY;
  receiptSecretSnapshot = process.env.RECEIPT_SIGNING_SECRET;
  process.env.ORCHESTRATE_QUOTE_HMAC_KEY = KEY;
});
afterEach(() => {
  if (envSnapshot === undefined) delete process.env.ORCHESTRATE_QUOTE_HMAC_KEY;
  else process.env.ORCHESTRATE_QUOTE_HMAC_KEY = envSnapshot;
  if (receiptSecretSnapshot === undefined)
    delete process.env.RECEIPT_SIGNING_SECRET;
  else process.env.RECEIPT_SIGNING_SECRET = receiptSecretSnapshot;
});

/** Re-encodea un payload mutado CONSERVANDO la firma original del token. */
function tamperPayload(
  token: string,
  mutate: (payload: Record<string, unknown>) => void,
): string {
  const [version, encoded, signature] = token.split('.') as [
    string,
    string,
    string,
  ];
  const payload = JSON.parse(
    Buffer.from(encoded, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  mutate(payload);
  const reencoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  return `${version}.${reencoded}.${signature}`;
}

/** Firma un payload arbitrario con la clave REAL (para probar guards post-firma). */
function signTamperedWithRealKey(
  token: string,
  mutate: (payload: Record<string, unknown>) => void,
): string {
  const tampered = tamperPayload(token, mutate);
  const [version, encoded] = tampered.split('.') as [string, string];
  // `createHmac` se usa SOLO acá para FABRICAR una entrada de test (un token cuyo
  // payload es inválido pero cuya firma sí verifica). No se usa para comprobar
  // ninguna aserción contra sí misma — eso es justo lo que CD-17 prohíbe.
  const sig = createHmac('sha256', KEY)
    .update(`${version}.${encoded}`, 'utf8')
    .digest('hex');
  return `${version}.${encoded}.${sig}`;
}

describe('orchestrate-quote — emisión y verificación', () => {
  // T-Q-U1
  it('T-Q-U1: round-trip congela slug, registry y precio; el TTL es exactamente 600 s', () => {
    const signed = signQuote({
      orchestrationId: 'orch-1',
      caller: CALLER,
      steps: STEPS,
    });
    expect(signed).not.toBeNull();
    if (signed === null) throw new Error('unreachable');

    const result = verifyQuote(signed.token, CALLER);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    expect(result.payload.steps.map((s) => s.a)).toEqual([
      'agent-alpha',
      'agent-beta',
    ]);
    expect(result.payload.steps.map((s) => s.r)).toEqual(['wasiai', null]);
    expect(result.payload.steps.map((s) => s.p)).toEqual([
      '0.05000000',
      '0.06000000',
    ]);
    expect(result.payload.steps.map((s) => Number(s.p))).toEqual([0.05, 0.06]);
    expect(result.payload.oid).toBe('orch-1');
    // Los 10 minutos son 10 minutos.
    expect(result.payload.exp - result.payload.iat).toBe(600);
    expect(QUOTE_TTL_SECONDS).toBe(600);
    expect(signed.expiresAtIso).toBe(
      new Date(result.payload.exp * 1000).toISOString(),
    );
  });

  // T-Q-U2
  it('T-Q-U2: payload mutado (precio 0.05 → 0.01) con la MISMA firma → QUOTE_INVALID', () => {
    const signed = signQuote({
      orchestrationId: 'orch-1',
      caller: CALLER,
      steps: [{ agent: 'agent-alpha', registry: null, priceUsdc: 0.05 }],
    });
    if (signed === null) throw new Error('unreachable');

    const tampered = tamperPayload(signed.token, (payload) => {
      const steps = payload.steps as Array<Record<string, unknown>>;
      const first = steps[0];
      if (first !== undefined) first.p = '0.01000000';
    });
    expect(tampered).not.toBe(signed.token);

    const result = verifyQuote(tampered, CALLER);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('QUOTE_INVALID');
  });

  // T-Q-U3 — los DOS lados del borde
  it('T-Q-U3: a los 599 s el quote vive; a los 601 s está expirado', () => {
    const issuedAtMs = 1_800_000_000_000;
    const signed = signQuote({
      orchestrationId: 'orch-1',
      caller: CALLER,
      steps: STEPS,
      nowMs: issuedAtMs,
    });
    if (signed === null) throw new Error('unreachable');

    const alive = verifyQuote(signed.token, CALLER, issuedAtMs + 599_000);
    expect(alive.ok).toBe(true);

    const expired = verifyQuote(signed.token, CALLER, issuedAtMs + 601_000);
    expect(expired.ok).toBe(false);
    if (expired.ok) throw new Error('unreachable');
    expect(expired.code).toBe('QUOTE_EXPIRED');
  });

  // T-Q-U4
  it('T-Q-U4: el binding es a la credencial EXACTA (otro id, y mismo id con otro kind)', () => {
    const signed = signQuote({
      orchestrationId: 'orch-1',
      caller: { kind: 'key', id: 'k1' },
      steps: STEPS,
    });
    if (signed === null) throw new Error('unreachable');

    const otherKey = verifyQuote(signed.token, { kind: 'key', id: 'k2' });
    expect(otherKey.ok).toBe(false);
    if (otherKey.ok) throw new Error('unreachable');
    expect(otherKey.code).toBe('QUOTE_CALLER_MISMATCH');

    // Mismo id, distinto kind: una delegación y una sesión que compartan UUID no
    // pueden redimir el quote de la otra.
    const sameIdOtherKind = signQuote({
      orchestrationId: 'orch-2',
      caller: { kind: 'delegation', id: 'shared-uuid' },
      steps: STEPS,
    });
    if (sameIdOtherKind === null) throw new Error('unreachable');
    const crossKind = verifyQuote(sameIdOtherKind.token, {
      kind: 'session',
      id: 'shared-uuid',
    });
    expect(crossKind.ok).toBe(false);
    if (crossKind.ok) throw new Error('unreachable');
    expect(crossKind.code).toBe('QUOTE_CALLER_MISMATCH');
  });

  // T-Q-U5 — AC-7
  it('T-Q-U5: el módulo es stateless (sin storage en el fuente) y el round-trip corre sin un solo mock', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, 'orchestrate-quote.ts'), 'utf8');
    expect(source).not.toMatch(/supabase|redis|ioredis|pg/i);

    const signed = signQuote({
      orchestrationId: 'orch-1',
      caller: CALLER,
      steps: STEPS,
    });
    if (signed === null) throw new Error('unreachable');
    expect(verifyQuote(signed.token, CALLER).ok).toBe(true);
  });

  // T-Q-U6 — el precio se valida aunque la firma sea nuestra
  it('T-Q-U6: precio 0, negativo o no numérico → QUOTE_INVALID aunque la firma VERIFIQUE', () => {
    const signed = signQuote({
      orchestrationId: 'orch-1',
      caller: CALLER,
      steps: [{ agent: 'agent-alpha', registry: null, priceUsdc: 0.05 }],
    });
    if (signed === null) throw new Error('unreachable');

    for (const badPrice of ['0.00000000', '-0.05000000', 'NaN']) {
      const forged = signTamperedWithRealKey(signed.token, (payload) => {
        const steps = payload.steps as Array<Record<string, unknown>>;
        const first = steps[0];
        if (first !== undefined) first.p = badPrice;
      });
      const result = verifyQuote(forged, CALLER);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`unreachable for ${badPrice}`);
      expect(result.code).toBe('QUOTE_INVALID');
    }
  });

  // T-Q-U7 — fail-closed
  it('T-Q-U7: sin secreto no se firma, y un token válido previo deja de aceptarse', () => {
    const signed = signQuote({
      orchestrationId: 'orch-1',
      caller: CALLER,
      steps: STEPS,
    });
    if (signed === null) throw new Error('unreachable');

    process.env.ORCHESTRATE_QUOTE_HMAC_KEY = '';
    expect(
      signQuote({ orchestrationId: 'orch-2', caller: CALLER, steps: STEPS }),
    ).toBeNull();
    expect(computeQuoteBinding(CALLER)).toBeNull();

    const result = verifyQuote(signed.token, CALLER);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('QUOTE_INVALID');
  });

  // T-Q-U7b — CD-5: el secreto es DEDICADO, sin fallback cruzado.
  // Este caso existe porque el mutante M14 (fallback a RECEIPT_SIGNING_SECRET)
  // SOBREVIVÍA: el fallback solo es observable si el OTRO secreto existe, y ningún
  // test lo seteaba. En producción `RECEIPT_SIGNING_SECRET` normalmente SÍ está, así
  // que sin este test un fallback cruzado pasaría inadvertido: acoplaría dos
  // subsistemas (rotar uno invalidaría el otro en silencio) y filtrar cualquiera de
  // los dos permitiría FORJAR quotes.
  it('T-Q-U7b: con RECEIPT_SIGNING_SECRET presente pero SIN el secreto dedicado, no se firma nada', () => {
    delete process.env.ORCHESTRATE_QUOTE_HMAC_KEY;
    process.env.RECEIPT_SIGNING_SECRET = 'secreto-de-recibos-no-de-quotes';

    expect(quoteHmacKey()).toBeNull();
    expect(computeQuoteBinding(CALLER)).toBeNull();
    expect(
      signQuote({ orchestrationId: 'orch-3', caller: CALLER, steps: STEPS }),
    ).toBeNull();
  });

  // T-Q-U8
  it('T-Q-U8: un token por encima del techo de tamaño → QUOTE_INVALID, sin tirar', () => {
    const huge = `v1.${'a'.repeat(QUOTE_MAX_TOKEN_CHARS)}.${'f'.repeat(64)}`;
    expect(huge.length).toBeGreaterThan(QUOTE_MAX_TOKEN_CHARS);
    let result: ReturnType<typeof verifyQuote> | undefined;
    expect(() => {
      result = verifyQuote(huge, CALLER);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    if (result === undefined || result.ok) throw new Error('unreachable');
    expect(result.code).toBe('QUOTE_INVALID');
  });

  // T-Q-U9
  it('T-Q-U9: `iat` en el futuro más allá del skew → QUOTE_INVALID', () => {
    const nowMs = 1_800_000_000_000;
    const signed = signQuote({
      orchestrationId: 'orch-1',
      caller: CALLER,
      steps: STEPS,
      nowMs: nowMs + 120_000, // 120 s en el futuro: supera el skew de 60 s
    });
    if (signed === null) throw new Error('unreachable');

    const result = verifyQuote(signed.token, CALLER, nowMs);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('QUOTE_INVALID');
  });

  // T-Q-U10
  it('T-Q-U10: firmas y formas malformadas → QUOTE_INVALID y NUNCA throw', () => {
    const signed = signQuote({
      orchestrationId: 'orch-1',
      caller: CALLER,
      steps: STEPS,
    });
    if (signed === null) throw new Error('unreachable');
    const [version, encoded] = signed.token.split('.') as [string, string];

    const malformed: string[] = [
      `${version}.${encoded}.${'f'.repeat(63)}`, // hex corto
      `${version}.${encoded}.${'f'.repeat(65)}`, // hex largo
      `${version}.${encoded}.${'g'.repeat(64)}`, // no-hex
      `${version}.${encoded}.`, // firma vacía
      `${version}.${encoded}`, // sin firma (2 partes)
      `${version}.${encoded}.${'f'.repeat(64)}.extra`, // 4 partes
      'sin-puntos',
      '',
      `v2.${encoded}.${'f'.repeat(64)}`, // prefijo desconocido
      `${version}..${'f'.repeat(64)}`, // payload vacío
      // firmado con OTRA clave (CD-17: no re-implementamos el HMAC para compararlo)
      (() => {
        process.env.ORCHESTRATE_QUOTE_HMAC_KEY = OTHER_KEY;
        const other = signQuote({
          orchestrationId: 'orch-1',
          caller: CALLER,
          steps: STEPS,
        });
        process.env.ORCHESTRATE_QUOTE_HMAC_KEY = KEY;
        return other?.token ?? 'x';
      })(),
      undefined as unknown as string,
      null as unknown as string,
      12345 as unknown as string,
    ];

    for (const token of malformed) {
      let result: ReturnType<typeof verifyQuote> | undefined;
      expect(() => {
        result = verifyQuote(token, CALLER);
      }).not.toThrow();
      expect(result?.ok).toBe(false);
      if (result === undefined || result.ok) {
        throw new Error(`unreachable for ${String(token)}`);
      }
      expect(result.code).toBe('QUOTE_INVALID');
    }
  });

  // T-Q-U11
  it('T-Q-U11: precedencia del binding — delegación > sesión > key; sin ninguno → null', () => {
    expect(
      resolveQuoteCaller({
        delegationContext: { delegationId: 'd1' },
        keySessionContext: { sessionId: 's1' },
        a2aKeyRow: { id: 'k1' },
      }),
    ).toEqual({ kind: 'delegation', id: 'd1' });

    expect(
      resolveQuoteCaller({
        keySessionContext: { sessionId: 's1' },
        a2aKeyRow: { id: 'k1' },
      }),
    ).toEqual({ kind: 'session', id: 's1' });

    expect(resolveQuoteCaller({ a2aKeyRow: { id: 'k1' } })).toEqual({
      kind: 'key',
      id: 'k1',
    });

    // x402 / anónimo: no bindeable
    expect(resolveQuoteCaller({})).toBeNull();
  });
});
