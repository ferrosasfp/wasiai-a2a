/**
 * WKH-315 · AC-7 / AC-8 — `identityService.bindSolanaFundingWallet`.
 *
 * Archivo NUEVO y aditivo: `identity.test.ts` no se toca (CD-1).
 *
 * ── LA PROPIEDAD QUE ESTE ARCHIVO CANDA (M7) ────────────────────────────────
 *
 * Que la pubkey se persista **byte-exacta**, sin `toLowerCase()`. base58 usa
 * mayúsculas y minúsculas como símbolos DISTINTOS: bajar de caja una pubkey no la
 * normaliza, la **destruye**, y mapea pubkeys diferentes al mismo valor almacenado —
 * colisiones en un índice UNIQUE cuyo propósito es justamente impedir que dos keys
 * reclamen la misma wallet.
 *
 * ── CD-9: EL DOBLE CAPTURA SUS ARGS Y SE ASSERTA SOBRE ELLOS ────────────────
 *
 * `T-315-09b` no verifica el valor de RETORNO (que podría ser correcto mientras se
 * persiste otra cosa): **captura el argumento del `.update()`** y asserta sobre él.
 * Sin eso, un `toLowerCase()` en la escritura pasaría desapercibido mientras la
 * función devuelve el original.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn() },
}));

import { Keypair } from '@solana/web3.js';
import { supabase } from '../lib/supabase.js';
import { identityService } from './identity.js';
import {
  FundingWalletAlreadyBoundError,
  OwnershipMismatchError,
} from './security/errors.js';

const mockFrom = vi.mocked(supabase.from);

const KEY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OWNER_REF = 'user-1';

/**
 * Doble de la cadena de supabase que **CAPTURA** los args de `.update()` y de cada
 * `.eq()`, y resuelve con lo que se le pide.
 */
function chainSpy(result: {
  data?: unknown[] | null;
  error?: { code?: string; message: string } | null;
}) {
  const updateArgs: unknown[] = [];
  const eqArgs: [string, unknown][] = [];
  const chain: Record<string, unknown> = {
    update: vi.fn((payload: unknown) => {
      updateArgs.push(payload);
      return chain;
    }),
    eq: vi.fn((col: string, val: unknown) => {
      eqArgs.push([col, val]);
      return chain;
    }),
    select: vi.fn(() =>
      Promise.resolve({
        data: result.data ?? null,
        error: result.error ?? null,
      }),
    ),
  };
  mockFrom.mockReturnValue(
    chain as unknown as ReturnType<typeof supabase.from>,
  );
  return { updateArgs, eqArgs, chain };
}

