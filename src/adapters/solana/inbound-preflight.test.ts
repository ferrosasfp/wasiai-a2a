/**
 * WKH-314 — unit del preflight inbound (`inbound-preflight.ts`). T-COL-*, T-PRE-*.
 *
 * ── EL TEST QUE JUSTIFICA EL ARCHIVO: T-COL-01 ─────────────────────────────
 *
 * Si `SOLANA_X402_INBOUND_PAY_TO` fuera la cuenta de depósito de WKH-315, **una sola
 * transferencia se cobraría DOS VECES**: una como crédito de saldo prepago y otra como
 * prueba de pago x402. Los dos stores son distintos y ninguno mira al otro, así que
 * nada lo detectaría después. Este guard es lo único que lo impide, y viene con sus
 * DOS gemelos positivos (direcciones distintas ⇒ pasa; sin cuenta de depósito ⇒ pasa).
 */

import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({ getLogger: () => logSpy }));

const storeProbe = vi.hoisted(() => vi.fn());
vi.mock('../../services/solana-inbound-proof.js', () => ({
  probeInboundProofStore: storeProbe,
}));

const historyProbe = vi.hoisted(() => vi.fn());
vi.mock('./schema-preflight.js', () => ({
  probeRpcHistoryRetention: historyProbe,
}));

const tokenAccounts = vi.hoisted(() => vi.fn());
vi.mock('./chain.js', async () => {
  const actual =
    await vi.importActual<typeof import('./chain.js')>('./chain.js');
  return {
    ...actual,
    getSolanaConnection: () => ({ getTokenAccountsByOwner: tokenAccounts }),
  };
});

import { _resetSolanaChain } from './chain.js';
import {
  _resetSolanaInboundPreflight,
  ensureSolanaInboundReady,
} from './inbound-preflight.js';

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const INBOUND_WALLET = Keypair.generate().publicKey.toBase58();
const DEPOSIT_OWNER = Keypair.generate().publicKey.toBase58();

function ataOf(owner: string): string {
  return getAssociatedTokenAddressSync(
    new PublicKey(MINT),
    new PublicKey(owner),
  ).toBase58();
}

function configure(over: Record<string, string | undefined> = {}): void {
  const env: Record<string, string | undefined> = {
    SOLANA_ADAPTER_ENABLED: 'true',
    SOLANA_X402_INBOUND_ENABLED: 'true',
    SOLANA_X402_INBOUND_PAY_TO: INBOUND_WALLET,
    SOLANA_X402_INBOUND_CHALLENGE_SECRET: 'z'.repeat(48),
    SOLANA_USDC_MINT_DEVNET: MINT,
    A2A_DEPOSIT_OWNER_SOLANA: DEPOSIT_OWNER,
    SOLANA_RPC_URL_FALLBACK: undefined,
    ...over,
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  _resetSolanaInboundPreflight();
  _resetSolanaChain();
  storeProbe.mockReset().mockResolvedValue({ probe: 'ok' });
  historyProbe.mockReset().mockResolvedValue(null);
  tokenAccounts.mockReset().mockResolvedValue({ value: [{}] });
  logSpy.warn.mockClear();
  logSpy.error.mockClear();
  configure();
});

describe('WKH-314 · preflight inbound — la colisión con la cuenta de depósito', () => {
  it('T-COL-01 💰 · `payTo` == la ATA de depósito ⇒ FALLA CERRADO', async () => {
    configure({ SOLANA_X402_INBOUND_PAY_TO: ataOf(DEPOSIT_OWNER) });
    _resetSolanaInboundPreflight();
    const v = await ensureSolanaInboundReady();
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.failure).toBe('payto_collides_with_deposit');
    expect(v.detail).toContain('SOLANA_INBOUND_PAYTO_COLLIDES_WITH_DEPOSIT');
  });

  it('T-COL-01b 💰 · `payTo` == el OWNER de depósito (misma ATA derivada) ⇒ FALLA CERRADO', async () => {
    // El caso realista: el operador pone la misma WALLET en las dos envs. La ATA que
    // se deriva es la misma, así que la plata aterrizaría en la misma cuenta.
    configure({ SOLANA_X402_INBOUND_PAY_TO: DEPOSIT_OWNER });
    _resetSolanaInboundPreflight();
    const v = await ensureSolanaInboundReady();
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.failure).toBe('payto_collides_with_deposit');
  });

  it('T-COL-02 · GEMELO POSITIVO: direcciones distintas ⇒ el preflight pasa', async () => {
    const v = await ensureSolanaInboundReady();
    expect(v.ok).toBe(true);
  });

  it('T-COL-03 · SEGUNDO GEMELO: sin cuenta de depósito configurada ⇒ pasa (no hay colisión posible)', async () => {
    configure({ A2A_DEPOSIT_OWNER_SOLANA: undefined });
    _resetSolanaInboundPreflight();
    const v = await ensureSolanaInboundReady();
    expect(v.ok).toBe(true);
  });
});

