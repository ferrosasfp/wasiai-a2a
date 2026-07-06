/**
 * Tests — operator funding classifier (WKH-71 AC-3).
 */
import { InsufficientFundsError } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  classifyOperatorError,
  isOperatorFundingLowError,
  OPERATOR_FUNDING_LOW_MESSAGE,
  OPERATOR_FUNDING_LOW_REASON,
} from './operator-funding.js';

describe('operator-funding classifier', () => {
  it('detects the classic viem "insufficient funds for gas" error', () => {
    const err = new Error(
      'insufficient funds for gas * price + value: address 0xf432... have 0 want 1',
    );
    expect(isOperatorFundingLowError(err)).toBe(true);
  });

  it('detects "gas required exceeds allowance"', () => {
    expect(
      isOperatorFundingLowError(
        new Error('gas required exceeds allowance (0)'),
      ),
    ).toBe(true);
  });

  // NIT-1: viem's own InsufficientFundsError shortMessage does NOT contain the
  // literal "insufficient funds" — it reads "...exceeds the balance of the
  // account." Without the extra patterns AC-3 would silently fail to relabel.
  it('detects viem InsufficientFundsError (shortMessage variant)', () => {
    expect(isOperatorFundingLowError(new InsufficientFundsError({}))).toBe(
      true,
    );
  });

  it('detects the node-message variant "exceeds transaction sender account balance"', () => {
    expect(
      isOperatorFundingLowError(
        new Error(
          'err: insufficient funds: exceeds transaction sender account balance',
        ),
      ),
    ).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(
      isOperatorFundingLowError(new Error('Insufficient Funds For Gas')),
    ).toBe(true);
  });

  it('accepts a raw string, not only Error instances', () => {
    expect(isOperatorFundingLowError('insufficient funds')).toBe(true);
  });

  it('does NOT misclassify unrelated errors (network / revert / timeout)', () => {
    expect(isOperatorFundingLowError(new Error('network down'))).toBe(false);
    expect(
      isOperatorFundingLowError(new Error('execution reverted: bad nonce')),
    ).toBe(false);
    expect(isOperatorFundingLowError(new Error('request timed out'))).toBe(
      false,
    );
    expect(isOperatorFundingLowError(undefined)).toBe(false);
    expect(isOperatorFundingLowError(null)).toBe(false);
  });

  it('classifyOperatorError prefixes the stable reason but preserves the original message', () => {
    const original = 'insufficient funds for gas * price + value';
    const out = classifyOperatorError(new Error(original));
    expect(out.fundingLow).toBe(true);
    expect(out.reason).toBe(OPERATOR_FUNDING_LOW_REASON);
    expect(out.message.startsWith(OPERATOR_FUNDING_LOW_MESSAGE)).toBe(true);
    // Original crude string is still grep-able.
    expect(out.message).toContain(original);
  });

  it('classifyOperatorError leaves non-funding errors untouched', () => {
    const out = classifyOperatorError(new Error('network down'));
    expect(out.fundingLow).toBe(false);
    expect(out.reason).toBeNull();
    expect(out.message).toBe('network down');
  });
});
