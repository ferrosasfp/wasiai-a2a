#!/usr/bin/env node
/**
 * HU-306 — ¿cuánto puede quedar VARADO, como máximo, en un solo pipeline?
 *
 * QUÉ ES UN PAGO VARADO. Cuando `/compose` falla en el step `i`, los steps anteriores ya
 * se ejecutaron y su pago ya se confirmó on-chain. Esa plata no vuelve: la tx está minada
 * y el destinatario es un tercero. Esto NO la recupera ni la reclama — la ACOTA, para que
 * el techo por pipeline y el umbral de alerta se elijan con un número medido y no con una
 * corazonada.
 *
 * LA FÓRMULA ES LA MISMA QUE LA DEL CÓDIGO, y a propósito (CD-6): `MAX_STRANDABLE_STEPS`
 * y `maxStrandedExposureUsd` se IMPORTAN de `src/lib/stranded-payment.ts`, no se copian.
 * Un reporte con su propia copia de la aritmética empieza a mentir el día que cambia el
 * límite de steps.
 *
 * ⚠️ QUÉ ACOTA Y QUÉ NO. El precio por agente NO tiene techo en el repo, así que lo que
 * sale de acá es una MEDICIÓN DEL CATÁLOGO DE HOY, no una garantía estructural: mañana
 * alguien publica un agente más caro y la cota sube sola. Por eso el número se re-mide
 * antes de tocar el techo, y no se anota en un documento como si fuera permanente.
 *
 * FREE — sólo lee `GET /discover` (público, sin pago, sin settle, sin gasto on-chain).
 *
 * SI NO ALCANZA EL GATEWAY, SALE CON EXIT ≠ 0 Y SIN NÚMERO. Un número inventado por
 * defecto en un reporte de exposición es peor que ningún número: se copia a una env y
 * queda un techo elegido sobre un dato que nunca se midió.
 *
 * Usage:
 *   node scripts/report-stranded-exposure.mjs [BASE_URL]
 *   A2A_URL=https://... node scripts/report-stranded-exposure.mjs
 */
const BASE =
  process.argv[2] ||
  process.env.A2A_URL ||
  'https://wasiai-a2a-production.up.railway.app';

const die = (msg, detail = '') => {
  console.error('\n╔══════════════════════════════════════════════════════╗');
  console.error(`║  FAIL: ${msg.padEnd(46)}║`);
  console.error('╚══════════════════════════════════════════════════════╝');
  if (detail) console.error(detail);
  console.error(
    '\nNO se imprime ninguna cota: un número por defecto en un reporte de exposición\n' +
      'termina copiado a una env como si se hubiera medido.\n' +
      `Revisá que el gateway responda: ${BASE}/discover\n`,
  );
  process.exit(1);
};

/**
 * La aritmética se IMPORTA del código compilado, nunca se copia acá (CD-6). Si `dist/`
 * no existe, esto FALLA con un mensaje accionable en vez de redeclarar la fórmula: dos
 * copias del mismo cálculo divergen el día que cambia el límite de steps, y la que
 * divergiría es justo la que se usa para elegir un techo de dinero.
 */
const loadFormula = async () => {
  try {
    return await import('../dist/lib/stranded-payment.js');
  } catch (err) {
    die(
      'falta el build (`dist/`)',
      `${String(err)}\n\nCorré \`npm run build\` y volvé a intentar: este reporte importa\n` +
        'la fórmula del código compilado en vez de tener su propia copia.',
    );
    return null;
  }
};

const main = async () => {
  console.log(`\n📏 Cota de exposición por pipeline varado — catálogo de ${BASE}\n`);

  const {
    MAX_STRANDABLE_STEPS,
    MAX_STRANDABLE_STEPS_ANY_PATH,
    maxStrandedExposureUsd,
    recommendedAlertThresholdUsd,
  } = await loadFormula();

  let res;
  try {
    res = await fetch(`${BASE}/discover`, {
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    die('no se pudo alcanzar el gateway', String(err));
    return;
  }
  if (!res.ok) die('GET /discover no devolvió 200', `HTTP ${res.status}`);

  let body = null;
  try {
    body = await res.json();
  } catch (err) {
    die('GET /discover no devolvió JSON', String(err));
  }
  const agents = Array.isArray(body?.agents) ? body.agents : null;
  if (!agents || agents.length === 0) {
    die('el catálogo vino vacío o sin `agents`');
    return;
  }

  const priced = agents
    .map((a) => ({ slug: a?.slug ?? '(sin slug)', price: Number(a?.priceUsdc) }))
    .filter((a) => Number.isFinite(a.price) && a.price >= 0);
  if (priced.length === 0) die('ningún agente del catálogo declara un precio legible');

  const top = priced.reduce((max, a) => (a.price > max.price ? a : max), priced[0]);
  // ⚠️ El PEOR CASO manda, y NO es el de `/compose` (fix-pack AR MENOR-1). El guard de
  // `MAX_COMPOSE_STEPS` vive sólo en `routes/compose.ts`; `/orchestrate` —el camino
  // insignia— acota por `maxAgents` (hasta 20) y llama a compose() directo. Reportar 4
  // acá subestimaba la exposición del camino que más importa casi cinco veces.
  // Redondeo SÓLO para mostrar: `19 * 0.1` en punto flotante imprime
  // `1.9000000000000001`, y un reporte de dinero con basura de coma flotante se lee como
  // un error de cálculo (o se copia con la basura incluida a una env).
  const usd = (n) => Number(n.toFixed(6));
  const cotaCompose = usd(maxStrandedExposureUsd(top.price));
  const cota = usd(MAX_STRANDABLE_STEPS_ANY_PATH * top.price);
  const umbral = usd(10 * cota);

  console.log(`  agentes con precio legible : ${priced.length} de ${agents.length}`);
  console.log(`  agente más caro            : ${top.slug} — ${top.price} USDC`);
  console.log(
    `  steps varables por camino  : /compose ${MAX_STRANDABLE_STEPS}  ·  /orchestrate ${MAX_STRANDABLE_STEPS_ANY_PATH}`,
  );
  console.log(`\n  cota por pipeline /compose : ${cotaCompose} USD`);
  console.log(`  COTA REAL (peor caso)      : ${cota} USD  ← la que vale`);
  console.log(
    `  umbral de alerta sugerido  : ${umbral} USD  (STRANDED_EXPOSURE_ALERT_THRESHOLD_USD)`,
  );
  if (usd(recommendedAlertThresholdUsd(top.price)) !== umbral) {
    console.log(
      `  (el umbral de 10 × cota de /compose sería ${usd(recommendedAlertThresholdUsd(top.price))} USD:\n` +
        '   se descarta porque dejaría el camino /orchestrate por debajo del radar)',
    );
  }
  console.log(
    '\n  El step que FALLA no entra en la cota: si SU settle quedó sin resolver, eso es\n' +
      '  la otra lista (`compose_settle_unknown`) y se cuenta allá.\n',
  );
  console.log(
    '  ⚠️  Los dos caminos NO tienen el mismo tope: el guard de MAX_COMPOSE_STEPS está\n' +
      '      sólo en la ruta /compose. /orchestrate acota por maxAgents (hasta 20) y llama\n' +
      '      a compose() directo, así que ahí la cota es la grande.\n',
  );
  console.log(
    '  ⚠️  Esto es una medición de HOY. El precio por agente no tiene techo en el repo:\n' +
      '      un agente más caro publicado mañana sube la cota sin que nadie la re-mida.\n',
  );
};

main().catch((err) => {
  die('error inesperado', String(err));
});
