/**
 * WKH-191h · PASO 3 — Configurar el rol árbitro on-chain en el escrow del demo.
 *
 * Llama setArbiter(arbiterAddress) sobre 0x149D (onlyOwner). Post-upgrade el
 * _arbiter arranca en address(0); esto lo activa. Lee la dirección del árbitro
 * de `.env.arbiter` (paso 2) o del primer argumento. Firma con OPERATOR_PRIVATE_KEY
 * (owner 0xf432). Verifica arbiter() == arbiterAddress al final.
 *
 * Uso:
 *   export OPERATOR_PRIVATE_KEY=$(grep -hE '^OPERATOR_PRIVATE_KEY=' .env .env.local | head -1 | cut -d= -f2- | tr -d '"'"'"'"')
 *   node scripts/191h/3-set-arbiter.cjs            # lee la addr de .env.arbiter
 *   node scripts/191h/3-set-arbiter.cjs 0xArbiter  # o pasás la addr explícita
 */
const path = require('path');
const fs = require('fs');
const ROOT = '/home/ferdev/.openclaw/workspace/wasiai-a2a';
const V = require(path.join(ROOT, 'node_modules/viem'));
const { privateKeyToAccount } = require(path.join(ROOT, 'node_modules/viem/accounts'));

const DEMO = '0x149D814e065DC8eb35E297eC36FAcfeEd204A102';
const OWNER = '0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba';
const chain = { id: 2368, name: 'kite', nativeCurrency: { name: 'KITE', symbol: 'KITE', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc-testnet.gokite.ai/'] } } };

(async () => {
  // Resolver la dirección del árbitro (arg > .env.arbiter)
  let arb = process.argv[2];
  if (!arb) {
    const f = path.join(ROOT, '.env.arbiter');
    if (fs.existsSync(f)) {
      const m = fs.readFileSync(f, 'utf8').match(/ARBITER_PRIVATE_KEY=(\S+)/);
      if (m) arb = privateKeyToAccount(m[1].startsWith('0x') ? m[1] : '0x' + m[1]).address;
    }
  }
  if (!arb || !/^0x[0-9a-fA-F]{40}$/.test(arb)) { console.log('ERR: falta la dirección del árbitro (arg o .env.arbiter)'); process.exit(1); }
  console.log('arbiter a setear:', arb);

  let pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk) { console.log('ERR: OPERATOR_PRIVATE_KEY no está en el env'); process.exit(1); }
  pk = pk.startsWith('0x') ? pk : '0x' + pk;
  const acct = privateKeyToAccount(pk);
  console.log('signer:', acct.address);
  if (acct.address.toLowerCase() !== OWNER.toLowerCase()) { console.log('ABORT: el signer no es el owner'); process.exit(1); }

  const pc = V.createPublicClient({ chain, transport: V.http() });
  const wc = V.createWalletClient({ account: acct, chain, transport: V.http() });
  const abi = [
    { name: 'setArbiter', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'newArbiter', type: 'address' }], outputs: [] },
    { name: 'arbiter', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  ];
  try {
    await pc.simulateContract({ address: DEMO, abi, functionName: 'setArbiter', args: [arb], account: acct });
  } catch (e) {
    console.log('SIM REVERT (no se envía):', (e.shortMessage || e.message).split('\n')[0]);
    console.log('  -> si dice función inexistente, el upgrade (paso 1) todavía no se ejecutó.');
    process.exit(1);
  }
  console.log('sim OK -> enviando setArbiter...');
  const hash = await wc.writeContract({ address: DEMO, abi, functionName: 'setArbiter', args: [arb] });
  console.log('tx:', hash);
  const r = await pc.waitForTransactionReceipt({ hash });
  console.log('status:', r.status, '| block:', r.blockNumber.toString());
  const onchain = await pc.readContract({ address: DEMO, abi, functionName: 'arbiter' });
  console.log('arbiter() on-chain:', onchain);
  console.log(onchain.toLowerCase() === arb.toLowerCase() ? 'SET ARBITER OK ✓ — disputa activa en el escrow del demo' : 'ATENCIÓN: arbiter() no coincide');
})().catch((e) => { console.log('ERR:', (e.message || String(e)).split('\n')[0]); process.exit(1); });
