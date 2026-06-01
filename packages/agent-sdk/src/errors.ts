import type { ProvisionStep } from './types.js';

export class WasiAgentError extends Error {
  readonly code: string;
  readonly cause?: unknown;
  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'WasiAgentError';
    this.code = code;
    // cause no-enumerable → no aparece en JSON.stringify (anti-leak, CD-11)
    Object.defineProperty(this, 'cause', { value: cause, enumerable: false });
  }
}

export class ProvisionError extends WasiAgentError {
  readonly step: ProvisionStep;
  constructor(step: ProvisionStep, message: string, cause?: unknown) {
    super('PROVISION_FAILED', message, cause);
    this.name = 'ProvisionError';
    this.step = step;
  }
}

export class InsufficientBudgetError extends WasiAgentError {
  readonly keyId?: string;
  readonly chainId?: number;
  constructor(
    detail: string,
    keyId?: string,
    chainId?: number,
    cause?: unknown,
  ) {
    super('INSUFFICIENT_BUDGET', detail, cause);
    this.name = 'InsufficientBudgetError';
    this.keyId = keyId;
    this.chainId = chainId;
  }
}

export class IdentityMintError extends WasiAgentError {
  readonly stage: 'mint' | 'bind';
  constructor(stage: 'mint' | 'bind', message: string, cause?: unknown) {
    super('IDENTITY_MINT_FAILED', message, cause);
    this.name = 'IdentityMintError';
    this.stage = stage;
  }
}

export class OperationError extends WasiAgentError {
  readonly endpoint: string;
  readonly status: number;
  constructor(
    endpoint: string,
    status: number,
    message: string,
    cause?: unknown,
  ) {
    super('OPERATION_FAILED', message, cause);
    this.name = 'OperationError';
    this.endpoint = endpoint;
    this.status = status;
  }
}
