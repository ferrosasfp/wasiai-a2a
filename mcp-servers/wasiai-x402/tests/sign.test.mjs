// sign.test.mjs — 8 tests for src/sign.mjs.
//
// T01 is the GOLDEN VECTOR (CD-5 BLOQUEANTE). Any drift in domain/types/serialization
// breaks this and gets caught by AR pre-merge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const FIXED_PK = '0x' + '11'.repeat(32);
// Deterministic operator address derived from FIXED_PK above.
const FIXED_OPERATOR_ADDRESS = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';

// Frozen golden envelope captured during W1.4 verification (3 runs identical).
// If this string changes, AR rejects the PR — see SDD §15 V2 (envelope drift).
const GOLDEN_ENVELOPE_BASE64 =
  'eyJzaWduYXR1cmUiOiIweDM3YWYzNWU4ZTRkZDBhYTRmNTRmMDc1YjU4NWZjZjY5ZmM0YTViODI1OTFjNzI5MDE5MDNmZmVjNjMwYTY2OWExMjhjNmJiMjk1ZWE1OGY2OWZhMGE3YjU0NWUzODQyMmM3MzNmZWEzZGRkMzE4ZDBlNTE4ZGU5ZTlkOTRhMTAxMWMiLCJhdXRob3JpemF0aW9uIjp7ImZyb20iOiIweDE5RTdFMzc2RTdDMjEzQjdFN2U3ZTQ2Y2M3MEE1ZEQwODZEQWZmMkEiLCJ0byI6IjB4MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMyIsInZhbHVlIjoiMTAwMDAwMDAwMDAwMDAwMDAwMCIsInZhbGlkQWZ0ZXIiOiIwIiwidmFsaWRCZWZvcmUiOiIxNzAwMDAwMDAwIiwibm9uY2UiOiIweDIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIifSwibmV0d29yayI6ImVpcDE1NToyMzY4In0=';
const GOLDEN_SIGNATURE =
  '0x37af35e8e4dd0aa4f54f075b585fcf69fc4a5b82591c72901903ffec630a669a128c6bb295ea58f69fa0a7b545e38422c733fea3ddd318d0e518de9e9d94a1011c';

// Helper: dynamic import of src/sign.mjs after env is set, since the module reads
// the PK on-demand inside the function bodies (CD-14).
async function loadSign() {
  return await import('../src/sign.mjs');
}

function fixedArgs(overrides = {}) {
  return {
    to: '0x' + '33'.repeat(20),
    value: 1000000000000000000n,
    validBefore: 1700000000n,
    nonce: '0x' + '22'.repeat(32),
    chainId: 2368,
    contract: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9',
    domainName: 'PYUSD',
    domainVersion: '1',
    ...overrides,
  };
}

test('T01: GOLDEN VECTOR — fixed inputs produce deterministic envelope', async () => {
  process.env.OPERATOR_PRIVATE_KEY = FIXED_PK;
  const { signX402Envelope } = await loadSign();
  const r = await signX402Envelope(fixedArgs());
  // Signature shape.
  assert.match(r.signature, /^0x[0-9a-f]{130}$/i);
  // Envelope decodes to JSON.
  const decoded = JSON.parse(Buffer.from(r.envelopeBase64, 'base64').toString('utf8'));
  // Exactly 3 top-level keys.
  assert.deepEqual(Object.keys(decoded).sort(), ['authorization', 'network', 'signature']);
  assert.equal(decoded.authorization.from, FIXED_OPERATOR_ADDRESS);
  assert.equal(decoded.authorization.value, '1000000000000000000');
  assert.equal(decoded.authorization.validAfter, '0');
  assert.equal(decoded.authorization.nonce, '0x' + '22'.repeat(32));
  assert.equal(decoded.network, 'eip155:2368');
  // PIN: full envelope match.
  assert.equal(r.envelopeBase64, GOLDEN_ENVELOPE_BASE64, 'envelope drift detected (CD-5 BLOCKER)');
  assert.equal(r.signature, GOLDEN_SIGNATURE, 'signature drift detected (CD-5 BLOCKER)');
});

