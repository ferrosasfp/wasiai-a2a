/**
 * @file probe-money-path.test.mjs
 * @description Suite de la sonda del camino del dinero (WKH-364). **CERO RED.**
 *
 * Las funciones puras se importan; los dos casos que necesitan el proceso entero lo
 * spawnean con un env CONTROLADO (sin credencial), y ahí la fila 0 corta antes de
 * cualquier `fetch`. Ningún test de este archivo abre un socket ni gasta un centavo.
 *
 * T-1..T-4  → AC-1  derivación (incluido el caso que mata una implementación hardcodeada)
 * T-5, T-6  → AC-3  la escalera entera, fila por fila, y sus mensajes distinguibles
 * T-7       → AC-8  credencial ausente: exit 3, y exit 0 con SKIP en `pull_request`
 * T-8, T-9  → AC-5, AC-6, AC-4  afirmaciones sobre el YAML REAL
 * T-10..T-12→ AC-2, AC-7, CD-4, CD-6, CD-14, CD-15  ejecutables sobre el fuente real
 * T-16      → FIX-PACK 2026-08-25: la sonda declara EN QUÉ RED se le cobra (la de Chaski)
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertQuoteShape,
  classify,
  deriveInput,
  isRetryable,
  main,
  PAYMENT_CHAIN,
  schemaFingerprint,
} from '../scripts/probe-money-path.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SCRIPT_PATH = resolve(HERE, '../scripts/probe-money-path.mjs');
const SCRIPT_SRC = readFileSync(SCRIPT_PATH, 'utf8');
const WORKFLOW = readFileSync(
  resolve(REPO_ROOT, '.github/workflows/probe-money-path.yml'),
  'utf8',
);

/** Las líneas que son ÍNTEGRAMENTE comentario del YAML: prosa, no cableado. */
const sinComentarios = (yaml) =>
  yaml
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

/**
 * Lo mismo para JS. Mismo criterio y MISMO motivo que el de arriba
 * (`auto-blindaje.md:8-25`): un guardián que escanea la explicación del archivo se
 * denuncia a sí mismo por su propia prosa, y el precio concreto es que el script no
 * puede documentar sus decisiones. Se filtran sólo las líneas cuyo texto ARRANCA con
 * `//`, `*` o `/*` — nunca a mitad de línea, que podría hacer DESAPARECER código real.
 */
const sinComentariosJs = (src) =>
  src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

/** El CÓDIGO del script, sin su prosa. Es sobre esto que corren T-10, T-11 y T-13. */
const SCRIPT_CODE = sinComentariosJs(SCRIPT_SRC);

/** El schema REAL que publica el catálogo hoy, como fixture literal (§4 del Story File). */
const SCHEMA_REAL = {
  type: 'object',
  required: ['amountUsd'],
  properties: {
    amountUsd: { type: 'number', exclusiveMinimum: 0 },
    destCountry: { type: 'string' },
    payoutMethod: { type: 'string', enum: ['yape', 'plin', 'bank_cci'] },
  },
};

const ok = { credentialPresent: true, discover: { status: 200, inputSchema: SCHEMA_REAL } };

