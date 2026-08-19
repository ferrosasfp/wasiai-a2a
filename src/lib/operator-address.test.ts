/**
 * operator-address — WKH-316 · T-316-11.
 *
 * Lo que fija este archivo: `resolveOperatorAddress` **nunca lanza** y devuelve
 * `null` cuando este proceso no puede resolver su propia dirección. Esa es la
 * precondición de AC-6: si pudiera lanzar, una env de firma faltante tumbaría
 * `POST /agents` entero en vez de saltear un guard decorativo.
 *
 * ⚠️ POR QUÉ CADA CASO RE-IMPORTA EL MÓDULO. `resolveOperatorAddress` cachea por
 * proceso y por familia, **incluido el `null`**. Sin `vi.resetModules()` el primer
 * `it` de este archivo decidiría el resultado de todos los demás, y los tests
 * negativos pasarían por herencia en vez de por medición. El helper `fresh()`
 * existe para eso y para nada más.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('./logger.js', () => ({ getLogger: () => logSpy }));

// El keypair de Solana entra por `await import()` (CD-13). `vi.mock` lo
// intercepta igual: lo que se mockea es el módulo, no la forma del import.
const solanaKeypair = vi.hoisted(() => vi.fn());
vi.mock('../adapters/solana/chain.js', () => ({
  getSolanaOperatorKeypair: () => solanaKeypair(),
}));

/** Clave privada EVM de test. Determinista y sin fondos en ninguna red. */
const TEST_PK = `0x${'11'.repeat(32)}`;
/**
 * Address derivada de `TEST_PK`. MEDIDA, no supuesta:
 * `node -e "privateKeyToAccount('0x11…11').address"` → este literal.
 * Está escrita a mano a propósito: si el test la derivara con la misma función
 * que el módulo bajo prueba, no probaría nada más que que viem es determinista.
 */
const TEST_ADDRESS = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';

const SOL_PUBKEY = 'So11111111111111111111111111111111111111112';

/** Re-importa el módulo con el cache vacío. */
async function fresh(): Promise<typeof import('./operator-address.js')> {
  vi.resetModules();
  return import('./operator-address.js');
}

const ORIGINAL_PK = process.env.OPERATOR_PRIVATE_KEY;

beforeEach(() => {
  logSpy.error.mockClear();
  logSpy.warn.mockClear();
  logSpy.info.mockClear();
  solanaKeypair.mockReset();
});

afterEach(() => {
  if (ORIGINAL_PK === undefined) {
    delete process.env.OPERATOR_PRIVATE_KEY;
  } else {
    process.env.OPERATOR_PRIVATE_KEY = ORIGINAL_PK;
  }
});

