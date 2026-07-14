/**
 * WKH-191h · PASO 1 — Ejecutar el upgrade UUPS del escrow del demo 0x149D a v191f.
 *
 * Correr DENTRO de la ventana del timelock:
 *   ETA (desde): 2026-07-16 19:43 UTC   ·   cierra: 2026-07-23 19:43 UTC
 *
 * Si el timelock NO transcurrió, la simulación revierte con TimelockNotElapsed
 * y NO se envía nada (fail-safe). Lee OPERATOR_PRIVATE_KEY del env (owner 0xf432).
 * La key NUNCA se imprime.
 *
 * Uso:
 *   export OPERATOR_PRIVATE_KEY=$(grep -hE '^OPERATOR_PRIVATE_KEY=' .env .env.local | head -1 | cut -d= -f2- | tr -d '"'"'"'"')
 *   node scripts/191h/1-execute-upgrade.cjs
 */
const path = require('path');
const ROOT = '/home/ferdev/.openclaw/workspace/wasiai-a2a';
const V = require(path.join(ROOT, 'node_modules/viem'));
const { privateKeyToAccount } = require(path.join(ROOT, 'node_modules/viem/accounts'));

const DEMO = '0x149D814e065DC8eb35E297eC36FAcfeEd204A102';
const NEWIMPL = '0x82b5f3180b4ff1a2097d8afa6b876cf363e60b74'; // v191f (validado en el arbiter E2E)
const OWNER = '0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba';
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const chain = { id: 2368, name: 'kite', nativeCurrency: { name: 'KITE', symbol: 'KITE', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc-testnet.gokite.ai/'] } } };

(async () => {
  let pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk) { console.log('ERR: OPERATOR_PRIVATE_KEY no está en el env'); process.exit(1); }
  pk = pk.startsWith('0x') ? pk : '0x' + pk;
  const acct = privateKeyToAccount(pk);
  console.log('signer:', acct.address);
  if (acct.address.toLowerCase() !== OWNER.toLowerCase()) { console.log('ABORT: el signer no es el owner'); process.exit(1); }

  const pc = V.createPublicClient({ chain, transport: V.http() });
  const wc = V.createWalletClient({ account: acct, chain, transport: V.http() });
  const abi = [{ name: 'upgradeToAndCall', type: 'function', stateMutability: 'payable', inputs: [{ name: 'newImplementation', type: 'address' }, { name: 'data', type: 'bytes' }], outputs: [] }];

  const implBefore = '0x' + (await pc.getStorageAt({ address: DEMO, slot: IMPL_SLOT })).slice(-40);
  console.log('impl ANTES:', implBefore);

  try {
    await pc.simulateContract({ address: DEMO, abi, functionName: 'upgradeToAndCall', args: [NEWIMPL, '0x'], account: acct });
  } catch (e) {
    console.log('SIM REVERT (no se envía):', (e.shortMessage || e.message).split('\n')[0]);
    console.log('  -> si dice TimelockNotElapsed, todavía no se abrió la ventana (o ya se cerró).');
    process.exit(1);
  }
  console.log('sim OK -> ejecutando upgradeToAndCall...');
  const hash = await wc.writeContract({ address: DEMO, abi, functionName: 'upgradeToAndCall', args: [NEWIMPL, '0x'] });
  console.log('tx:', hash);
  const r = await pc.waitForTransactionReceipt({ hash });
  console.log('status:', r.status, '| block:', r.blockNumber.toString());
  const implAfter = '0x' + (await pc.getStorageAt({ address: DEMO, slot: IMPL_SLOT })).slice(-40);
  console.log('impl DESPUÉS:', implAfter);
  console.log(implAfter.toLowerCase() === NEWIMPL.toLowerCase() ? 'UPGRADE OK ✓ (impl = v191f)' : 'ATENCIÓN: impl no coincide con newImpl');
  console.log('SIGUIENTE: correr 2-provision-arbiter.cjs y luego 3-set-arbiter.cjs');
})().catch((e) => { console.log('ERR:', (e.message || String(e)).split('\n')[0]); process.exit(1); });
