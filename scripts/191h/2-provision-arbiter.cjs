/**
 * WKH-191h · PASO 2 — Provisionar la wallet DEDICADA del árbitro.
 *
 * Genera una wallet nueva, guarda la private key en `.env.arbiter` (gitignored
 * por el patrón `.env*`), e imprime SOLO la dirección + el comando para setear
 * ARBITER_PRIVATE_KEY en Railway. La private key NO se imprime en pantalla.
 *
 * Idempotente: si `.env.arbiter` ya existe, NO regenera (reusa la wallet) para
 * no perder una key ya seteada en Railway.
 *
 * Uso:  node scripts/191h/2-provision-arbiter.cjs
 * Después: setear ARBITER_PRIVATE_KEY en Railway (comando que imprime) +
 *          fondear la wallet con un poco de KITE gas (para firmar resolveDispute).
 */
const path = require('path');
const fs = require('fs');
const ROOT = '/home/ferdev/.openclaw/workspace/wasiai-a2a';
const { generatePrivateKey, privateKeyToAccount } = require(path.join(ROOT, 'node_modules/viem/accounts'));

const OUT = path.join(ROOT, '.env.arbiter');

(async () => {
  let pk;
  if (fs.existsSync(OUT)) {
    const prev = fs.readFileSync(OUT, 'utf8').match(/ARBITER_PRIVATE_KEY=(\S+)/);
    if (prev) { pk = prev[1]; console.log('.env.arbiter ya existe -> reuso la wallet (no regenero).'); }
  }
  if (!pk) {
    pk = generatePrivateKey();
    fs.writeFileSync(OUT, `ARBITER_PRIVATE_KEY=${pk}\n`, { mode: 0o600 });
    console.log('wallet del árbitro generada -> private key guardada en .env.arbiter (gitignored, 0600).');
  }
  const acct = privateKeyToAccount(pk);
  console.log('');
  console.log('ARBITER ADDRESS:', acct.address);
  console.log('');
  console.log('-> Setear en Railway (la key sale del archivo, no del chat):');
  console.log('   RAILWAY_TOKEN=$RAILWAY_TOKEN_D railway variables --service wasiai-a2a \\');
  console.log('     --set "ARBITER_PRIVATE_KEY=$(grep -hE \'^ARBITER_PRIVATE_KEY=\' .env.arbiter | cut -d= -f2-)"');
  console.log('');
  console.log('-> Fondear', acct.address, 'con KITE gas (faucet kite / consolidar sobrantes) para que pueda firmar resolveDispute.');
  console.log('-> Luego correr: node scripts/191h/3-set-arbiter.cjs');
})().catch((e) => { console.log('ERR:', (e.message || String(e)).split('\n')[0]); process.exit(1); });
