/**
 * WKH-315 — tests de `deposit-account.ts` (la cuenta de depósito Solana).
 *
 * Sin mocks del módulo bajo prueba y sin red: `getAssociatedTokenAddressSync` es
 * derivación determinística de PDA y `PublicKey` es parseo local.
 *
 * ── QUE PROPIEDADES CANDAN ESTOS TESTS ──────────────────────────────────────
 *
 * T-315-19  el flag es una comparación de string ESTRICTA. Con `Boolean(env)`, el
 *           string `'false'` es TRUTHY: un operador que escribe
 *           `A2A_SOLANA_DEPOSIT_ENABLED=false` para APAGAR la entrada de dinero la
 *           estaría ENCENDIENDO. Ese es el mutante M19.
 * T-315-13  ningún archivo del camino de depósito INVOCA el loader del keypair
 *           (AC-12/CD-4). Test ESTATICO, con su limitación escrita.
 * (+)       el destino publicado es la ATA y NUNCA el owner (CD-5), y no hay
 *           NINGUN fallback cuando la env falta (M18).
 */

import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isValidSolanaAddress as isValidSolanaAddressForTest } from '../../lib/wallet-format.js';
import { getSolanaUsdcMint } from './chain.js';
import {
  isSolanaDepositEnabled,
  resolveSolanaDepositAta,
  resolveSolanaDepositOwner,
} from './deposit-account.js';

const ENV_KEYS = [
  'A2A_DEPOSIT_SOLANA_OWNER',
  'A2A_SOLANA_DEPOSIT_ENABLED',
  'SOLANA_USDC_MINT_DEVNET',
  // Se limpian a propósito: si el módulo las leyera (no debe), estos tests lo
  // notarían al fallar con ellas ausentes.
  'A2A_DEPOSIT_TREASURY_SOLANA',
  'OPERATOR_PRIVATE_KEY',
  'SOLANA_ADAPTER_ENABLED',
] as const;

/** Owner válido, derivado de la librería que lo consume (CD-16). */
const OWNER = Keypair.generate().publicKey.toBase58();

