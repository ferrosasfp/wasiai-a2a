/**
 * @file check-catalog-vs-live.test.mjs
 * @description Suite del vigilante del catálogo (WKH-370). **CERO RED, CERO GASTO.**
 *
 * Las funciones puras se importan; `main()` corre con un `fetch` DOBLADO que enruta
 * por URL y REGISTRA cada llamada —el registro es la mitad que importa: la escalera
 * podía decir que todo anda sin haber preguntado nada, y eso no se ve mirando sólo
 * el exit code—; y las afirmaciones de cableado corren sobre los archivos REALES
 * del repo. Ningún test de este archivo abre un socket.
 *
 * ⚠️ Los fixtures literales salen de una medición contra producción del
 * **2026-08-27**: veintinueve agentes = veinticuatro federados + cinco
 * self-published, `inputSchema` en la raíz de `/discover` = CERO y bajo `metadata`
 * = cinco, y las cinco huellas de `inputSchema` reproducidas a mano. Llevan la
 * fecha porque el número se mueve: el universo se DERIVA en cada corrida, y lo
 * único hardcodeado vive acá, en la suite.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLASES,
  canonicalJson,
  classify,
  compararAgente,
  derivarUniverso,
  deriveManifestUrl,
  evaluarCompletitud,
  isRetryable,
  main,
  MODOS,
  readCredential,
  readMode,
  schemaFingerprint,
  SELF_PUBLISHED,
} from '../scripts/check-catalog-vs-live.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SCRIPT_PATH = resolve(HERE, '../scripts/check-catalog-vs-live.mjs');
const SCRIPT_SRC = readFileSync(SCRIPT_PATH, 'utf8');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/check-catalog-vs-live.yml');
const WORKFLOW = readFileSync(WORKFLOW_PATH, 'utf8');

/** Las líneas que son ÍNTEGRAMENTE comentario del YAML: prosa, no cableado. */
const sinComentarios = (yaml) =>
  yaml
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

/**
 * Lo mismo para JS, y por el MISMO motivo medido en la sonda del camino del dinero:
 * un guardián que escanea la explicación del archivo se denuncia a sí mismo por su
 * propia prosa, y el precio concreto es que el script no puede documentar sus
 * decisiones. Se filtran sólo las líneas cuyo texto ARRANCA con `//`, `*` o `/*` —
 * nunca a mitad de línea, que podría hacer DESAPARECER código real.
 */
const sinComentariosJs = (src) =>
  src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

/** El CÓDIGO del script, sin su prosa. Es sobre esto que corren T-S1..T-S3. */
const SCRIPT_CODE = sinComentariosJs(SCRIPT_SRC);

// ── Fixtures literales, medidos contra producción el 2026-08-27 ───────────────

/**
 * El `inputSchema` REAL de `remit-corridor-fx-solana`, huella `8d8bb152ab46`.
 * ⛔ NO se reemplaza por `{}`: un fixture vacío haría pasar tanto al comparador
 * correcto COMO a uno que no compara nada. T-D3 es el candado de eso.
 */
const SCHEMA_REAL = {
  type: 'object',
  required: ['amountUsd'],
  properties: {
    amountUsd: {
      type: 'number',
      description:
        'Monto a enviar. Ademas del schema hay un piso y un techo de corredor: fuera de rango la cotizacion se rechaza.',
      exclusiveMinimum: 0,
    },
    destCountry: {
      enum: ['PE'],
      type: 'string',
      description:
        'Opcional y de un solo valor. Este agente cotiza SOLO el corredor hacia Peru; cualquier otro pais se rechaza con 400. Si se omite, cotiza PE.',
    },
    destCurrency: {
      type: 'string',
      const: 'PEN',
      description: 'Opcional y de un solo valor. Si se omite, el agente cotiza PEN.',
    },
    payoutMethod: {
      enum: ['yape', 'plin', 'bank_cci'],
      type: 'string',
      description: 'Opcional. Si se omite, el agente cotiza yape.',
    },
  },
};

const SLUG = 'remit-corridor-fx-solana';
/** ⚠️ El path NO es el slug — medido, es falso en dos de cinco. */
const INVOKE_URL = 'https://agentes.example/api/agents/remit-corridor-fx/invoke';
const MANIFEST_URL = 'https://agentes.example/api/agents/remit-corridor-fx/manifest';
const DISCOVER_URL = 'https://wasiai-a2a-production.up.railway.app/discover';
const AGENTS_URL = 'https://wasiai-a2a-production.up.railway.app/agents';

const CAPS = ['remittance-fx-quote', 'usdc-to-pen', 'corridor-pricing'];
/** El bloque tal como está PERSISTIDO en `metadata.payment`: cuatro keys. */
const PAGO_PERSISTIDO = { asset: 'USDC', chain: 'solana-devnet', method: 'x402', contract: 'MINT-DE-MENTIRA' };
/** El de la RAÍZ de `/discover`, DERIVADO: seis keys. Comparar éste fabrica deriva. */
const PAGO_DERIVADO = { ...PAGO_PERSISTIDO, network: 'solana:devnet', resolvedChain: 'solana-devnet' };

