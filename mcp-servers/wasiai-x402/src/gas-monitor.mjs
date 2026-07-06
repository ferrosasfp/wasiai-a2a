// SPDX-License-Identifier: MIT
// src/gas-monitor.mjs — WKH-71 multi-wallet / multi-chain native-gas monitor.
//
// SEPARATE module from balance-check.mjs (DT-5): balance-check.mjs watches the
// MCP operator's USDC (ERC-20) spend budget on Avalanche mainnet; THIS module
// watches whether operator/relayer wallets still hold enough NATIVE gas to
// broadcast settles on testnet (Fuji / Kite / Base Sepolia). Two distinct
// invariants — never mixed.
//
// Design:
//   - Pure, dependency-injected core (`checkGasBalances`) so the unit suite can
//     drive it with a fake `readBalance` + `sendAlert` (no RPC, no network).
//   - Config comes ONLY from env (CD-6): wallet list via GAS_ALERT_TARGETS
//     (JSON), thresholds via WALLET_ALERT_THRESHOLD_<KEY>_{WARNING,CRITICAL} in
//     native units, RPC overrides via GAS_ALERT_RPC_<chainId>. No wallet
//     address is ever hardcoded here — only in .env.example as documentation.
//   - Each wallet×chain combination is evaluated independently (AC-6): a read
//     error or an alert for one combo never aborts or masks another.
//   - Read-only (CD-3): the core never signs; the injected `readBalance` uses a
//     zero-cost `getBalance` RPC call.
//   - Fail-open (CD-4): `sendAlert` never throws; individual read errors are
//     caught and logged, the loop keeps going, the caller still responds 200.

import { formatEther, parseEther } from 'viem';
import * as log from './log.mjs';

// Chain registry. `key` is the token used in the threshold env var name; RPC
// defaults are public read-only endpoints (env-overridable, same pattern as
// AVALANCHE_RPC_URL in balance-check.mjs). NO wallet addresses live here.
export const CHAIN_REGISTRY = {
  43113: {
    key: 'FUJI',
    symbol: 'AVAX',
    defaultRpc: 'https://api.avax-test.network/ext/bc/C/rpc',
    defaultWarning: '0.5',
    defaultCritical: '0.1',
  },
  2368: {
    key: 'KITE',
    symbol: 'KITE',
    defaultRpc: 'https://rpc-testnet.gokite.ai/',
    defaultWarning: '0.5',
    defaultCritical: '0.1',
  },
  84532: {
    key: 'BASESEPOLIA',
    symbol: 'ETH',
    defaultRpc: 'https://sepolia.base.org',
    defaultWarning: '0.05',
    defaultCritical: '0.01',
  },
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// A plain non-negative decimal that `parseEther` can consume WITHOUT throwing.
// Deliberately stricter than `Number.parseFloat`: it rejects trailing/leading
// whitespace ("0.5 "), scientific notation ("1e-6") and multi-dot ("0.1.2") —
// all of which are finite & >= 0 for parseFloat but make parseEther throw
// InvalidDecimalNumberError (BLQ-1: validate !== parse-safe).
const NATIVE_DECIMAL_RE = /^\d+(\.\d+)?$/;

/**
 * Parse GAS_ALERT_TARGETS (JSON array). Each valid entry is
 * `{ label:string, address:0x..40, chainIds:number[] }`. Invalid entries are
 * dropped with a log line (fail-open, AC-6 independence). Returns [] on any
 * parse failure (never throws).
 *
 * @param {string|undefined} raw
 * @returns {Array<{label:string,address:string,chainIds:number[]}>}
 */
export function parseTargets(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log.error('mcp.gas-monitor.targets-parse-failed', {
      stage: 'config', error: e?.message ?? 'unknown',
    });
    return [];
  }
  if (!Array.isArray(parsed)) {
    log.error('mcp.gas-monitor.targets-not-array', { stage: 'config' });
    return [];
  }
  const out = [];
  // NIT-4: dedup by address+chainId (address case-insensitive) so the same
  // wallet×chain never yields two alerts, whether the duplicate is inside one
  // entry's chainIds or spread across separate entries.
  const seen = new Set();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const { label, address, chainIds } = entry;
    if (typeof label !== 'string' || label.length === 0) continue;
    if (typeof address !== 'string' || !ADDRESS_RE.test(address)) {
      log.warn('mcp.gas-monitor.target-invalid-address', {
        stage: 'config', label,
      });
      continue;
    }
    if (!Array.isArray(chainIds) || chainIds.length === 0) {
      log.warn('mcp.gas-monitor.target-no-chains', { stage: 'config', label });
      continue;
    }
    const addrKey = address.toLowerCase();
    const ids = [];
    for (const c of chainIds) {
      const id = Number(c);
      if (!Number.isInteger(id) || id <= 0) continue;
      const comboKey = `${addrKey}:${id}`;
      if (seen.has(comboKey)) continue;
      seen.add(comboKey);
      ids.push(id);
    }
    if (ids.length === 0) continue;
    out.push({ label, address, chainIds: ids });
  }
  return out;
}

