#!/usr/bin/env node
/**
 * @file smoke-downstream-x402.mjs
 * @description Committeable, secret-free regression smoke for the OUTBOUND x402
 *              downstream payout path (operator-float pays downstream agents via
 *              our facilitator). Live + on-chain proven on Base Sepolia (WKH-106)
 *              and Avalanche Fuji (WKH-107). WKH-108.
 *
 * Two layers:
 *   1. LIGHT layer (always, network-only, NO secrets): asserts the facilitator
 *      is up (GET /health == 200) and that /supported lists every chain in
 *      EXPECTED_CHAINS (default: Base Sepolia eip155:84532 + Avalanche Fuji
 *      eip155:43113), each declaring THE METHOD THAT CORRESPONDS TO ITS CAIP-2
 *      NAMESPACE (see CHAIN_METHOD_BY_CAIP2_NAMESPACE — 'eip3009' for eip155:*,
 *      'spl-token-transfer-finalized' for solana:*) and un breaker ACEPTABLE
 *      (ver `assertBreakerAcceptable`: 'CLOSED' si el estado viene, o una razón
 *      conocida si no viene). Fails (exit != 0) if any is missing.
 *
 *      ⚠️ EL RESIDUAL DE SOLANA YA NO ESTÁ, Y NO SE CERRÓ AFLOJANDO EL CHEQUEO.
 *      Hasta el 2026-08-04 la entrada `solana:devnet` no traía `breakerState` ni
 *      nada en su lugar, así que `EXPECTED_CHAINS=solana:devnet` salía exit 1 con
 *      `breakerState='undefined'` — un rojo que acusaba a una cadena sana. El
 *      facilitator (commit 1c257c2 / fix ad5b352) ahora publica, por cadena,
 *      EXACTAMENTE UNO de `breakerState` o `breakerStateAbsentReason`, y la
 *      entrada Solana trae `NO_BREAKER` porque ese adaptador no tiene circuit
 *      breaker ni corresponde que lo tenga. Verificado contra producción el
 *      2026-08-05. Lo que este script acepta es la RAZÓN, no la ausencia: sin
 *      ninguno de los dos campos, o con una razón fuera del enum, sigue rojo.
 *
 *      El default de EXPECTED_CHAINS sigue sin Solana porque el rail que este
 *      smoke cubre de punta a punta (capa E2E) es el EVM; `solana:devnet` ya se
 *      puede pasar por env y sale verde.
 *   2. E2E layer (opt-in): ONLY when RUN_DOWNSTREAM_E2E=1 AND FUNDER_PK present.
 *      Runs the real provision -> discover -> compose -> downstream-settle flow
 *      (mirror of scripts/smoke-base-downstream.mjs) and asserts a
 *      downstreamTxHash. Without the gate or FUNDER_PK -> prints SKIP, exit 0.
 *
 * Usage:
 *   node scripts/smoke-downstream-x402.mjs                      # light layer only
 *   RUN_DOWNSTREAM_E2E=1 FUNDER_PK=0x... node scripts/...mjs    # + E2E (testnet)
 *
 * Env vars (all optional, public defaults):
 *   FACILITATOR_URL   Default: https://wasiai-facilitator-production.up.railway.app
 *   EXPECTED_CHAINS   Default: eip155:84532,eip155:43113   (CSV of CAIP-2 ids)
 *   A2A_BASE          Default: https://wasiai-a2a-production.up.railway.app  (E2E)
 *   NETWORK           Default: base-sepolia | avalanche-fuji                 (E2E)
 *   RPC_URL, AMOUNT, GAS_ETH, OWNER_REF, GOAL                                (E2E)
 *   RUN_DOWNSTREAM_E2E  '1' to enable the E2E layer
 *   FUNDER_PK           sponsor private key (E2E only; NEVER committed)
 *
 * Exit codes:
 *   0 = PASS (incl. E2E skipped cleanly)
 *   != 0 = real failure (facilitator down, chain dropped, breaker open, E2E fail)
 *
 * Constraint Directives (WKH-108):
 *   CD-1  No secrets/abs-paths committed: all creds/URLs via env w/ public defaults.
 *   CD-2  Clean skip: no RUN_DOWNSTREAM_E2E=1 or no FUNDER_PK -> exit 0 + SKIP.
 *   CD-3  Light network layer inside vitest is gated by RUN_NETWORK_SMOKE.
 */

