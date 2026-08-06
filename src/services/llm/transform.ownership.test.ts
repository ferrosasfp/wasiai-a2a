/**
 * Caché L2 de transformaciones — aislamiento entre inquilinos (WKH-SEC-03).
 *
 * ── EL HUECO QUE CIERRA ESTE ARCHIVO ──────────────────────────────────────
 *
 * `src/services/llm/transform.ts:234` es el `.eq('owner_ref', ownerId)` del
 * SELECT de L2, y `:278` el del UPDATE de `hit_count`. Medido en `ef384b7`:
 * borrando cualquiera de las dos la suite entera quedaba idéntica a la baseline.
 *
 * De los 11 sitios del corte, `:234` es el de mayor consecuencia. La clave de
 * caché es `(source_agent_id, target_agent_id, schema_hash)` — **ortogonal al
 * dueño**: dos inquilinos que encadenan los mismos dos agentes con el mismo
 * schema comparten clave. Sin el filtro, A no sólo LEE la función de B: la
 * EJECUTA sobre sus propios datos (`applyTransformFn`, en un worker + `node:vm`).
 * El chequeo HMAC no lo tapa: verifica que el SERVIDOR firmó la función, no que
 * sea del caller.
 *
 * ── EN QUÉ MODO DE HMAC CORRE ESTE ARCHIVO (declarado, no implícito) ──────
 *
 * Corre en modo DEGRADADO: `SCHEMA_TRANSFORM_HMAC_KEY` se borra del entorno en
 * cada `beforeEach`. La razón es que `getFromL2:245-264` trata una fila sin
 * `transform_fn_sig` válido como MISS cuando la clave está configurada: con HMAC
 * activo, TR-01 daría "A no obtuvo la función de B" por la FIRMA y no por el
 * filtro de dueño, o sea pasaría por la razón equivocada. Borrando la variable,
 * lo único que separa los dos espacios de caché es el filtro.
 *
 * ── LA CACHÉ L1 PUEDE TAPAR LA CONSULTA ENTERA ───────────────────────────
 *
 * `maybeTransform:392-402` consulta L1 antes que L2. Su clave ya incluye al
 * dueño (`:390`), así que L1 no mezcla inquilinos — pero si L1 tiene la entrada,
 * la consulta a supabase NUNCA OCURRE y el test pasaría sin ejercitar el filtro.
 * Por eso `_clearL1Cache()` en `beforeEach` es obligatorio.
 *
 * ── ⚠️ HALLAZGO: EL UPDATE DE `hit_count` NO SE EJECUTA NUNCA ────────────
 *
 * `transform.ts:269-278` está escrito como
 * `void supabase.from(...).update(...).eq(...)`, sin `await` y sin `.then()`.
 * En `@supabase/postgrest-js@2.101.1` el request sale DENTRO de `then()`
 * (`dist/index.mjs:104`, el único call-site de `fetch` de toda la librería), así
 * que una cadena que nadie resuelve no llega jamás a la base.
 *
 * Consecuencia para TR-02: NO se puede afirmar «el `hit_count` que sube es el de
 * la fila de A», porque no sube ninguno. Lo máximo que se puede afirmar con
 * honestidad es que la cadena SE ARMA con el filtro por dueño — una aserción de
 * forma de llamada (espía), más débil que las de propiedad de TR-01/TR-03, y
 * declarada como tal. TR-02b fija el hallazgo en sí: la cadena queda sin
 * resolver. Arreglar el `void` está fuera del alcance de esta HU (no se toca
 * ninguna línea de producción).
 *
 * Naming: TR-00 (control de armado), TR-01, TR-01b, TR-02, TR-02b, TR-03.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/supabase.js', () => ({
  supabase: { from: vi.fn() },
}));

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  // biome-ignore lint/complexity/useArrowFunction: tiene que ser function() para poder instanciarse con `new`
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

import { supabase } from '../../lib/supabase.js';
import { createOwnerScopedFake } from '../__tests__/owner-scoped-fake.js';
import { schemaHash } from './canonical-json.js';
import { _clearL1Cache, maybeTransform } from './transform.js';

const OWNER_A = 'owner-A-0xaaaa';
const OWNER_B = 'owner-B-0xbbbb';
const SOURCE = 'agente-origen';
const TARGET = 'agente-destino';

/** El output NO satisface el schema, así que `maybeTransform` no hace SKIP. */
const OUTPUT = { text: 'hola' };
const INPUT_SCHEMA = { required: ['query'] };
/** Misma clave de caché para los dos dueños: es el punto del escenario. */
const SCHEMA_HASH = schemaHash(INPUT_SCHEMA);