describe('WKH-364 · derivación del cuerpo desde el inputSchema (AC-1, CD-1)', () => {
  it('T-1: toma enum[0] del schema RECIBIDO, no un valor de memoria', () => {
    // Si el script escribiera "yape" de memoria, este test se pone rojo. Es el único
    // que distingue "derivó" de "acertó".
    const derived = deriveInput({
      type: 'object',
      required: ['amountUsd'],
      properties: {
        amountUsd: { type: 'number', exclusiveMinimum: 0 },
        payoutMethod: { type: 'string', enum: ['plin', 'yape'] },
      },
    });
    expect(derived.input.payoutMethod).toBe('plin');
  });

  it('T-2: con el schema real produce {amountUsd:25, payoutMethod:"yape"} y omite el string libre', () => {
    const derived = deriveInput(SCHEMA_REAL);
    expect(derived.input).toEqual({ amountUsd: 25, payoutMethod: 'yape' });
    expect(derived.omitted).toEqual(['destCountry']);
  });

  it('T-3: un string libre EN required no se inventa: DRIFT sin input', () => {
    const derived = deriveInput({
      type: 'object',
      required: ['amountUsd', 'destCountry'],
      properties: {
        amountUsd: { type: 'number' },
        destCountry: { type: 'string' },
      },
    });
    expect(derived.reason).toBe('required-not-derivable');
    expect(derived.field).toBe('destCountry');
    expect(derived).not.toHaveProperty('input');
  });

  it('T-4: enum vacío y cotas insatisfacibles son los dos bordes, y los dos son DRIFT', () => {
    const vacio = deriveInput({
      type: 'object',
      required: ['modo'],
      properties: { modo: { type: 'string', enum: [] } },
    });
    expect(vacio.reason).toBe('required-not-derivable');
    expect(vacio.detail).toBe('enum-vacio-o-no-array');

    const cotas = deriveInput({
      type: 'object',
      required: ['amountUsd'],
      properties: { amountUsd: { type: 'number', minimum: 10, maximum: 5 } },
    });
    expect(cotas.reason).toBe('required-not-derivable');
    expect(cotas.detail).toBe('cotas-insatisfacibles');

    // Y la contracara, para que el de arriba no pase por un DRIFT indiscriminado:
    // dentro de cotas publicadas satisfacibles, el monto de la sonda se ajusta y pasa.
    const dentro = deriveInput({
      type: 'object',
      required: ['amountUsd'],
      properties: { amountUsd: { type: 'number', minimum: 100, maximum: 500 } },
    });
    expect(dentro.input).toEqual({ amountUsd: 100 });
  });

  it('la huella del schema es estable ante el ORDEN de las claves y cambia con el contenido', () => {
    const reordenado = { properties: SCHEMA_REAL.properties, required: ['amountUsd'], type: 'object' };
    expect(schemaFingerprint(reordenado)).toBe(schemaFingerprint(SCHEMA_REAL));
    expect(schemaFingerprint({ ...SCHEMA_REAL, required: [] })).not.toBe(schemaFingerprint(SCHEMA_REAL));
  });
});