const FACILITATOR_URL =
  process.env.FACILITATOR_URL ??
  'https://wasiai-facilitator-production.up.railway.app';
const DEFAULT_EXPECTED_CHAINS = 'eip155:84532,eip155:43113'; // Base Sepolia, Avalanche Fuji
const EXPECTED_CHAINS = (process.env.EXPECTED_CHAINS ?? DEFAULT_EXPECTED_CHAINS)
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);
/**
 * Método de settle que le exigimos a cada cadena, DERIVADO DE LA CADENA.
 *
 * ⚠️ ACÁ HABÍA UN LITERAL `const REQUIRED_METHOD = 'eip3009'` APLICADO A CUALQUIER
 * CADENA. `eip3009` es un método EVM: una cadena Solana no lo declara ni puede
 * declararlo. Medido contra el facilitator de producción el 2026-08-04,
 * `GET /supported` devuelve `solana:devnet` con `methods: ['spl-token-transfer-finalized']`,
 * así que `EXPECTED_CHAINS=solana:devnet node scripts/smoke-downstream-x402.mjs`
 * salía exit 1 con «chain solana:devnet (Solana Devnet) missing method 'eip3009'»
 * — un ROJO FALSO que le echa la culpa a la cadena cuando la cadena está sana. El
 * único motivo por el que nadie lo vio es que el default de `EXPECTED_CHAINS` no
 * incluye ninguna cadena Solana: el rail Solana simplemente NO estaba cubierto por
 * este smoke, y la primera persona que intentara cubrirlo se iba a comer el rojo.
 *
 * La clave es el NAMESPACE CAIP-2 del propio id de cadena (`eip155:84532` →
 * `eip155`, `solana:devnet` → `solana`), o sea que el método sale del dato de
 * entrada y no de una constante paralela al lado.
 *
 * ⚠️ POR QUÉ ESTA TABLA NO SE IMPORTA DE `src/`: se buscó y NO EXISTE allá. El
 * nombre `spl-token-transfer-finalized` no aparece en ningún archivo de este repo
 * (el vocabulario de métodos lo define el facilitator, que es otro servicio); lo
 * más cercano es `getChainVmFamily()` de `src/adapters/chain-resolver.ts`, que
 * clasifica en `'evm' | 'solana'` pero no nombra métodos, y además es TypeScript
 * — este script corre con `node` pelado, sin loader de TS.
 *
 * Lo que SÍ evita que esta tabla se desincronice es mecánico y no una promesa
 * escrita: `test/smoke-downstream-x402.method.test.ts` cruza el conjunto de
 * `vmFamily` de acá contra las familias que `chain-resolver.ts` conoce de verdad
 * (enumerando `listChainAliases()` → `normalizeChainSlug()` → `getChainVmFamily()`).
 * Agregar una familia de VM nueva en `src/` sin enseñársela a este script pone ese
 * test en rojo. Por eso cada entrada lleva su `vmFamily`: es la costura por donde
 * el cruce agarra.
 *
 * Prototipo `null` (mismo criterio anti-prototype-pollution que `SLUG_ALIASES` en
 * `chain-resolver.ts`): el namespace sale de `EXPECTED_CHAINS`, que es input.
 */
const CHAIN_METHOD_BY_CAIP2_NAMESPACE = Object.assign(
  Object.create(null),
  /** @type {Record<string, {vmFamily: string, method: string}>} */ ({
    eip155: { vmFamily: 'evm', method: 'eip3009' },
    solana: { vmFamily: 'solana', method: 'spl-token-transfer-finalized' },
  }),
);

