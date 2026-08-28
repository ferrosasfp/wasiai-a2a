/**
 * `spendPolicyService` — INTEGRIDAD ANTE UNA FILA INCONSISTENTE (WKH-SEC-03).
 *
 * ⚠️ ESTE ARCHIVO NO PRUEBA AISLAMIENTO, Y DECIRLO ES LA MITAD DE SU VALOR.
 *
 * Estos tres filtros **no previenen un IDOR**, y no son tres rutas: son DOS
 * rutas y una función sin llamador. La versión anterior de este bloque decía
 * «las tres rutas» y citaba dos.
 *
 * ── `src/services/spend-policy.ts:163` y `src/services/spend-policy.ts:190`: SÍ hay ruta ──
 * Las dos son `/keys/me/spend-policies` (`src/routes/auth/spend-policy.ts:79` es
 * el `fastify.get`, `:106` el `fastify.delete`) y las dos pasan `callerKey.id`
 * **y** `callerKey.owner_ref`, dos campos de la **misma fila autenticada**
 * (`:94-95` y `:125-126`). No hay parámetro de ruta para la key: el caller no
 * puede pasar un `keyId` ajeno.
 *
 * ── `spend-policy.ts:219` (`hasAnyPolicy`) NO TIENE LLAMADOR DE PRODUCCIÓN ──
 * Medido: `grep -rn 'hasAnyPolicy' src --include=*.ts` da la definición
 * (`spend-policy.ts:214`), sus usos en dos archivos de test
 * (`src/services/spend-policy.test.ts:341,353` y este) y un `vi.fn()` de mock en
 * `src/routes/auth.spend-policies.test.ts:54`. **Ninguna ruta la llama**, y su
 * propio docblock lo admite (`spend-policy.ts:209-212`: «NO se usa en el
 * hot-path del débito […] Se expone para tests/diagnóstico»). **La única
 * superficie que ejercita este filtro es este test.** No se puede afirmar que
 * proteja una ruta, porque no hay ruta; lo que sí se puede afirmar es que el
 * filtro existe y que si mañana alguien le cuelga una, SP-03 ya está.
 *
 * Y en los tres: como una `key_id` pertenece a exactamente un dueño, en una base
 * **consistente** el filtro por `key_id` ya acota al dueño, así que borrar
 * `.eq('owner_ref', …)` **no cambia ninguna salida de ninguna ruta**.
 *
 * Lo que estos tests afirman es **integridad ante una fila inconsistente**: una
 * fila con `key_id = K` pero `owner_ref ≠ dueño(K)` no se le entrega al dueño de
 * K. Ese estado sólo existe si la base quedó inconsistente o si una key cambió
 * de dueño.
 *
 * **El fixture es deliberadamente inconsistente. No es un escenario de ataque.**
 *
 * Escribir acá "estos tres previenen un IDOR" sería exactamente la clase de
 * prosa que afirma de más que esta HU existe para sacar del repo.
 *
 * ⚠️ Y esa clase de prosa estuvo escrita acá mismo. La versión anterior de este
 * bloque decía que `src/services/spend-policy.ts:163`, `:190` y `:219` "se
 * pueden borrar hoy y la suite entera queda verde". **Es falso, y se midió**:
 * los tres ya tenían un espía de llamada preexistente en
 * `src/services/spend-policy.test.ts` (`:292`, `:311`, `:344`). Borrando `:163`,
 * ese archivo solo da `1 failed | 17 passed (18)` con
 * `× AC-7: filters by key_id and owner_ref`. Lo que un espía NO distingue es
 * "filtró" de "escribió el filtro y la consulta lo ignoró"; eso es lo que
 * agregan SP-01/02/03, sobre un falso que SÍ aplica los filtros.
 * (Desarrollado en `mutation-log.md` §N-2.)
 *
 * Naming: SP-01, SP-02, SP-03, más un control anti-vacuidad por cada uno.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn() },
}));

import { supabase } from '../lib/supabase.js';
import { createOwnerScopedFake } from './__tests__/owner-scoped-fake.js';
import { OwnershipMismatchError } from './security/errors.js';
import { spendPolicyService } from './spend-policy.js';

const OWNER_A = 'owner-A-0xaaaa';
const OWNER_B = 'owner-B-0xbbbb';
/** La key es de A. Que exista una fila suya marcada como de B es el defecto. */
const KEY_A = 'key-de-A';