describe('WKH-315 · deposit-account.ts', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ── resolveSolanaDepositOwner: CERO FALLBACK (M18) ────────────────────────
  describe('resolveSolanaDepositOwner — sin fallback, nunca (M18)', () => {
    it('sin la env devuelve null', () => {
      expect(resolveSolanaDepositOwner()).toBeNull();
    });

    it('M18: NO cae a `A2A_DEPOSIT_TREASURY_SOLANA` ni a `OPERATOR_PRIVATE_KEY`', () => {
      // ⚠️ ESTE ES EL TEST DEL LANDMINE. `resolveTreasury` hacía exactamente esto:
      // con la env de treasury inválida (una pubkey base58 nunca pasa `^0x…{40}$`)
      // derivaba la address EVM del operador y la devolvía como destino de un
      // depósito Solana. Acá las dos envs están seteadas y el resultado sigue null.
      process.env.A2A_DEPOSIT_TREASURY_SOLANA =
        '0x1111111111111111111111111111111111111111';
      process.env.OPERATOR_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
      expect(resolveSolanaDepositOwner()).toBeNull();
      expect(resolveSolanaDepositAta()).toBeNull();
      expect(isSolanaDepositEnabled()).toBe(false);
    });

    it('M18 (el caso que de verdad duele): `A2A_DEPOSIT_TREASURY_SOLANA` con una pubkey VALIDA tampoco se usa', () => {
      // ══════════════════════════════════════════════════════════════════════════
      // ⚠️ ESTE CASO EXISTE PORQUE UN MUTANTE SOBREVIVIO AL TEST DE ARRIBA.
      //
      // La campaña de mutación aplicó el fallback real
      // (`A2A_DEPOSIT_SOLANA_OWNER ?? A2A_DEPOSIT_TREASURY_SOLANA`) y la suite quedó
      // VERDE. El motivo: el test de arriba pone en esa env una address EVM, que
      // `isValidSolanaAddress` rechaza igual, así que el fallback devolvía `null`
      // por la validación siguiente y NO por su ausencia. El test probaba el
      // validador, no la ausencia del fallback.
      //
      // El caso peligroso es justamente el que faltaba: un operador confundido
      // pone una pubkey base58 VALIDA en la env de treasury —que es exactamente la
      // confusión que el landmine de `resolveTreasury` invita, porque esa env se
      // llama "SOLANA"—. Con fallback, el depósito se dirigiría a una cuenta que
      // nadie eligió para eso. Sin fallback, el camino queda apagado y se nota.
      // ══════════════════════════════════════════════════════════════════════════
      const validButUnrelated = Keypair.generate().publicKey.toBase58();
      // Andamiaje: la env SI contiene algo que pasaría el validador.
      expect(isValidSolanaAddressForTest(validButUnrelated)).toBe(true);
      process.env.A2A_DEPOSIT_TREASURY_SOLANA = validButUnrelated;
      delete process.env.A2A_DEPOSIT_SOLANA_OWNER;

      expect(resolveSolanaDepositOwner()).toBeNull();
      expect(resolveSolanaDepositOwner()).not.toBe(validButUnrelated);
      expect(resolveSolanaDepositAta()).toBeNull();
      expect(isSolanaDepositEnabled()).toBe(false);
    });

    it('una env que NO es pubkey Solana devuelve null (address EVM, charset inválido, longitud mala)', () => {
      for (const bad of [
        '0x1111111111111111111111111111111111111111',
        '0OIl'.repeat(11), // charset fuera de base58
        'short',
        Keypair.generate().secretKey.length.toString(),
      ]) {
        process.env.A2A_DEPOSIT_SOLANA_OWNER = bad;
        expect(resolveSolanaDepositOwner(), bad).toBeNull();
      }
    });

    it('una pubkey válida se devuelve TAL CUAL, sin normalizar la caja', () => {
      process.env.A2A_DEPOSIT_SOLANA_OWNER = OWNER;
      expect(resolveSolanaDepositOwner()).toBe(OWNER);
      // Y no se pasa a minúsculas: bajar de caja una cadena base58 la DESTRUYE.
      expect(resolveSolanaDepositOwner()).not.toBe(OWNER.toLowerCase());
    });

    it('tolera whitespace alrededor (un `.env` copy-pasteado suele traerlo)', () => {
      process.env.A2A_DEPOSIT_SOLANA_OWNER = `  ${OWNER}\n`;
      expect(resolveSolanaDepositOwner()).toBe(OWNER);
    });
  });

  // ── resolveSolanaDepositAta: el destino es la ATA (CD-5) ──────────────────
  describe('resolveSolanaDepositAta — el destino es la ATA, no el owner (CD-5)', () => {
    it('deriva la ATA del par (mint, owner) y es DISTINTA del owner', () => {
      process.env.A2A_DEPOSIT_SOLANA_OWNER = OWNER;
      const ata = resolveSolanaDepositAta();
      expect(ata).not.toBeNull();
      // ⚠️ La aserción que importa: publicar el owner como destino haría que el
      // depositante mande USDC a una dirección que NO recibe USDC.
      expect(ata).not.toBe(OWNER);
    });

    it('coincide byte a byte con el derivador de la librería (oráculo externo, no re-implementación)', () => {
      process.env.A2A_DEPOSIT_SOLANA_OWNER = OWNER;
      const expected = getAssociatedTokenAddressSync(
        new PublicKey(getSolanaUsdcMint()),
        new PublicKey(OWNER),
      ).toBase58();
      expect(resolveSolanaDepositAta()).toBe(expected);
    });

    it('cambia si cambia el MINT — la ATA depende del par, no sólo del owner', () => {
      process.env.A2A_DEPOSIT_SOLANA_OWNER = OWNER;
      const withDefaultMint = resolveSolanaDepositAta();
      process.env.SOLANA_USDC_MINT_DEVNET =
        Keypair.generate().publicKey.toBase58();
      const withOtherMint = resolveSolanaDepositAta();
      expect(withOtherMint).not.toBeNull();
      expect(withOtherMint).not.toBe(withDefaultMint);
    });

    it('un mint corrupto devuelve null y NO LANZA (lo consume una ruta pública y un verificador never-throw)', () => {
      process.env.A2A_DEPOSIT_SOLANA_OWNER = OWNER;
      process.env.SOLANA_USDC_MINT_DEVNET = 'no-es-una-pubkey';
      expect(() => resolveSolanaDepositAta()).not.toThrow();
      expect(resolveSolanaDepositAta()).toBeNull();
    });

    it('owner inválido ⇒ ATA null ⇒ el camino queda OFF (la cadena completa)', () => {
      process.env.A2A_SOLANA_DEPOSIT_ENABLED = 'true';
      process.env.A2A_DEPOSIT_SOLANA_OWNER = 'no-es-una-pubkey';
      expect(resolveSolanaDepositOwner()).toBeNull();
      expect(resolveSolanaDepositAta()).toBeNull();
      expect(isSolanaDepositEnabled()).toBe(false);
    });
  });

  // ── T-315-19: el flag estricto (M19) ─────────────────────────────────────
  describe('T-315-19: isSolanaDepositEnabled — comparación de string ESTRICTA (M19)', () => {
    beforeEach(() => {
      process.env.A2A_DEPOSIT_SOLANA_OWNER = OWNER;
    });

    it("T-315-19: SOLO 'true' exacto enciende", () => {
      process.env.A2A_SOLANA_DEPOSIT_ENABLED = 'true';
      expect(isSolanaDepositEnabled()).toBe(true);
    });

    it("T-315-19 (M19): 'false' deja OFF — con Boolean(env) el string 'false' es TRUTHY y encendería la entrada de dinero", () => {
      // ⚠️ EL MUTANTE QUE ESTE CASO MATA. Un operador que escribe
      // `A2A_SOLANA_DEPOSIT_ENABLED=false` para APAGAR el camino lo estaría
      // ENCENDIENDO si el código usara `Boolean(process.env...)`.
      process.env.A2A_SOLANA_DEPOSIT_ENABLED = 'false';
      expect(isSolanaDepositEnabled()).toBe(false);
    });

    it("T-315-19: '1', 'TRUE', 'yes', '' y la ausencia dejan OFF (default fail-safe)", () => {
      for (const v of ['1', 'TRUE', 'True', 'yes', 'on', '']) {
        process.env.A2A_SOLANA_DEPOSIT_ENABLED = v;
        expect(isSolanaDepositEnabled(), `valor=${JSON.stringify(v)}`).toBe(
          false,
        );
      }
      delete process.env.A2A_SOLANA_DEPOSIT_ENABLED;
      expect(isSolanaDepositEnabled()).toBe(false);
    });

    it("T-315-19: con el flag en 'true' pero SIN owner sigue OFF (las dos condiciones son necesarias)", () => {
      process.env.A2A_SOLANA_DEPOSIT_ENABLED = 'true';
      delete process.env.A2A_DEPOSIT_SOLANA_OWNER;
      expect(isSolanaDepositEnabled()).toBe(false);
    });

    it('NO lee SOLANA_ADAPTER_ENABLED — el AND con el rail es ESTRUCTURAL, vía la existencia del bundle', () => {
      // El flag del rail tiene choke-point único en `registry.ts` y la regla de que
      // el resolver y los adapters no lo leen. Si este módulo lo leyera, habría dos
      // fuentes de verdad del mismo gate.
      process.env.A2A_SOLANA_DEPOSIT_ENABLED = 'true';
      process.env.SOLANA_ADAPTER_ENABLED = 'false';
      expect(isSolanaDepositEnabled()).toBe(true);
    });
  });

  // ── T-315-13: cero Keypair en el camino de depósito (AC-12 / CD-4) ────────
  describe('T-315-13 (ESTATICO): el camino de depósito nunca INVOCA el loader del keypair', () => {
    /**
     * ⚠️ ALCANCE HONESTO DE ESTE TEST, PORQUE UN TEST QUE PROMETE MAS DE LO QUE MIDE
     * ES PEOR QUE NO TENERLO.
     *
     * Lo que SI garantiza: ninguno de los archivos del camino de depósito menciona
     * `getSolanaOperatorKeypair` ni `Keypair` en su propio texto, o sea que ninguno
     * puede invocar el loader de la llave que firma.
     *
     * Lo que NO garantiza: el cierre TRANSITIVO. `deposit-account.ts` importa
     * `./chain.js` para el mint, y `chain.ts` importa `Keypair` a nivel de módulo
     * para el camino de SETTLE. Ese import existe y es legítimo; lo que importa es
     * que el camino de depósito no lo EJECUTE — `getSolanaOperatorKeypair()` es
     * lazy y LANZA si `SOLANA_OPERATOR_PRIVATE_KEY` no está seteada, así que un
     * proceso que sólo recibe depósitos no puede depender de ella.
     *
     * (Los tests de arriba corren con `SOLANA_OPERATOR_PRIVATE_KEY` sin setear y
     * pasan: ésa es la evidencia dinámica que complementa a este grep.)
     */
    const DEPOSIT_PATH_FILES = [
      'src/adapters/solana/deposit-account.ts',
      'src/adapters/solana/deposit-verifier.ts',
      'src/lib/ed25519.ts',
    ];

    it('T-315-13: ninguno menciona `getSolanaOperatorKeypair` ni `Keypair` (fuera de comentarios)', async () => {
      const { readFileSync } = await import('node:fs');
      const { dirname, resolve } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const ROOT = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
      );

      for (const rel of DEPOSIT_PATH_FILES) {
        const src = readFileSync(resolve(ROOT, rel), 'utf8');
        // Sobre el texto SIN COMENTARIOS: las cabeceras de estos archivos EXPLICAN
        // por qué no se usa el keypair, así que un match contra el fuente crudo se
        // satisface con la prosa y se pondría rojo por cumplir bien la prohibición.
        const code = src
          .split('\n')
          .filter((l) => {
            const t = l.trimStart();
            return (
              !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
            );
          })
          .join('\n');
        expect(code, `${rel}: getSolanaOperatorKeypair`).not.toMatch(
          /getSolanaOperatorKeypair/,
        );
        // `PublicKey` no matchea /\bKeypair\b/ — el word-boundary es lo que hace
        // que este assert sea sobre el tipo que carga el SECRETO y no sobre
        // cualquier símbolo de web3.js.
        expect(code, `${rel}: Keypair`).not.toMatch(/\bKeypair\b/);
      }
    });

    it('T-315-13 (andamiaje): el grep SI encontraría el símbolo si estuviera — probado contra `chain.ts`', async () => {
      // Sin esto, un regex mal escrito haría pasar el test de arriba sobre cualquier
      // archivo, incluido uno que SI cargue el keypair. `chain.ts` es el control
      // positivo: tiene las dos cosas.
      const { readFileSync } = await import('node:fs');
      const { dirname, resolve } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const src = readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), 'chain.ts'),
        'utf8',
      );
      const code = src
        .split('\n')
        .filter((l) => {
          const t = l.trimStart();
          return (
            !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
          );
        })
        .join('\n');
      expect(code).toMatch(/getSolanaOperatorKeypair/);
      expect(code).toMatch(/\bKeypair\b/);
    });
  });
});
