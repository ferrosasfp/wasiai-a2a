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
import { REDACT_PATHS, scrubSecretHex } from './logger.js';

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

// ── OP-11: 0x64-hex secret-pattern scrubber for free-form message strings ────

describe('scrubSecretHex — OP-11', () => {
  const SECRET64 =
    '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

  it('masks a 0x + 64-hex run inside a message string', () => {
    const out = scrubSecretHex(`settled with key ${SECRET64} done`);
    expect(out).not.toContain(SECRET64);
    expect(out).toContain('0x[REDACTED-HEX64]');
  });

  it('masks ALL occurrences in one string', () => {
    const out = scrubSecretHex(`${SECRET64} and ${SECRET64}`);
    expect(out).not.toContain(SECRET64);
    expect(out.match(/0x\[REDACTED-HEX64\]/g)).toHaveLength(2);
  });

  it('leaves short 0x values (e.g. addresses) untouched', () => {
    const addr = '0x1111111111111111111111111111111111111111'; // 40 hex
    expect(scrubSecretHex(`to ${addr}`)).toBe(`to ${addr}`);
  });

  it('passes non-string values through unchanged', () => {
    expect(scrubSecretHex(42)).toBe(42);
    const obj = { a: 1 };
    expect(scrubSecretHex(obj)).toBe(obj);
  });

  it('the logger hook scrubs a secret hex from the emitted message', () => {
    // Build a logger with the SAME hook the rootLogger uses (mirrors logger.ts).
    let captured: Record<string, unknown> = {};
    const stream = {
      write: (chunk: string) => {
        captured = JSON.parse(chunk) as Record<string, unknown>;
      },
    };
    const log = pino(
      {
        level: 'info',
        hooks: {
          logMethod(args, method) {
            const scrubbed = args.map((a) => scrubSecretHex(a)) as typeof args;
            return method.apply(this, scrubbed);
          },
        },
      },
      stream,
    );
    log.info(`tx settled ${SECRET64}`);
    expect(JSON.stringify(captured)).not.toContain(SECRET64);
    expect(captured.msg).toContain('0x[REDACTED-HEX64]');
  });
});
