// rotate-bearer.test.mjs — WKH-66 W4.2.
//
// 2 tests T-RB-01..T-RB-02. Spawn the script as a child process and inspect
// stdout/stderr/exit code. We use `pty.js`-equivalent? No — we rely on
// `process.stdout.isTTY` checks in the script. Spawn with stdio: ['pipe',
// 'pipe', 'pipe'] simulates a non-TTY for T-RB-02. For T-RB-01 we spawn
// with isTTY=true via { stdio: ... } isn't sufficient — `child.stdout` is
// always a pipe in spawn(). We patch the script behavior by setting an env
// var override (FORCE_TTY=1) for the test only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'scripts', 'rotate-bearer.mjs');

test('T-RB-01: rotate generates 32 bytes hex once + no disk write', () => {
  // Trick: we cannot easily fake isTTY from the parent. Instead, we use
  // `script` (BSD/Linux) wrappers… not portable. Cleanest path: bypass the
  // TTY check by piping the script through a small wrapper that replaces
  // process.stdout.isTTY before importing. We do this inline with `node -e`.
  const wrapper = `
    process.stdout.isTTY = true;
    // Spy on fs writes — must NOT be called.
    const fs = require('node:fs');
    const origWriteFile = fs.writeFile;
    const origWriteFileSync = fs.writeFileSync;
    fs.writeFile = (...args) => { process.stderr.write('FS_WRITE_DETECTED\\n'); origWriteFile(...args); };
    fs.writeFileSync = (...args) => { process.stderr.write('FS_WRITE_DETECTED\\n'); origWriteFileSync(...args); };
    import(${JSON.stringify(SCRIPT)});
  `;
  const r = spawnSync(process.execPath, ['-e', wrapper], {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `exit ${r.status}, stderr: ${r.stderr}`);
  assert.match(r.stdout, /^[0-9a-f]{64}\n$/, `stdout did not match expected pattern: ${r.stdout}`);
  assert.ok(!r.stderr.includes('FS_WRITE_DETECTED'), 'script must not write to disk');
  // Stderr must NOT contain the bearer (CD-10).
  const bearer = r.stdout.trim();
  assert.ok(!r.stderr.includes(bearer), 'stderr must not echo the bearer');
});

test('T-RB-02: rotate non-TTY → exit !=0', () => {
  const r = spawnSync(process.execPath, [SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  // process.stdout.isTTY is false because stdout is a pipe.
  assert.notEqual(r.status, 0, `expected non-zero exit, got ${r.status}`);
  assert.match(r.stderr, /Refusing/);
  // No bearer leaked.
  assert.ok(!/[0-9a-f]{64}/.test(r.stdout), 'stdout must not contain bearer');
});
