/**
 * Credencial OUTBOUND hacia agentes self-published — parsing de la env var y
 * resolución por destino (`lib/self-published-auth.ts`).
 *
 * Lo que se prueba acá es el GUARD: a quién se le manda el secreto y a quién no.
 * El cableado dentro de `compose.invokeAgent` (que es el que decide si esta
 * función se llama y con qué URL) vive en
 * `services/compose.selfpublished-auth.test.ts`, sobre el camino real.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertSelfPublishedAuthEnv,
  classifySelfPublishedAuthEnv,
  resolveSelfPublishedAuthHeaders,
  SELF_PUBLISHED_AUTH_ENV,
} from './self-published-auth.js';

const OURS = 'agents.example.com';
const THEIRS = 'attacker.example.net';
const SECRET = 'gateway-secret-1';

function setEnv(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[SELF_PUBLISHED_AUTH_ENV];
    return;
  }
  process.env[SELF_PUBLISHED_AUTH_ENV] = value;
}

const original = process.env[SELF_PUBLISHED_AUTH_ENV];

beforeEach(() => setEnv(undefined));
afterEach(() => setEnv(original));

describe('classifySelfPublishedAuthEnv — estados de la variable', () => {
  it('ausente → absent (estado válido: nadie recibe credencial)', () => {
    expect(classifySelfPublishedAuthEnv()).toEqual({ state: 'absent' });
  });

  it('vacía o sólo espacios → absent (no es "mal escrita")', () => {
    setEnv('');
    expect(classifySelfPublishedAuthEnv()).toEqual({ state: 'absent' });
    setEnv('   ');
    expect(classifySelfPublishedAuthEnv()).toEqual({ state: 'absent' });
  });

  it('mapa válido → configured con los hosts canonicalizados (sin secretos)', () => {
    setEnv(JSON.stringify({ 'AGENTS.Example.COM': SECRET }));
    const status = classifySelfPublishedAuthEnv();
    expect(status).toEqual({ state: 'configured', hosts: [OURS] });
    // El status PÚBLICO no puede arrastrar la credencial a un log.
    expect(JSON.stringify(status)).not.toContain(SECRET);
  });

  it.each([
    ['no es JSON', 'no-json'],
    ['es un array', '["a"]'],
    ['es un escalar', '"just-a-string"'],
    ['es null', 'null'],
    ['es un mapa vacío', '{}'],
    ['la clave trae puerto', '{"agents.example.com:8443":"s"}'],
    ['la clave trae esquema', '{"https://agents.example.com":"s"}'],
    ['la clave trae path', '{"agents.example.com/invoke":"s"}'],
    ['la clave trae userinfo', '{"user@agents.example.com":"s"}'],
    ['la clave está vacía', '{"":"s"}'],
    ['el secreto no es string', '{"agents.example.com":123}'],
    ['el secreto está vacío', '{"agents.example.com":""}'],
    ['el secreto tiene espacios de borde', '{"agents.example.com":" s "}'],
    [
      'el mismo host aparece dos veces',
      '{"agents.example.com":"a","AGENTS.EXAMPLE.COM":"b"}',
    ],
  ])('presente pero inservible (%s) → invalid', (_label, raw) => {
    setEnv(raw);
    expect(classifySelfPublishedAuthEnv().state).toBe('invalid');
  });
});

describe('assertSelfPublishedAuthEnv — chequeo de arranque', () => {
  it('ausente → no lanza y devuelve lista vacía', () => {
    expect(assertSelfPublishedAuthEnv()).toEqual([]);
  });

  it('válida → devuelve los hosts, y NUNCA los secretos', () => {
    setEnv(JSON.stringify({ [OURS]: SECRET, [THEIRS]: 'otro' }));
    const hosts = assertSelfPublishedAuthEnv();
    expect(hosts).toEqual([OURS, THEIRS]);
    expect(hosts.join('|')).not.toContain(SECRET);
  });

  it('MAL ESCRITA → lanza (no bootea) y el mensaje NO filtra el secreto', () => {
    // Secreto válido, clave inválida: el valor está bien pero el destino no se
    // puede leer. El mensaje tiene que nombrar la clave sin escupir la credencial.
    setEnv(JSON.stringify({ 'agents.example.com:8443': SECRET }));
    let thrown: unknown;
    try {
      assertSelfPublishedAuthEnv();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(SELF_PUBLISHED_AUTH_ENV);
    expect((thrown as Error).message).not.toContain(SECRET);
  });
});

describe('resolveSelfPublishedAuthHeaders — a quién se le manda el secreto', () => {
  it('POSITIVO: host declarado + https → viaja SU bearer', () => {
    setEnv(JSON.stringify({ [OURS]: SECRET }));
    expect(resolveSelfPublishedAuthHeaders(`https://${OURS}/invoke`)).toEqual({
      Authorization: `Bearer ${SECRET}`,
    });
  });

  it('POSITIVO: el host se compara canonicalizado (mayúsculas y punto final)', () => {
    setEnv(JSON.stringify({ 'Agents.Example.Com': SECRET }));
    expect(
      resolveSelfPublishedAuthHeaders(`https://AGENTS.EXAMPLE.COM/invoke`),
    ).toEqual({ Authorization: `Bearer ${SECRET}` });
  });

  it('NEGATIVO: variable ausente → sin credencial (default fail-closed)', () => {
    expect(resolveSelfPublishedAuthHeaders(`https://${OURS}/invoke`)).toEqual(
      {},
    );
  });

  it('NEGATIVO: variable ilegible → sin credencial (no degrada a "mandale igual")', () => {
    setEnv('{roto');
    expect(resolveSelfPublishedAuthHeaders(`https://${OURS}/invoke`)).toEqual(
      {},
    );
  });

  it('NEGATIVO: host NO declarado → sin credencial, aunque el mapa tenga otros', () => {
    setEnv(JSON.stringify({ [OURS]: SECRET }));
    expect(resolveSelfPublishedAuthHeaders(`https://${THEIRS}/invoke`)).toEqual(
      {},
    );
  });

  it('NEGATIVO: un subdominio del host declarado NO hereda la credencial', () => {
    setEnv(JSON.stringify({ [OURS]: SECRET }));
    expect(
      resolveSelfPublishedAuthHeaders(`https://evil.${OURS}/invoke`),
    ).toEqual({});
    // Y tampoco el truco del sufijo pegado (`xagents.example.com`).
    expect(resolveSelfPublishedAuthHeaders(`https://x${OURS}/invoke`)).toEqual(
      {},
    );
  });

  it('NEGATIVO: http:// no recibe el secreto ni estando declarado (nunca en claro)', () => {
    setEnv(JSON.stringify({ [OURS]: SECRET }));
    expect(resolveSelfPublishedAuthHeaders(`http://${OURS}/invoke`)).toEqual(
      {},
    );
  });

  it('NEGATIVO: invokeUrl no parseable → sin credencial (no revienta)', () => {
    setEnv(JSON.stringify({ [OURS]: SECRET }));
    expect(resolveSelfPublishedAuthHeaders('no-es-una-url')).toEqual({});
  });

  it('AISLAMIENTO: cada destino recibe SU secreto, no el del otro', () => {
    setEnv(JSON.stringify({ [OURS]: SECRET, [THEIRS]: 'secreto-del-otro' }));
    expect(resolveSelfPublishedAuthHeaders(`https://${OURS}/invoke`)).toEqual({
      Authorization: `Bearer ${SECRET}`,
    });
    expect(resolveSelfPublishedAuthHeaders(`https://${THEIRS}/invoke`)).toEqual(
      { Authorization: 'Bearer secreto-del-otro' },
    );
  });
});