describe('WKH-315 · identityService.bindSolanaFundingWallet', () => {
  it('T-315-09b (M7, CD-9): persiste la pubkey BYTE-EXACTA — el arg del .update() se CAPTURA y se assertea', () => {
    // ⚠️ EL MUTANTE M7. Si la implementación recuperara `pubkey.toLowerCase()`, el
    // valor de retorno podría seguir siendo el original y este test es el único que
    // mira lo que REALMENTE se escribe en la base.
    const pubkey = Keypair.generate().publicKey.toBase58();
    // Andamiaje: el fixture TIENE mayúsculas, si no el test no distinguiría nada.
    expect(pubkey).not.toBe(pubkey.toLowerCase());

    const { updateArgs } = chainSpy({ data: [{ id: KEY_ID }] });

    return identityService
      .bindSolanaFundingWallet(KEY_ID, OWNER_REF, pubkey)
      .then((returned) => {
        expect(updateArgs).toHaveLength(1);
        expect(updateArgs[0]).toEqual({ funding_wallet_solana: pubkey });
        // Y explícitamente NO la versión bajada de caja.
        expect(updateArgs[0]).not.toEqual({
          funding_wallet_solana: pubkey.toLowerCase(),
        });
        // La escritura va a `funding_wallet_solana`, NUNCA a `funding_wallet`
        // (que tiene contrato lowercase y es del camino EVM — CD-1).
        expect(Object.keys(updateArgs[0] as Record<string, unknown>)).toEqual([
          'funding_wallet_solana',
        ]);
        expect(returned).toBe(pubkey);
      });
  });

  it('T-315-09 (AC-8): dos pubkeys que difieren SOLO EN CAJA producen dos valores DISTINTOS, sin colisión', async () => {
    // ⚠️ La propiedad de AC-8. Con normalización, estas dos escrituras chocarían en el
    // índice UNIQUE y la segunda key quedaría sin poder bindear su propia wallet.
    const a = Keypair.generate().publicKey.toBase58();
    const b = a.toLowerCase();
    expect(a).not.toBe(b); // andamiaje

    const first = chainSpy({ data: [{ id: KEY_ID }] });
    await identityService.bindSolanaFundingWallet(KEY_ID, OWNER_REF, a);

    const second = chainSpy({ data: [{ id: 'other-key' }] });
    await identityService.bindSolanaFundingWallet('other-key', OWNER_REF, b);

    expect(first.updateArgs[0]).toEqual({ funding_wallet_solana: a });
    expect(second.updateArgs[0]).toEqual({ funding_wallet_solana: b });
    expect(first.updateArgs[0]).not.toEqual(second.updateArgs[0]);
  });

  it('Ownership Guard: el UPDATE filtra por id Y owner_ref (el cliente usa SERVICE_KEY y bypassa RLS)', async () => {
    // Sin `.eq('owner_ref', ...)` cualquier caller autenticado podría bindear una
    // wallet a la key de otro owner: un IDOR.
    const { eqArgs } = chainSpy({ data: [{ id: KEY_ID }] });
    const pubkey = Keypair.generate().publicKey.toBase58();

    await identityService.bindSolanaFundingWallet(KEY_ID, OWNER_REF, pubkey);

    expect(eqArgs).toEqual([
      ['id', KEY_ID],
      ['owner_ref', OWNER_REF],
    ]);
  });

  it('0 filas afectadas ⇒ OwnershipMismatchError (no un silencioso "ok")', async () => {
    chainSpy({ data: [] });
    await expect(
      identityService.bindSolanaFundingWallet(
        KEY_ID,
        'otro-owner',
        Keypair.generate().publicKey.toBase58(),
      ),
    ).rejects.toBeInstanceOf(OwnershipMismatchError);
  });

  it('data null ⇒ OwnershipMismatchError', async () => {
    chainSpy({ data: null });
    await expect(
      identityService.bindSolanaFundingWallet(
        KEY_ID,
        OWNER_REF,
        Keypair.generate().publicKey.toBase58(),
      ),
    ).rejects.toBeInstanceOf(OwnershipMismatchError);
  });

  it('error 23505 (UNIQUE parcial) ⇒ FundingWalletAlreadyBoundError', async () => {
    chainSpy({
      error: { code: '23505', message: 'duplicate key value' },
    });
    await expect(
      identityService.bindSolanaFundingWallet(
        KEY_ID,
        OWNER_REF,
        Keypair.generate().publicKey.toBase58(),
      ),
    ).rejects.toBeInstanceOf(FundingWalletAlreadyBoundError);
  });

  it('cualquier otro error de la base se propaga como Error genérico (no se traga)', async () => {
    chainSpy({ error: { code: '08006', message: 'connection failure' } });
    await expect(
      identityService.bindSolanaFundingWallet(
        KEY_ID,
        OWNER_REF,
        Keypair.generate().publicKey.toBase58(),
      ),
    ).rejects.toThrow(/Failed to bind solana funding wallet/);
  });

  it('escribe en la tabla a2a_agent_keys', async () => {
    chainSpy({ data: [{ id: KEY_ID }] });
    await identityService.bindSolanaFundingWallet(
      KEY_ID,
      OWNER_REF,
      Keypair.generate().publicKey.toBase58(),
    );
    expect(mockFrom).toHaveBeenCalledWith('a2a_agent_keys');
  });

  it('M7 (estático): `bindSolanaFundingWallet` no contiene toLowerCase, y `bindFundingWallet` SI lo conserva', async () => {
    // Las dos mitades importan: la primera es la propiedad nueva; la segunda prueba
    // que NO se tocó el contrato lowercase del camino EVM (CD-1).
    const { readFileSync } = await import('node:fs');
    const { dirname, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'identity.ts'),
      'utf8',
    );
    const bodyOf = (name: string): string => {
      const at = src.indexOf(`async ${name}(`);
      if (at === -1) throw new Error(`no se encontró ${name} en identity.ts`);
      const end = src.indexOf('\n  },', at);
      if (end === -1) throw new Error(`no se cerró el cuerpo de ${name}`);
      return src
        .slice(at, end)
        .split('\n')
        .filter((l) => {
          const t = l.trimStart();
          return (
            !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
          );
        })
        .join('\n');
    };
    expect(bodyOf('bindSolanaFundingWallet')).not.toMatch(/toLowerCase/);
    // Control positivo: el grep SI encontraría el símbolo si estuviera.
    expect(bodyOf('bindFundingWallet')).toMatch(/toLowerCase/);
  });
});