test('T02: signature shape', async () => {
  process.env.OPERATOR_PRIVATE_KEY = FIXED_PK;
  const { signX402Envelope } = await loadSign();
  const r = await signX402Envelope(fixedArgs({ value: 42n, nonce: '0x' + 'ab'.repeat(32) }));
  assert.match(r.signature, /^0x[0-9a-f]{130}$/i);
});

test('T03: network field encodes chainId', async () => {
  process.env.OPERATOR_PRIVATE_KEY = FIXED_PK;
  const { signX402Envelope } = await loadSign();
  const r = await signX402Envelope(fixedArgs({ chainId: 2366 }));
  const decoded = JSON.parse(Buffer.from(r.envelopeBase64, 'base64').toString('utf8'));
  assert.equal(decoded.network, 'eip155:2366');
});

test('T04: value 0n produces valid envelope (authorization.value === "0")', async () => {
  process.env.OPERATOR_PRIVATE_KEY = FIXED_PK;
  const { signX402Envelope } = await loadSign();
  const r = await signX402Envelope(fixedArgs({ value: 0n }));
  const decoded = JSON.parse(Buffer.from(r.envelopeBase64, 'base64').toString('utf8'));
  assert.equal(decoded.authorization.value, '0');
  assert.match(r.signature, /^0x[0-9a-f]{130}$/i);
});

test('T05: validBefore BigInt → string in envelope', async () => {
  process.env.OPERATOR_PRIVATE_KEY = FIXED_PK;
  const { signX402Envelope } = await loadSign();
  const r = await signX402Envelope(fixedArgs({ validBefore: 1234567890n }));
  const decoded = JSON.parse(Buffer.from(r.envelopeBase64, 'base64').toString('utf8'));
  assert.equal(decoded.authorization.validBefore, '1234567890');
  assert.equal(typeof decoded.authorization.validBefore, 'string');
});

test('T06: nonce uniqueness over 100 sequential calls (V4.1 defense)', async () => {
  process.env.OPERATOR_PRIVATE_KEY = FIXED_PK;
  const { signX402Envelope } = await loadSign();
  const nonces = new Set();
  for (let i = 0; i < 100; i++) {
    const nonce = '0x' + randomBytes(32).toString('hex');
    const r = await signX402Envelope(fixedArgs({ nonce }));
    const decoded = JSON.parse(Buffer.from(r.envelopeBase64, 'base64').toString('utf8'));
    nonces.add(decoded.authorization.nonce);
  }
  assert.equal(nonces.size, 100);
});

test('T07: getOperatorAddress reads PK on-demand (no caching)', async () => {
  const PK1 = '0x' + '11'.repeat(32);
  const PK2 = '0x' + '22'.repeat(32);
  const { getOperatorAddress } = await loadSign();
  process.env.OPERATOR_PRIVATE_KEY = PK1;
  const a1 = getOperatorAddress();
  process.env.OPERATOR_PRIVATE_KEY = PK2;
  const a2 = getOperatorAddress();
  assert.notEqual(a1, a2, 'address should change when PK changes (no caching)');
});

test('T08: throws if PK deleted post-startup at sign-time', async () => {
  const { signX402Envelope } = await loadSign();
  process.env.OPERATOR_PRIVATE_KEY = FIXED_PK;
  // Delete BEFORE the call — must not crash startup, must crash at sign-time.
  delete process.env.OPERATOR_PRIVATE_KEY;
  await assert.rejects(
    async () => signX402Envelope(fixedArgs()),
    /OPERATOR_PRIVATE_KEY missing at sign-time/,
  );
  // Restore for downstream tests sharing the process.
  process.env.OPERATOR_PRIVATE_KEY = FIXED_PK;
});