const REQUIRED_BREAKER = 'CLOSED';
/**
 * Los tres valores que `breakerState` puede tomar en `GET /supported` según el
 * contrato del facilitator (`doc/openapi.yaml`, campo `breakerState`, y el tipo
 * `ChainSupportedItem` en `src/core/supported.ts` de ese repo). Cualquier otro
 * string en ese campo es una respuesta que no entendemos, no un estado.
 */
const BREAKER_STATES = ['CLOSED', 'OPEN', 'HALF_OPEN'];
/**
 * Las razones por las que una entrada legítimamente NO trae `breakerState`.
 * Enum publicado por el facilitator (`doc/openapi.yaml`:
 * `breakerStateAbsentReason.enum`, commit 1c257c2 / fix ad5b352):
 *   - NO_BREAKER        el adaptador no expone breaker. Es el caso `solana:*`.
 *   - BREAKER_DISABLED  tiene breaker en passthrough (`CB_ENABLED=false`).
 *   - ADAPTER_LOOKUP_FAILED  el registry no devolvió el adaptador de una metadata
 *     que él mismo listó. El facilitator lo documenta como inalcanzable por
 *     construcción; si aparece, su registry está inconsistente — por eso el log
 *     de abajo lo marca, aunque no cambia el exit code (no es un breaker abierto).
 *
 * ⚠️ ESTA LISTA ES UN CONJUNTO CERRADO A PROPÓSITO. Aceptar cualquier string acá
 * equivale a aceptar la ausencia del campo: bastaría con que el facilitator
 * mandara `breakerStateAbsentReason: "?"` —o con que un proxy lo reescribiera—
 * para que el chequeo del breaker se apagara solo. Un guard que acepta cualquier
 * cosa en lugar del campo que falta no es un guard.
 */
const KNOWN_BREAKER_ABSENT_REASONS = [
  'NO_BREAKER',
  'BREAKER_DISABLED',
  'ADAPTER_LOOKUP_FAILED',
];
const FETCH_TIMEOUT_MS = Number(process.env.SMOKE_FETCH_TIMEOUT_MS ?? 10000);

function progress(msg) {
  process.stderr.write(`[smoke] ${msg}\n`);
}

/**
 * Las familias de VM que este script sabe verificar. La consume el test que las
 * cruza contra `chain-resolver.ts`; se DERIVA de la tabla (no es una segunda
 * lista) para que no pueda quedar desactualizada respecto de ella.
 * @returns {string[]} ordenadas, sin repetidos
 */
export function knownVmFamilies() {
  return [
    ...new Set(
      Object.values(CHAIN_METHOD_BY_CAIP2_NAMESPACE).map((e) => e.vmFamily),
    ),
  ].sort();
}

/**
 * Método de settle que le corresponde a `network` según su namespace CAIP-2.
 *
 * ⚠️ TIRA ERROR ANTE UNA CADENA DESCONOCIDA. A PROPÓSITO, Y NO SE "ARREGLA"
 * DEVOLVIENDO `undefined` NI SALTEANDO EL CHEQUEO. La tentación obvia ante un
 * namespace que no está en la tabla es dejar pasar la cadena "porque no sabemos
 * qué exigirle": eso convierte a este smoke en un chequeo que se apaga solo justo
 * para las cadenas nuevas — las únicas donde todavía no hay confianza acumulada.
 * Un rail que nadie verificó saldría VERDE y se leería como "verificado", que es
 * exactamente la clase de falla que este repo ya pagó con un doble pago que
 * sobrevivió un mes porque su reporter leía dos hashes y nunca el tercero.
 * No saber qué exigir es un motivo para FALLAR RUIDOSAMENTE, no para aprobar.
 *
 * @param {string} network id CAIP-2, p.ej. 'eip155:84532' | 'solana:devnet'
 * @returns {string} el método exigido
 */