/**
 * @internal — validate a native-unit threshold string, falling back to the
 * chain default when absent / non-finite / negative (mirrors MNR-AR-2 in
 * balance-check.mjs). Returns the native decimal string that is safe to
 * `parseEther`.
 */
function _resolveNative(raw, fallback, ctx) {
  if (raw === undefined || raw === '') return fallback;
  // BLQ-1: the value must be parse-safe, not merely finite. A string like
  // "0.5 " / "1e-6" / "0.1.2" passes a NaN/negative guard yet makes parseEther
  // throw — which (config resolution running outside the per-combo try) would
  // abort the WHOLE monitor. Reject anything parseEther cannot consume and fall
  // back to the chain default instead of propagating.
  if (!NATIVE_DECIMAL_RE.test(raw)) {
    log.warn('mcp.gas-monitor.invalid-threshold', {
      stage: 'config', ...ctx, raw, fallback, reason: 'invalid-threshold-value',
    });
    return fallback;
  }
  return raw;
}

/**
 * Resolve WARNING/CRITICAL thresholds for a chain from env, in both native
 * decimal (for display) and wei (for comparison). Returns null for an
 * unknown chainId.
 *
 * @param {number} chainId
 * @param {Record<string,string|undefined>} env
 */
export function resolveThresholds(chainId, env) {
  const chain = CHAIN_REGISTRY[chainId];
  if (!chain) return null;
  const warningNative = _resolveNative(
    env[`WALLET_ALERT_THRESHOLD_${chain.key}_WARNING`],
    chain.defaultWarning,
    { chainId, tier: 'warning' },
  );
  const criticalNative = _resolveNative(
    env[`WALLET_ALERT_THRESHOLD_${chain.key}_CRITICAL`],
    chain.defaultCritical,
    { chainId, tier: 'critical' },
  );
  const warningWei = parseEther(warningNative);
  const criticalWei = parseEther(criticalNative);
  // NIT-3 (AR-MNR-1): warning must be >= critical. An inverted pair silently
  // kills the warning tier (every balance below warning is already "critical").
  // Fall back to the chain defaults (always correctly ordered) and log it.
  if (warningWei < criticalWei) {
    log.warn('mcp.gas-monitor.invalid-threshold', {
      stage: 'config', chainId, reason: 'invalid-threshold-order',
      warningNative, criticalNative,
    });
    return {
      warningNative: chain.defaultWarning,
      criticalNative: chain.defaultCritical,
      warningWei: parseEther(chain.defaultWarning),
      criticalWei: parseEther(chain.defaultCritical),
    };
  }
  return { warningNative, criticalNative, warningWei, criticalWei };
}

/**
 * Resolve the RPC URL for a chain: GAS_ALERT_RPC_<chainId> env override wins,
 * else the registry default. Returns null for an unknown chainId.
 */
export function resolveRpcUrl(chainId, env) {
  const chain = CHAIN_REGISTRY[chainId];
  if (!chain) return null;
  const override = env[`GAS_ALERT_RPC_${chainId}`];
  return override && override.length > 0 ? override : chain.defaultRpc;
}

/**
 * Pure severity decision. `critical` takes precedence over `warning`.
 * Returns null when the balance is at/above the warning threshold (OK).
 *
 * @param {bigint} balanceWei
 * @param {{warningWei:bigint,criticalWei:bigint}} thresholds
 * @returns {'critical'|'warning'|null}
 */
export function evaluateSeverity(balanceWei, { warningWei, criticalWei }) {
  if (balanceWei < criticalWei) return 'critical';
  if (balanceWei < warningWei) return 'warning';
  return null;
}

