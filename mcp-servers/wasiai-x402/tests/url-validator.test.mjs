// url-validator.test.mjs — 9 tests + bonus (V3 BLOQUEANTE).
//
// Mocking strategy: pass a custom `dnsLookup` via the options injection point
// to avoid touching real DNS. This keeps tests offline and deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateGatewayUrl,
  SSRFViolationError,
  isPrivateIPv4,
  isPrivateIPv6,
} from '../src/url-validator.mjs';

// Build a fake dns.lookup that always returns `addrs`.
function fakeDns(addrs) {
  return async (_host, _opts) => addrs;
}

test('T16: parse fails on garbage url', async () => {
  await assert.rejects(
    async () => validateGatewayUrl('not a url'),
    (e) => e instanceof SSRFViolationError && e.category === 'parse',
  );
});

test('T17: rejects ftp scheme', async () => {
  await assert.rejects(
    async () => validateGatewayUrl('ftp://example.com'),
    (e) => e instanceof SSRFViolationError && e.category === 'scheme',
  );
});

test('T18: rejects http:// in production (allowDevPrivate=false)', async () => {
  await assert.rejects(
    async () => validateGatewayUrl('http://example.com'),
    (e) => e instanceof SSRFViolationError && e.category === 'scheme',
  );
});

test('T19: rejects literal localhost in prod', async () => {
  await assert.rejects(
    async () => validateGatewayUrl('https://localhost'),
    (e) => e instanceof SSRFViolationError && e.category === 'literal',
  );
});

test('T20: rejects localhost. with trailing dot (RFC 1035)', async () => {
  await assert.rejects(
    async () => validateGatewayUrl('https://localhost.'),
    (e) => e instanceof SSRFViolationError && e.category === 'literal',
  );
});

test('T21: rejects foo.local', async () => {
  await assert.rejects(
    async () => validateGatewayUrl('https://foo.local'),
    (e) => e instanceof SSRFViolationError && e.category === 'literal',
  );
});

test('T22: rejects private IPv4 ranges (subtests)', async (t) => {
  const cases = [
    '169.254.169.254', // AWS metadata
    '10.0.0.1',
    '192.168.1.1',
    '172.16.0.1',
    '127.0.0.1',
    '0.0.0.0',
  ];
  for (const ip of cases) {
    await t.test(`rejects ${ip}`, async () => {
      const dnsLookup = fakeDns([{ family: 4, address: ip }]);
      await assert.rejects(
        async () => validateGatewayUrl('https://attacker.example.com', { dnsLookup }),
        (e) => e instanceof SSRFViolationError && e.category === 'private-ipv4',
      );
    });
  }
});

test('T23: rejects private IPv6 ranges (subtests)', async (t) => {
  const cases = [
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ];
  for (const ip of cases) {
    await t.test(`rejects ${ip}`, async () => {
      const dnsLookup = fakeDns([{ family: 6, address: ip }]);
      await assert.rejects(
        async () => validateGatewayUrl('https://attacker.example.com', { dnsLookup }),
        (e) => e instanceof SSRFViolationError && e.category === 'private-ipv6',
      );
    });
  }
});

test('T24: MCP_GATEWAY_ALLOWLIST permits private DNS (early return)', async () => {
  // dnsLookup would resolve to 10.0.0.5 (private), but allowlist short-circuits.
  const dnsLookup = fakeDns([{ family: 4, address: '10.0.0.5' }]);
  const url = await validateGatewayUrl('https://internal.example.com', {
    allowlist: ['internal.example.com'],
    dnsLookup,
  });
  assert.equal(url.hostname, 'internal.example.com');
});

// ── Bonus / sanity ─────────────────────────────────────────────────────────
test('Bonus: allows public IPv4 like 8.8.8.8', async () => {
  const dnsLookup = fakeDns([{ family: 4, address: '8.8.8.8' }]);
  const url = await validateGatewayUrl('https://example.com', { dnsLookup });
  assert.equal(url.protocol, 'https:');
});

test('Bonus: dev mode permits http://localhost', async () => {
  const url = await validateGatewayUrl('http://localhost:3000', { allowDevPrivate: true });
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, 'localhost');
});

test('Bonus: isPrivateIPv4 / isPrivateIPv6 helpers', () => {
  assert.equal(isPrivateIPv4('10.0.0.1'), true);
  assert.equal(isPrivateIPv4('8.8.8.8'), false);
  assert.equal(isPrivateIPv4('169.254.169.254'), true);
  assert.equal(isPrivateIPv4('not.an.ip.at.all'), false);
  assert.equal(isPrivateIPv6('::1'), true);
  assert.equal(isPrivateIPv6('2001:4860:4860::8888'), false);
  assert.equal(isPrivateIPv6('fd00::1'), true);
  assert.equal(isPrivateIPv6('fe80::1'), true);
  assert.equal(isPrivateIPv6('::ffff:10.0.0.1'), true);
});
