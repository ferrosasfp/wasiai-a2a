/**
 * Logger redaction Tests — F-06 (audit 2026-06-29).
 *
 * Proves the shared `REDACT_PATHS` list redacts credential-bearing fields so
 * neither the service logger nor the Fastify request logger emit secrets in
 * plaintext. We construct a pino logger with `redact: REDACT_PATHS` writing to
 * an in-memory stream and assert the matched paths become `[Redacted]`.
 */

import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS } from './logger.js';

function captureLog(obj: Record<string, unknown>): Record<string, unknown> {
  let captured: Record<string, unknown> = {};
  const stream = {
    write: (chunk: string) => {
      captured = JSON.parse(chunk) as Record<string, unknown>;
    },
  };
  const log = pino({ level: 'info', redact: REDACT_PATHS }, stream);
  log.info(obj, 'test');
  return captured;
}

describe('logger REDACT_PATHS — F-06', () => {
  it('redacts request credential headers (authorization / x-payment / x-a2a-key)', () => {
    const out = captureLog({
      req: {
        headers: {
          authorization: 'Bearer super-secret',
          'x-payment': 'pay-secret',
          'x-a2a-key': 'key-secret',
          'user-agent': 'visible-ua',
        },
      },
    });
    const headers = (out.req as { headers: Record<string, unknown> }).headers;
    expect(headers.authorization).toBe('[Redacted]');
    expect(headers['x-payment']).toBe('[Redacted]');
    expect(headers['x-a2a-key']).toBe('[Redacted]');
    // Non-credential headers stay visible.
    expect(headers['user-agent']).toBe('visible-ua');
  });

  it('redacts wildcard secret fields (privateKey / serviceKey / secret / signature)', () => {
    const out = captureLog({
      ctx: {
        privateKey: '0xPRIV',
        serviceKey: 'SVC',
        secret: 'SHH',
        signature: 'SIG',
        keep: 'visible',
      },
    });
    const ctx = out.ctx as Record<string, unknown>;
    expect(ctx.privateKey).toBe('[Redacted]');
    expect(ctx.serviceKey).toBe('[Redacted]');
    expect(ctx.secret).toBe('[Redacted]');
    expect(ctx.signature).toBe('[Redacted]');
    expect(ctx.keep).toBe('visible');
  });

  it('the serialized log NEVER contains the raw secret values', () => {
    const out = captureLog({
      req: { headers: { authorization: 'Bearer LEAK-ME' } },
      ctx: { privateKey: 'LEAK-PRIV' },
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('LEAK-ME');
    expect(serialized).not.toContain('LEAK-PRIV');
  });
});
