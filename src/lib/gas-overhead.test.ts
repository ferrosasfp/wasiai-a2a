/**
 * Tests for the step gas-overhead pass-through (audit 2026-06-25).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getStepGasOverheadUsd } from './gas-overhead.js';

const AVAX_MAINNET = 43114;
const BASE_MAINNET = 8453;
const KITE_MAINNET = 2366;
const FUJI = 43113;
const BASE_SEPOLIA = 84532;
const KITE_TESTNET = 2368;

describe('getStepGasOverheadUsd', () => {
  const ENV_KEYS = [
    'STEP_GAS_OVERHEAD_USD',
    `STEP_GAS_OVERHEAD_USD_${AVAX_MAINNET}`,
    `STEP_GAS_OVERHEAD_USD_${BASE_MAINNET}`,
    `STEP_GAS_OVERHEAD_USD_${KITE_MAINNET}`,
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('testnet chainIds → 0 even with env set', () => {
    process.env.STEP_GAS_OVERHEAD_USD = '0.05';
    expect(getStepGasOverheadUsd(FUJI)).toBe(0);
    expect(getStepGasOverheadUsd(BASE_SEPOLIA)).toBe(0);
    expect(getStepGasOverheadUsd(KITE_TESTNET)).toBe(0);
  });

  it('unknown chainId → 0', () => {
    process.env.STEP_GAS_OVERHEAD_USD = '0.05';
    expect(getStepGasOverheadUsd(1)).toBe(0);
    expect(getStepGasOverheadUsd(999999)).toBe(0);
  });

  it('mainnet without env → 0 (default no-change)', () => {
    expect(getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0);
    expect(getStepGasOverheadUsd(BASE_MAINNET)).toBe(0);
    expect(getStepGasOverheadUsd(KITE_MAINNET)).toBe(0);
  });

  it('mainnet with flat env → the value', () => {
    process.env.STEP_GAS_OVERHEAD_USD = '0.02';
    expect(getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0.02);
    expect(getStepGasOverheadUsd(BASE_MAINNET)).toBe(0.02);
    expect(getStepGasOverheadUsd(KITE_MAINNET)).toBe(0.02);
  });

  it('per-chain override wins over the flat default', () => {
    process.env.STEP_GAS_OVERHEAD_USD = '0.02';
    process.env[`STEP_GAS_OVERHEAD_USD_${BASE_MAINNET}`] = '0.10';
    expect(getStepGasOverheadUsd(BASE_MAINNET)).toBe(0.1);
    // other mainnets fall back to flat
    expect(getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0.02);
  });

  it('per-chain override applies even without a flat default', () => {
    process.env[`STEP_GAS_OVERHEAD_USD_${KITE_MAINNET}`] = '0.07';
    expect(getStepGasOverheadUsd(KITE_MAINNET)).toBe(0.07);
    expect(getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0);
  });

  it('non-finite / non-numeric env → 0', () => {
    process.env.STEP_GAS_OVERHEAD_USD = 'abc';
    expect(getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0);
    process.env.STEP_GAS_OVERHEAD_USD = 'NaN';
    expect(getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0);
    process.env.STEP_GAS_OVERHEAD_USD = 'Infinity';
    expect(getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0);
  });

  it('negative env → clamped to 0', () => {
    process.env.STEP_GAS_OVERHEAD_USD = '-0.5';
    expect(getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0);
  });

  it('above-range env → clamped to MAX (1.0)', () => {
    process.env.STEP_GAS_OVERHEAD_USD = '5';
    expect(getStepGasOverheadUsd(AVAX_MAINNET)).toBe(1.0);
  });

  it('empty / whitespace env → 0 (treated as unset)', () => {
    process.env.STEP_GAS_OVERHEAD_USD = '';
    expect(getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0);
    process.env.STEP_GAS_OVERHEAD_USD = '   ';
    expect(getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0);
  });
});