const fila = (over = {}) => ({
  slug: SLUG,
  name: SLUG,
  registry: SELF_PUBLISHED,
  invokeUrl: INVOKE_URL,
  capabilities: [...CAPS],
  priceUsdc: 0.03,
  payment: PAGO_DERIVADO,
  metadata: { inputSchema: SCHEMA_REAL, payment: PAGO_PERSISTIDO, outputSchema: { properties: { rate: {} } } },
  ...over,
});

const manifiesto = (over = {}) => ({
  slug: SLUG,
  name: SLUG,
  manifestVersion: '1',
  description: 'Cotiza el corredor',
  capabilities: [...CAPS],
  priceUsdc: 0.03,
  inputSchema: SCHEMA_REAL,
  payment: PAGO_PERSISTIDO,
  ...over,
});

/** Los veinticuatro federados de la medición: mismo número, motivo uno por uno. */
const federados = () =>
  Array.from({ length: 24 }, (_, i) => ({
    slug: `federado-${i}`,
    registry: 'wasiai-marketplace',
    invokeUrl: `https://otro.example/${i}/invoke`,
  }));

const registro = (over = {}) => ({ slug: SLUG, hasPayoutWallet: true, ...over });

const obsBase = (over = {}) => ({
  modo: 'deriva',
  agentes: 29,
  elegibles: 5,
  credencialPresente: false,
  conSchemaEnMetadata: 5,
  comparados: 5,
  derivas: 0,
  incompletas: 0,
  unresolved: 0,
  inalcanzables: 0,
  sinDato: 0,
  ...over,
});

/**
 * Corre `main` con un `fetch` doblado que enruta por URL. Una URL no doblada
 * contesta 599 (y NO un error de conexión, que dispararía el reintento y haría
 * dormir a la suite dos segundos). Devuelve además la SALIDA emitida, que es lo
 * único que permite el control positivo de que el chequeo ejecutó.
 */
const correr = async (rutas, env = {}) => {
  const llamadas = [];
  const cabeceras = [];
  const original = globalThis.fetch;
  const salida = [];
  globalThis.fetch = async (url, init) => {
    llamadas.push(`${init?.method ?? 'GET'} ${url}`);
    cabeceras.push(init?.headers ?? {});
    const r = rutas[String(url)];
    if (!r) return { status: 599, json: async () => null };
    return { status: r.status, json: async () => r.body };
  };
  try {
    const exit = await main({ CHECK_MODE: 'deriva', ...env }, (s) => salida.push(s));
    return { exit, llamadas, cabeceras, salida: salida.join('') };
  } finally {
    globalThis.fetch = original;
  }
};

const catalogo = (filas) => ({ agents: [...federados(), ...filas], total: 24 + filas.length });

// ── AC-1 · deriva ─────────────────────────────────────────────────────────────

describe('WKH-370 · deriva: catálogo vs manifiesto vivo (AC-1)', () => {
  it('T-D1: huellas distintas en inputSchema → DERIVA(4) con slug, campo y LAS DOS huellas', async () => {
    const otro = { ...SCHEMA_REAL, required: ['amountUsd', 'destCountry'] };
    const r = await correr({
      [DISCOVER_URL]: { status: 200, body: catalogo([fila()]) },
      [MANIFEST_URL]: { status: 200, body: manifiesto({ inputSchema: otro }) },
    });
    expect(r.exit).toBe(CLASES.DERIVA);
    expect(r.salida).toContain(`HALLAZGO: ${SLUG} tipo=deriva campo=inputSchema`);
    // Las DOS huellas, y DISTINTAS: un comparador que devolviera la del catálogo en
    // las dos daría CONFORME(0) falso, y sin esta aserción no se vería.
    expect(r.salida).toContain(`catalogo=${schemaFingerprint(SCHEMA_REAL)}`);
    expect(r.salida).toContain(`manifiesto=${schemaFingerprint(otro)}`);
    expect(schemaFingerprint(SCHEMA_REAL)).not.toBe(schemaFingerprint(otro));
  });

  it('T-D2: los CINCO campos comparables producen deriva cada uno POR SEPARADO', () => {
    const casos = [
      ['inputSchema', manifiesto({ inputSchema: { type: 'object' } })],
      ['payment', manifiesto({ payment: { ...PAGO_PERSISTIDO, chain: 'otra' } })],
      ['capabilities', manifiesto({ capabilities: ['remittance-fx-quote'] })],
      ['priceUsdc', manifiesto({ priceUsdc: 0.04 })],
      ['name', manifiesto({ name: 'otro-nombre' })],
    ];
    for (const [campo, m] of casos) {
      const difs = compararAgente(fila(), m);
      expect(difs.map((d) => d.campo)).toEqual([campo]);
      expect(difs[0].catalogo).not.toBe(difs[0].manifiesto);
    }
    // Y el control positivo: sin mutar nada, los cinco campos coinciden.
    expect(compararAgente(fila(), manifiesto())).toEqual([]);
  });

  it('T-D3 (CD-21): el fixture positivo tiene contenido REAL — un comparador vacío no lo satisface', () => {
    // La huella es la medida contra producción el 2026-08-27. Si alguien vacía el
    // fixture "para simplificar", esta línea se pone roja antes que nada más.
    expect(schemaFingerprint(SCHEMA_REAL)).toBe('8d8bb152ab46');
    expect(Object.keys(SCHEMA_REAL.properties)).toHaveLength(4);
    // Y el schema vacío NO tiene la misma huella: comparar `{}` contra `{}` sería un
    // comparador que no compara nada y que aun así daría verde.
    expect(schemaFingerprint({})).not.toBe(schemaFingerprint(SCHEMA_REAL));
  });

  it('T-Z2 (CD-12): se compara metadata.payment y NUNCA el payment DERIVADO de la raíz', async () => {
    // El de la raíz trae `network` y `resolvedChain`, que el manifiesto no tiene:
    // compararlo fabricaría deriva en los cinco agentes, todos los días.
    expect(Object.keys(PAGO_DERIVADO)).toHaveLength(6);
    expect(Object.keys(PAGO_PERSISTIDO)).toHaveLength(4);
    const r = await correr({
      [DISCOVER_URL]: { status: 200, body: catalogo([fila()]) },
      [MANIFEST_URL]: { status: 200, body: manifiesto() },
    });
    expect(r.exit).toBe(CLASES.CONFORME);
    expect(r.salida).not.toContain('campo=payment');
    expect(SCRIPT_CODE).toContain('meta.payment');
  });
});

