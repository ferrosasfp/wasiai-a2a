/**
 * Guardián estructural — WKH-225 · fix-pack CR/CR-3.
 *
 * LO QUE FIJA: los cinco puntos en que `debitResumedFirstStep`
 * (`src/routes/compose.ts`) espeja el cobro del step 0 de `/compose` siguen
 * presentes **en los dos lados**. No dice que hagan lo mismo — dice que ninguno
 * de los dos perdió su mitad del espejo sin que nadie se entere.
 *
 * ── POR QUÉ EXISTE ESTE ARCHIVO
 *
 * El CR verificó que separar las dos funciones es CORRECTO y no pidió unirlas:
 * para saber cuál es el primer step restante hay que claimear el run, y el claim
 * necesita el `owner_ref` del caller autenticado, así que un preHandler de precio
 * tendría que consultar la base antes de saber quién pregunta. Lo que el CR sí
 * midió es que, separadas, **nada las obliga a moverse juntas**: un `grep` de
 * `debitResumedFirstStep|resolveComposePriceHandler` sobre los tests daba CERO, y
 * lo único que las ataba era un inventario de cinco viñetas en prosa
 * (`src/routes/compose.ts`, el docblock de `debitResumedFirstStep`).
 *
 * Una lista mantenida a mano es cierta el día que se escribe y **se vuelve falsa
 * sin que nadie la edite**. Estas cinco viñetas son cinco aserciones sin escribir;
 * acá están escritas.
 *
 * ── EXEMPLAR
 *
 * `test/payment-guards-live-in-one-place.test.ts` (T-316-24 / CD-9): mismo
 * diagnóstico, misma forma — guardián a nivel FUENTE, con control de vacuidad
 * por cada criterio, y con el stripper de comentarios controlado aparte. Se copia
 * de ahí que **se mira el CÓDIGO, no la prosa**: los dos docblocks nombran a
 * mansalva los símbolos que este archivo busca, y sin sacar los comentarios
 * primero todo daría verde por la razón equivocada.
 *
 * ⚠️ LO QUE ESTE GUARDIÁN **NO** HACE, dicho antes de apoyarse en su verde:
 *
 *  · No compara VALORES. Que los dos lados llamen a `resolveAgentPriceUsdc` no
 *    prueba que cobren lo mismo; eso lo miden `T-RES-13`/`T-RES-14`/`T-RES-15`
 *    en `src/routes/compose.resume.test.ts`, ejecutando los dos caminos.
 *  · No detecta una divergencia SEMÁNTICA que conserve los símbolos (por ejemplo
 *    invertir una comparación). Detecta que un lado PIERDA un eslabón.
 *  · No cubre el bloque del FEE del resume — ése tiene sus propios testigos
 *    (`T-RES-FEE-1`..`T-RES-FEE-6b`), y con config de splits NO-default, porque
 *    con la default el reparto es inobservable.
 *
 * Naming: T-MIR-1..T-MIR-5 (el espejo), T-MIR-V* (vacuidad), T-MIR-I* (instrumento).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ROUTES = 'src/routes/compose.ts';
const SERVICES = 'src/services/compose.ts';

/**
 * Saca los comentarios de bloque y las líneas que son SÓLO comentario, dejando
 * las URLs y los strings de código intactos. Mismo criterio que `codeOnly` en
 * `test/payment-guards-live-in-one-place.test.ts`.
 */