describe('WKH-314 · preflight inbound — los otros guards', () => {
  it('T-PRE-01 💰 · sin config completa NO se declara listo', async () => {
    configure({ SOLANA_X402_INBOUND_PAY_TO: undefined });
    _resetSolanaInboundPreflight();
    _resetSolanaChain();
    const v = await ensureSolanaInboundReady();
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.failure).toBe('not_configured');
  });

  it('T-PRE-02 💰 · la tabla ausente y la base caída son motivos DISTINTOS', async () => {
    storeProbe.mockResolvedValue({ probe: 'table_missing', detail: 'x' });
    _resetSolanaInboundPreflight();
    const a = await ensureSolanaInboundReady();
    expect(a.ok === false && a.failure).toBe('store_table_missing');

    storeProbe.mockResolvedValue({ probe: 'failed', detail: 'x' });
    _resetSolanaInboundPreflight();
    const b = await ensureSolanaInboundReady();
    expect(b.ok === false && b.failure).toBe('store_probe_failed');

    storeProbe.mockResolvedValue({ probe: 'rpc_missing', detail: 'x' });
    _resetSolanaInboundPreflight();
    const c = await ensureSolanaInboundReady();
    expect(c.ok === false && c.failure).toBe('store_rpc_missing');
  });

  it('T-PRE-03 💰 · la retención de histórico del RPC apaga el camino', async () => {
    historyProbe.mockResolvedValue({
      ok: false,
      failure: 'rpc_history_insufficient',
      detail: 'x',
    });
    _resetSolanaInboundPreflight();
    const v = await ensureSolanaInboundReady();
    expect(v.ok === false && v.failure).toBe('rpc_history_insufficient');
  });

  it('T-PRE-04 💰 · un fallback que se declara de MAINNET falla cerrado (CD-5)', async () => {
    configure({
      SOLANA_RPC_URL_FALLBACK: 'https://api.mainnet-beta.solana.com',
    });
    _resetSolanaInboundPreflight();
    _resetSolanaChain();
    const v = await ensureSolanaInboundReady();
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.failure).toBe('fallback_rpc_invalid');
  });

  it('T-PRE-04b · GEMELO POSITIVO: un segundo endpoint de devnet pasa', async () => {
    configure({ SOLANA_RPC_URL_FALLBACK: 'https://devnet.example.com/rpc' });
    _resetSolanaInboundPreflight();
    _resetSolanaChain();
    const v = await ensureSolanaInboundReady();
    expect(v.ok).toBe(true);
  });

  it('T-PRE-04c 💰 · el RPC **PRIMARIO** declarado de mainnet falla cerrado (CD-5)', async () => {
    // ⚠️ ESTE ERA EL AGUJERO (AR de WKH-314, BLQ-MED-3). El guard anti-mainnet existía
    // sólo para el fallback, que es OPCIONAL. `SOLANA_RPC_URL` es OBLIGATORIA y es la
    // que construye la `Connection` primaria: con ella apuntando a mainnet, el preflight
    // pasaba, el rail arrancaba, y toda la verificación de cobros se hacía contra otro
    // ledger. El fallback ni siquiera hace falta para tener el problema.
    configure({ SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com' });
    _resetSolanaInboundPreflight();
    _resetSolanaChain();
    try {
      const v = await ensureSolanaInboundReady();
      expect(v.ok).toBe(false);
      if (v.ok) return;
      expect(v.failure).toBe('primary_rpc_is_mainnet');
      expect(v.detail).toContain('SOLANA_RPC_URL');
      // Y corta ANTES de gastar la base y el RPC: si midiéramos contra otra red, un
      // "ok" de esos probes no significaría nada.
      expect(storeProbe).not.toHaveBeenCalled();
      expect(historyProbe).not.toHaveBeenCalled();
    } finally {
      delete process.env.SOLANA_RPC_URL;
      _resetSolanaChain();
    }
  });

  it('T-PRE-04d · GEMELO POSITIVO: el default de devnet (y una URL de devnet) pasan', async () => {
    // El control de que el guard no apagó el rail entero.
    configure();
    _resetSolanaInboundPreflight();
    _resetSolanaChain();
    expect((await ensureSolanaInboundReady()).ok).toBe(true);

    configure({ SOLANA_RPC_URL: 'https://api.devnet.solana.com' });
    _resetSolanaInboundPreflight();
    _resetSolanaChain();
    try {
      expect((await ensureSolanaInboundReady()).ok).toBe(true);
    } finally {
      delete process.env.SOLANA_RPC_URL;
      _resetSolanaChain();
    }
  });

  it('T-PRE-06 · sin `SOLANA_RPC_URL_FALLBACK` el rail arranca, pero AVISA (MNR-1)', async () => {
    // No apaga nada: un solo proveedor es una config válida que falla en la dirección
    // segura. Lo que no puede ser es que la degradación de DT-10 sea silenciosa.
    configure({ SOLANA_RPC_URL_FALLBACK: undefined });
    _resetSolanaInboundPreflight();
    _resetSolanaChain();
    const v = await ensureSolanaInboundReady();
    expect(v.ok).toBe(true);
    const warned = logSpy.warn.mock.calls
      .map((c) => JSON.stringify(c))
      .join(' ');
    expect(warned).toContain('SOLANA_RPC_URL_FALLBACK is not set');
  });

  it('T-PRE-06b 💰 · un fallback IGUAL al primario avisa: no son dos opiniones', async () => {
    configure({
      SOLANA_RPC_URL: 'https://devnet.example.com/rpc',
      SOLANA_RPC_URL_FALLBACK: 'https://devnet.example.com/rpc',
    });
    _resetSolanaInboundPreflight();
    _resetSolanaChain();
    try {
      const v = await ensureSolanaInboundReady();
      expect(v.ok).toBe(true);
      const warned = logSpy.warn.mock.calls
        .map((c) => JSON.stringify(c))
        .join(' ');
      expect(warned).toContain('SAME url');
    } finally {
      delete process.env.SOLANA_RPC_URL;
      _resetSolanaChain();
    }
  });

  it('T-PRE-05 · la cuenta de token es una SEÑAL, no un guard: avisa y NO apaga', async () => {
    // DT-C3: el crédito se mide SUMANDO sobre todas las cuentas del destinatario, así
    // que dos cuentas son un caso que el código maneja bien. Apagar el rail por eso
    // sería romperlo por una condición correcta.
    tokenAccounts.mockResolvedValue({ value: [{}, {}] });
    _resetSolanaInboundPreflight();
    const v = await ensureSolanaInboundReady();
    expect(v.ok).toBe(true);
    expect(logSpy.warn).toHaveBeenCalled();
  });

  it('T-PRE-06 · el guard del store corre ANTES que el chequeo informativo', async () => {
    // Si el orden fuera al revés, una base caída gastaría una llamada al RPC antes de
    // fallar por algo que no depende de ella.
    storeProbe.mockResolvedValue({ probe: 'table_missing', detail: 'x' });
    _resetSolanaInboundPreflight();
    await ensureSolanaInboundReady();
    expect(tokenAccounts).not.toHaveBeenCalled();
  });

  it('T-PRE-07 · un veredicto positivo se cachea (un probe, no uno por request)', async () => {
    await ensureSolanaInboundReady();
    await ensureSolanaInboundReady();
    await ensureSolanaInboundReady();
    expect(storeProbe).toHaveBeenCalledTimes(1);
  });

  it('T-PRE-08 💰 · un throw inesperado NO se lee como listo', async () => {
    storeProbe.mockRejectedValue(new Error('boom'));
    _resetSolanaInboundPreflight();
    const v = await ensureSolanaInboundReady();
    expect(v.ok).toBe(false);
  });
});