describe('WKH-364 · la escalera de clasificación, fila por fila (AC-3)', () => {
  /**
   * La cuarta columna es la ATRIBUCIÓN, y existe por una razón medida: un mutante que
   * conserva `klass` y `exit` y sólo degrada el mensaje pasaba la tabla entera en verde.
   * El más caro convertía `DOWN: candidata a caída real — no hay campo estructurado que
   * atribuya la causa` (fila 9) en `DOWN: producción está caída` — el número correcto por
   * la razón equivocada, que es exactamente el falso rojo que esta HU existe para NO
   * producir: el mensaje es lo que se pega en el issue. Cada fragmento sale del prefijo
   * que `story-file.md:205-217` (§5) fija fila por fila, más el dato interpolado que
   * atribuye la causa (el status, el código, el campo, el slug).
   */
  const casos = [
    ['fila 0 · sin credencial', { credentialPresent: false }, 'CONFIG', 3, '(A2A_PROBE_KEY) — esto NO dice nada sobre producción'],
    ['fila 0 · sin credencial en pull_request', { credentialPresent: false, githubEventName: 'pull_request' }, 'SKIP', 0, 'un pull_request DESDE UN FORK no recibe el secret del repo'],
    ['fila 0-bis · PROBE_AMOUNT_USD no numérico es config, no contrato', { credentialPresent: true, amountInvalid: true }, 'CONFIG', 3, 'PROBE_AMOUNT_USD no es un número — es configuración de la sonda, no del catálogo'],
    ['fila 1 · /discover con error de red', { credentialPresent: true, discover: { networkError: 'ENOTFOUND' } }, 'DOWN', 2, '/discover inalcanzable (ENOTFOUND)'],
    ['fila 1 · /discover 5xx', { credentialPresent: true, discover: { status: 503 } }, 'DOWN', 2, '/discover inalcanzable (503)'],
    ['fila 2 · /discover 404', { credentialPresent: true, discover: { status: 404 } }, 'DRIFT', 4, 'el catálogo ya no publica el inputSchema de remit-corridor-fx-solana'],
    ['fila 2 · 200 sin inputSchema', { credentialPresent: true, discover: { status: 200, inputSchema: null } }, 'DRIFT', 4, 'el catálogo ya no publica el inputSchema de remit-corridor-fx-solana'],
    ['fila 2-bis · /discover 403 del borde', { credentialPresent: true, discover: { status: 403 } }, 'DOWN', 2, '/discover no contestó 200 (403)'],
    ['fila 2-bis · /discover 429 del borde', { credentialPresent: true, discover: { status: 429 } }, 'DOWN', 2, '/discover no contestó 200 (429)'],
    ['fila 3 · campo requerido no derivable', { ...ok, derive: { reason: 'required-not-derivable', field: 'x', detail: 'string-libre-sin-enum' } }, 'DRIFT', 4, 'campo requerido no derivable: x (string-libre-sin-enum) — la sonda NO inventa valores'],
    ['fila 4 · 403 con error_code de credencial', { ...ok, compose: { status: 403, body: { error_code: 'DAILY_LIMIT' } } }, 'CONFIG', 3, 'la credencial de la sonda (DAILY_LIMIT) — producción no está implicada'],
    ['fila 5 · 402 (la key no fue aceptada)', { ...ok, compose: { status: 402, body: {} } }, 'CONFIG', 3, 'la credencial no fue aceptada (402)'],
    ['fila 6 · INPUT_REJECTED es la sonda vieja', { ...ok, compose: { status: 400, body: { agentFailure: 'INPUT_REJECTED' } } }, 'DRIFT', 4, 'el agente rechazó el input DERIVADO del schema publicado'],
    ['fila 7 · AGENT_ERROR es el agente fallando', { ...ok, compose: { status: 400, body: { agentFailure: 'AGENT_ERROR' } } }, 'DOWN', 2, 'el agente contestó un error que no es sobre el pedido'],
    ['fila 8 · el gateway rechazó el cuerpo', { ...ok, compose: { status: 400, body: { code: 'VALIDATION_ERROR' } } }, 'DRIFT', 4, 'el gateway rechazó el cuerpo de la sonda (VALIDATION_ERROR)'],
    ['fila 9 · no-2xx sin campo que atribuya', { ...ok, compose: { status: 500, body: {} } }, 'DOWN', 2, 'candidata a caída real — no hay campo estructurado que atribuya la causa'],
    ['fila 9 · error de red en el pipeline', { ...ok, compose: { networkError: 'ECONNRESET' } }, 'DOWN', 2, 'candidata a caída real — no hay campo estructurado que atribuya la causa'],
    ['fila 10 · 200 con una cotización que no lo es', { ...ok, compose: { status: 200, body: {} }, quote: { ok: false, field: 'rate', reason: 'no es un número finito > 0' } }, 'DOWN', 2, '200 con una cotización que no es una cotización (rate no es un número finito > 0)'],
    ['fila 11 · PASS', { ...ok, compose: { status: 200, body: {} }, quote: { ok: true } }, 'PASS', 0, 'el camino del dinero cotiza'],
    ['fila 12 · el default de la escalera NO es PASS', { ...ok }, 'DOWN', 2, 'la sonda no llegó a observar un 2xx de /compose con una cotización verificada'],
  ];
  for (const [nombre, obs, klass, exit, atribucion] of casos) {
    it(`T-5: ${nombre} → ${klass} (exit ${exit}) y ATRIBUYE la causa`, () => {
      const v = classify(obs);
      expect(v.klass).toBe(klass);
      expect(v.exit).toBe(exit);
      expect(v.message.startsWith(`${klass}:`)).toBe(true);
      // Sin esta línea, `DOWN: producción está caída` en lugar de la fila 9 pasaba en verde.
      expect(v.message).toContain(atribucion);
    });
  }

  // Y el fragmento no puede degradarse a algo que se cumpla solo: `toContain('')` es
  // cierto para cualquier string, y `toContain('DOWN')` lo garantiza el `startsWith` de
  // arriba. Una columna vacua sería el mismo agujero con la forma de un testigo.
  it('T-5: cada fila declara un fragmento de atribución que NO se cumple por sí solo', () => {
    expect(casos.length).toBe(20);
    for (const [nombre, , klass, , atribucion] of casos) {
      expect(typeof atribucion, nombre).toBe('string');
      expect(atribucion.trim().length, nombre).toBeGreaterThanOrEqual(20);
      // No es el nombre de la clase ni el prefijo `KLASE: `, que ya están cubiertos.
      expect(atribucion.includes(klass), nombre).toBe(false);
      // Y DISTINGUE: el fragmento de una fila no puede aparecer en el mensaje de otra
      // fila. Si apareciera, no atribuiría nada — sería un `toContain` que cualquier
      // rama satisface, que es la misma vacuidad con otra forma.
      const fila = nombre.split(' ·')[0];
      for (const [otroNombre, otraObs] of casos) {
        if (otroNombre.split(' ·')[0] === fila) continue;
        expect(
          classify(otraObs).message.includes(atribucion),
          `${nombre} vs ${otroNombre}`,
        ).toBe(false);
      }
    }
  });

  it('T-5: SCOPE_DENIED es la credencial de la sonda, con CUALQUIERA de sus dos grafías', () => {
    // ⚠️ Este caso afirmaba lo contrario (exit 2) y candaba una misclasificación. Hay
    // DOS productores de 403 en `/compose`: el middleware manda `error_code` (snake) y
    // la RUTA manda `errorCode` (camel, `src/routes/compose.ts:1113`). Las cuatro causas
    // de SCOPE_DENIED son propiedades de la KEY del caller, o sea de la sonda misma: es
    // config, no caída. Y es el caso que produce una key creada con scope propio.
    for (const body of [
      { error_code: 'SCOPE_DENIED' },
      { errorCode: 'SCOPE_DENIED', error: 'Step 0 denied by scope: agent_slug' },
    ]) {
      const v = classify({ ...ok, compose: { status: 403, body } });
      expect(v.klass).toBe('CONFIG');
      expect(v.exit).toBe(3);
    }
    // El punto que el caso viejo SÍ quería hacer, que sigue en pie con otro código: no
    // cualquier 403 es config. Uno que no está en ninguno de los dos conjuntos sigue
    // siendo candidato a caída, porque nadie sabe qué lo produjo.
    const desconocido = classify({ ...ok, compose: { status: 403, body: { error_code: 'ALGO_QUE_NADIE_DECLARO' } } });
    expect(desconocido.exit).toBe(2);
  });

  it('T-5: PASS es inalcanzable sin un 2xx de /compose con la cotización verificada', () => {
    // El default de la escalera era PASS: cualquier respuesta de /discover fuera de
    // {404, 5xx} salía exit 0 SIN haber llamado nunca a /compose — y un exit 0 por reloj
    // CIERRA el issue de una caída abierta. Estos son los estados reproducidos.
    for (const status of [204, 302, 400, 401, 403, 429, 451]) {
      const v = classify({ credentialPresent: true, discover: { status } });
      expect(v.klass).not.toBe('PASS');
      expect(v.exit).not.toBe(0);
      // Y ATRIBUYE: dice que el que no contestó fue /discover. No alcanza con que el
      // default de abajo lo agarre — un "no sé" genérico manda a mirar el lado
      // equivocado, que es el costo que esta HU existe para eliminar.
      expect(v.message).toContain('/discover');
    }
    expect(classify({ ...ok }).klass).not.toBe('PASS'); // nunca se llamó a /compose
    expect(classify({ ...ok, compose: { status: 200, body: {} } }).klass).not.toBe('PASS'); // 2xx sin forma verificada
    // Y la contracara, para que lo de arriba no pase por un rojo indiscriminado:
    expect(classify({ ...ok, compose: { status: 200, body: {} }, quote: { ok: true } }).exit).toBe(0);
  });

  it('T-5: el outputSchema que ya no declara el campo es contrato cambiado, no caída (§7)', () => {
    const v = classify({ ...ok, compose: { status: 200, body: {} }, quote: { ok: false, drift: true, field: 'rate' } });
    expect(v.klass).toBe('DRIFT');
    expect(v.exit).toBe(4);
  });

  it('T-5: el self-test no puede terminar en 0 JAMÁS', () => {
    const verde = { ...ok, compose: { status: 200, body: {} }, quote: { ok: true }, selfTestField: 'amountUsd' };
    expect(classify(verde).exit).toBe(5);
    // Y tampoco puede afirmar que el gateway aceptó algo si nunca se envió nada.
    const sinCredencial = { credentialPresent: false, githubEventName: 'pull_request', selfTestField: 'amountUsd' };
    expect(classify(sinCredencial).exit).toBe(3);
    // Un rojo legítimo se conserva tal cual: el self-test no lo reetiqueta.
    const rojo = { ...ok, compose: { status: 400, body: { agentFailure: 'INPUT_REJECTED' } }, selfTestField: 'amountUsd' };
    expect(classify(rojo).exit).toBe(4);
  });

  it('T-5: el self-test no acusa al gateway de aceptar algo que nunca se rompió', () => {
    // `delete input[campo]` es un no-op si el campo no está: el cuerpo sale ENTERO, el
    // gateway lo acepta con razón, y el exit 5 pasa a ser una acusación fabricada —
    // pagada. La sonda corta antes del pipeline y lo llama por su nombre: config.
    const noOp = { ...ok, selfTestField: 'campoQueLaDerivacionNoProduce', selfTestFieldPresent: false };
    expect(classify(noOp).klass).toBe('CONFIG');
    expect(classify(noOp).exit).toBe(3);
    // Y el exit 5 sigue reservado para el caso REAL: se rompió el cuerpo y lo aceptaron.
    const roto = { ...ok, compose: { status: 200, body: {} }, quote: { ok: true }, selfTestField: 'amountUsd', selfTestFieldPresent: true };
    expect(classify(roto).exit).toBe(5);
  });

  it('T-6: los mensajes de DRIFT y de caída son distinguibles, y ninguno usa la palabra del otro', () => {
    const drift = classify({ ...ok, compose: { status: 400, body: { agentFailure: 'INPUT_REJECTED' } } });
    const down = classify({ ...ok, compose: { status: 400, body: { agentFailure: 'AGENT_ERROR' } } });
    expect(drift.message).toMatch(/^DRIFT: /);
    expect(down.message).toMatch(/^DOWN: /);
    expect(drift.message).not.toContain('DOWN');
    expect(down.message).not.toContain('DRIFT');
    expect(drift.message).not.toBe(down.message);
  });

  it('assertQuoteShape no afirma ninguna banda de valor, sólo finito y > 0', () => {
    const outputSchema = { properties: { rate: {}, netDeliveredLocal: {} } };
    const body = (rate) => ({ success: true, steps: [{ output: { rate, netDeliveredLocal: 90 } }] });
    expect(assertQuoteShape(body(3.7), outputSchema).ok).toBe(true);
    expect(assertQuoteShape(body(999999), outputSchema).ok).toBe(true);
    expect(assertQuoteShape(body(0), outputSchema).ok).toBe(false);
    expect(assertQuoteShape(body(Number.NaN), outputSchema).ok).toBe(false);
    expect(assertQuoteShape({ success: false }, outputSchema).ok).toBe(false);
    expect(assertQuoteShape(body(3.7), { properties: { netDeliveredLocal: {} } }).drift).toBe(true);
  });
});

