// refresh-session.test.mjs — WKH-66 W4.4.
//
// 1 test T-RS-01. We spawn the script with a stub fetch via NODE_OPTIONS
// `--import` of an inline module that overrides globalThis.fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'scripts', 'refresh-session.mjs');

test('T-RS-01: refresh session tools/list → 3 → exit 0', () => {
  // Build a tiny ESM module that monkey-patches globalThis.fetch BEFORE
  // the script runs. We use `--import` (Node 20+) to register it.
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'wkh66-rs-'));
  const stubPath = path.join(tmpDir, 'fetch-stub.mjs');
  writeFileSync(stubPath, `
    globalThis.fetch = async (url, init) => {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            { name: 'discover_agents' },
            { name: 'get_payment_quote' },
            { name: 'pay_x402' },
          ],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  `);
  try {
    const r = spawnSync(process.execPath, ['--import', stubPath, SCRIPT], {
      env: {
        ...process.env,
        MCP_BEARER_TOKEN: 'test-bearer',
        MCP_DEPLOY_URL: 'https://wasiai-x402-mcp.vercel.app',
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `exit ${r.status}, stderr: ${r.stderr}`);
    const stdout = r.stdout.trim();
    const parsed = JSON.parse(stdout);
    assert.deepEqual(parsed, { ok: true, toolCount: 3 });
  } finally {
    try { unlinkSync(stubPath); } catch {}
  }
});
