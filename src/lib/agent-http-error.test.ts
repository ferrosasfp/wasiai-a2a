/**
 * Tests for AgentHttpError / classifyAgentFailure — WKH-335 (§9.2).
 *
 * CD-17: los bordes se prueban con PARES QUE DISCRIMINAN (399/400, 422/423,
 * 429/500). Está prohibido usar el mismo status para probar dos cláusulas
 * distintas: un test así pasaría igual con las dos cláusulas colapsadas en una.
 */
import { describe, expect, it } from 'vitest';
import { AgentHttpError, classifyAgentFailure } from './agent-http-error.js';
import { parseFieldErrors } from './field-error-parser.js';

// El mismo body Zod que usa la máquina de reintento en compose.test.ts.
const FIELD_ERR_BODY =
  '{"error":"invalid_input","details":{"fieldErrors":{"senderName":["Required"]}}}';

describe('classifyAgentFailure', () => {
  // Tabla normativa completa del Story File.
  const TABLE: Array<[number, 'INPUT_REJECTED' | 'AGENT_ERROR']> = [
    [400, 'INPUT_REJECTED'],
    [422, 'INPUT_REJECTED'],
    [401, 'AGENT_ERROR'],
    [402, 'AGENT_ERROR'],
    [403, 'AGENT_ERROR'],
    [404, 'AGENT_ERROR'],
    [405, 'AGENT_ERROR'],
    [408, 'AGENT_ERROR'],
    [409, 'AGENT_ERROR'],
    [410, 'AGENT_ERROR'],
    [413, 'AGENT_ERROR'],
    [415, 'AGENT_ERROR'],
    [429, 'AGENT_ERROR'],
    [500, 'AGENT_ERROR'],
    [502, 'AGENT_ERROR'],
    [503, 'AGENT_ERROR'],
  ];

  for (const [status, kind] of TABLE) {
    it(`T-335-CLS: ${status} → ${kind}`, () => {
      expect(classifyAgentFailure(status)).toBe(kind);
    });
  }

  // CD-17: los tres pares que DISCRIMINAN. Cada par cruza un borde de la
  // allow-list con dos números DISTINTOS y exige valores DISTINTOS.
  describe('T-335-CLS-PAIRS: pares que discriminan (CD-17)', () => {
    it('399 vs 400 — el borde inferior de la allow-list', () => {
      expect(classifyAgentFailure(399)).toBe('AGENT_ERROR');
      expect(classifyAgentFailure(400)).toBe('INPUT_REJECTED');
    });

    it('422 vs 423 — el borde superior de la allow-list', () => {
      expect(classifyAgentFailure(422)).toBe('INPUT_REJECTED');
      expect(classifyAgentFailure(423)).toBe('AGENT_ERROR');
    });

    it('429 vs 500 — dos AGENT_ERROR de familias distintas (4xx / 5xx)', () => {
      // El 429 NO es INPUT_REJECTED: reintentar el MISMO input tras esperar
      // puede funcionar, así que la promesa del enum sería falsa.
      expect(classifyAgentFailure(429)).toBe('AGENT_ERROR');
      expect(classifyAgentFailure(500)).toBe('AGENT_ERROR');
    });
  });

  // Totalidad: la función es TOTAL y no lanza para ningún `number`.
  describe('T-335-CLS-TOTAL: total, nunca lanza', () => {
    for (const status of [Number.NaN, -1, 0, 999, Number.POSITIVE_INFINITY]) {
      it(`${String(status)} → un valor válido, sin lanzar`, () => {
        expect(() => classifyAgentFailure(status)).not.toThrow();
        expect(['INPUT_REJECTED', 'AGENT_ERROR']).toContain(
          classifyAgentFailure(status),
        );
      });
    }
  });
});

describe('AgentHttpError', () => {
  it('T-335-ERR-SHAPE: es instanceof Error, name propio, status y kind', () => {
    const err = new AgentHttpError(
      'remit-corridor-fx-solana',
      400,
      'Bad Request',
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AgentHttpError');
    expect(err.status).toBe(400);
    expect(err.kind).toBe('INPUT_REJECTED');
  });

  it('T-335-ERR-KIND: el kind sale del clasificador, no de un literal', () => {
    expect(new AgentHttpError('foo', 500, '').kind).toBe('AGENT_ERROR');
    expect(new AgentHttpError('foo', 422, '').kind).toBe('INPUT_REJECTED');
  });

  // CD-9 MEDIDO, no leído: el `message` es byte-idéntico al que armaba el
  // `throw new Error(...)` de compose.ts, con y sin `detail`.
  describe('T-335-CD9: mensaje byte-idéntico', () => {
    it('con detail → `Agent <slug> returned <status>: <detail>`', () => {
      expect(
        new AgentHttpError('cobraya-cfdi', 422, FIELD_ERR_BODY).message,
      ).toBe(`Agent cobraya-cfdi returned 422: ${FIELD_ERR_BODY}`);
    });

    it('sin detail (body ilegible) → sin el `: ` colgando', () => {
      expect(new AgentHttpError('cobraya-cfdi', 502, '').message).toBe(
        'Agent cobraya-cfdi returned 502',
      );
    });

    it('parseFieldErrors devuelve LO MISMO para el error y para el literal', () => {
      const fromError = parseFieldErrors(
        new AgentHttpError('cobraya-cfdi', 422, FIELD_ERR_BODY).message,
      );
      const fromLiteral = parseFieldErrors(
        `Agent cobraya-cfdi returned 422: ${FIELD_ERR_BODY}`,
      );
      // No basta con que sean iguales entre sí: si el parser devolviera `null`
      // para los dos, el test pasaría sin probar nada.
      expect(fromError).toEqual(['senderName']);
      expect(fromError).toEqual(fromLiteral);
    });
  });
});