describe('WKH-364 · el proceso entero, sin red (AC-8)', () => {
  const correr = (env) =>
    spawnSync(process.execPath, [SCRIPT_PATH], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    });

  it('T-7: sin credencial → exit 3 y el mensaje NO implica a producción', () => {
    const r = correr({});
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('CONFIG: credencial de sonda ausente');
    expect(r.stdout).toContain('NO dice nada sobre producción');
  });

  it('T-7: sin credencial en pull_request → exit 0 con SKIP (un fork no recibe secrets)', () => {
    const r = correr({ GITHUB_EVENT_NAME: 'pull_request' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^SKIP: /);
  });
});

describe('WKH-364 · main() con `fetch` doblado: cero red, y ningún POST de más', () => {
  const CARD = {
    metadata: {
      inputSchema: SCHEMA_REAL,
      outputSchema: { properties: { rate: {}, netDeliveredLocal: {} } },
    },
  };

  /**
   * Corre `main` con un doble de `fetch` que REGISTRA cada llamada. El registro es la
   * mitad que importa: la escalera podía decir PASS sin haber llamado nunca al pipeline,
   * y eso no se ve mirando sólo el exit code. Sigue siendo cero red.
   */
  const conFetch = async (respuestas, env) => {
    const llamadas = [];
    const cabeceras = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      llamadas.push(`${init?.method ?? 'GET'} ${url}`);
      cabeceras.push(init?.headers ?? {});
      const r = respuestas[llamadas.length - 1];
      return { status: r.status, json: async () => r.body };
    };
    try {
      const exit = await main({ A2A_PROBE_KEY: 'credencial-de-mentira', ...env });
      return { exit, llamadas, cabeceras };
    } finally {
      globalThis.fetch = original;
    }
  };

  it('T-15: un /discover que no da 200 no sale en verde, y no llega a pagar', async () => {
    // Reproducción del defecto: estos siete estados salían exit 0 con UNA sola llamada,
    // imprimiendo "el camino del dinero cotiza". Y un exit 0 por reloj CIERRA el issue
    // de una caída abierta, así que el control no sólo mentía: borraba la alarma.
    for (const status of [204, 302, 400, 401, 403, 429, 451]) {
      const r = await conFetch([{ status, body: {} }], {});
      expect(r.exit).not.toBe(0);
      expect(r.llamadas).toHaveLength(1);
    }
  });

  it('T-15: PROBE_AMOUNT_USD no numérico es config de la sonda, no contrato cambiado', async () => {
    const r = await conFetch([{ status: 200, body: CARD }], { PROBE_AMOUNT_USD: 'veinticinco' });
    expect(r.exit).toBe(3);
    expect(r.llamadas).toHaveLength(1);
  });

  it('T-15: el self-test sobre un campo ausente corta antes del pipeline: no acusa ni paga', async () => {
    const r = await conFetch([{ status: 200, body: CARD }], {
      PROBE_SELF_TEST_OMIT_REQUIRED: 'campoQueLaDerivacionNoProduce',
    });
    expect(r.exit).toBe(3);
    expect(r.llamadas).toHaveLength(1);
  });

  it('T-15: el camino feliz sí llega al POST y sale 0', async () => {
    // La contracara obligatoria: sin esto, lo de arriba pasaría con una sonda que
    // siempre dice que no.
    const r = await conFetch(
      [
        { status: 200, body: CARD },
        { status: 200, body: { success: true, steps: [{ output: { rate: 3.7, netDeliveredLocal: 90 } }] } },
      ],
      {},
    );
    expect(r.exit).toBe(0);
    expect(r.llamadas).toHaveLength(2);
    expect(r.llamadas[0]).toContain('GET https://');
    expect(r.llamadas[1]).toContain('POST https://');
  });

  it('T-16: el POST /compose declara EN QUÉ RED se le cobra, y el slug es uno que el gateway reconoce', async () => {
    // Por qué existe este testigo: la sonda nació SIN esta cabecera y la suite entera
    // estaba verde. Sin ella el gateway cobra en su red default, que —medido contra
    // producción el 2026-08-25— es kite-ozone-testnet en PYUSD, no Solana devnet en
    // USDC (ver el docblock de PAYMENT_CHAIN). O sea: el defecto no era un número mal
    // puesto, era que la sonda ejercitaba OTRO riel que el del producto, y ninguna
    // revisión podía verlo porque ninguna pudo correr la llamada autenticada.
    const r = await conFetch(
      [
        { status: 200, body: CARD },
        { status: 200, body: { success: true, steps: [{ output: { rate: 3.7, netDeliveredLocal: 90 } }] } },
      ],
      {},
    );
    expect(r.exit).toBe(0);

    // (a) el cableado: la cabecera viaja en el POST, con el valor de la constante.
    expect(r.cabeceras[1]['x-payment-chain']).toBe(PAYMENT_CHAIN);
    // (b) y NO en el GET, que es gratis y no cobra nada: ahí sería ruido.
    expect(r.cabeceras[0]['x-payment-chain']).toBeUndefined();
    // (c) el VALOR no es un literal de fantasía. El gateway traduce el header con el
    //     mapa de `chain-resolver.ts`; un slug fuera de ese mapa no cae en la red
    //     esperada, cae en un rechazo. Se cruza contra la fuente REAL del repo, que es
    //     lo que hace que un typo en la constante ponga esto en rojo.
    const resolver = readFileSync(resolve(REPO_ROOT, 'src/adapters/chain-resolver.ts'), 'utf8');
    expect(resolver).toContain(`'${PAYMENT_CHAIN}': '${PAYMENT_CHAIN}',`);
  });
});

