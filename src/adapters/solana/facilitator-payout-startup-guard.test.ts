/**
 * WKH-302 — guard de arranque del transporte del payout Solana.
 *
 * LA TRAMPA QUE ESTOS TESTS CANDAN, y por qué no alcanzaba con el comentario:
 * `.env.example` entrega `SOLANA_SETTLE_VIA_FACILITATOR=false` y, dos líneas
 * abajo, `SOLANA_FACILITATOR_URL=` VACÍA. Encender la primera es una línea. Con la
 * bandera en `'true'` y sin URL, cada leg de payout Solana reclama su intent, entra
 * a `settleViaFacilitator` y muere en `payoutViaFacilitator` con `'not-sent'` — de a
 * un leg por vez, en producción, y sin una sola señal en el arranque. El único
 * control que existía era prosa (`⛔ CONDICION PREVIA A ENCENDER …` en
 * `payment.ts`), y una prosa no impide un redeploy con la variable a medias.
 *
 * Las cuatro propiedades, y cada una tiene su mutación anotada:
 *   1. bandera ON + URL presente ⇒ el arranque SIGUE (el guard no brickea lo que
 *      funciona) — incluido el fallback `WASIAI_FACILITATOR_URL`, que es la misma
 *      resolución que usa el camino de request.
 *   2. bandera ON + URL ausente/en blanco ⇒ el arranque CORTA, nombrando las tres
 *      envs que hay que tocar.
 *   3. bandera APAGADA (y todo valor truthy-pero-no-`'true'`) ⇒ el arranque sigue
 *      igual que hoy, con o sin URL. Es el camino VIVO y no se toca.
 *   4. el rail Solana apagado ⇒ la bandera es INERTE y el guard no corre (romper el
 *      arranque de quien no usa Solana sería un outage autoinfligido).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetRegistry,
  getAdaptersBundle,
  getInitializedChainKeys,
  initAdapters,
} from '../registry.js';
import { payoutViaFacilitator } from './facilitator-settle.js';

// El bundle Solana se stubea: lo que se está probando es el GUARD del arranque,
// que corre ANTES de la factory (`registry.buildBundle`), no los adapters. El
// CAIP-2 es devnet para no disparar `assertNoSlugDestinationDrift`.
vi.mock('./index.js', () => ({
  createSolanaAdapters: vi.fn(async (_opts?: { network?: 'devnet' }) => ({
    payment: {
      name: 'solana',
      vmFamily: 'solana',
      caip2ChainId: 'solana:devnet',
    },
    attestation: { name: 'solana', chainId: 900001 },
    gasless: { name: 'solana', chainId: 900001 },
    identity: null,
    chainConfig: {
      name: 'Solana Devnet',
      chainId: 900001,
      explorerUrl: 'https://explorer.solana.com?cluster=devnet',
    },
  })),
}));

const ENV_KEYS = [
  'WASIAI_A2A_CHAINS',
  'WASIAI_A2A_CHAIN',
  'SOLANA_ADAPTER_ENABLED',
  'SOLANA_SETTLE_VIA_FACILITATOR',
  'SOLANA_FACILITATOR_URL',
  'WASIAI_FACILITATOR_URL',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  _resetRegistry();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetRegistry();
  vi.clearAllMocks();
});

/** Arranque REAL del registry con el rail Solana como única chain del CSV. */
function bootSolanaRail(): Promise<void> {
  process.env.WASIAI_A2A_CHAINS = 'solana-devnet';
  process.env.SOLANA_ADAPTER_ENABLED = 'true';
  return initAdapters();
}

describe('G-1 — bandera ON con la condición PRESENTE: el arranque funciona', () => {
  it('★ `SOLANA_FACILITATOR_URL` seteada ⇒ initAdapters resuelve y el bundle queda alcanzable', async () => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    process.env.SOLANA_FACILITATOR_URL = 'https://facilitator.test';

    await expect(bootSolanaRail()).resolves.toBeUndefined();

    expect(getInitializedChainKeys()).toEqual(['solana-devnet']);
    expect(getAdaptersBundle('solana-devnet')).toBeDefined();
  });

  it('★ sólo el fallback `WASIAI_FACILITATOR_URL` ⇒ TAMBIÉN arranca', async () => {
    // No es un detalle: `getFacilitatorUrl()` acepta ese fallback en el camino de
    // request. Un guard que exigiera únicamente la env específica rompería el
    // arranque de una config que SÍ paga. Mutación: quitar el fallback del
    // resolver (o duplicar el criterio en el guard) ⇒ este caso se pone rojo.
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    process.env.WASIAI_FACILITATOR_URL = 'https://facilitator.fallback.test';

    await expect(bootSolanaRail()).resolves.toBeUndefined();
    expect(getAdaptersBundle('solana-devnet')).toBeDefined();
  });
});