describe('resolveOperatorAddress — familia evm', () => {
  it('T-316-11: OPERATOR_PRIVATE_KEY ausente → null sin lanzar, y loguea PAYTO_OPERATOR_CHECK_SKIPPED', async () => {
    delete process.env.OPERATOR_PRIVATE_KEY;
    const { resolveOperatorAddress } = await fresh();

    await expect(resolveOperatorAddress('evm')).resolves.toBeNull();

    const codes = logSpy.info.mock.calls.map(
      (c) => (c[0] as { code: string }).code,
    );
    expect(codes).toContain('PAYTO_OPERATOR_CHECK_SKIPPED');
  });

  it('T-316-11: OPERATOR_PRIVATE_KEY basura → null sin lanzar, y el log lleva el MENSAJE del error', async () => {
    process.env.OPERATOR_PRIVATE_KEY = 'no-soy-una-clave';
    const { resolveOperatorAddress } = await fresh();

    await expect(resolveOperatorAddress('evm')).resolves.toBeNull();

    expect(logSpy.warn).toHaveBeenCalledTimes(1);
    const payload = logSpy.warn.mock.calls[0]?.[0] as {
      code: string;
      family: string;
      err: string;
    };
    expect(payload.code).toBe('PAYTO_OPERATOR_CHECK_SKIPPED');
    expect(payload.family).toBe('evm');
    // El mensaje del error, no un string vacío ni un `[object Object]`: sin él el
    // operador no puede distinguir "no seteé la env" de "la seteé mal".
    expect(payload.err.length).toBeGreaterThan(0);
    expect(payload.err).not.toBe('[object Object]');
    // Y NUNCA el secreto.
    expect(payload.err).not.toContain('no-soy-una-clave');
  });

  // Gemelo positivo (CD-A4): sin este caso, un `return null` incondicional
  // pasaría los dos tests negativos de arriba.
  it('T-316-11 (gemelo positivo): con una clave válida devuelve la address derivada', async () => {
    process.env.OPERATOR_PRIVATE_KEY = TEST_PK;
    const { resolveOperatorAddress } = await fresh();

    await expect(resolveOperatorAddress('evm')).resolves.toBe(TEST_ADDRESS);
    expect(logSpy.warn).not.toHaveBeenCalled();
  });

  it('cachea el resultado por familia: cambiar la env después NO cambia la respuesta', async () => {
    process.env.OPERATOR_PRIVATE_KEY = TEST_PK;
    const { resolveOperatorAddress } = await fresh();
    await expect(resolveOperatorAddress('evm')).resolves.toBe(TEST_ADDRESS);

    delete process.env.OPERATOR_PRIVATE_KEY;
    await expect(resolveOperatorAddress('evm')).resolves.toBe(TEST_ADDRESS);
  });

  it('cachea también el null: el log de skip sale UNA vez, no una por llamada', async () => {
    delete process.env.OPERATOR_PRIVATE_KEY;
    const { resolveOperatorAddress } = await fresh();

    await expect(resolveOperatorAddress('evm')).resolves.toBeNull();
    await expect(resolveOperatorAddress('evm')).resolves.toBeNull();
    await expect(resolveOperatorAddress('evm')).resolves.toBeNull();

    expect(logSpy.info).toHaveBeenCalledTimes(1);
  });
});

describe('resolveOperatorAddress — familia solana', () => {
  it('T-316-11: el keypair LANZA (aserción WKH-315) → null sin propagar, con el mensaje logueado', async () => {
    solanaKeypair.mockImplementation(() => {
      throw new Error(
        'A2A_DEPOSIT_OWNER_SOLANA (X) is not the solana operator pubkey (Y)',
      );
    });
    const { resolveOperatorAddress } = await fresh();

    await expect(resolveOperatorAddress('solana')).resolves.toBeNull();

    expect(logSpy.warn).toHaveBeenCalledTimes(1);
    const payload = logSpy.warn.mock.calls[0]?.[0] as {
      code: string;
      family: string;
      err: string;
    };
    expect(payload.code).toBe('PAYTO_OPERATOR_CHECK_SKIPPED');
    expect(payload.family).toBe('solana');
    // El mensaje de la aserción de WKH-315 llega entero al log del servidor. Si
    // el `catch` fuera silencioso, un error de configuración del depósito se
    // volvería mudo justo cuando alguien publica.
    expect(payload.err).toContain('is not the solana operator pubkey');
  });

  it('T-316-11 (gemelo positivo): con keypair cargado devuelve la pubkey base58', async () => {
    solanaKeypair.mockReturnValue({
      publicKey: { toBase58: () => SOL_PUBKEY },
    });
    const { resolveOperatorAddress } = await fresh();

    await expect(resolveOperatorAddress('solana')).resolves.toBe(SOL_PUBKEY);
    expect(logSpy.warn).not.toHaveBeenCalled();
  });

  it('las dos familias se cachean por separado', async () => {
    process.env.OPERATOR_PRIVATE_KEY = TEST_PK;
    solanaKeypair.mockReturnValue({
      publicKey: { toBase58: () => SOL_PUBKEY },
    });
    const { resolveOperatorAddress } = await fresh();

    await expect(resolveOperatorAddress('evm')).resolves.toBe(TEST_ADDRESS);
    await expect(resolveOperatorAddress('solana')).resolves.toBe(SOL_PUBKEY);
    // Una sola carga del keypair pese a las dos llamadas de arriba más ésta.
    await expect(resolveOperatorAddress('solana')).resolves.toBe(SOL_PUBKEY);
    expect(solanaKeypair).toHaveBeenCalledTimes(1);
  });
});