describe('WKH-364 · afirmaciones sobre los archivos reales (AC-2, AC-4..AC-7)', () => {
  it('T-8: el continue-on-error está acotado a pull_request y el aviso al reloj', () => {
    expect(WORKFLOW).toContain("continue-on-error: ${{ github.event_name == 'pull_request' }}");
    expect(WORKFLOW).toContain("if: failure() && github.event_name == 'schedule'");
    expect(WORKFLOW).toContain("if: success() && github.event_name == 'schedule'");
    const titulos = WORKFLOW.match(/^\s+TITULO: '(.+)'$/gm) ?? [];
    expect(titulos).toHaveLength(2);
    expect(titulos[0].trim()).toBe(titulos[1].trim());
    expect(titulos[0]).toContain('probe-money-path: la corrida por reloj esta fallando');
    // Sin `--label`: crear el issue con una etiqueta inexistente falla, y eso
    // convertiría el aviso en un segundo fallo silencioso. Se mira el CÓDIGO y no la
    // prosa: el YAML documenta la razón en un comentario y, sin este filtro, el
    // guardián se denunciaba a sí mismo por su propia explicación.
    expect(sinComentarios(WORKFLOW)).not.toMatch(/gh issue create[^\n]*--label/);
  });

  it('T-8: el aviso PEGA la línea de clase que emitió la sonda, y el exit sobrevive', () => {
    // El comentario del YAML afirmaba este mecanismo y el cuerpo del issue era 100 %
    // estático: no había captura de stdout en ningún lado. Sin la línea, cada alerta
    // obliga a abrir Actions para saber si producción está implicada — que es la mitad
    // del argumento de existencia de la HU (§9: "un fallo CONFIG dice CONFIG").
    const codigo = sinComentarios(WORKFLOW);
    expect(codigo).toContain('id: sonda');
    expect(codigo).toContain('tee "$RUNNER_TEMP/probe.log"');
    expect(codigo).toContain('>> "$GITHUB_OUTPUT"');
    expect(codigo).toContain('LINEA: ${{ steps.sonda.outputs.clase }}');
    expect(codigo).toContain('"  $clase"');
    // La captura no puede tragarse el rojo: el exit de la sonda se preserva a mano.
    expect(codigo).toContain('codigo=${PIPESTATUS[0]}');
    expect(codigo).toContain('exit "$codigo"');
    // Se pega la LÍNEA DE CLASE, nunca el log entero: eso sería salida cruda (CD-8).
    expect(codigo).not.toMatch(/--body-file|cat "?\$RUNNER_TEMP/);
    // Y el aviso no se pierde en silencio: bajo `set -e`, un `x=$(gh issue list ...)`
    // suelto mata el step si la API falla, con el job YA rojo y nadie mirando. Las dos
    // consultas van dentro de un `if !` que decide qué hacer con el fallo.
    expect(codigo).not.toMatch(/^\s+existente=\$\(gh issue list/m);
    expect([...codigo.matchAll(/if ! existente=\$\(gh issue list/g)]).toHaveLength(2);
  });

  it('T-8: el trigger `pull_request` está acotado a los archivos de la sonda', () => {
    // Un PR de una rama de ESTE repo recibe el secret entero (GitHub se lo niega sólo a
    // los forks): la sonda hace el POST real y cobra ~0,0303 USDC en cada push, con
    // `continue-on-error` haciendo que nadie lo note. `paths:` ata ese gasto a los PRs
    // que tocan la sonda misma. Es la SEGUNDA palanca de gasto, además del `cron`.
    const codigo = sinComentarios(WORKFLOW);
    expect(codigo).toMatch(/pull_request:\n\s+paths:/);
    for (const archivo of [
      'scripts/probe-money-path.mjs',
      'test/probe-money-path.test.mjs',
      '.github/workflows/probe-money-path.yml',
    ]) {
      expect(codigo).toContain(`- '${archivo}'`);
    }
  });

  it('T-9: el interruptor de self-test sólo se cablea desde el input del dispatch', () => {
    const lineas = sinComentarios(WORKFLOW).split('\n').filter((l) => l.includes('PROBE_SELF_TEST_OMIT_REQUIRED'));
    expect(lineas).toHaveLength(1);
    expect(lineas[0]).toContain('inputs.self_test');
  });

  it('T-10: la sonda OBSERVA: sin depósito ni desembolso, y un único método no-GET', () => {
    expect(SCRIPT_CODE).not.toMatch(/deposit|payout|settle|orchestrate/i);
    const metodos = [...SCRIPT_CODE.matchAll(/method: '([A-Z]+)'/g)].map((m) => m[1]);
    expect(metodos.filter((m) => m === 'POST')).toHaveLength(1);
    expect(metodos.filter((m) => m !== 'GET' && m !== 'POST')).toEqual([]);
    expect(SCRIPT_CODE).toContain('${BASE_URL}/compose');
    expect([...SCRIPT_CODE.matchAll(/\$\{BASE_URL\}/g)]).toHaveLength(2);
  });

  it('T-11: ninguna aserción afirma corredor, país ni moneda local (CD-15)', () => {
    expect(SCRIPT_CODE).not.toMatch(/\bPEN\b/);
    expect(SCRIPT_CODE).not.toContain('localCurrency');
    expect(SCRIPT_CODE).not.toContain('destCountry');
  });

  it('T-12: el nombre del npm script no empieza por `test`, y package.json:11 no se movió', () => {
    const pkgSrc = readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgSrc);
    expect(pkg.scripts['probe:money-path']).toBe('node scripts/probe-money-path.mjs');
    // `test-files-are-run-in-ci.test.ts:228` filtra los steps de CI con `^npm (test|run test)`
    // y manda a `untranslatable` los que llevan `continue-on-error:`. El step de la sonda lo
    // lleva, así que un nombre que empiece por `test` pondría ese guardián en rojo.
    expect('probe:money-path').not.toMatch(/^test/);
    expect(pkgSrc.split('\n')[10]).toContain('biome check src/');
  });

  it('T-13: la credencial no puede llegar a stdout — el repo es PÚBLICO (CD-8)', () => {
    // El docblock del script afirma "nunca imprime la credencial" y NINGÚN test podía
    // refutarlo: un mutante que agrega `key=${process.env.A2A_PROBE_KEY}` a la línea de
    // clase pasaba la suite entera. Estas aserciones son ese candado.
    const lecturas = [...SCRIPT_CODE.matchAll(/env\.A2A_PROBE_KEY/g)];
    expect(lecturas).toHaveLength(1);
    const desde = SCRIPT_CODE.indexOf('export function readCredential');
    const cuerpoLectura = SCRIPT_CODE.slice(desde, SCRIPT_CODE.indexOf('\n}', desde));
    expect(cuerpoLectura).toContain('env.A2A_PROBE_KEY'); // la única lectura vive ahí
    // Y el valor se usa en UN solo lugar: el header del único POST.
    expect([...SCRIPT_CODE.matchAll(/cred\.key/g)]).toHaveLength(1);
    expect(SCRIPT_CODE).toContain("'x-a2a-key': cred.key");
    // Lo que imprime la línea de clase no puede tocar la credencial de ninguna forma.
    const impresion = SCRIPT_CODE.slice(SCRIPT_CODE.indexOf('function emit('));
    expect(impresion).not.toMatch(/A2A_PROBE_KEY|cred\.key|\bkey\b/);
  });

  it('T-14: el POST /compose NO se reintenta ante timeout — repetirlo paga dos veces', () => {
    // §8 es la única regla de PLATA de la HU y no tenía testigo: cambiar el `false` del
    // POST por `true` dejaba la suite entera en verde. Se verifican las dos mitades: la
    // función pura Y el cableado, porque el mutante vive en el cableado.
    const timeout = { name: 'AbortError' };
    expect(isRetryable(timeout, true)).toBe(true); // GET /discover: idempotente y gratis
    expect(isRetryable(timeout, false)).toBe(false); // POST /compose: pudo haber debitado
    expect(isRetryable({ cause: { code: 'ECONNRESET' } }, false)).toBe(true);
    expect(isRetryable({ cause: { code: 'EPIPE' } }, false)).toBe(false);
    expect(SCRIPT_CODE).toMatch(/COMPOSE_TIMEOUT_MS,\s*false,/);
    expect(SCRIPT_CODE).toMatch(/DISCOVER_TIMEOUT_MS,\s*true\)/);
  });
});
