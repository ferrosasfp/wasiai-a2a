#!/usr/bin/env node
/**
 * Smoke — /capabilities ⇄ /discover schema-sync regression guard.
 *
 * GET /capabilities and GET /discover and assert they stay in sync:
 *   - agent count matches (capabilities.agentsTotal === discover.total === len(agents))
 *   - the chains list is present and non-empty (kite/fuji/base testnets)
 *   - protocol identity fields are present and sane (protocol:'a2a', capabilities obj)
 *   - every discovered agent carries a sane, non-negative priceUsdc and an invokeUrl
 *
 * FREE — read-only, no payment, no settlement, no on-chain spend. Cheap regression
 * guard for the recently-added /capabilities route.
 *
 * Required env: none.
 * Gateway URL: $A2A_URL or arg[2], default prod testnet gateway.
 *
 * Usage:
 *   node scripts/smoke-capabilities-schema.mjs [BASE_URL]
 *   A2A_URL=https://... node scripts/smoke-capabilities-schema.mjs
 */
const BASE =
  process.argv[2] ||
  process.env.A2A_URL ||
  'https://wasiai-a2a-production.up.railway.app';

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = '') => {
  console.log(
    `  ${cond ? '✅ PASS' : '❌ FAIL'}  ${label}${detail ? ' — ' + detail : ''}`,
  );
  cond ? pass++ : fail++;
};

const getJson = async (path) => {
  const res = await fetch(BASE + path, {
    headers: { accept: 'application/json' },
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
};

const banner = (msg) => {
  console.error('\n╔══════════════════════════════════════════════════════╗');
  console.error(`║  FAIL: ${msg.padEnd(46)}║`);
  console.error('╚══════════════════════════════════════════════════════╝\n');
};

const main = async () => {
  console.log(`\n🔬 Smoke capabilities⇄discover schema-sync vs ${BASE}\n`);

  const cap = await getJson('/capabilities');
  ok('GET /capabilities → 200', cap.status === 200, `HTTP ${cap.status}`);
  const disc = await getJson('/discover');
  ok('GET /discover → 200', disc.status === 200, `HTTP ${disc.status}`);

  if (cap.status !== 200 || disc.status !== 200) {
    banner('capabilities or discover did not return 200');
    process.exit(1);
  }

  const capAgents = Array.isArray(cap.json?.agents) ? cap.json.agents : null;
  const discAgents = Array.isArray(disc.json?.agents) ? disc.json.agents : null;

  // ── Agent-count sync ──────────────────────────────────────────────
  ok(
    'capabilities exposes agents[] + agentsTotal',
    capAgents !== null && typeof cap.json?.agentsTotal === 'number',
    `agentsTotal=${cap.json?.agentsTotal} len=${capAgents?.length}`,
  );
  ok(
    'discover exposes agents[] + total',
    discAgents !== null && typeof disc.json?.total === 'number',
    `total=${disc.json?.total} len=${discAgents?.length}`,
  );
  ok(
    'agent count in sync (capabilities.agentsTotal === discover.total)',
    cap.json?.agentsTotal === disc.json?.total,
    `${cap.json?.agentsTotal} vs ${disc.json?.total}`,
  );
  ok(
    'capabilities.agentsTotal === len(capabilities.agents)',
    capAgents !== null && cap.json.agentsTotal === capAgents.length,
    `${cap.json?.agentsTotal} vs ${capAgents?.length}`,
  );
  ok(
    'discover.total === len(discover.agents)',
    discAgents !== null && disc.json.total === discAgents.length,
    `${disc.json?.total} vs ${discAgents?.length}`,
  );

  // The two agent lists share the same source; their slug sets should match.
  if (capAgents && discAgents) {
    const capSlugs = new Set(capAgents.map((a) => a.slug));
    const discSlugs = new Set(discAgents.map((a) => a.slug));
    const sameSet =
      capSlugs.size === discSlugs.size &&
      [...capSlugs].every((s) => discSlugs.has(s));
    ok('agent slug sets match between the two routes', sameSet,
      `${capSlugs.size} slugs`);
  }

  // ── Chains list ───────────────────────────────────────────────────
  const chains = Array.isArray(cap.json?.chains) ? cap.json.chains : null;
  ok(
    'capabilities.chains present + non-empty',
    chains !== null && chains.length >= 1,
    `chains=${chains?.map((c) => c.key).join(',')}`,
  );
  ok(
    'every chain entry has key + numeric chainId',
    chains !== null &&
      chains.every(
        (c) => typeof c.key === 'string' && typeof c.chainId === 'number',
      ),
    `n=${chains?.length}`,
  );
  ok(
    'exactly one chain flagged isDefault',
    chains !== null && chains.filter((c) => c.isDefault === true).length === 1,
    `default=${chains?.find((c) => c.isDefault)?.key}`,
  );

  // ── Protocol identity / capabilities fields ───────────────────────
  ok(
    "capabilities.protocol === 'a2a'",
    cap.json?.protocol === 'a2a',
    `protocol=${cap.json?.protocol}`,
  );
  ok(
    'capabilities.capabilities is an object (streaming/pushNotifications flags)',
    cap.json?.capabilities !== null &&
      typeof cap.json?.capabilities === 'object',
    JSON.stringify(cap.json?.capabilities),
  );
  ok(
    'capabilities.methods is a non-empty array (advertised gateway skills)',
    Array.isArray(cap.json?.methods) && cap.json.methods.length >= 1,
    `n=${cap.json?.methods?.length}`,
  );

  // ── Per-agent price sanity (fee/price field present + non-negative) ─
  // Note: the 1% protocol fee is charged at compose/orchestrate time, not a
  // /discover field. The price-facing field on each agent is `priceUsdc`.
  if (discAgents) {
    const bad = discAgents.filter((a) => {
      const p = Number(a.priceUsdc);
      return !Number.isFinite(p) || p < 0;
    });
    ok(
      'every discovered agent has a sane non-negative priceUsdc',
      bad.length === 0,
      bad.length ? `offenders=${bad.map((a) => a.slug).join(',')}` : 'all sane',
    );
    const noUrl = discAgents.filter(
      (a) => typeof a.invokeUrl !== 'string' || a.invokeUrl.length === 0,
    );
    ok(
      'every discovered agent advertises an invokeUrl',
      noUrl.length === 0,
      noUrl.length ? `missing=${noUrl.map((a) => a.slug).join(',')}` : 'all present',
    );
  }

  console.log(`\n  Resultado: ${pass} PASS / ${fail} FAIL\n`);
  if (fail > 0) {
    banner(`${fail} assertion(s) failed`);
    process.exit(1);
  }
  process.exit(0);
};

main().catch((e) => {
  banner(e.message);
  process.exit(1);
});