// ── AC-6 · la unión se verifica ───────────────────────────────────────────────

describe('WKH-370 · la unión catálogo↔manifiesto se VERIFICA (AC-6)', () => {
  it('T-J1: manifest.slug distinto → UNRESOLVED(6), y NO se compara ni un schema', async () => {
    const r = await correr({
      [DISCOVER_URL]: { status: 200, body: catalogo([fila()]) },
      // Manifiesto de OTRO agente, con un inputSchema distinto: si se comparara,
      // saldría deriva. Salir UNRESOLVED es lo que evita acusar al agente equivocado.
      [MANIFEST_URL]: { status: 200, body: manifiesto({ slug: 'otro-agente', inputSchema: { type: 'string' } }) },
    });
    expect(r.exit).toBe(CLASES.UNRESOLVED);
    expect(r.salida).toContain('tipo=unresolved');
    expect(r.salida).not.toContain('tipo=deriva');
    expect(r.salida).toContain('comparados=0');
  });

  it('T-J2: el pathSlug NO es el slug, y un invokeUrl sin el sufijo NO se adivina', async () => {
    // Los dos casos REALES medidos: el path dice `remit-corridor-fx` y el slug es
    // `remit-corridor-fx-solana`. La clave sale del invokeUrl y el manifiesto se
    // autodeclara: asumir `slug == pathSlug` produciría un 404 leído como deriva.
    expect(deriveManifestUrl(INVOKE_URL)).toEqual({ ok: true, url: MANIFEST_URL });
    expect(deriveManifestUrl('https://agentes.example/api/agents/remit-cashout-payout/invoke').url)
      .toBe('https://agentes.example/api/agents/remit-cashout-payout/manifest');
    // Y lo que NO termina en el sufijo no se adivina: se declara no resuelto.
    const raro = deriveManifestUrl('https://agentes.example/api/agents/remit-corridor-fx');
    expect(raro.ok).toBe(false);
    expect(raro.motivo).toContain('/invoke');
    const r = await correr({
      [DISCOVER_URL]: { status: 200, body: catalogo([fila({ invokeUrl: 'https://agentes.example/x' })]) },
    });
    expect(r.exit).toBe(CLASES.UNRESOLVED);
    // ⛔ y no salió a pedir NINGUNA URL adivinada: sólo el listado.
    expect(r.llamadas).toHaveLength(1);
  });
});

// ── AC-2 / AC-3 · completitud, y LA TESIS ─────────────────────────────────────

