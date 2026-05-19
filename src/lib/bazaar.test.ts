/**
 * Bazaar factory tests — WKH-106 BASE-03.
 *
 * Covers:
 *   - validateAgentSchemas — happy path, rejected shapes, rejected compileability.
 *   - buildBazaarDiscoveryExtension — declares + validates the SDK envelope.
 *   - BazaarSchemaError — field discriminator + details propagation.
 */

import { describe, expect, it } from 'vitest';
import {
  BazaarSchemaError,
  buildBazaarDiscoveryExtension,
  validateAgentSchemas,
} from './bazaar.js';

describe('validateAgentSchemas', () => {
  it('accepts both schemas absent (no-op)', () => {
    expect(() => validateAgentSchemas({})).not.toThrow();
  });

  it('accepts a minimal valid JSON Schema for inputSchema', () => {
    expect(() =>
      validateAgentSchemas({
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      }),
    ).not.toThrow();
  });

  it('accepts both inputSchema and outputSchema when both are valid', () => {
    expect(() =>
      validateAgentSchemas({
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        outputSchema: { type: 'object', properties: { r: { type: 'number' } } },
      }),
    ).not.toThrow();
  });

  it('rejects inputSchema that is not an object (string)', () => {
    expect(() =>
      validateAgentSchemas({ inputSchema: 'not-a-schema' }),
    ).toThrow(BazaarSchemaError);
  });

  it('rejects inputSchema that is an array', () => {
    expect(() => validateAgentSchemas({ inputSchema: [] })).toThrow(
      BazaarSchemaError,
    );
  });

  it('rejects inputSchema that is null', () => {
    expect(() => validateAgentSchemas({ inputSchema: null })).toThrow(
      BazaarSchemaError,
    );
  });

  it('rejects inputSchema that fails to compile (malformed type)', () => {
    let caught: BazaarSchemaError | undefined;
    try {
      validateAgentSchemas({
        inputSchema: { type: 'not-a-valid-type' },
      });
    } catch (err) {
      caught = err as BazaarSchemaError;
    }
    expect(caught).toBeInstanceOf(BazaarSchemaError);
    expect(caught?.field).toBe('inputSchema');
    expect(caught?.details.length).toBeGreaterThan(0);
  });

  it('rejects outputSchema that is malformed', () => {
    let caught: BazaarSchemaError | undefined;
    try {
      validateAgentSchemas({
        // valid input but broken output
        inputSchema: { type: 'object' },
        outputSchema: { properties: 'should-be-object-not-string' },
      });
    } catch (err) {
      caught = err as BazaarSchemaError;
    }
    expect(caught).toBeInstanceOf(BazaarSchemaError);
    expect(caught?.field).toBe('outputSchema');
  });

  it('error message identifies which field is invalid', () => {
    try {
      validateAgentSchemas({ inputSchema: 42 });
    } catch (err) {
      const e = err as BazaarSchemaError;
      expect(e.message).toContain('inputSchema');
    }
  });
});

describe('buildBazaarDiscoveryExtension', () => {
  it('builds a valid extension for a GET endpoint with query params', () => {
    const ext = buildBazaarDiscoveryExtension({
      method: 'GET',
      input: { query: 'example' },
      inputSchema: {
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    });
    expect(ext).toBeTypeOf('object');
    expect(Object.keys(ext).length).toBeGreaterThan(0);
  });

  it('builds a valid extension for a POST endpoint with JSON body', () => {
    const ext = buildBazaarDiscoveryExtension({
      method: 'POST',
      input: { name: 'alice' },
      inputSchema: {
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      bodyType: 'json',
      output: {
        example: { success: true, id: '123' },
      },
    });
    const values = Object.values(ext);
    expect(values.length).toBeGreaterThan(0);
    // The SDK returns a record keyed by extension URI; each value should
    // carry an `info` + `schema` pair.
    for (const v of values) {
      expect(v).toHaveProperty('info');
      expect(v).toHaveProperty('schema');
    }
  });

  it('builds a valid extension for an MCP tool', () => {
    const ext = buildBazaarDiscoveryExtension({
      toolName: 'financial_analysis',
      description: 'Analyze financial data',
      inputSchema: {
        type: 'object',
        properties: { ticker: { type: 'string' } },
        required: ['ticker'],
      },
    });
    expect(Object.keys(ext).length).toBeGreaterThan(0);
  });
});

describe('BazaarSchemaError', () => {
  it('exposes field, message, and details', () => {
    const err = new BazaarSchemaError('inputSchema', 'bad schema', [
      'reason A',
      'reason B',
    ]);
    expect(err.field).toBe('inputSchema');
    expect(err.message).toBe('bad schema');
    expect(err.details).toEqual(['reason A', 'reason B']);
    expect(err.name).toBe('BazaarSchemaError');
  });

  it('defaults details to empty array', () => {
    const err = new BazaarSchemaError('outputSchema', 'msg');
    expect(err.details).toEqual([]);
  });

  it('is an Error instance', () => {
    const err = new BazaarSchemaError('manifest', 'msg');
    expect(err).toBeInstanceOf(Error);
  });
});
