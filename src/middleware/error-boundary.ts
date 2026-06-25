/**
 * Error Boundary — Global error handler normalizing all errors
 * WKH-18: Hardening — AC-3, AC-4
 *
 * All errors go through here. Response shape:
 * { error: string, code: string, details?: object, requestId: string }
 */

import type { FastifyInstance } from 'fastify';

interface AppError {
  message: string;
  statusCode?: number;
  code?: string;
  stack?: string;
  validation?: unknown[];
  retryAfterMs?: number;
  orchestrationId?: string;
}

// B8 (audit 2026-06-24): narrowing seguro en vez de `err as unknown as AppError`.
// Leemos cada campo opcional con un type-guard, sin double-cast.
// B8 (audit 2026-06-24): lectura de un campo extra de un Error vía `in`
// narrowing — sin double-cast `as unknown as`. El `key in obj` estrecha el tipo
// para que indexar `obj[key]` sea seguro.
function readNumberProp(obj: object, key: string): number | undefined {
  if (key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === 'number') return v;
  }
  return undefined;
}

function readStringProp(obj: object, key: string): string | undefined {
  if (key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function readArrayProp(obj: object, key: string): unknown[] | undefined {
  if (key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v;
  }
  return undefined;
}

function toAppError(err: unknown): AppError {
  if (err instanceof Error) {
    // Leemos los campos extra (statusCode, code, …) que algunas clases de error
    // adjuntan, con narrowing por `in` en vez del cast `as unknown as AppError`.
    const result: AppError = { message: err.message };
    if (err.stack !== undefined) result.stack = err.stack;
    const statusCode = readNumberProp(err, 'statusCode');
    if (statusCode !== undefined) result.statusCode = statusCode;
    const code = readStringProp(err, 'code');
    if (code !== undefined) result.code = code;
    const validation = readArrayProp(err, 'validation');
    if (validation !== undefined) result.validation = validation;
    const retryAfterMs = readNumberProp(err, 'retryAfterMs');
    if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;
    const orchestrationId = readStringProp(err, 'orchestrationId');
    if (orchestrationId !== undefined) result.orchestrationId = orchestrationId;
    return result;
  }
  return { message: String(err) };
}

export function registerErrorBoundary(fastify: FastifyInstance): void {
  fastify.setErrorHandler((rawError: unknown, request, reply) => {
    const error = toAppError(rawError);
    const requestId = request.id;

    // 1. Fastify schema validation error (AC-4)
    if (error.validation) {
      return reply.status(400).send({
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: error.validation,
        requestId,
      });
    }

    // BLQ-3: Extract orchestrationId from error if present (e.g. /orchestrate failures)
    const orchestrationId = error.orchestrationId ?? undefined;

    // 2. Custom errors with code (CircuitOpenError, rate-limit, backpressure, timeout, etc.)
    if (error.code && typeof error.code === 'string') {
      const statusCode = error.statusCode ?? 500;
      const body: Record<string, unknown> = {
        error: error.message,
        code: error.code,
        requestId,
      };
      // Include retryAfterMs for rate-limit errors (AC-1)
      if (typeof error.retryAfterMs === 'number') {
        body.retryAfterMs = error.retryAfterMs;
      }
      if (orchestrationId) body.orchestrationId = orchestrationId;
      return reply.status(statusCode).send(body);
    }

    // 3. Rate limit (fallback -- plugin usually handles directly)
    if (error.statusCode === 429) {
      return reply.status(429).send({
        error: 'Too Many Requests',
        code: 'RATE_LIMIT_EXCEEDED',
        requestId,
      });
    }

    // 4. Default: internal error
    const isDev = process.env.NODE_ENV === 'development';
    const defaultBody: Record<string, unknown> = {
      error: isDev ? error.message : 'Internal server error',
      code: 'INTERNAL_ERROR',
      details: isDev ? { stack: error.stack } : undefined,
      requestId,
    };
    if (orchestrationId) defaultBody.orchestrationId = orchestrationId;
    return reply.status(error.statusCode ?? 500).send(defaultBody);
  });
}