const TRANSFORM_COLUMNS = [
  'id',
  'source_agent_id',
  'target_agent_id',
  'schema_hash',
  'owner_ref',
  'transform_fn',
  'transform_fn_sig',
  'hit_count',
  'created_at',
  'updated_at',
];

function transformRow(
  ownerRef: string | null,
  marca: string,
): Record<string, unknown> {
  return {
    id: `row-${marca}`,
    source_agent_id: SOURCE,
    target_agent_id: TARGET,
    schema_hash: SCHEMA_HASH,
    owner_ref: ownerRef,
    transform_fn: `return { query: '${marca}' };`,
    transform_fn_sig: null,
    hit_count: 5,
    created_at: '2026-08-05T00:00:00.000Z',
    updated_at: '2026-08-05T00:00:00.000Z',
  };
}

const mockFrom = vi.mocked(supabase.from);
let fake: ReturnType<typeof createOwnerScopedFake>;
let hmacBackup: string | undefined;

function seed(rows: Record<string, unknown>[]): void {
  fake = createOwnerScopedFake({
    kite_schema_transforms: { columns: TRANSFORM_COLUMNS, rows },
  });
  mockFrom.mockImplementation(
    (table: string) => fake.from(table) as ReturnType<typeof mockFrom>,
  );
}

