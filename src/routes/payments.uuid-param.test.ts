/**
 * `:id` sin forma de UUID en las cuatro superficies de escritura de
 * `src/routes/payments.ts` (WKH-345). T-4a..T-4e.
 *
 * ── POR QUÉ ESTE ARCHIVO Y NO `payments.test.ts` ──────────────────────────
 *
 * `payments.test.ts` mockea `paymentIntentService` pero NO `arbiterService`, y
 * T-4c/T-4e necesitan espiar `openDispute` y manejar `ARBITER_ENABLED`. Meterle
 * un `vi.mock` nuevo a ese archivo perturbaría el grafo de mocks de 20+ tests
 * que ya andan. Un archivo dedicado por HU es la convención acá
 * (`payments.dispute-ownership.test.ts`, `tasks.no-charge-before-validating.test.ts`).
 *
 * ── LA TRAMPA DEL MOCK DE ARBITER ─────────────────────────────────────────
 *
 * De `../services/arbiter.js` se mockea SÓLO `arbiterService`. `isArbiterEnabled`
 * queda REAL vía `importActual`, y el flag se maneja por env con backup/restore.
 * Si se mockeara también el flag, T-4e pasaría a testear el mock en vez del gate
 * y dejaría de medir el orden que fija D-3.
 *
 * ── QUÉ MATA A ESTOS TESTS ────────────────────────────────────────────────
 *
 * El mutante de una línea `return UUID_RE.test(id)` → `return true` en
 * `src/lib/uuid.ts` anula el guard en las cinco superficies a la vez, y pone
 * rojos T-4a..T-4d. El aserto de `not.toHaveBeenCalled()` es el único que además
 * mata "mover el guard adentro del try". T-4e mata el mutante contrario: subir
 * el guard por encima del gate `isArbiterEnabled()`.
 *
 * T-4-POS es el control positivo: sin él, los cuatro asertos de ausencia
 * estarían sobre un conjunto vacío y aplaudirían cualquier implementación —
 * incluido un guard que rechace TODO.
 */

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockService = vi.hoisted(() => ({
  openSession: vi.fn(),
  addVoucher: vi.fn(),
  closeSession: vi.fn(),
  createUpto: vi.fn(),
  settleUpto: vi.fn(),
  expireStale: vi.fn(),
  verifyCapSignature: vi.fn(),
}));

vi.mock('../services/payment-intent.js', async () => {
  const actual = await vi.importActual<
    typeof import('../services/payment-intent.js')
  >('../services/payment-intent.js');
  return { ...actual, paymentIntentService: mockService };
});

// SÓLO el service. `isArbiterEnabled` se conserva REAL (ver docblock).
const mockArbiter = vi.hoisted(() => ({
  openDispute: vi.fn(),
}));

vi.mock('../services/arbiter.js', async () => {
  const actual = await vi.importActual<typeof import('../services/arbiter.js')>(
    '../services/arbiter.js',
  );
  return { ...actual, arbiterService: mockArbiter };
});

const mockResolveCallerKey = vi.hoisted(() => vi.fn());
vi.mock('./auth/parsers.js', () => ({
  resolveCallerKey: mockResolveCallerKey,
}));

vi.mock('../adapters/registry.js', () => ({
  getChainConfig: () => ({ name: 'kite', chainId: 2368, explorerUrl: '' }),
}));

// Si el guard desapareciera, el handler seguiría hasta acá. Con supabase
// mockeado el fallo se ve como "el service SÍ fue llamado", no como un error de
// red.
vi.mock('../lib/supabase.js', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}));

import { isArbiterEnabled } from '../services/arbiter.js';
import { paymentsRoutes } from './payments.js';

const FUNDING = '0xabc0000000000000000000000000000000000001';

/** El id que hoy provoca el 22P02 de Postgres y termina en 500. */
const MALFORMED = 'not-a-uuid';
/** Forma de UUID válida, para el control positivo. */
const VALID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function activeKey(): void {
  mockResolveCallerKey.mockResolvedValue({
    is_active: true,
    owner_ref: 'tenant-A',
    funding_wallet: FUNDING,
  });
}

async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  await app.register(paymentsRoutes, { prefix: '/payments' });
  await app.ready();
  return app;
}

let arbiterBackup: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  arbiterBackup = process.env.ARBITER_ENABLED;
  activeKey();
});

afterEach(() => {
  if (arbiterBackup === undefined) {
    delete process.env.ARBITER_ENABLED;
  } else {
    process.env.ARBITER_ENABLED = arbiterBackup;
  }
});