export function requiredMethodFor(network) {
  const raw = typeof network === 'string' ? network.trim() : '';
  const sep = raw.indexOf(':');
  const namespace = sep === -1 ? '' : raw.slice(0, sep).toLowerCase();
  const known = Object.keys(CHAIN_METHOD_BY_CAIP2_NAMESPACE);
  if (
    namespace === '' ||
    !Object.hasOwn(CHAIN_METHOD_BY_CAIP2_NAMESPACE, namespace)
  ) {
    throw new Error(
      `cannot determine the required settle method for chain '${raw}': ` +
        `unrecognised CAIP-2 namespace '${namespace}' (known: ${known.join(', ')}). ` +
        'Refusing to skip the method check — teach this script the namespace ' +
        'instead of letting an unverified chain report green.',
    );
  }
  return CHAIN_METHOD_BY_CAIP2_NAMESPACE[namespace].method;
}

/**
 * Verifica la pata breaker de UNA entrada de `/supported`. Tira si no pasa;
 * devuelve el fragmento que se imprime en el log de la cadena.
 *
 * ⚠️ QUÉ CAMBIÓ Y POR QUÉ (medido, no inferido). Antes acá había
 * `if (chain.breakerState !== 'CLOSED') throw`, aplicado a TODA cadena. El
 * 2026-08-05, contra el facilitator de producción:
 *
 *     EXPECTED_CHAINS=solana:devnet node scripts/smoke-downstream-x402.mjs
 *     → [smoke] FAIL: chain solana:devnet (Solana Devnet)
 *       breakerState='undefined' (expected 'CLOSED')            exit 1
 *
 * Ese rojo acusaba a una cadena sana: el `SolanaAdapter` NO TIENE circuit breaker
 * y no corresponde que lo tenga. El breaker envuelve el camino EVM, donde el
 * facilitator SIMULA y TRANSMITE una autorización EIP-3009 pagando su propio gas
 * — abrirlo deja de quemar gas y el caller puede irse a otra cadena ANTES de
 * pagar. En el riel Solana el facilitator es TESTIGO: lee a commitment
 * `finalized` una tx que el pagador ya transmitió. No hay gas nuestro que
 * proteger, y un breaker abierto sólo rechazaría pagos que ya están finales en la
 * cadena. (Todo esto está en `src/core/supported.ts` del facilitator, commit
 * 1c257c2 / fix ad5b352.)
 *
 * ⚠️ LO QUE **NO** SE HIZO: no se aflojó el chequeo a "si no viene `breakerState`,
 * no lo mires". Eso sería el chequeo-que-se-apaga-solo que explica el docstring de
 * `requiredMethodFor`, y borraría la diferencia entre "esta cadena no tiene
 * breaker" y "el campo se perdió en el camino" / "estoy hablando con un
 * facilitator anterior a este campo" — que es EXACTAMENTE la distinción que el
 * facilitator acaba de agregar. La ausencia se acepta sólo cuando viene
 * ACOMPAÑADA de una razón que está en `KNOWN_BREAKER_ABSENT_REASONS`; sin razón,
 * o con una razón que no reconocemos, esto sale rojo.
 *
 * @param {{name?: string, breakerState?: unknown, breakerStateAbsentReason?: unknown}} chain
 *        la entrada tal cual vino de `/supported`
 * @param {string} network id CAIP-2 de la entrada, para el mensaje de error
 * @returns {string} fragmento de log, p.ej. `breaker=CLOSED` | `breakerAbsent=NO_BREAKER`
 */