describe('caché L2 de transform — aislamiento entre tenants (WKH-SEC-03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Obligatorio: con L1 caliente la consulta a supabase nunca ocurre.
    _clearL1Cache();
    hmacBackup = process.env.SCHEMA_TRANSFORM_HMAC_KEY;
    // Se BORRA, no se pone en la cadena "undefined": `getHmacKey()` mira si la
    // variable está presente, y la cadena "undefined" está presente.
    delete process.env.SCHEMA_TRANSFORM_HMAC_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    // El camino de MISS de L2 llama al LLM. Se mockea con una respuesta
    // distinguible para que "A no obtuvo nada de la caché" sea observable como
    // un valor concreto en vez de como una excepción.
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ transformFn: "return { query: 'DEL-LLM' };" }),
        },
      ],
    });
    seed([transformRow(OWNER_A, 'DE-A'), transformRow(OWNER_B, 'DE-B')]);
  });

  afterEach(() => {
    if (hmacBackup === undefined) {
      delete process.env.SCHEMA_TRANSFORM_HMAC_KEY;
    } else {
      process.env.SCHEMA_TRANSFORM_HMAC_KEY = hmacBackup;
    }
  });

  it('TR-00 (control de armado): A llega a L2 de verdad y obtiene SU función', async () => {
    // Si esto no pasa, los fixtures no están llegando a L2 y TR-01/TR-02 están
    // verdes por no ejecutarse.
    const result = await maybeTransform(
      SOURCE,
      TARGET,
      OUTPUT,
      INPUT_SCHEMA,
      OWNER_A,
    );

    expect(result.bridgeType).toBe('CACHE_L2');
    expect(result.transformedOutput).toEqual({ query: 'DE-A' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('TR-01 [transform.ts:234]: con la MISMA clave de caché y dos dueños, A obtiene la suya y nunca la de B', async () => {
    const result = await maybeTransform(
      SOURCE,
      TARGET,
      OUTPUT,
      INPUT_SCHEMA,
      OWNER_A,
    );

    expect(result.transformedOutput).toEqual({ query: 'DE-A' });
    expect(result.transformedOutput).not.toEqual({ query: 'DE-B' });
    // Y la fila de B existe con la misma clave: lo único que la esconde es el
    // filtro por dueño.
    expect(
      fake
        .rows('kite_schema_transforms')
        .some((r) => r.owner_ref === OWNER_B && r.schema_hash === SCHEMA_HASH),
    ).toBe(true);
  });

  it('TR-01b [transform.ts:234]: si la ÚNICA fila de esa clave es de B, A no la ejecuta', async () => {
    // Éste es el escenario con la consecuencia real: sin el filtro, A recibe la
    // función de B y la CORRE sobre sus propios datos.
    seed([transformRow(OWNER_B, 'DE-B')]);

    const result = await maybeTransform(
      SOURCE,
      TARGET,
      OUTPUT,
      INPUT_SCHEMA,
      OWNER_A,
    );

    expect(result.transformedOutput).not.toEqual({ query: 'DE-B' });
    // A cayó al camino de miss (LLM), que es lo correcto: no tiene caché propia.
    expect(result.transformedOutput).toEqual({ query: 'DEL-LLM' });
    expect(result.bridgeType).not.toBe('CACHE_L2');
  });

  it('TR-02 [transform.ts:278]: la cadena del `hit_count` se arma acotada al dueño del caller', async () => {
    // ⚠️ ASERCIÓN DE FORMA DE LLAMADA, NO DE PROPIEDAD, y la diferencia está
    // declarada a propósito: este UPDATE nunca llega a la base (ver TR-02b), así
    // que no hay ningún efecto sobre el cual afirmar. Lo único observable es con
    // qué filtros se construyó.
    await maybeTransform(SOURCE, TARGET, OUTPUT, INPUT_SCHEMA, OWNER_A);

    const update = fake.queries.find((q) => q.kind === 'update');
    expect(
      update,
      'el UPDATE de hit_count debería haberse armado',
    ).toBeDefined();
    expect(
      update?.filters.some(([c, v]) => c === 'owner_ref' && v === OWNER_A),
    ).toBe(true);
    // Y no apunta al dueño equivocado.
    expect(
      update?.filters.some(([c, v]) => c === 'owner_ref' && v === OWNER_B),
    ).toBe(false);
  });

  it('TR-02b (hallazgo fijado): ese UPDATE se arma y NUNCA se envía a la base', async () => {
    // `transform.ts:269` es `void supabase...` sin `await` ni `.then()`. En
    // postgrest-js el request sale dentro de `then()`, así que la cadena queda
    // armada y sin enviar. Si algún día alguien le pone el `await`, este test se
    // pone rojo y hay que actualizar TR-02 para que afirme la propiedad (que el
    // `hit_count` que sube es el de la fila de A) en vez de la forma.
    await maybeTransform(SOURCE, TARGET, OUTPUT, INPUT_SCHEMA, OWNER_A);

    const update = fake.queries.find((q) => q.kind === 'update');
    expect(update?.resolved).toBe(false);
    // El SELECT de al lado sí se resolvió: la diferencia no es del falso.
    expect(fake.queries.some((q) => q.kind === 'select' && q.resolved)).toBe(
      true,
    );
    // Y el contador de la fila quedó como estaba.
    expect(
      fake.rows('kite_schema_transforms').find((r) => r.owner_ref === OWNER_A)
        ?.hit_count,
    ).toBe(5);
  });

  it('TR-03: una fila con `owner_ref = NULL` no se le entrega a nadie', async () => {
    // `kite_schema_transforms` es la única tabla con `owner_ref: string | null`
    // (`database.types.ts:2303`). Una fila con NULL no matchea
    // `.eq('owner_ref', X)` para ningún X: queda invisible para todos. Eso NO es
    // un IDOR, es un miss permanente — y este test distingue los dos casos.
    seed([transformRow(null, 'DE-NADIE')]);

    const result = await maybeTransform(
      SOURCE,
      TARGET,
      OUTPUT,
      INPUT_SCHEMA,
      OWNER_A,
    );

    expect(result.transformedOutput).not.toEqual({ query: 'DE-NADIE' });
    expect(result.transformedOutput).toEqual({ query: 'DEL-LLM' });
    // La fila sigue ahí, invisible.
    expect(
      fake.rows('kite_schema_transforms').some((r) => r.owner_ref === null),
    ).toBe(true);
  });
});