describe('WKH-370 · completitud: la fila mal nacida (AC-2, AC-3)', () => {
  const conCatalogo = (registros) => ({
    [DISCOVER_URL]: { status: 200, body: catalogo([fila()]) },
    [MANIFEST_URL]: { status: 200, body: manifiesto() },
    [AGENTS_URL]: { status: 200, body: { agents: registros, total: registros.length } },
  });
  const envCompletitud = { CHECK_MODE: 'completitud', A2A_CATALOG_OWNER_KEY: 'credencial-de-mentira' };

  it('T-C1 (AC-2): las dos mitades son INDEPENDIENTES — el mismo agente, dos veredictos', async () => {
    const rutas = conCatalogo([registro({ hasPayoutWallet: false })]);
    // Mitad deriva: el agente coincide con su manifiesto en los cinco campos.
    const d = await correr(rutas, { CHECK_MODE: 'deriva' });
    expect(d.exit).toBe(CLASES.CONFORME);
    expect(d.salida).toContain('derivas=0');
    // Mitad completitud, MISMO agente, MISMO fixture: mal nacido.
    const c = await correr(rutas, envCompletitud);
    expect(c.exit).toBe(CLASES.INCOMPLETA);
    // Ninguna de las dos consultó nada de la otra: no hay `needs:` escondido en el
    // código. ⚠️ Se compara la URL ENTERA y no un fragmento: el manifiesto vive bajo
    // un path que contiene la palabra `agents`, así que un `includes` suelto daba
    // este test por roto en la mitad de deriva, que no consultó el listado propio.
    expect(d.llamadas).not.toContain(`GET ${AGENTS_URL}`);
    expect(c.llamadas).not.toContain(`GET ${MANIFEST_URL}`);
  });

  it('T-C2 (LA TESIS): payout ausente y deriva CERO → INCOMPLETA(5), ⛔ jamás CONFORME(0)', async () => {
    const c = await correr(conCatalogo([registro({ hasPayoutWallet: false })]), envCompletitud);
    expect(c.exit).toBe(CLASES.INCOMPLETA);
    expect(c.exit).not.toBe(CLASES.CONFORME);
    expect(c.salida).toContain('tipo=incompleta faltantes=[payoutWallet]');
    expect(c.salida).toContain('derivas=0');
    // Y en la escalera pura: la fila de incompletas va ANTES que la de deriva y que
    // la buena. Moverla debajo de la última hace que esto salga CONFORME — ése es el
    // mutante, y ésta es la aserción que lo mata.
    expect(classify(obsBase({ incompletas: 1, derivas: 0 })).klass).toBe('INCOMPLETA');
    expect(classify(obsBase({ incompletas: 1, derivas: 3 })).klass).toBe('INCOMPLETA');
  });

  it('T-C3: metadata vacío (sin inputSchema) → INCOMPLETA aunque no haya nada que comparar', () => {
    const r = evaluarCompletitud(fila({ metadata: {} }), registro());
    expect(r.estado).toBe('incompleta');
    expect(r.faltantes).toContain('metadata.inputSchema');
    expect(classify(obsBase({ modo: 'completitud', credencialPresente: true, incompletas: 1 })).exit)
      .toBe(CLASES.INCOMPLETA);
  });

  it('T-C4 (CD-17): ownerRef en blanco → INCOMPLETA, y el límite se declara en voz alta', () => {
    expect(evaluarCompletitud(fila(), registro({ ownerRef: '   ' })).faltantes).toEqual(['ownerRef']);
    expect(evaluarCompletitud(fila(), registro({ ownerRef: 'owner-1' })).estado).toBe('completa');
    // La comprobación es CASI VACUA por DOS razones, y las dos están escritas en el
    // docblock en vez de disfrazadas de protección: la columna es NOT NULL por tipo
    // —así que un nulo es inconstruible— y el registro publicado no trae el campo,
    // así que en la corrida real esta rama no se evalúa nunca.
    const doc = SCRIPT_SRC.slice(0, SCRIPT_SRC.indexOf('export function evaluarCompletitud'));
    expect(doc).toContain('CASI VACUA');
    expect(doc).toContain('NOT NULL');
    // Ausencia del campo NO es incompletitud: si lo fuera, TODA fila real saldría
    // roja el día uno, que es el falso rojo que este chequeo existe para no producir.
    expect(evaluarCompletitud(fila(), registro()).estado).toBe('completa');
  });

  it('T-C5 (D-1): sin outputSchema en catálogo NI en manifiesto → CONFORME(0), y se CUENTA', async () => {
    const sinOutput = fila({ metadata: { inputSchema: SCHEMA_REAL, payment: PAGO_PERSISTIDO } });
    const r = await correr({
      [DISCOVER_URL]: { status: 200, body: catalogo([sinOutput]) },
      [MANIFEST_URL]: { status: 200, body: manifiesto() },
    });
    // ⛔ `outputSchema` NO entra a la escalera: exigir un campo sin fuente de verdad
    // haría nacer el chequeo en rojo, y un control que nace rojo se aprende a ignorar.
    expect(r.exit).toBe(CLASES.CONFORME);
    // Pero se cuenta y se reporta: la deuda se hace VISIBLE, no se tapa.
    expect(r.salida).toContain('outputSchemaPresente=0/1');
    const conOutput = await correr({
      [DISCOVER_URL]: { status: 200, body: catalogo([fila()]) },
      [MANIFEST_URL]: { status: 200, body: manifiesto() },
    });
    expect(conOutput.salida).toContain('outputSchemaPresente=1/1');
    expect(conOutput.exit).toBe(CLASES.CONFORME);
    // Y la deuda está declarada en el código, no en un backlog aparte.
    expect(SCRIPT_SRC).toContain('TD-370-OUTPUTSCHEMA-SIN-FUENTE');
  });
});

// ── AC-4 · anti-vacuidad, y su control positivo ───────────────────────────────