describe('G-2 — bandera ON con la condición AUSENTE: el arranque CORTA', () => {
  it('★ sin ninguna URL ⇒ initAdapters LANZA y el bundle NO queda registrado', async () => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';

    await expect(bootSolanaRail()).rejects.toThrow(
      /SOLANA_SETTLE_VIA_FACILITATOR is 'true' but no facilitator URL is configured/,
    );
    // Fail-loud ANTES de registrar: un rail que no puede pagar nunca queda
    // alcanzable por el money-path (mismo criterio que it2 BLQ-ALTO-1).
    expect(getAdaptersBundle('solana-devnet')).toBeUndefined();
  });

  it('★ el mensaje nombra las TRES envs que hay que tocar, no "config inválida"', async () => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';

    const err = await bootSolanaRail().catch((e: unknown) => e);
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg).toContain('SOLANA_FACILITATOR_URL');
    expect(msg).toContain('WASIAI_FACILITATOR_URL');
    expect(msg).toContain('SOLANA_SETTLE_VIA_FACILITATOR');
    // Y dice qué pasaría si arrancara igual, que es el dato que hoy no existe en
    // ningún lado hasta que un leg de dinero muere en producción.
    expect(msg).toMatch(/fail-closed/);
  });

  it.each([
    '',
    '   ',
  ])('★ URL en blanco (%j) cuenta como AUSENTE — el mismo criterio que el request path', async (blank) => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    process.env.SOLANA_FACILITATOR_URL = blank;

    await expect(bootSolanaRail()).rejects.toThrow(
      /no facilitator URL is configured/,
    );
  });
});

describe('G-3 — el camino de HOY (bandera apagada) queda idéntico', () => {
  it('★ bandera ausente + sin URL ⇒ arranca (es la config de producción de hoy)', async () => {
    expect(process.env.SOLANA_SETTLE_VIA_FACILITATOR).toBeUndefined();

    await expect(bootSolanaRail()).resolves.toBeUndefined();
    expect(getAdaptersBundle('solana-devnet')).toBeDefined();
  });

  it.each([
    'false',
    '1',
    'TRUE',
    'yes',
    '',
  ])("★ valor %j (truthy-pero-no-'true') ⇒ arranca SIN URL, porque toma el camino legado", async (value) => {
    // La ramificación de `settle()` compara literal contra 'true'
    // (`payment.ts`). El guard usa EXACTAMENTE la misma comparación: si fuera
    // `Boolean(process.env.X)`, estos cinco valores brickearían un arranque que
    // hoy funciona y que firma localmente. Mutación probada, ver el reporte.
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = value;

    await expect(bootSolanaRail()).resolves.toBeUndefined();
    expect(getAdaptersBundle('solana-devnet')).toBeDefined();
  });
});

describe('G-4 — sin rail Solana la bandera es INERTE y el guard no corre', () => {
  it('★ `SOLANA_ADAPTER_ENABLED` apagado ⇒ el slug ni siquiera se acepta, y el arranque no depende del facilitator', async () => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    // Sin `SOLANA_ADAPTER_ENABLED` el slug no está soportado: el fail-fast del
    // registry lo rechaza por OTRO motivo, y ese mensaje no menciona facilitator.
    process.env.WASIAI_A2A_CHAINS = 'solana-devnet';

    const err = await initAdapters().catch((e: unknown) => e);
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg).toMatch(/Unsupported chain 'solana-devnet'/);
    expect(msg).not.toContain('facilitator');
  });
});

describe('G-5 — la mitad de request: sin URL el leg muere "not-sent", sin salir a la red', () => {
  it('★ `payoutViaFacilitator` sin URL lanza `not-sent` y NUNCA hace fetch', async () => {
    // Esta es la línea que el guard de arranque adelanta al boot. Se testea acá
    // para que quede claro QUÉ es lo que dejaba de pasar en silencio: el leg no
    // "falla raro", declara que el request nunca salió — y con la bandera ON no
    // hay fallback local que lo rescate (T-CD15, `payment.flag.test.ts`).
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const err = await payoutViaFacilitator({
      intentId: 'guard:0',
      payTo: 'So11111111111111111111111111111111111111112',
      amountAtomic: '3000000',
      network: 'solana:devnet',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as { valueDisposition?: string }).valueDisposition).toBe(
      'not-sent',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