describe('payments — `:id` sin forma de UUID (WKH-345)', () => {
  it('T-4a (AC-4) POST /session/:id/voucher con body VÁLIDO → 422 INVALID_INPUT, addVoucher NOT llamado', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/payments/session/${MALFORMED}/voucher`,
      // Body válido a propósito: si fuera inválido, el 422 podría venir de la
      // validación de body y el test no mediría el guard.
      payload: { voucherId: 'v-1', amountUsd: 1 },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error_code).toBe('INVALID_INPUT');
    expect(mockService.addVoucher).not.toHaveBeenCalled();
    await app.close();
  });

  it('T-4b (AC-4) POST /session/:id/close → 422 INVALID_INPUT, closeSession NOT llamado', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/payments/session/${MALFORMED}/close`,
      payload: {},
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error_code).toBe('INVALID_INPUT');
    expect(mockService.closeSession).not.toHaveBeenCalled();
    await app.close();
  });

  it('T-4c (AC-4) POST /session/:id/dispute con ARBITER_ENABLED=true → 422 INVALID_INPUT, openDispute NOT llamado', async () => {
    process.env.ARBITER_ENABLED = 'true';
    // No-tautológico: el gate real está ABIERTO, así que el 422 sólo puede venir
    // del guard de forma y no del 404 del flag.
    expect(isArbiterEnabled()).toBe(true);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/payments/session/${MALFORMED}/dispute`,
      payload: {},
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error_code).toBe('INVALID_INPUT');
    expect(mockArbiter.openDispute).not.toHaveBeenCalled();
    await app.close();
  });

  it('T-4d (AC-4) POST /upto/:id/settle con body VÁLIDO → 422 INVALID_INPUT, settleUpto NOT llamado', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/payments/upto/${MALFORMED}/settle`,
      payload: { reportedUsageUsd: 2 },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error_code).toBe('INVALID_INPUT');
    expect(mockService.settleUpto).not.toHaveBeenCalled();
    await app.close();
  });

  // T-4e — el ORDEN del guard (D-3), y es el único test de esta HU que espera un
  // status que NO es el del guard.
  //
  // Con `ARBITER_ENABLED` apagado la ruta responde 404, byte-idéntico a "no
  // existe" (`payments.ts:336-338` lo declara). Si el guard se subiera por
  // encima del gate del flag, este pedido devolvería 422 y le anunciaría a un
  // desconocido que la ruta existe: una regresión de disclosure, no un detalle
  // de orden. Mutante que lo mata: mover el `if (!isValidUUID(...))` arriba del
  // `if (!isArbiterEnabled())`.
  //
  // ⚠️ NO BORRAR, NI "SIMPLIFICAR" EL `:id` A UNO BIEN FORMADO. Medido en
  // `c3b7333` con ese mutante aplicado: **es el único rojo del repo entero**, y
  // `src/services/arbiter.test.ts` queda 64/64 en verde. Ese archivo tenía un
  // segundo testigo del mismo orden mientras inyectaba con `'i1'`; al pasar a un
  // UUID válido dejó de poder distinguir los dos órdenes. O sea que hoy este test
  // es la ÚNICA cobertura de D-3 en el repo: si se va, la propiedad queda sin
  // testigo y la suite no se pone roja. Con un `:id` válido acá tampoco hay
  // testigo, porque el guard deja pasar el pedido en cualquiera de los dos
  // órdenes.
  it('T-4e (D-3) POST /session/:id/dispute con ARBITER_ENABLED apagado → 404 NOT_FOUND, NO 422', async () => {
    delete process.env.ARBITER_ENABLED;
    expect(isArbiterEnabled()).toBe(false);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/payments/session/${MALFORMED}/dispute`,
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error_code).toBe('NOT_FOUND');
    expect(res.statusCode).not.toBe(422);
    expect(mockArbiter.openDispute).not.toHaveBeenCalled();
    await app.close();
  });

  // Control positivo. Sin este test, los cuatro `not.toHaveBeenCalled()` de
  // arriba estarían sobre un conjunto vacío: un guard que rechazara TODO id,
  // incluidos los legítimos, los dejaría verdes igual.
  it('T-4-POS un :id con forma válida SÍ llega al service (control positivo de AC-5)', async () => {
    mockService.closeSession.mockResolvedValue({
      status: 'settled',
      txHash: null,
      consumedUsd: 0,
      residualUsd: 0,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/payments/session/${VALID}/close`,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(mockService.closeSession).toHaveBeenCalledWith(
      VALID,
      'tenant-A',
      false,
      undefined,
    );
    await app.close();
  });
});