const POLICY_COLUMNS = [
  'id',
  'key_id',
  'owner_ref',
  'destination',
  'max_usd',
  'window_type',
  'window_secs',
  'created_at',
  'updated_at',
];

function policyRow(
  id: string,
  ownerRef: string,
  destination: string,
): Record<string, unknown> {
  return {
    id,
    key_id: KEY_A,
    owner_ref: ownerRef,
    destination,
    max_usd: '10.000000',
    window_type: 'total',
    window_secs: null,
    created_at: '2026-08-05T00:00:00.000Z',
    updated_at: '2026-08-05T00:00:00.000Z',
  };
}

const mockFrom = vi.mocked(supabase.from);

function install(
  rows: Record<string, unknown>[],
): ReturnType<typeof createOwnerScopedFake> {
  const fake = createOwnerScopedFake({
    a2a_key_spend_policies: { columns: POLICY_COLUMNS, rows },
  });
  mockFrom.mockImplementation(
    (table: string) => fake.from(table) as ReturnType<typeof mockFrom>,
  );
  return fake;
}

describe('spendPolicyService — integridad ante fila inconsistente (WKH-SEC-03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('SP-01 [spend-policy.ts:163]: list(K, dueño(K)) no devuelve la fila con key_id=K y owner_ref=B', async () => {
    const fake = install([policyRow('p-de-B', OWNER_B, '0xdestino')]);
    // La fila existe y tiene la key_id del caller: lo único que la excluye es el
    // filtro por dueño.
    expect(
      fake.rows('a2a_key_spend_policies').some((r) => r.key_id === KEY_A),
    ).toBe(true);

    const policies = await spendPolicyService.list(KEY_A, OWNER_A);

    expect(policies).toEqual([]);
  });

  it('SP-01b (anti-vacuidad): list(K, dueño(K)) SÍ devuelve la fila consistente de A', async () => {
    install([
      policyRow('p-de-A', OWNER_A, '0xdestino-a'),
      policyRow('p-de-B', OWNER_B, '0xdestino-b'),
    ]);

    const policies = await spendPolicyService.list(KEY_A, OWNER_A);

    expect(policies.map((p) => p.destination)).toEqual(['0xdestino-a']);
  });

  it('SP-02 [spend-policy.ts:190]: delete(K, dueño(K), dest) no borra la fila de B y lanza OwnershipMismatchError', async () => {
    const fake = install([policyRow('p-de-B', OWNER_B, '0xdestino')]);

    await expect(
      spendPolicyService.delete(KEY_A, OWNER_A, '0xdestino'),
    ).rejects.toBeInstanceOf(OwnershipMismatchError);

    // LA ASERCIÓN QUE IMPORTA: la fila sigue ahí. El throw solo no dice que no
    // se haya borrado nada.
    expect(fake.rows('a2a_key_spend_policies')).toHaveLength(1);
    expect(fake.rows('a2a_key_spend_policies')[0]?.owner_ref).toBe(OWNER_B);
  });

  it('SP-02b (anti-vacuidad): delete(K, dueño(K), dest) SÍ borra la fila consistente de A', async () => {
    const fake = install([
      policyRow('p-de-A', OWNER_A, '0xdestino'),
      policyRow('p-de-B', OWNER_B, '0xotro'),
    ]);

    await expect(
      spendPolicyService.delete(KEY_A, OWNER_A, '0xdestino'),
    ).resolves.toBeUndefined();

    const left = fake.rows('a2a_key_spend_policies');
    expect(left).toHaveLength(1);
    expect(left[0]?.owner_ref).toBe(OWNER_B);
  });

  it('SP-03 [spend-policy.ts:219]: hasAnyPolicy(K, dueño(K)) es false si la única fila con key_id=K es de B', async () => {
    install([policyRow('p-de-B', OWNER_B, '0xdestino')]);

    await expect(spendPolicyService.hasAnyPolicy(KEY_A, OWNER_A)).resolves.toBe(
      false,
    );
  });

  it('SP-03b (anti-vacuidad): hasAnyPolicy(K, dueño(K)) es true con la fila consistente de A', async () => {
    install([policyRow('p-de-A', OWNER_A, '0xdestino')]);

    await expect(spendPolicyService.hasAnyPolicy(KEY_A, OWNER_A)).resolves.toBe(
      true,
    );
  });
});