export function assertBreakerAcceptable(chain, network) {
  const label = `chain ${network} (${chain?.name ?? '?'})`;
  const state = chain?.breakerState;
  const reason = chain?.breakerStateAbsentReason;

  // Caso 1 — el estado VINO: se valida contra el enum y después contra el valor
  // exigido. Los dos rojos son distintos a propósito: 'OPEN' es un breaker
  // abierto (la cadena está fallando) y 'sarasa' es una respuesta que no
  // entendemos; mandar a buscar el problema al lugar equivocado cuesta tiempo.
  if (state !== undefined) {
    if (!BREAKER_STATES.includes(state)) {
      throw new Error(
        `${label} breakerState='${state}' is not a known breaker state ` +
          `(known: ${BREAKER_STATES.join(', ')}). Refusing to accept a value ` +
          'this script cannot interpret.',
      );
    }
    if (state !== REQUIRED_BREAKER) {
      throw new Error(
        `${label} breakerState='${state}' (expected '${REQUIRED_BREAKER}')`,
      );
    }
    return `breaker=${state}`;
  }

  // Caso 2 — no vino el estado y TAMPOCO la razón. ROJO, y este es el caso que
  // no se puede aflojar: es la respuesta incompleta o el facilitator viejo.
  if (reason === undefined) {
    throw new Error(
      `${label} has NEITHER breakerState NOR breakerStateAbsentReason. ` +
        'GET /supported must carry exactly one of the two per chain: the ' +
        'payload is incomplete, was rewritten in transit, or the facilitator ' +
        'predates the reason field. Not treating a missing field as "this ' +
        'chain has no breaker".',
    );
  }

  // Caso 3 — vino una razón que no está en el conjunto conocido. También ROJO:
  // "no sé qué me dijiste" no es "está todo bien".
  if (!KNOWN_BREAKER_ABSENT_REASONS.includes(reason)) {
    throw new Error(
      `${label} breakerStateAbsentReason='${reason}' is not a reason this ` +
        `script understands (known: ${KNOWN_BREAKER_ABSENT_REASONS.join(', ')}). ` +
        'An unrecognised reason is an answer we cannot read, not a licence to ' +
        'skip the breaker check.',
    );
  }

  // Caso 4 — ausencia legítima y explicada. VERDE, con la razón en el log: el
  // motivo queda escrito en la evidencia del smoke, no se pierde.
  return reason === 'ADAPTER_LOOKUP_FAILED'
    ? // Verde en exit code (no hay breaker abierto), pero el facilitator declara
      // este valor inalcanzable por construcción: si sale, su registry está
      // inconsistente y alguien tiene que mirarlo.
      `breakerAbsent=${reason} (WARN: facilitator registry inconsistent)`
    : `breakerAbsent=${reason}`;
}

/**
 * fetch wrapper with an AbortSignal timeout. A hung facilitator (accepts the
 * connection but never responds) must fail fast with a legible error instead
 * of hanging until the CI runner's global timeout (MNR-2).
 * @param {string} url
 * @param {string} label  human-readable endpoint label for the error message
 * @param {RequestInit} [init]
 */
