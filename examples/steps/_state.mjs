// Helpers compartidos por los 6 pasos. Estado en /tmp/wasi-run/state.json.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { avalancheFuji, baseSepolia } from 'viem/chains';

const DIR = '/tmp/wasi-run';
const FILE = `${DIR}/state.json`;

export const A2A_BASE = process.env.A2A_BASE ?? 'https://wasiai-a2a-production.up.railway.app';

export function readState() {
  if (!existsSync(FILE)) return {};
  return JSON.parse(readFileSync(FILE, 'utf8'));
}

export function writeState(patch) {
  mkdirSync(DIR, { recursive: true });
  const s = { ...readState(), ...patch };
  writeFileSync(FILE, JSON.stringify(s, null, 2));
  return s;
}

export async function api(path, { method = 'POST', key, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['x-a2a-key'] = key;
  const res = await fetch(`${A2A_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

export const RPCS = {
  'avalanche-fuji': { chain: avalancheFuji, rpc: process.env.RPC_URL ?? 'https://api.avax-test.network/ext/bc/C/rpc' },
  'base-sepolia':   { chain: baseSepolia,   rpc: process.env.RPC_URL ?? 'https://sepolia.base.org' },
};

// Acepta la PK con o sin '0x' / espacios; toma los últimos 64 hex.
export const normPk = (s) => `0x${(s || '').replace(/[^0-9a-fA-F]/g, '').slice(-64)}`;

export function need(state, ...keys) {
  for (const k of keys) {
    if (state[k] === undefined || state[k] === null) {
      console.error(`Falta '${k}' en el estado. Corré el paso anterior primero.`);
      process.exit(1);
    }
  }
}