/**
 * Iterate every wallet×chain combination, read its native balance (via the
 * injected read-only `readBalance`), decide severity and fire the alert
 * through the injected `sendAlert` (reusing src/alerts.mjs in production).
 *
 * NEVER throws. Each combo is isolated (AC-6): a read error or a missing
 * threshold for one combo is recorded and skipped without affecting others.
 *
 * @param {object} deps
 * @param {Array<{label,address,chainIds}>} deps.targets
 * @param {Record<string,string|undefined>} deps.env
 * @param {(chainId:number, address:string, rpcUrl:string)=>Promise<bigint>} deps.readBalance
 * @param {(args:object)=>Promise<unknown>} deps.sendAlert
 * @param {string|undefined} deps.webhookUrl
 * @param {string|undefined} [deps.mention]
 * @param {()=>string} [deps.now]
 * @returns {Promise<Array<object>>} per-combo results
 */
export async function checkGasBalances({
  targets,
  env,
  readBalance,
  sendAlert,
  webhookUrl,
  mention,
  now = () => new Date().toISOString(),
}) {
  const results = [];
  for (const target of targets) {
    for (const chainId of target.chainIds) {
      const combo = { label: target.label, address: target.address, chainId };
      const chain = CHAIN_REGISTRY[chainId];
      if (!chain) {
        log.warn('mcp.gas-monitor.unsupported-chain', { stage: 'check', ...combo });
        results.push({ ...combo, status: 'unsupported-chain' });
        continue;
      }
      // BLQ-1: resolve per-combo config INSIDE the try so a malformed threshold
      // or RPC for ONE combo can never abort the whole loop (true AC-6
      // isolation — the docstring's own promise). `resolveThresholds` is now
      // parse-safe, but wrapping the whole resolution keeps the guarantee even
      // if a future config path throws.
      let thresholds;
      let rpcUrl;
      let balanceWei;
      try {
        thresholds = resolveThresholds(chainId, env);
        rpcUrl = resolveRpcUrl(chainId, env);
        if (!thresholds || !rpcUrl) {
          results.push({ ...combo, status: 'no-config' });
          continue;
        }
        balanceWei = await readBalance(chainId, target.address, rpcUrl);
      } catch (e) {
        // Fail-open (CD-4): one config/RPC failure never masks another combo.
        log.warn('mcp.gas-monitor.read-failed', {
          stage: 'read', ...combo, error: e?.message ?? 'unknown',
        });
        results.push({ ...combo, status: 'read-error' });
        continue;
      }

      const balanceNative = formatEther(balanceWei);
      const severity = evaluateSeverity(balanceWei, thresholds);
      const checkedAt = now();

      if (severity) {
        const threshold =
          severity === 'critical'
            ? Number(thresholds.criticalNative)
            : Number(thresholds.warningNative);
        log.warn('mcp.gas-monitor.below-threshold', {
          stage: 'alert', ...combo, severity, balanceNative, threshold,
          symbol: chain.symbol,
        });
        // sendAlert is fire-and-forget — the real src/alerts.mjs never throws
        // (CD-1/CD-4). We still wrap it defensively so a misbehaving alert
        // client can never abort the remaining wallet×chain checks (AC-6).
        try {
          await sendAlert({
            severity,
            webhookUrl,
            // NIT-1: forward the ONCALL mention so a `critical` gas alert ALSO
            // fires a Discord push — matching the runbook / .env.example claim
            // that ONCALL_MENTION applies to every critical (health + gas).
            // sendAlert only turns it into a push on `severity === 'critical'`.
            mention,
            body: {
              severity,
              reason:
                severity === 'critical'
                  ? 'gas-below-critical'
                  : 'gas-below-warning',
              chain: `${chain.key.toLowerCase()}-${chainId}`,
              chainId,
              operator: target.address,
              label: target.label,
              balanceNative,
              symbol: chain.symbol,
              threshold,
              checkedAt,
            },
          });
        } catch (e) {
          log.warn('mcp.gas-monitor.alert-failed', {
            stage: 'alert', ...combo, error: e?.message ?? 'unknown',
          });
        }
      }

      results.push({
        ...combo,
        status: 'checked',
        balanceNative,
        symbol: chain.symbol,
        severity: severity ?? 'ok',
        checkedAt,
      });
    }
  }
  return results;
}