describe('WKH-370 · un chequeo que no ejecutó nada no afirma nada (AC-4)', () => {
  it('T-V1: comparados === 0 con todo lo demás en orden → CONFIG(3), ⛔ nunca 0', () => {
    const v = classify(obsBase({ comparados: 0 }));
    expect(v.exit).toBe(CLASES.CONFIG);
    expect(v.exit).not.toBe(CLASES.CONFORME);
    expect(v.message).toContain('sin haber comparado');
  });

  it('T-V2: CONTROL POSITIVO — en el caso feliz la línea emitida lleva comparados > 0', async () => {
    // Sin este control, un rojo no prueba que el chequeo haya CORRIDO: un chequeo
    // que sólo verifica una ausencia pasa igual cuando no ejecutó nada.
    const r = await correr({
      [DISCOVER_URL]: { status: 200, body: catalogo([fila()]) },
      [MANIFEST_URL]: { status: 200, body: manifiesto() },
    });
    expect(r.exit).toBe(CLASES.CONFORME);
    const linea = r.salida.trim().split('\n').at(-1);
    expect(linea).toMatch(/^CONFORME: /);
    const comparados = Number(linea.match(/ comparados=(\d+)/)[1]);
    expect(comparados).toBeGreaterThan(0);
    // Y efectivamente salió a preguntarle al manifiesto: dos llamadas, no una.
    expect(r.llamadas).toHaveLength(2);
    expect(r.llamadas[1]).toBe(`GET ${MANIFEST_URL}`);
  });
});

// ── AC-5 · el universo se deriva, y nadie sale en silencio ────────────────────

describe('WKH-370 · el universo se DERIVA y las exclusiones se declaran (AC-5)', () => {
  it('T-U1: los 24 federados salen en EXCLUIDOS con motivo NO vacío, uno por uno', async () => {
    const r = await correr({
      [DISCOVER_URL]: { status: 200, body: catalogo([fila()]) },
      [MANIFEST_URL]: { status: 200, body: manifiesto() },
    });
    const { elegibles, excluidos } = derivarUniverso(catalogo([fila()]).agents);
    expect(elegibles).toHaveLength(1);
    expect(excluidos).toHaveLength(24);
    for (const e of excluidos) {
      expect(e.slug).toBeTruthy();
      expect(e.motivo.trim().length).toBeGreaterThan(0);
    }
    // Y viajan a la salida, uno por uno: filtrar sin registrar sería exclusión silenciosa.
    expect(r.salida).toContain('EXCLUIDOS: ');
    for (const e of excluidos) expect(r.salida).toContain(`${e.slug}=${e.motivo}`);
    expect(r.salida).toContain('excluidos=24');
    // ⛔ El número NO está en el fuente: se deriva. Lo único hardcodeado vive acá.
    expect(SCRIPT_CODE).not.toMatch(/\b(29|24)\b/);
  });

  it('T-U2 (CD-3): sin elegibles → CONFIG(3), ⛔ nunca la clase buena', async () => {
    expect(classify(obsBase({ elegibles: 0 })).exit).toBe(CLASES.CONFIG);
    const r = await correr({ [DISCOVER_URL]: { status: 200, body: catalogo([]) } });
    expect(r.exit).toBe(CLASES.CONFIG);
    expect(r.exit).not.toBe(CLASES.CONFORME);
    expect(r.salida).toContain('ningún agente elegible');
  });
});

// ── AC-7 · el cero uniforme acusa al instrumento ──────────────────────────────

describe('WKH-370 · un cero UNIFORME acusa al instrumento (AC-7)', () => {
  it('T-Z1: los 5 publican inputSchema en la RAÍZ y nada en metadata → CONFIG(3), NO "5 derivas"', async () => {
    // La trampa medida: `inputSchema` vive en `metadata` en `/discover` y en la RAÍZ
    // en el manifiesto. Un barrido a la raíz devuelve "cero de veintinueve publican
    // schema", que es FALSO — y leerlo como deriva acusaría a los cinco agentes de
    // un defecto del instrumento.
    const enLaRaiz = Array.from({ length: 5 }, (_, i) =>
      fila({ slug: `${SLUG}-${i}`, inputSchema: SCHEMA_REAL, metadata: { payment: PAGO_PERSISTIDO } }),
    );
    const r = await correr({ [DISCOVER_URL]: { status: 200, body: catalogo(enLaRaiz) } });
    expect(r.exit).toBe(CLASES.CONFIG);
    expect(r.exit).not.toBe(CLASES.DERIVA);
    expect(r.salida).toContain('cero uniforme');
    expect(r.salida).toContain('derivas=0');
    // Y ni siquiera salió a molestar a los cinco servicios: cortó en el instrumento.
    expect(r.llamadas).toHaveLength(1);
  });
});

// ── AC-8 · las clases, la escalera y sus bordes ───────────────────────────────

