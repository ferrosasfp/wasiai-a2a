/**
 * Tests for parseFieldErrors — WKH-130 (W1).
 * Covers the 8 input→output cases from the Story File table (T-PARSE-1..4).
 */
import { describe, expect, it } from 'vitest';
import { parseFieldErrors } from './field-error-parser.js';

describe('parseFieldErrors', () => {
  // T-PARSE-1: Zod shape (details.fieldErrors) → keys with ≥1 message.
  it('T-PARSE-1: parses Zod fieldErrors shape', () => {
    const msg =
      'Agent cobraya-cfdi returned 422: {"error":"invalid_input","details":{"fieldErrors":{"uuidCfdi":["Required"],"rfcEmisor":["Required"]}}}';
    expect(parseFieldErrors(msg)).toEqual(['uuidCfdi', 'rfcEmisor']);
  });

  // T-PARSE-2: free-text multi-field "a, b, c required".
  it('T-PARSE-2: parses free-text comma list before "required"', () => {
    const msg =
      'Agent agentshop-remit returned 400: {"error":"senderName, amountUSD, receiverCountry required"}';
    expect(parseFieldErrors(msg)).toEqual([
      'senderName',
      'amountUSD',
      'receiverCountry',
    ]);
  });

  // T-PARSE-3: free-text single field via `message` key, "field X is required".
  it('T-PARSE-3: parses "field X is required" from message key', () => {
    const msg =
      'Agent foo returned 422: {"message":"field walletAddress is required"}';
    expect(parseFieldErrors(msg)).toEqual(['walletAddress']);
  });

  // T-PARSE-4: the five null cases.
  describe('T-PARSE-4: non-parseable / non-4xx → null', () => {
    it('4xx without fieldErrors and without pattern → null', () => {
      const msg = 'Agent foo returned 422: {"error":"invalid_input"}';
      expect(parseFieldErrors(msg)).toBeNull();
    });

    it('5xx → null (status guard)', () => {
      const msg = 'Agent foo returned 502: {"error":"upstream down"}';
      expect(parseFieldErrors(msg)).toBeNull();
    });

    it('4xx non-JSON without "required" → null', () => {
      const msg = 'Agent foo returned 400: Bad Request';
      expect(parseFieldErrors(msg)).toBeNull();
    });

    it('no status (SSRF) → null', () => {
      const msg = 'Agent foo invokeUrl blocked by SSRF guard (link-local)';
      expect(parseFieldErrors(msg)).toBeNull();
    });

    it('empty fieldErrors object (0 keys) → null', () => {
      const msg =
        'Agent foo returned 422: {"error":"invalid_input","details":{"fieldErrors":{}}}';
      expect(parseFieldErrors(msg)).toBeNull();
    });
  });

  // CD-10: never throws — defensive inputs degrade to null.
  describe('CD-10: pure, never throws', () => {
    it('empty string → null', () => {
      expect(parseFieldErrors('')).toBeNull();
    });

    it('truncated JSON (300-char cut) → null when no free-text pattern', () => {
      const msg =
        'Agent foo returned 422: {"error":"invalid_input","details":{"fieldErrors":{"uuidCfd';
      expect(parseFieldErrors(msg)).toBeNull();
    });

    it('fieldErrors with only empty arrays → null', () => {
      const msg =
        'Agent foo returned 422: {"details":{"fieldErrors":{"a":[],"b":[]}}}';
      expect(parseFieldErrors(msg)).toBeNull();
    });
  });

  // T-PARSE-WRAPPED: shape REAL que el gateway recibe en prod — el body del
  // agente viene ENVUELTO por wasiai-v2 (fieldErrors anidado en
  // result.detail.details.fieldErrors). El parser lo encuentra recursivamente.
  describe('T-PARSE-WRAPPED: wasiai-v2 wrapped body (nested fieldErrors)', () => {
    it('Zod fieldErrors nested under result.detail.details → keys', () => {
      const msg =
        'Agent cobraya-cfdi-validator returned 422: {"result":{"error":"Upstream 400","upstream_status":400,"detail":{"error":"invalid_input","details":{"formErrors":[],"fieldErrors":{"uuidCfdi":["Required"],"rfcEmisor":["Required"],"amountMXN":["Required"],"anchorBuyer":["Required"]}}}},"meta":{"model":"cobraya-cfdi-validator"}}';
      expect(parseFieldErrors(msg)).toEqual([
        'uuidCfdi',
        'rfcEmisor',
        'amountMXN',
        'anchorBuyer',
      ]);
    });

    it('free-text nested under result.detail.error → keys', () => {
      const msg =
        'Agent agentshop-kyc-validator returned 422: {"result":{"error":"Upstream 400","upstream_status":400,"detail":{"error":"senderName, amountUSD, receiverCountry required"}},"meta":{}}';
      expect(parseFieldErrors(msg)).toEqual([
        'senderName',
        'amountUSD',
        'receiverCountry',
      ]);
    });
  });
});
