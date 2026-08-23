/**
 * WKH-225 — el token de reanudación (AC-4).
 *
 * Lo que estos tests protegen NO es "que devuelva el código correcto": es el
 * ORDEN. La firma se valida ANTES de leer el payload, y ANTES de tocar la base.
 * Un test que sólo mirara el código de error pasaría igual con el orden
 * invertido, que es el bug que el AC existe para prevenir.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signQuote, verifyQuote } from '../services/orchestrate-quote.js';
import {
  RESUME_CLOCK_SKEW_SECONDS,
  RESUME_ENV_VAR,
  RESUME_MAX_TOKEN_CHARS,
  type ResumeTokenCaller,
  resolveResumeCaller,
  resolveSuspendTtlSeconds,
  resumeTokenHash,
  SUSPEND_DEFAULT_MAX_TTL_SECONDS,
  SUSPEND_MAX_TTL_ENV_VAR,
  SUSPEND_MIN_TTL_SECONDS,
  signResumeToken,
  suspendMaxTtlSeconds,
  verifyResumeToken,
} from './resume-token.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = resolve(HERE, 'resume-token.ts');

const RESUME_SECRET = 'resume-secret-para-los-tests';
const QUOTE_SECRET = 'quote-secret-para-los-tests';
const QUOTE_ENV = 'ORCHESTRATE_QUOTE_HMAC_KEY';

const CALLER: ResumeTokenCaller = { kind: 'key', id: 'key-aaa' };
const RUN_ID = '11111111-2222-3333-4444-555555555555';
const NOW_MS = 1_760_000_000_000;

let savedResume: string | undefined;
let savedQuote: string | undefined;
let savedMax: string | undefined;

beforeEach(() => {
  savedResume = process.env[RESUME_ENV_VAR];
  savedQuote = process.env[QUOTE_ENV];
  savedMax = process.env[SUSPEND_MAX_TTL_ENV_VAR];
  process.env[RESUME_ENV_VAR] = RESUME_SECRET;
  process.env[QUOTE_ENV] = QUOTE_SECRET;
  delete process.env[SUSPEND_MAX_TTL_ENV_VAR];
});

afterEach(() => {
  if (savedResume === undefined) delete process.env[RESUME_ENV_VAR];
  else process.env[RESUME_ENV_VAR] = savedResume;
  if (savedQuote === undefined) delete process.env[QUOTE_ENV];
  else process.env[QUOTE_ENV] = savedQuote;
  if (savedMax === undefined) delete process.env[SUSPEND_MAX_TTL_ENV_VAR];
  else process.env[SUSPEND_MAX_TTL_ENV_VAR] = savedMax;
  vi.restoreAllMocks();
});

function mint(over?: {
  caller?: ResumeTokenCaller;
  ttlSeconds?: number;
  nowMs?: number;
}): string {
  const signed = signResumeToken({
    runId: RUN_ID,
    caller: over?.caller ?? CALLER,
    ttlSeconds: over?.ttlSeconds ?? 3600,
    nowMs: over?.nowMs ?? NOW_MS,
  });
  expect(signed).not.toBeNull();
  return (signed as { token: string }).token;
}

describe('T-TOK · emisión y verificación del token de reanudación', () => {
  it('el camino feliz verifica y devuelve el runId', () => {
    const res = verifyResumeToken(mint(), CALLER, NOW_MS + 1000);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.payload.rid).toBe(RUN_ID);
      expect(res.payload.exp).toBe(res.payload.iat + 3600);
    }
  });

  it('T-TOK-1: una firma inválida da RESUME_INVALID', () => {
    const token = mint();
    // Se toca UN carácter de la firma, no del payload: lo que se mide es el
    // HMAC, no la forma.
    const flipped = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    expect(verifyResumeToken(flipped, CALLER, NOW_MS + 1000)).toEqual({
      ok: false,
      code: 'RESUME_INVALID',
    });
  });

  it('T-TOK-2: con firma inválida NO se hace NINGUNA llamada a supabase', async () => {
    // 🔴 ESTE es el test del AC, y no el anterior. Sin él sólo se prueba el
    // código de error; el ORDEN —firma antes que payload, y payload antes que
    // base— quedaría sin testigo. Se mide sobre el módulo real de supabase: si
    // este archivo lo importara, `from` aparecería en el LEAF y `T-TOK-LEAF`
    // se caería, así que el testigo del orden y el de la pureza se sostienen.
    const supabaseModule = await import('./supabase.js');
    const spy = vi.spyOn(supabaseModule.supabase, 'from');
    const rpc = vi.spyOn(supabaseModule.supabase, 'rpc');

    const token = mint();
    const flipped = `${token.slice(0, -2)}zz`;
    expect(verifyResumeToken(flipped, CALLER, NOW_MS + 1000).ok).toBe(false);

    expect(spy).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('T-TOK-3: un `iat` en el futuro más allá del skew es inválido', () => {
    const token = mint({ nowMs: NOW_MS });
    // Justo dentro del skew: sigue siendo válido.
    const dentro = verifyResumeToken(
      token,
      CALLER,
      NOW_MS - RESUME_CLOCK_SKEW_SECONDS * 1000,
    );
    expect(dentro.ok).toBe(true);
    // Un segundo más allá del skew: inválido.
    const fuera = verifyResumeToken(
      token,
      CALLER,
      NOW_MS - (RESUME_CLOCK_SKEW_SECONDS + 2) * 1000,
    );
    expect(fuera).toEqual({ ok: false, code: 'RESUME_INVALID' });
  });

  it('T-TOK-4: un token de QUOTE no verifica como resume, ni al revés', () => {
    const quote = signQuote({
      orchestrationId: RUN_ID,
      caller: { kind: 'key', id: CALLER.id },
      steps: [{ agent: 'a', registry: null, priceUsdc: 1 }],
      nowMs: NOW_MS,
    });
    expect(quote).not.toBeNull();
    const quoteToken = (quote as { token: string }).token;

    // Dirección 1: el quote presentado como resume.
    expect(verifyResumeToken(quoteToken, CALLER, NOW_MS + 1000).ok).toBe(false);

    // Dirección 2: el resume presentado como quote.
    const resumeToken = mint();
    expect(
      verifyQuote(resumeToken, { kind: 'key', id: CALLER.id }, NOW_MS + 1000)
        .ok,
    ).toBe(false);

    // Y el caso REALMENTE peligroso: los dos secretos configurados con el MISMO
    // valor. Si la separación viviera sólo en el secreto, acá se cruzarían.
    process.env[QUOTE_ENV] = RESUME_SECRET;
    const quoteMismoSecreto = signQuote({
      orchestrationId: RUN_ID,
      caller: { kind: 'key', id: CALLER.id },
      steps: [{ agent: 'a', registry: null, priceUsdc: 1 }],
      nowMs: NOW_MS,
    });
    expect(quoteMismoSecreto).not.toBeNull();
    expect(
      verifyResumeToken(
        (quoteMismoSecreto as { token: string }).token,
        CALLER,
        NOW_MS + 1000,
      ).ok,
    ).toBe(false);
  });

  it('T-TOK-5: sin secreto es inválido (fail-closed) y NO lanza', () => {
    const token = mint();
    delete process.env[RESUME_ENV_VAR];
    expect(() => verifyResumeToken(token, CALLER, NOW_MS + 1000)).not.toThrow();
    expect(verifyResumeToken(token, CALLER, NOW_MS + 1000)).toEqual({
      ok: false,
      code: 'RESUME_INVALID',
    });
    // Y tampoco se puede EMITIR sin secreto.
    expect(
      signResumeToken({ runId: RUN_ID, caller: CALLER, ttlSeconds: 3600 }),
    ).toBeNull();
  });

  it('T-TOK-6: un token gigante se rechaza ANTES de decodificar nada', () => {
    const token = mint();
    const [version, encoded, signature] = token.split('.') as [
      string,
      string,
      string,
    ];
    // Payload legítimo, sólo que inflado con relleno base64url válido hasta
    // pasar el techo. Si el techo no corriera primero, esto se decodificaría.
    const relleno = 'A'.repeat(RESUME_MAX_TOKEN_CHARS);
    const gigante = `${version}.${encoded}${relleno}.${signature}`;
    expect(gigante.length).toBeGreaterThan(RESUME_MAX_TOKEN_CHARS);
    expect(verifyResumeToken(gigante, CALLER, NOW_MS + 1000)).toEqual({
      ok: false,
      code: 'RESUME_INVALID',
    });
  });

  it('T-TOK-7: un `exp` vencido no verifica (y se distingue de una firma rota)', () => {
    const token = mint({ ttlSeconds: SUSPEND_MIN_TTL_SECONDS });
    const despues = NOW_MS + (SUSPEND_MIN_TTL_SECONDS + 1) * 1000;
    expect(verifyResumeToken(token, CALLER, despues)).toEqual({
      ok: false,
      code: 'RESUME_EXPIRED',
    });
    // El código es OTRO que el de la firma rota A PROPÓSITO: un vencido todavía
    // tiene que llegar a la base, que es la única que puede marcar la fila
    // `expired` y dejar constancia del residuo. Uno inválido no.
    expect(verifyResumeToken(`${token}x`, CALLER, NOW_MS + 1000)).toEqual({
      ok: false,
      code: 'RESUME_INVALID',
    });
  });

  it('T-TOK-8: el binding es a la credencial EXACTA, en los 3 `kind`', () => {
    const kinds: ResumeTokenCaller['kind'][] = ['key', 'session', 'delegation'];
    for (const kind of kinds) {
      const emisor: ResumeTokenCaller = { kind, id: 'cred-1' };
      const token = mint({ caller: emisor });
      // Mismo id, OTRO kind ⇒ inválido (por eso el kind entra al material
      // firmado: una delegación y una sesión pueden compartir UUID).
      for (const otroKind of kinds) {
        const res = verifyResumeToken(
          token,
          { kind: otroKind, id: 'cred-1' },
          NOW_MS + 1000,
        );
        expect(res.ok).toBe(otroKind === kind);
      }
      // Mismo kind, OTRO id ⇒ inválido.
      expect(
        verifyResumeToken(token, { kind, id: 'cred-2' }, NOW_MS + 1000),
      ).toEqual({ ok: false, code: 'RESUME_INVALID' });
    }
  });

  it('un token con partes de menos o prefijo ajeno es inválido, sin lanzar', () => {
    const casos = [
      '',
      'v1',
      'v1.abc',
      'v2.abc.' + 'f'.repeat(64),
      'v1..' + 'f'.repeat(64),
      'v1.abc.no-es-hex',
      `v1.${Buffer.from('{"no":"json-valido"').toString('base64url')}.${'f'.repeat(64)}`,
    ];
    for (const caso of casos) {
      expect(() => verifyResumeToken(caso, CALLER, NOW_MS)).not.toThrow();
      expect(verifyResumeToken(caso, CALLER, NOW_MS).ok).toBe(false);
    }
  });
});

describe('T-TOK · el hash es lo único que se persiste', () => {
  it('el hash es estable, hex de 64, y NO contiene el token', () => {
    const token = mint();
    const hash = resumeTokenHash(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(resumeTokenHash(token));
    expect(hash).not.toContain(token.slice(0, 16));
    expect(resumeTokenHash(`${token}x`)).not.toBe(hash);
  });
});

describe('T-TOK · el TTL', () => {
  it('sin TTL pedido, el efectivo es el MÁXIMO (default = máximo)', () => {
    expect(resolveSuspendTtlSeconds(undefined)).toBe(
      SUSPEND_DEFAULT_MAX_TTL_SECONDS,
    );
  });

  it('rechaza (no recorta) lo que está fuera de rango', () => {
    expect(resolveSuspendTtlSeconds(SUSPEND_MIN_TTL_SECONDS - 1)).toBeNull();
    expect(
      resolveSuspendTtlSeconds(SUSPEND_DEFAULT_MAX_TTL_SECONDS + 1),
    ).toBeNull();
    expect(resolveSuspendTtlSeconds(1.5)).toBeNull();
    expect(resolveSuspendTtlSeconds(Number.NaN)).toBeNull();
    expect(resolveSuspendTtlSeconds(SUSPEND_MIN_TTL_SECONDS)).toBe(
      SUSPEND_MIN_TTL_SECONDS,
    );
  });

  it('el piso duro queda por encima del techo de wall-clock del propio /compose', () => {
    // MEDIDO contra el default del timeout (180000 ms): por debajo del 504 la
    // suspensión no compra nada.
    expect(SUSPEND_MIN_TTL_SECONDS).toBeGreaterThan(180000 / 1000);
  });

  it('un techo por env inválido o menor que el piso cae al default', () => {
    process.env[SUSPEND_MAX_TTL_ENV_VAR] = 'no-es-un-numero';
    expect(suspendMaxTtlSeconds()).toBe(SUSPEND_DEFAULT_MAX_TTL_SECONDS);
    process.env[SUSPEND_MAX_TTL_ENV_VAR] = '0';
    expect(suspendMaxTtlSeconds()).toBe(SUSPEND_DEFAULT_MAX_TTL_SECONDS);
    process.env[SUSPEND_MAX_TTL_ENV_VAR] = '10';
    expect(suspendMaxTtlSeconds()).toBe(SUSPEND_DEFAULT_MAX_TTL_SECONDS);
    process.env[SUSPEND_MAX_TTL_ENV_VAR] = '600';
    expect(suspendMaxTtlSeconds()).toBe(600);
    expect(resolveSuspendTtlSeconds(700)).toBeNull();
  });
});

describe('T-TOK · la precedencia del binding', () => {
  it('delegación gana a sesión, y sesión gana a key', () => {
    expect(
      resolveResumeCaller({
        delegationContext: { delegationId: 'd1' },
        keySessionContext: { sessionId: 's1' },
        a2aKeyRow: { id: 'k1' },
      }),
    ).toEqual({ kind: 'delegation', id: 'd1' });
    expect(
      resolveResumeCaller({
        keySessionContext: { sessionId: 's1' },
        a2aKeyRow: { id: 'k1' },
      }),
    ).toEqual({ kind: 'session', id: 's1' });
    expect(resolveResumeCaller({ a2aKeyRow: { id: 'k1' } })).toEqual({
      kind: 'key',
      id: 'k1',
    });
  });

  it('un caller no bindeable (x402 / anónimo) da null — fail-closed', () => {
    expect(resolveResumeCaller({})).toBeNull();
    expect(resolveResumeCaller({ a2aKeyRow: { id: '' } })).toBeNull();
  });
});

describe('T-TOK-LEAF · el módulo no importa nada más que node:crypto', () => {
  it('el fuente de resume-token.ts no tiene otro `from` que node:crypto', () => {
    // ⚠️ Se lee EL FUENTE DEL MÓDULO, no este archivo de test. Un
    // `expect(self.includes('node:crypto'))` sobre el test nunca podría fallar:
    // el literal estaría en la línea que lo busca.
    const src = readFileSync(SELF, 'utf8');
    const froms = [...src.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]);
    expect(froms.length).toBeGreaterThan(0);
    expect([...new Set(froms)]).toEqual(['node:crypto']);
    // Y ningún `import(...)` dinámico, que esquivaría el barrido de arriba.
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });
});