describe('WKH-370 · siete clases, siete códigos, y un default que no es el bueno (AC-8)', () => {
  it('T-E1: los códigos son los SIETE distintos y ningún mensaje usa la palabra de otra clase', () => {
    const codigos = Object.values(CLASES);
    expect(new Set(codigos).size).toBe(codigos.length);
    expect(codigos).toHaveLength(7);
    expect(CLASES.CONFORME).toBe(0);
    const nombres = Object.keys(CLASES);
    const mensajes = [
      classify({}),
      classify(obsBase({ modo: null })),
      classify(obsBase({ agentes: 0 })),
      classify(obsBase({ elegibles: 0 })),
      classify(obsBase({ modo: 'completitud' })),
      classify(obsBase({ conSchemaEnMetadata: 0 })),
      classify(obsBase({ modo: 'completitud', credencialPresente: true, sinDato: 5 })),
      classify(obsBase({ comparados: 0 })),
      classify(obsBase({ inalcanzables: 1 })),
      classify(obsBase({ unresolved: 1 })),
      classify(obsBase({ incompletas: 1 })),
      classify(obsBase({ derivas: 1 })),
      classify(obsBase({ modo: 'completitud', credencialPresente: true, sinDato: 1 })),
      classify(obsBase()),
      classify({ modo: 'deriva', agentes: 1, elegibles: 1, conSchemaEnMetadata: 1, comparados: -1, derivas: 0, incompletas: 0, unresolved: 0, inalcanzables: 0, sinDato: 0 }),
    ];
    for (const v of mensajes) {
      expect(v.exit).toBe(CLASES[v.klass]);
      expect(v.message.startsWith(`${v.klass}: `)).toBe(true);
      // El resto del mensaje no puede nombrar a OTRA clase: si lo hiciera, el texto
      // dejaría de atribuir tan claro como el exit code.
      const cuerpo = v.message.slice(v.klass.length + 2);
      for (const otra of nombres) if (otra !== v.klass) expect(cuerpo).not.toContain(otra);
    }
  });

  it('T-E2: CHECK_MODE ausente o basura → CONFIG(3), y el default NUNCA corre "algo"', async () => {
    expect(readMode({})).toBeNull();
    expect(readMode({ CHECK_MODE: 'DeRiVa' })).toBeNull();
    expect(readMode({ CHECK_MODE: 'completud' })).toBeNull();
    expect(readMode({ CHECK_MODE: 'deriva' })).toBe('deriva');
    expect(MODOS).toEqual(['deriva', 'completitud']);
    for (const env of [{ CHECK_MODE: '' }, { CHECK_MODE: 'basura' }]) {
      const r = await correr({ [DISCOVER_URL]: { status: 200, body: catalogo([fila()]) } }, env);
      expect(r.exit).toBe(CLASES.CONFIG);
      expect(r.salida).toContain('CHECK_MODE');
      // ⛔ Un typo no puede medir otra cosa en silencio: no salió a pedir NADA.
      expect(r.llamadas).toHaveLength(0);
    }
  });

  it('T-E3: el DEFAULT de la escalera no es la clase buena', () => {
    // `comparados` negativo es inalcanzable por construcción: es justamente el estado
    // que nadie previó, y por eso sirve para ejercitar la última fila.
    const v = classify({ modo: 'deriva', agentes: 1, elegibles: 1, conSchemaEnMetadata: 1, comparados: -1, derivas: 0, incompletas: 0, unresolved: 0, inalcanzables: 0, sinDato: 0 });
    expect(v.klass).not.toBe('CONFORME');
    expect(v.exit).not.toBe(0);
    expect(v.exit).toBe(CLASES.INALCANZABLE);
    expect(v.message).toContain('por omisión jamás se declara sano');
  });

  it('T-E4 (CD-15): sin credencial → CONFIG nombrándola; y un sinDato parcial → CONFIG, nunca 0', async () => {
    const r = await correr({ [DISCOVER_URL]: { status: 200, body: catalogo([fila()]) } }, { CHECK_MODE: 'completitud' });
    expect(r.exit).toBe(CLASES.CONFIG);
    expect(r.salida).toContain('A2A_CATALOG_OWNER_KEY');
    expect(readCredential({}).run).toBe(false);
    expect(readCredential({ A2A_CATALOG_OWNER_KEY: '   ' }).run).toBe(false);
    expect(readCredential({ A2A_CATALOG_OWNER_KEY: 'x' }).run).toBe(true);
    // Parcial: se midieron algunos y otros no. Lo NO medido no se declara sano.
    const parcial = classify(obsBase({ modo: 'completitud', credencialPresente: true, comparados: 4, sinDato: 1 }));
    expect(parcial.exit).toBe(CLASES.CONFIG);
    expect(parcial.exit).not.toBe(CLASES.CONFORME);
    // Y el "no pude preguntar por NINGUNO" es su propia fila, antes que la anterior.
    expect(classify(obsBase({ modo: 'completitud', credencialPresente: true, comparados: 0, sinDato: 5 })).exit)
      .toBe(CLASES.CONFIG);
  });

  it('T-E4b: un remoto que no contesta es INALCANZABLE(2) y NO acusa al catálogo', async () => {
    const caido = await correr({ [DISCOVER_URL]: { status: 503, body: null } });
    expect(caido.exit).toBe(CLASES.INALCANZABLE);
    expect(caido.salida).toContain('NO dice que el catálogo esté mal');
    // Un manifiesto que no contesta es del mismo color, y por agente.
    const manifiestoCaido = await correr({
      [DISCOVER_URL]: { status: 200, body: catalogo([fila()]) },
      [MANIFEST_URL]: { status: 500, body: null },
    });
    expect(manifiestoCaido.exit).toBe(CLASES.INALCANZABLE);
    expect(manifiestoCaido.salida).toContain('tipo=inalcanzable');
    // Y sólo el timeout de una lectura idempotente se reintenta.
    expect(isRetryable({ name: 'AbortError' }, true)).toBe(true);
    expect(isRetryable({ name: 'AbortError' }, false)).toBe(false);
    expect(isRetryable({ cause: { code: 'ECONNRESET' } }, false)).toBe(true);
    expect(isRetryable({ cause: { code: 'EPIPE' } }, false)).toBe(false);
  });

  it('T-E4c: canonicalJson ordena las keys, así que la huella no depende del orden', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(schemaFingerprint({ b: 1, a: 2 })).toBe(schemaFingerprint({ a: 2, b: 1 }));
    expect(schemaFingerprint([1, 2])).not.toBe(schemaFingerprint([2, 1]));
  });
});