function codeOnly(file: string): string {
  const raw = readFileSync(join(REPO_ROOT, file), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

/**
 * El bloque `{ … }` que arranca en el ancla, contando llaves.
 *
 * Corre sobre código YA sin comentarios: un `{` dentro de un comentario
 * desbalancearía la cuenta y el corte saldría en cualquier lado. Los template
 * literals (`` `${a}/${b}` ``) tienen sus llaves balanceadas, así que no la
 * mueven. Si el ancla no aparece, TIRA: un guardián que devuelve `''` cuando no
 * encuentra nada es un guardián que aplaude un archivo borrado.
 */
export function blockAt(code: string, anchor: RegExp): string {
  const m = anchor.exec(code);
  if (!m) throw new Error(`ancla no encontrada: ${anchor}`);
  let i = m.index + m[0].length - 1; // el `{` del ancla
  if (code[i] !== '{') throw new Error(`el ancla no termina en '{': ${anchor}`);
  let depth = 0;
  for (; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return code.slice(m.index, i + 1);
    }
  }
  throw new Error(`bloque sin cerrar: ${anchor}`);
}

const A_RESUMED =
  /async function debitResumedFirstStep\([\s\S]*?\): Promise<ResumeStep0Debit> \{/;
const A_PREHANDLER =
  /async function resolveComposePriceHandler\([\s\S]*?\): Promise<void> \{/;
const A_PER_STEP = /if \(i > 0 && scopingKeyRow && chainId !== undefined\) \{/;
const A_GAS_HELPER =
  /async function resolveStep0GasOverheadUsd\([\s\S]*?\): Promise<number> \{/;

const ROUTES_CODE = codeOnly(ROUTES);
const SERVICES_CODE = codeOnly(SERVICES);

/** El tramo reanudado: el que espeja. */
const RESUMED = blockAt(ROUTES_CODE, A_RESUMED);
/** El step 0 de `/compose`: el preHandler de precio. */
const PREHANDLER = blockAt(ROUTES_CODE, A_PREHANDLER);
/** Los steps 1..N de `/compose`: el débito per-step del pipeline. */
const PER_STEP = blockAt(SERVICES_CODE, A_PER_STEP);

type Region = { name: string; code: string };
const R_PREHANDLER: Region = { name: `${ROUTES} · preHandler`, code: PREHANDLER };
const R_PER_STEP: Region = { name: `${SERVICES} · per-step`, code: PER_STEP };

/**
 * Una viñeta del inventario, con el patrón de CADA lado.
 *
 * Los dos patrones se escriben por separado a propósito: los dos lados dicen lo
 * mismo con distinto identificador (el tramo reanudado lee un precio congelado
 * escalar y el bucle lo lee de un array indexado por `i`), y forzar un patrón
 * único obligaría a aflojarlo hasta que deje de discriminar.
 */
const MIRROR: ReadonlyArray<{
  id: string;
  what: string;
  resumed: RegExp;
  origin: RegExp;
  region: Region;
}> = [
  {
    id: 'T-MIR-1',
    what: 'el precio y el destino salen del MISMO par (+ el derivador del cap)',
    resumed:
      /resolveAgentPriceUsdc\s*\([\s\S]*resolveAgentDestination\s*\([\s\S]*deriveComposeDestination\s*\(/,
    origin:
      /resolveAgentPriceUsdc\s*\([\s\S]*resolveAgentDestination\s*\([\s\S]*deriveComposeDestination\s*\(/,
    region: R_PREHANDLER,
  },
  {
    id: 'T-MIR-2',
    what: 'el gas overhead per-step se suma al monto debitado',
    resumed: /getStepGasOverheadUsd\s*\(/,
    // El preHandler lo pide por el envoltorio que resuelve la cadena desde el
    // header; el fondo del pozo es el mismo helper (ver T-MIR-2b).
    origin: /resolveStep0GasOverheadUsd\s*\(/,
    region: R_PREHANDLER,
  },
  {
    id: 'T-MIR-3',
    what: 'el precio CONGELADO gana sobre el vivo cuando existe (WKH-303)',
    resumed: /frozenFirstPriceUsd[\s\S]*Number\.isFinite\([\s\S]*> 0/,
    origin: /frozenStepPricesUsd\?\.\[i\][\s\S]*Number\.isFinite\([\s\S]*> 0/,
    region: R_PER_STEP,
  },
  {
    id: 'T-MIR-4',
    what: 'el fallback honesto `PLACEHOLDER_FEE_USD` para un precio inválido',
    // ⚠️ Los dos patrones apuntan al MONTO, no al nombre. Un `/PLACEHOLDER_FEE_USD/`
    // pelado sobrevive a que alguien saque el fallback del monto debitado,
    // porque el preHandler nombra la constante una segunda vez para el challenge
    // x402 — medido: esa mutación quedaba VIVA con el patrón laxo.
    resumed: /\? PLACEHOLDER_FEE_USD :/,
    origin: /composeEstimatedCostUsd = PLACEHOLDER_FEE_USD/,
    region: R_PREHANDLER,
  },
  {
    id: 'T-MIR-5',
    what: 'los tres campos que lee `refundComposeStep0` se setean en el request',
    resumed:
      /request\.resolvedChainId =[\s\S]*request\.composeEstimatedCostUsd =[\s\S]*request\.composeDestination =/,
    // El preHandler no setea `resolvedChainId` (lo pone el middleware de pago);
    // los dos que SÍ son suyos son los que el refund cruza con el débito.
    origin: /request\.composeEstimatedCostUsd =[\s\S]*request\.composeDestination =/,
    region: R_PREHANDLER,
  },
];

describe('WKH-225 · CR-3 — el espejo del step 0 reanudado tiene candado', () => {
  for (const { id, what, resumed, origin, region } of MIRROR) {
    it(`${id}: ${what} — está en el tramo REANUDADO`, () => {
      expect(
        resumed.test(RESUMED),
        `\`debitResumedFirstStep\` (${ROUTES}) perdió "${what}". Esa función ` +
          'espeja a propósito el cobro del step 0 de `/compose`, y el espejo ' +
          'está enumerado en su propio docblock. Dos criterios que nada obliga ' +
          'a moverse juntos divergen en la próxima corrección de borde, y el ' +
          'desacuerdo sale como un cobro distinto según si el run se suspendió ' +
          'o no — en un camino de dinero. Si la divergencia es DELIBERADA, ' +
          'sacá la viñeta del docblock y la entrada de este arreglo en el ' +
          'MISMO commit, con el motivo escrito.',
      ).toBe(true);
    });

    // ── Control de vacuidad ────────────────────────────────────────────
    // Un guardián que sólo mira el lado nuevo aplaude el día que el lado
    // ORIGINAL pierde el eslabón: el espejo quedaría "cumplido" contra un
    // original que ya no hace eso.
    it(`${id}: ...y en el ORIGINAL (si no, el de arriba mide contra la nada)`, () => {
      expect(
        origin.test(region.code),
        `${region.name} ya no contiene "${what}". O se movió, o cambió de ` +
          'forma, o se borró: en los tres casos el espejo de ' +
          '`debitResumedFirstStep` quedó apuntando a algo que no existe y hay ' +
          'que arreglar ESTE archivo junto con el código, no silenciarlo.',
      ).toBe(true);
    });
  }

  it('T-MIR-2b: los dos gas overheads terminan en el MISMO helper', () => {
    // Sin esto, `resolveStep0GasOverheadUsd` podría pasar a calcular el
    // overhead por su cuenta y T-MIR-2 seguiría verde con los dos lados
    // cobrando gas distinto.
    const helper = blockAt(ROUTES_CODE, A_GAS_HELPER);
    expect(
      /getStepGasOverheadUsd\s*\(/.test(helper),
      '`resolveStep0GasOverheadUsd` dejó de delegar en `getStepGasOverheadUsd`: ' +
        'el step 0 de `/compose` y el del tramo reanudado ya no comparten la ' +
        'fuente del overhead.',
    ).toBe(true);
  });

  it('T-MIR-5b: los tres campos se setean DESPUÉS del débito, nunca antes', () => {
    // No es estilo: setearlos antes deja a `refundComposeStep0` devolviendo
    // plata que nunca salió cuando el débito falla — el mismo bug con el signo
    // cambiado, y así está escrito en el docblock.
    const debit = RESUMED.indexOf('budgetService.debit(');
    const firstField = RESUMED.indexOf('request.resolvedChainId =');
    expect(debit, 'no hay `budgetService.debit(` en el tramo reanudado').toBeGreaterThan(-1);
    expect(firstField, 'no se setea `request.resolvedChainId`').toBeGreaterThan(-1);
    expect(
      firstField,
      'los campos que lee `refundComposeStep0` se setean ANTES del débito: un ' +
        'débito fallido habilitaría el reembolso de plata que nunca salió.',
    ).toBeGreaterThan(debit);
  });

  it('T-MIR-V1: las dos funciones existen y ALGUIEN las llama', () => {
    // Sin esto, borrar la HU entera dejaría este archivo… tirando en el import,
    // que es rojo igual; pero borrar sólo la LLAMADA dejaría las funciones
    // muertas y todos los espejos "cumplidos". El route tiene que seguir
    // cableando las dos.
    expect(ROUTES_CODE).toMatch(/await debitResumedFirstStep\s*\(/);
    expect(ROUTES_CODE).toMatch(/^\s*resolveComposePriceHandler,\s*$/m);
  });

  it('T-MIR-I1: el instrumento recorta bloques de verdad (control del slicer)', () => {
    // Si `blockAt` devolviera el archivo entero, TODOS los patrones de arriba
    // matchearían por vecindad y el guardián sería vacuo. Se fija en las dos
    // direcciones: cada región es más chica que su archivo, no está vacía, y NO
    // contiene el ancla de la otra.
    for (const [name, code, whole] of [
      ['RESUMED', RESUMED, ROUTES_CODE],
      ['PREHANDLER', PREHANDLER, ROUTES_CODE],
      ['PER_STEP', PER_STEP, SERVICES_CODE],
    ] as const) {
      expect(code.length, `${name} quedó vacío`).toBeGreaterThan(300);
      expect(code.length, `${name} se comió el archivo entero`).toBeLessThan(
        whole.length * 0.5,
      );
    }
    expect(RESUMED).not.toMatch(A_PREHANDLER);
    expect(PREHANDLER).not.toMatch(A_RESUMED);
    // Y el corte cierra donde tiene que cerrar: la función siguiente NO entra.
    expect(RESUMED).not.toContain('RESUME_CLAIM_HTTP');
    expect(PREHANDLER).not.toContain('debitResumedFirstStep');
  });

  it('T-MIR-I2: `blockAt` cuenta llaves y no adivina (control del instrumento)', () => {
    const fixture = 'function f(): void {\n  if (a) { g({ x: 1 }); }\n}\nconst z = 9;\n';
    const cut = blockAt(fixture, /function f\(\): void \{/);
    expect(cut.endsWith('}')).toBe(true);
    expect(cut).toContain('g({ x: 1 })');
    expect(cut).not.toContain('const z');
    // Y falla ruidosamente en vez de devolver vacío.
    expect(() => blockAt(fixture, /function NOPE\(\) \{/)).toThrow(/ancla/);
    expect(() => blockAt('function f() {\n  if (a) {\n', /function f\(\) \{/)).toThrow(
      /sin cerrar/,
    );
  });

  it('T-MIR-I3: el stripper de comentarios no se come el código', () => {
    // Los dos docblocks nombran todos los símbolos que este archivo busca. Si
    // `codeOnly` borrara de MÁS, los patrones darían rojo falso; si borrara de
    // MENOS, darían verde midiendo la prosa. Se ancla contra algo que sólo
    // puede vivir en el código, y contra algo que sólo vive en un comentario.
    expect(ROUTES_CODE).toContain('async function debitResumedFirstStep(');
    expect(ROUTES_CODE).not.toContain('EL DÉBITO DEL PRIMER STEP DEL TRAMO');
    expect(SERVICES_CODE).toContain('if (i > 0 && scopingKeyRow');
  });
});
