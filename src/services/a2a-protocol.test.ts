/**
 * Tests for A2A Protocol helpers — WKH-56
 *
 * Covers AC-5: isA2AMessage type guard + extractA2APayload + buildA2APayload.
 * 16 tests total: T-A2A-1..T-A2A-12 (guard) + T-A2A-13..T-A2A-14 (extract)
 * + T-A2A-15..T-A2A-16 (build).
 */

import { describe, expect, it } from 'vitest';
import type { A2AMessage } from '../types/index.js';
import {
  buildA2APayload,
  extractA2APayload,
  isA2AMessage,
} from './a2a-protocol.js';

describe('a2a-protocol', () => {
  // ── isA2AMessage (AC-5) ─────────────────────────────────────
  describe('isA2AMessage (AC-5)', () => {
    it('T-A2A-1: returns true for valid agent + text part', () => {
      expect(
        isA2AMessage({ role: 'agent', parts: [{ kind: 'text', text: 'hi' }] }),
      ).toBe(true);
    });

    it('T-A2A-2: returns true for valid user + data part', () => {
      expect(
        isA2AMessage({
          role: 'user',
          parts: [{ kind: 'data', data: { x: 1 } }],
        }),
      ).toBe(true);
    });

    it('T-A2A-3: returns true for valid tool + file part', () => {
      expect(
        isA2AMessage({
          role: 'tool',
          parts: [{ kind: 'file', file: { uri: 'x' } }],
        }),
      ).toBe(true);
    });

    it('T-A2A-4: returns true for mixed parts (text + data)', () => {
      expect(
        isA2AMessage({
          role: 'agent',
          parts: [
            { kind: 'text', text: 'a' },
            { kind: 'data', data: 1 },
          ],
        }),
      ).toBe(true);
    });

    it('T-A2A-5: returns false for null', () => {
      expect(isA2AMessage(null)).toBe(false);
    });

    it('T-A2A-6: returns false for undefined', () => {
      expect(isA2AMessage(undefined)).toBe(false);
    });

    it('T-A2A-7: returns false for invalid role', () => {
      expect(
        isA2AMessage({
          role: 'admin',
          parts: [{ kind: 'text', text: '' }],
        }),
      ).toBe(false);
    });

    it('T-A2A-8: returns false for empty parts array', () => {
      expect(isA2AMessage({ role: 'agent', parts: [] })).toBe(false);
    });

    it('T-A2A-9: returns false when parts is missing', () => {
      expect(isA2AMessage({ role: 'agent' })).toBe(false);
    });

    it('T-A2A-10: returns false when parts is not an array', () => {
      expect(isA2AMessage({ role: 'agent', parts: 'not-array' })).toBe(false);
    });

    it('T-A2A-11: returns false for invalid kind', () => {
      expect(
        isA2AMessage({
          role: 'agent',
          parts: [{ kind: 'video', data: {} }],
        }),
      ).toBe(false);
    });

    it('T-A2A-12: returns false for primitive', () => {
      expect(isA2AMessage(42)).toBe(false);
    });
  });

  // ── extractA2APayload ───────────────────────────────────────
  describe('extractA2APayload', () => {
    it('T-A2A-13: extracts text and data parts in order', () => {
      const msg: A2AMessage = {
        role: 'agent',
        parts: [
          { kind: 'text', text: 'hi' },
          { kind: 'data', data: { x: 1 } },
        ],
      };
      expect(extractA2APayload(msg)).toEqual(['hi', { x: 1 }]);
    });

    it('T-A2A-14: extracts file sub-object', () => {
      const msg: A2AMessage = {
        role: 'agent',
        parts: [{ kind: 'file', file: { uri: 'u' } }],
      };
      expect(extractA2APayload(msg)).toEqual([{ uri: 'u' }]);
    });
  });

  // ── buildA2APayload (CD-13) ─────────────────────────────────
  describe('buildA2APayload (CD-13)', () => {
    it('T-A2A-15: wraps object as data part', () => {
      expect(buildA2APayload({ x: 1 })).toEqual({
        role: 'agent',
        parts: [{ kind: 'data', data: { x: 1 } }],
      });
    });

    it('T-A2A-16: wraps undefined as null data', () => {
      expect(buildA2APayload(undefined)).toEqual({
        role: 'agent',
        parts: [{ kind: 'data', data: null }],
      });
    });
  });
});