// ── AC-9 · el workflow, sobre el YAML REAL ────────────────────────────────────

describe('WKH-370 · el workflow: dos mitades que no se apagan entre sí (AC-9)', () => {
  const CODIGO = sinComentarios(WORKFLOW);

  it('T-Y1: hay DOS jobs y NINGÚN `needs:` entre ellos', () => {
    // Se recorta desde `jobs:` a propósito: las claves de `on:` viven en la misma
    // indentación de dos espacios, y contarlas como jobs haría pasar este test por
    // el motivo equivocado.
    const bloque = CODIGO.slice(CODIGO.indexOf('\njobs:\n'));
    const jobs = [...bloque.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((m) => m[1]);
    expect(jobs).toEqual(['deriva', 'completitud']);
    // Un `needs:` haría que un fallo de una mitad APAGUE la otra, y la tesis entera
    // es que son preguntas independientes.
    expect(CODIGO).not.toContain('needs:');
  });

  it('T-Y2: cada job tiene su par abrir/cerrar con el MISMO título dentro del par', () => {
    const titulos = [...CODIGO.matchAll(/^\s+TITULO: '(.+)'$/gm)].map((m) => m[1]);
    expect(titulos).toHaveLength(4);
    expect(titulos[0]).toBe(titulos[1]);
    expect(titulos[2]).toBe(titulos[3]);
    // Distintos entre pares, o el verde de una mitad cierra el aviso de la otra.
    expect(titulos[0]).not.toBe(titulos[2]);
  });

  it('T-Y3: ningún `if:` de un job depende del otro job', () => {
    const ifs = [...CODIGO.matchAll(/^\s+if: (.+)$/gm)].map((m) => m[1]);
    expect(ifs.length).toBeGreaterThan(0);
    for (const cond of ifs) {
      expect(cond).not.toMatch(/needs\.|jobs\./);
      expect(cond).not.toMatch(/\bderiva\b|\bcompletitud\b/);
    }
  });

  it('T-Y4 (CD-6): los CUATRO títulos del repo son los CUATRO distintos', () => {
    const leer = (p) => readFileSync(resolve(REPO_ROOT, p), 'utf8');
    const deEste = [...new Set([...CODIGO.matchAll(/^\s+TITULO: '(.+)'$/gm)].map((m) => m[1]))];
    const sacar = (src) => [...new Set([...src.matchAll(/^\s+TITULO: '(.+)'$/gm)].map((m) => m[1]))];
    const otros = [
      ...sacar(leer('.github/workflows/probe-money-path.yml')),
      ...sacar(leer('.github/workflows/smoke-downstream.yml')),
    ];
    const todos = [...deEste, ...otros];
    expect(todos).toHaveLength(4);
    expect(new Set(todos).size).toBe(4);
  });

  it('T-Y5 (DT-3 mit.1): la credencial aparece EXACTAMENTE una vez, en el job completitud', () => {
    const lineas = CODIGO.split('\n');
    const idx = lineas.reduce((acc, l, i) => (l.includes('A2A_CATALOG_OWNER_KEY') ? [...acc, i] : acc), []);
    expect(idx).toHaveLength(1);
    // Y esa línea vive DESPUÉS del arranque del job `completitud`: filtrarla al job
    // público haría viajar la credencial a una corrida que no la necesita.
    const arranqueCompletitud = lineas.findIndex((l) => /^ {2}completitud:$/.test(l));
    expect(arranqueCompletitud).toBeGreaterThan(-1);
    expect(idx[0]).toBeGreaterThan(arranqueCompletitud);
  });

  it('T-Y6 (DT-3 mit.2): el job completitud NO corre en pull_request', () => {
    // GitHub le niega el secret a los PRs desde un FORK y se lo entrega ENTERO a un
    // PR de una rama de este mismo repo. Sin este `if:`, la credencial —que tiene
    // poder de borrado, porque no existe una agent key de sólo lectura— llega a cada
    // push de cada PR.
    expect(CODIGO).toContain("if: github.event_name != 'pull_request'");
    expect(CODIGO).toContain("continue-on-error: ${{ github.event_name == 'pull_request' }}");
    // La deuda de la key sin sólo-lectura está escrita en el YAML, no en un backlog.
    expect(WORKFLOW).toContain('TD-370-KEY-SOLO-LECTURA');
    // Cadencia diaria, minuto NO redondo, y distinta de las dos que ya existen.
    expect(CODIGO).toContain("- cron: '23 6 * * *'");
    // El aviso pega la LÍNEA de clase por `env:`, nunca interpolada dentro del `run:`.
    expect(CODIGO).toContain('LINEA: ${{ steps.chequeo.outputs.clase }}');
    // Sin `--label`: crear un issue con una etiqueta inexistente falla, y eso
    // convierte el aviso en un segundo fallo silencioso.
    expect(CODIGO).not.toMatch(/gh issue create[^\n]*--label/);
    // Y el exit del chequeo no se lo traga la captura.
    expect(CODIGO).toContain('codigo=${PIPESTATUS[0]}');
    expect(CODIGO).toContain('exit "$codigo"');
  });
});

// ── El fuente real: lo que el chequeo NO puede hacer ──────────────────────────

describe('WKH-370 · afirmaciones sobre el fuente real del chequeo', () => {
  it('T-S1 (CD-11): el chequeo OBSERVA — todo `method:` es GET y no hay verbo que mute', () => {
    const metodos = [...SCRIPT_CODE.matchAll(/method: '([A-Z]+)'/g)].map((m) => m[1]);
    expect(metodos.length).toBeGreaterThan(0);
    expect(metodos.filter((m) => m !== 'GET')).toEqual([]);
    expect(SCRIPT_CODE).not.toMatch(/\b(POST|PATCH|DELETE|PUT)\b/);
    expect(SCRIPT_CODE).not.toContain('/compose');
    expect(SCRIPT_CODE).not.toMatch(/orchestrate|settle|deposit|payout\b/i);
  });

  it('T-S2 (CD-5): la función que EMITE no menciona credencial ni billetera', () => {
    // El repo es PÚBLICO y la línea emitida termina pegada en un issue. Un mutante
    // que loguee el row entero pasaría la suite si nadie mira esto.
    const desde = SCRIPT_CODE.indexOf('function emit(');
    expect(desde).toBeGreaterThan(-1);
    const cuerpo = SCRIPT_CODE.slice(desde);
    expect(cuerpo).not.toMatch(/A2A_CATALOG_OWNER_KEY|cred\.key|payout_wallet|payoutWallet|owner_ref|ownerRef/i);
    // La credencial se lee en UN solo lugar y se usa en UN solo lugar: la cabecera.
    expect([...SCRIPT_CODE.matchAll(/env\.A2A_CATALOG_OWNER_KEY/g)]).toHaveLength(1);
    expect([...SCRIPT_CODE.matchAll(/cred\.key/g)]).toHaveLength(1);
    expect(SCRIPT_CODE).toContain("'x-a2a-key': cred.key");
  });

  it('T-S3 (CD-8): no se construye NINGUNA URL de detalle por slug — sólo las listas', () => {
    // El detalle cuesta hasta doscientas queries por request desde WKH-369 y perdió
    // su exención de rate limit. Se lee la LISTA, una vez por corrida.
    expect(SCRIPT_CODE).not.toMatch(/\/discover\/\$\{|\/discover\/'|\/discover\/`/);
    const usos = [...SCRIPT_CODE.matchAll(/\$\{BASE_URL\}([^\s`'"]*)/g)].map((m) => m[1]);
    expect(usos).toEqual(['/discover', '/agents']);
  });

  it('T-S4 (CD-14): los npm scripts no empiezan por `test`, y package.json:11 no se movió', () => {
    const pkgSrc = readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgSrc);
    for (const nombre of ['check:catalog:deriva', 'check:catalog:completitud']) {
      expect(pkg.scripts[nombre]).toBe('node scripts/check-catalog-vs-live.mjs');
      // El descubridor de runners de CI se queda con los steps que corren
      // `npm test` / `npm run test…` SIN `if:` ni `continue-on-error:`. Los steps de
      // este workflow llevan los dos, así que un nombre que empiece por `test` los
      // volvería `untranslatable` y pondría ese guardián en rojo.
      expect(nombre).not.toMatch(/^test/);
    }
    // Insertar por encima movería la línea que otro guardián tiene clavada.
    expect(pkgSrc.split('\n')[10]).toContain('biome check src/');
  });
});