async function fetchWithTimeout(url, label, init = {}) {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`${label} timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  }
}

/**
 * Light layer: network-only facilitator health + supported chains/breaker.
 * Throws on any assertion failure. No secrets.
 */
export async function runLightLayer() {
  progress(
    `facilitator=${FACILITATOR_URL} expectedChains=${EXPECTED_CHAINS.join(',')}`,
  );

  // --- AC-1: GET /health == 200 ------------------------------------------
  progress('GET /health ...');
  const healthRes = await fetchWithTimeout(
    `${FACILITATOR_URL}/health`,
    '/health',
  );
  if (healthRes.status !== 200) {
    throw new Error(`/health returned HTTP ${healthRes.status} (expected 200)`);
  }
  progress('health OK (200)');

  // --- AC-2: GET /supported -> chains + methods + breaker ----------------
  progress('GET /supported ...');
  const supRes = await fetchWithTimeout(
    `${FACILITATOR_URL}/supported`,
    '/supported',
  );
  if (supRes.status !== 200) {
    throw new Error(`/supported returned HTTP ${supRes.status} (expected 200)`);
  }
  const supported = await supRes.json();
  const chains = Array.isArray(supported?.chains) ? supported.chains : [];
  if (chains.length === 0) {
    throw new Error('/supported returned no chains');
  }

  const byNetwork = new Map(chains.map((c) => [c?.network, c]));
  for (const expected of EXPECTED_CHAINS) {
    const chain = byNetwork.get(expected);
    if (!chain) {
      throw new Error(
        `expected chain ${expected} not found in /supported (got: ${[...byNetwork.keys()].join(', ')})`,
      );
    }
    const methods = Array.isArray(chain.methods) ? chain.methods : [];
    // El método sale de la cadena que se está verificando, no de un literal EVM
    // aplicado a todas. Si la cadena es de una familia que no conocemos, esto
    // TIRA y el smoke sale rojo — ver el docstring de `requiredMethodFor`.
    const requiredMethod = requiredMethodFor(expected);
    if (!methods.includes(requiredMethod)) {
      throw new Error(
        `chain ${expected} (${chain.name ?? '?'}) missing method '${requiredMethod}' (got: ${methods.join(', ')})`,
      );
    }
    // El breaker se exige 'CLOSED' cuando la entrada LO TRAE, y se acepta ausente
    // sólo si viene la razón conocida que lo explica. Que no venga ninguno de los
    // dos sigue siendo rojo — ver el docstring de `assertBreakerAcceptable`.
    const breakerLog = assertBreakerAcceptable(chain, expected);
    progress(
      `chain ${expected} (${chain.name}) OK [methods=${methods.join(',')} ${breakerLog}]`,
    );
  }

  return { healthy: true, chains: EXPECTED_CHAINS };
}

/**
 * AC-6 (informative, NON-blocking): probe the A2A /discover endpoint to log
 * whether demo agents (base-demo / avax-demo) are reachable. NEVER throws or
 * changes the exit code — purely a stderr signal. Mirrors the E2E layer's
 * `POST /discover { q }` call shape (MNR-1).
 */
export async function probeA2ADiscover() {
  const A2A_BASE =
    process.env.A2A_BASE ?? 'https://wasiai-a2a-production.up.railway.app';
  try {
    const res = await fetchWithTimeout(`${A2A_BASE}/discover`, '/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: 'base' }),
    });
    if (res.status !== 200) {
      progress(`A2A discover: WARN HTTP ${res.status} (informative, ignored)`);
      return;
    }
    const json = await res.json().catch(() => ({}));
    const agents = json?.agents ?? json?.results ?? [];
    const slugs = Array.isArray(agents)
      ? agents.map((a) => a?.slug).filter(Boolean)
      : [];
    progress(
      `A2A discover: reachable, ${slugs.length} agent(s)${slugs.length ? ` [${slugs.slice(0, 5).join(', ')}]` : ''}`,
    );
  } catch (err) {
    progress(
      `A2A discover: WARN unreachable (${err?.message ?? String(err)}) (informative, ignored)`,
    );
  }
}

/**
 * Gate check for the E2E layer (CD-2 clean skip).
 * @returns {{run: boolean, reason?: string}}
 */
export function e2eGate(env = process.env) {
  if (env.RUN_DOWNSTREAM_E2E !== '1') {
    return { run: false, reason: 'RUN_DOWNSTREAM_E2E != 1' };
  }
  if (!env.FUNDER_PK) {
    return { run: false, reason: 'FUNDER_PK not set' };
  }
  return { run: true };
}

/**
 * E2E layer: real provision -> discover -> compose -> downstream settle.
 * Mirror of scripts/smoke-base-downstream.mjs. Testnet only. Requires FUNDER_PK.
 * Throws if no downstreamTxHash is produced.
 */
export async function runE2ELayer() {
  // Lazy import: viem is only needed for the opt-in E2E path.
  const { privateKeyToAccount, generatePrivateKey } = await import(
    'viem/accounts'
  );
  const {
    createWalletClient,
    createPublicClient,
    http,
    parseUnits,
    parseEther,
  } = await import('viem');
  const { baseSepolia, avalancheFuji } = await import('viem/chains');

  const A2A_BASE =
    process.env.A2A_BASE ?? 'https://wasiai-a2a-production.up.railway.app';
  const SPONSOR_PK = process.env.FUNDER_PK;
  const NETWORK = process.env.NETWORK ?? 'base-sepolia';
  const CHAIN_HEADER = NETWORK;
  const AMOUNT = process.env.AMOUNT ?? '0.05';
  const GAS_ETH = process.env.GAS_ETH ?? '0.0015';
  const OWNER_REF = process.env.OWNER_REF ?? `${NETWORK}-downstream-smoke`;
  const GOAL =
    process.env.GOAL ?? (NETWORK === 'avalanche-fuji' ? 'avalanche' : 'base');

  const CHAINS = {
    'base-sepolia': { viem: baseSepolia, rpc: 'https://sepolia.base.org' },
    'avalanche-fuji': {
      viem: avalancheFuji,
      rpc: 'https://api.avax-test.network/ext/bc/C/rpc',
    },
  };
  const CHAIN = CHAINS[NETWORK];
  if (!CHAIN) {
    throw new Error(
      `NETWORK not supported: ${NETWORK} (use base-sepolia | avalanche-fuji)`,
    );
  }
  const RPC = process.env.RPC_URL ?? CHAIN.rpc;

  const ERC20 = [
    {
      name: 'transfer',
      type: 'function',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      outputs: [{ type: 'bool' }],
    },
  ];

  async function api(path, { method = 'POST', key, body, chain } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['x-a2a-key'] = key;
    if (chain) headers['x-payment-chain'] = chain;
    const res = await fetchWithTimeout(`${A2A_BASE}${path}`, path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
    return json;
  }

  const DEPOSIT_RETRYABLE = new Set([
    'INSUFFICIENT_CONFIRMATIONS',
    'TX_NOT_FOUND',
    'RPC_UNAVAILABLE',
  ]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function depositWithRetry({ key, key_id, tx_hash, chain_id }) {
    const headers = { 'Content-Type': 'application/json', 'x-a2a-key': key };
    const payload = JSON.stringify({ key_id, tx_hash, chain_id });
    for (let i = 0; i <= 6; i++) {
      const res = await fetchWithTimeout(
        `${A2A_BASE}/auth/deposit`,
        '/auth/deposit',
        {
          method: 'POST',
          headers,
          body: payload,
        },
      );
      const json = await res.json().catch(() => ({}));
      if (res.ok) return json;
      const code = json?.error_code;
      if (code === 'DEPOSIT_ALREADY_CREDITED') return json;
      if (!DEPOSIT_RETRYABLE.has(code) || i === 6) {
        throw new Error(
          `/auth/deposit -> ${res.status} ${JSON.stringify(json)}`,
        );
      }
      progress(`deposit not confirmed (${code}); retry ${i + 1}/6 in 5s ...`);
      await sleep(5000);
    }
  }

  // ── provision ──────────────────────────────────────────────────────────
  const { networks } = await api('/auth/deposit-info', { method: 'GET' });
  const net = networks.find((n) => n.slug === NETWORK);
  if (!net?.treasury) throw new Error(`network ${NETWORK} has no treasury`);
  progress(
    `deposit-info: treasury=${net.treasury} token=${net.token.symbol} chain_id=${net.chain_id}`,
  );

  const normPk = (s) =>
    `0x${(s || '').replace(/[^0-9a-fA-F]/g, '').slice(-64)}`;
  const publicClient = createPublicClient({
    chain: CHAIN.viem,
    transport: http(RPC),
  });

  const sponsor = privateKeyToAccount(normPk(SPONSOR_PK));
  const sponsorWallet = createWalletClient({
    account: sponsor,
    chain: CHAIN.viem,
    transport: http(RPC),
  });
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = createWalletClient({
    account,
    chain: CHAIN.viem,
    transport: http(RPC),
  });
  progress(`sponsor=${sponsor.address} ephemeral=${account.address}`);

  let nonce = await publicClient.getTransactionCount({
    address: sponsor.address,
    blockTag: 'pending',
  });
  const gasTx = await sponsorWallet.sendTransaction({
    to: account.address,
    value: parseEther(GAS_ETH),
    nonce: nonce++,
  });
  const usdcTx = await sponsorWallet.writeContract({
    address: net.token.address,
    abi: ERC20,
    functionName: 'transfer',
    args: [account.address, parseUnits(AMOUNT, net.token.decimals)],
    nonce: nonce++,
  });
  await Promise.all([
    publicClient.waitForTransactionReceipt({ hash: gasTx }),
    publicClient.waitForTransactionReceipt({ hash: usdcTx }),
  ]);
  progress(
    `ephemeral funded (gas=${gasTx.slice(0, 12)}... usdc=${usdcTx.slice(0, 12)}...)`,
  );

  const { key, key_id } = await api('/auth/agent-signup', {
    body: { owner_ref: OWNER_REF, display_name: 'downstream x402 smoke' },
  });
  progress(`agent key: key_id=${key_id}`);

  const signature = await account.signMessage({
    message: `WASIAI_BIND_FUNDING_WALLET:${key_id}`,
  });
  await api('/auth/funding-wallet', {
    key,
    body: { wallet: account.address, signature },
  });
  progress('funding wallet bound');

  const amount = parseUnits(AMOUNT, net.token.decimals);
  const txHash = await wallet.writeContract({
    address: net.token.address,
    abi: ERC20,
    functionName: 'transfer',
    args: [net.treasury, amount],
  });
  progress(`${AMOUNT} ${net.token.symbol} -> treasury tx=${txHash}`);
  await publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: net.min_confirmations,
  });
  const dep = await depositWithRetry({
    key,
    key_id,
    tx_hash: txHash,
    chain_id: net.chain_id,
  });
  progress(`budget credited: ${JSON.stringify(dep)}`);

  // ── discover + compose ───────────────────────────────────────────────────
  const disc = await api('/discover', {
    key,
    chain: CHAIN_HEADER,
    body: { q: GOAL },
  });
  const agents = disc.agents ?? disc.results ?? [];
  const targetAgent =
    agents.find((a) => a.payment?.chain === NETWORK) ?? agents[0];
  if (!targetAgent) throw new Error(`no agents for q="${GOAL}"`);
  progress(
    `discover q="${GOAL}" -> ${targetAgent.slug} (registry=${targetAgent.registry_id})`,
  );

  progress(
    `compose ${targetAgent.slug} (debits budget + downstream payout via facilitator) ...`,
  );
  const composed = await api('/compose', {
    key,
    chain: CHAIN_HEADER,
    body: {
      steps: [
        {
          agent: targetAgent.slug,
          registry: targetAgent.registry_id,
          input: {},
        },
      ],
    },
  });

  const steps = composed.steps ?? [];
  const dtx = steps.map((s) => s.downstreamTxHash).filter(Boolean);
  if (dtx.length === 0) {
    throw new Error(
      `no downstreamTxHash in /compose response (payout did not fire). step txHashes=${JSON.stringify(steps.map((s) => s.txHash))}`,
    );
  }
  for (const h of dtx) {
    progress(`DOWNSTREAM SETTLED on ${NETWORK} via our facilitator. tx=${h}`);
  }
  return { network: NETWORK, downstreamTxHashes: dtx };
}

async function main() {
  // Layer 1 — always (network-only, no secrets).
  await runLightLayer();
  process.stderr.write('[smoke] light layer PASS\n');

  // AC-6 — informative, NON-blocking A2A /discover probe (never fails smoke).
  await probeA2ADiscover();

  // Layer 2 — opt-in E2E (CD-2 clean skip).
  const gate = e2eGate();
  if (!gate.run) {
    process.stdout.write(
      `SKIP: E2E layer skipped (${gate.reason}). Light layer passed.\n`,
    );
    process.exit(0);
  }

  process.stderr.write(
    '[smoke] running E2E layer (RUN_DOWNSTREAM_E2E=1, FUNDER_PK present) ...\n',
  );
  const result = await runE2ELayer();
  process.stdout.write(
    `PASS: E2E downstream settled on ${result.network} (${result.downstreamTxHashes.length} tx).\n`,
  );
  process.exit(0);
}

// Only auto-run when invoked directly (not when imported by the vitest wrapper).
const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`[smoke] FAIL: ${err?.message ?? String(err)}\n`);
    process.exit(1);
  });
}
