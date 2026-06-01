import { InsufficientBudgetError, OperationError } from './errors.js';

export interface A2AClientOptions {
  baseUrl: string;
  fetchImpl: typeof fetch;
  key?: string; // token wasi_a2a_* — interno, nunca logueado
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  key?: string;
}

interface ErrorBody {
  error_code?: unknown;
  keyId?: unknown;
  key_id?: unknown;
  chainId?: unknown;
  chain_id?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Tipado wrapper sobre `fetch` con header `x-a2a-key` y mapeo de errores
 * (DT-8 + OBS-1 + CD-11). Patrón de `examples/fund-agent-key.mjs:51-58`.
 * NUNCA lanza Error crudo: todo `!res.ok` mapea a un error tipado del SDK con
 * `cause` no-enumerable (el body crudo NO va al mensaje público).
 */
export class A2AClient {
  readonly #baseUrl: string;
  readonly #fetchImpl: typeof fetch;
  readonly #key?: string;

  constructor(opts: A2AClientOptions) {
    this.#baseUrl = opts.baseUrl;
    this.#fetchImpl = opts.fetchImpl;
    this.#key = opts.key;
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? 'POST';
    const key = opts.key ?? this.#key;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (key) {
      headers['x-a2a-key'] = key;
    }
    const res = await this.#fetchImpl(`${this.#baseUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as ErrorBody;
      throw this.#mapError(path, res.status, body);
    }

    return (await res.json().catch(() => ({}))) as T;
  }

  #mapError(path: string, status: number, body: ErrorBody): Error {
    const keyId = asString(body.keyId) ?? asString(body.key_id);
    const chainId = asNumber(body.chainId) ?? asNumber(body.chain_id);
    // OBS-1: 402 (x402) Y 403 con error_code INSUFFICIENT_BUDGET (x-a2a-key)
    // mapean al mismo error tipado. El detalle público es estable; body → cause.
    if (
      status === 402 ||
      (status === 403 && body.error_code === 'INSUFFICIENT_BUDGET')
    ) {
      return new InsufficientBudgetError(
        `request to ${path} failed: insufficient budget`,
        keyId,
        chainId,
        body,
      );
    }
    return new OperationError(
      path,
      status,
      `request to ${path} failed with status ${status}`,
      body,
    );
  }
}
