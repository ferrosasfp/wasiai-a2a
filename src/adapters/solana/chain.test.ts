/**
 * Tests de `solana/chain.ts` (P1 — hallazgo 1: el archivo estaba en 0% de
 * cobertura, verificado con `--coverage.include='src/adapters/solana/**'`).
 *
 * POR QUÉ estaba en 0%: los DOS test-files que ejercitan el rail Solana
 * (`payment.test.ts`, `intent-dedup.test.ts`) hacen `vi.mock('./chain.js', ...)`
 * para no tocar la red. O sea que TODA la resolución de config del rail —
 * decimals del mint, commitment, CAIP-2, RPC y la carga del operator keypair —
 * nunca se ejecutaba en la suite. Este archivo la ejercita SIN mocks del módulo
 * bajo prueba y SIN red (construir una `Connection` de web3.js es lazy: no
 * emite ningún request; `Keypair.fromSecretKey` es criptografía local).
 *
 * ALCANCE DELIBERADO (no se busca 100% por deporte): se cubre lo que cuesta
 * plata o corrompe estado si se rompe.
 *  · `getSolanaUsdcDecimals` — es el EXPONENTE del monto. Un 6 que se vuelve 8
 *    multiplica por 100 lo que se transfiere on-chain (`quote()` y el
 *    `amountAtomic` del leg lo consumen).
 *  · `getSolanaCaip2` — es la llave con la que el registry clasifica el destino
 *    como mainnet/testnet (`classifySolanaCaip2`). Apuntarlo a mainnet-beta es
 *    dinero REAL en un rail devnet-only.
 *  · `getSolanaCommitment` — la garantía de confirmación del settle.
 *  · `getSolanaOperatorKeypair` — la llave que FIRMA. Su fallo tiene que ser
 *    accionable, y el secreto NUNCA puede aparecer en un log (CD-3).
 *  · el cache por proceso — un `Connection`/`Keypair` recreado por llamada sería
 *    un leak de sockets y de trabajo criptográfico en el money-path.
 */

import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// El logger se mockea (no el módulo bajo prueba) para poder afirmar que el
// secreto NO viaja a los logs.
const loggerSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({
  getLogger: () => loggerSpy,
}));

import { base58Encode } from './base58.js';
import {
  _resetSolanaChain,
  getSolanaCaip2,
  getSolanaCommitment,
  getSolanaConnection,
  getSolanaNetwork,
  getSolanaOperatorKeypair,
  getSolanaRpcUrl,
  getSolanaSyntheticChainId,
  getSolanaUsdcDecimals,
  getSolanaUsdcMint,
} from './chain.js';

// Defaults documentados (mirror del bloque .env.example) — se duplican acá A
// PROPÓSITO en vez de importarlos: si alguien cambia una constante de `chain.ts`
// el test tiene que ROMPER, no seguirla.
const DEFAULT_RPC_URL = 'https://api.devnet.solana.com';
const DEFAULT_USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const DEFAULT_CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const DEFAULT_SYNTHETIC_CHAIN_ID = 900001;

const ENV_KEYS = [
  'SOLANA_RPC_URL',
  'SOLANA_COMMITMENT',
  'SOLANA_USDC_MINT_DEVNET',
  'SOLANA_USDC_DECIMALS',
  'SOLANA_CAIP2_CHAIN_ID',
  'SOLANA_SYNTHETIC_CHAIN_ID',
  'SOLANA_OPERATOR_PRIVATE_KEY',
  // WKH-315 (W3.1): las lee la aserción de coherencia cuenta-de-depósito ↔
  // operador. Se limpian con las demás para que ningún test las herede.
  'A2A_DEPOSIT_SOLANA_OWNER',
  'A2A_DEPOSIT_SOLANA_OWNER_IS_DEDICATED',
  // Fix-pack AR (BLQ-BAJO-1): la aserción sólo corre con el camino de depósito
  // ENCENDIDO, así que el flag es parte de su entrada.
  'A2A_SOLANA_DEPOSIT_ENABLED',
] as const;

describe('solana/chain.ts — resolución de config del rail (P1 hallazgo 1)', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
    _resetSolanaChain();
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetSolanaChain();
  });

  // ── Defaults documentados ────────────────────────────────────────────────
  it('T-P1-1a: sin env, cada getter devuelve su default DOCUMENTADO', () => {
    expect(getSolanaRpcUrl()).toBe(DEFAULT_RPC_URL);
    expect(getSolanaUsdcMint()).toBe(DEFAULT_USDC_MINT_DEVNET);
    expect(getSolanaUsdcDecimals()).toBe(6);
    expect(getSolanaCommitment()).toBe('confirmed');
    expect(getSolanaCaip2()).toBe(DEFAULT_CAIP2);
    expect(getSolanaSyntheticChainId()).toBe(DEFAULT_SYNTHETIC_CHAIN_ID);
  });

  // ── CD-4: devnet-only ────────────────────────────────────────────────────
  // El rail NO tiene variante mainnet. `getSolanaNetwork` ignora el `opts` a
  // propósito: si algún día devuelve lo que le pasan, un caller podría pedir
  // 'mainnet' y el bundle se nombraría solo (`index.ts` deriva `chainConfig.name`
  // de este valor).
  it('T-P1-1b: getSolanaNetwork SIEMPRE es devnet, incluso si el caller pide otra red', () => {
    expect(getSolanaNetwork()).toBe('devnet');
    expect(getSolanaNetwork({})).toBe('devnet');
    expect(
      getSolanaNetwork({ network: 'mainnet' as unknown as 'devnet' }),
    ).toBe('devnet');
  });

  // ── decimals: el EXPONENTE del monto (money) ─────────────────────────────
  it('T-P1-1c: los decimals del mint se leen de env y un valor INVÁLIDO cae al default (nunca NaN)', () => {
    process.env.SOLANA_USDC_DECIMALS = '9';
    expect(getSolanaUsdcDecimals()).toBe(9);

    process.env.SOLANA_USDC_DECIMALS = '0';
    expect(getSolanaUsdcDecimals()).toBe(0);

    // Un NaN acá sería catastrófico: `parseUnits(amount, NaN)` corrompe el monto.
    process.env.SOLANA_USDC_DECIMALS = 'seis';
    expect(getSolanaUsdcDecimals()).toBe(6);

    // Negativo = sin sentido para un exponente → default.
    process.env.SOLANA_USDC_DECIMALS = '-2';
    expect(getSolanaUsdcDecimals()).toBe(6);

    process.env.SOLANA_USDC_DECIMALS = '';
    expect(getSolanaUsdcDecimals()).toBe(6);
  });

  // ── commitment: whitelist cerrada ────────────────────────────────────────
  it('T-P1-1d: el commitment es una WHITELIST — un valor arbitrario NO se propaga al RPC', () => {
    process.env.SOLANA_COMMITMENT = 'processed';
    expect(getSolanaCommitment()).toBe('processed');

    process.env.SOLANA_COMMITMENT = 'finalized';
    expect(getSolanaCommitment()).toBe('finalized');

    // Cualquier otra cosa colapsa a 'confirmed' en vez de viajar como
    // `Commitment` inválido a `sendAndConfirmTransaction`.
    process.env.SOLANA_COMMITMENT = 'yolo';
    expect(getSolanaCommitment()).toBe('confirmed');

    process.env.SOLANA_COMMITMENT = 'CONFIRMED'; // case-sensitive a propósito
    expect(getSolanaCommitment()).toBe('confirmed');
  });

  // ── CAIP-2: la llave del gate mainnet/testnet ────────────────────────────
  // No se valida el formato acá (el registry lo clasifica y REFUSA arrancar si
  // el destino contradice el slug — ver registry.test.ts T-P1-4-solana-mainnet).
  // Lo que este test fija es que el override se HONRA, o sea que ese gate tiene
  // un input real que el operador puede mover.
  it('T-P1-1e: el CAIP-2 override se honra (es el input del gate mainnet del registry)', () => {
    process.env.SOLANA_CAIP2_CHAIN_ID =
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
    expect(getSolanaCaip2()).toBe(
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    );
  });

  it('T-P1-1f: el chainId sintético se lee de env y un valor inválido cae al sentinel', () => {
    process.env.SOLANA_SYNTHETIC_CHAIN_ID = '900002';
    expect(getSolanaSyntheticChainId()).toBe(900002);

    process.env.SOLANA_SYNTHETIC_CHAIN_ID = 'nope';
    expect(getSolanaSyntheticChainId()).toBe(DEFAULT_SYNTHETIC_CHAIN_ID);

    process.env.SOLANA_SYNTHETIC_CHAIN_ID = '';
    expect(getSolanaSyntheticChainId()).toBe(DEFAULT_SYNTHETIC_CHAIN_ID);
  });

  // ── Connection: cache por proceso + reset ────────────────────────────────
  // Construir una `Connection` NO emite requests (web3.js es lazy), así que esto
  // corre offline.
  it('T-P1-1g: la Connection se CACHEA por proceso y se construye con el RPC/commitment configurados', () => {
    process.env.SOLANA_RPC_URL = 'http://localhost:8899';
    process.env.SOLANA_COMMITMENT = 'finalized';

    const first = getSolanaConnection();
    const second = getSolanaConnection();

    expect(second).toBe(first); // MISMA instancia, no una nueva por llamada
    expect(first.rpcEndpoint).toBe('http://localhost:8899');
    expect(first.commitment).toBe('finalized');
  });

  it('T-P1-1h: _resetSolanaChain invalida el cache (una env nueva se toma de verdad)', () => {
    process.env.SOLANA_RPC_URL = 'http://localhost:8899';
    const first = getSolanaConnection();

    _resetSolanaChain();
    process.env.SOLANA_RPC_URL = 'http://localhost:9999';
    const second = getSolanaConnection();

    expect(second).not.toBe(first);
    expect(second.rpcEndpoint).toBe('http://localhost:9999');
  });

  // ── Operator keypair: la llave que FIRMA ─────────────────────────────────
  describe('getSolanaOperatorKeypair', () => {
    it('T-P1-1i: sin SOLANA_OPERATOR_PRIVATE_KEY LANZA con un mensaje ACCIONABLE (nombra la env var)', () => {
      expect(() => getSolanaOperatorKeypair()).toThrow(
        /SOLANA_OPERATOR_PRIVATE_KEY not set/,
      );
      // El mensaje tiene que decir QUÉ queda deshabilitado, no sólo "error".
      expect(() => getSolanaOperatorKeypair()).toThrow(
        /solana settle signing disabled/,
      );
    });

    it('T-P1-1j: decodifica el secret base58, cachea el Keypair y tolera whitespace', () => {
      const kp = Keypair.generate();
      const b58 = base58Encode(kp.secretKey);
      // Whitespace alrededor: un `.env` copy-pasteado suele traerlo, y sin el
      // `.trim()` el decode base58 falla con un charset error opaco.
      process.env.SOLANA_OPERATOR_PRIVATE_KEY = `  ${b58}\n`;

      const first = getSolanaOperatorKeypair();
      expect(first.publicKey.toBase58()).toBe(kp.publicKey.toBase58());

      const second = getSolanaOperatorKeypair();
      expect(second).toBe(first); // cacheado, no re-derivado
    });

    it('T-P1-1k (CD-3): el secreto NUNCA aparece en los logs — sólo la pubkey', () => {
      const kp = Keypair.generate();
      const b58 = base58Encode(kp.secretKey);
      process.env.SOLANA_OPERATOR_PRIVATE_KEY = b58;

      getSolanaOperatorKeypair();

      expect(loggerSpy.info).toHaveBeenCalledWith(
        { operator: kp.publicKey.toBase58() },
        'solana operator loaded',
      );

      // Barrido duro sobre TODO lo que se logueó (cualquier nivel): ni el base58
      // del secret ni ningún prefijo largo suyo puede aparecer serializado.
      const everything = JSON.stringify([
        loggerSpy.info.mock.calls,
        loggerSpy.warn.mock.calls,
        loggerSpy.error.mock.calls,
      ]);
      expect(everything).not.toContain(b58);
      expect(everything).not.toContain(b58.slice(0, 32));
    });

    it('T-P1-1l: un secret con charset base58 inválido LANZA (no devuelve un Keypair basura)', () => {
      // '0', 'O', 'I', 'l' están FUERA del alfabeto base58.
      process.env.SOLANA_OPERATOR_PRIVATE_KEY = '0OIl'.repeat(22);
      expect(() => getSolanaOperatorKeypair()).toThrow();
    });

    it('T-P1-1m: un secret base58 VÁLIDO pero de largo incorrecto LANZA (ed25519 exige 64 bytes)', () => {
      // Charset correcto, longitud incorrecta → `Keypair.fromSecretKey` rechaza.
      process.env.SOLANA_OPERATOR_PRIVATE_KEY = base58Encode(
        new Uint8Array(32).fill(7),
      );
      expect(() => getSolanaOperatorKeypair()).toThrow();
    });

    // ── WKH-315 · T-315-20 — coherencia cuenta-de-depósito ↔ operador ────────
    //
    // El riesgo: si `A2A_DEPOSIT_SOLANA_OWNER` apunta a una pubkey que el operador NO
    // controla, el dinero del usuario aterriza en una cuenta desde la que no se puede
    // pagar, y nadie se entera hasta querer gastarlo.
    describe('T-315-20: aserción de coherencia con A2A_DEPOSIT_SOLANA_OWNER', () => {
      /**
       * Setea un operador real **y enciende el camino de depósito**, que desde el
       * fix-pack (BLQ-BAJO-1) es precondición de la aserción. Devuelve su pubkey.
       */
      function withOperator(): string {
        const kp = Keypair.generate();
        process.env.SOLANA_OPERATOR_PRIVATE_KEY = base58Encode(kp.secretKey);
        process.env.A2A_SOLANA_DEPOSIT_ENABLED = 'true';
        return kp.publicKey.toBase58();
      }

      it('T-315-20: owner == operador ⇒ carga OK', () => {
        const pubkey = withOperator();
        process.env.A2A_DEPOSIT_SOLANA_OWNER = pubkey;
        expect(getSolanaOperatorKeypair().publicKey.toBase58()).toBe(pubkey);
      });

      it('T-315-20: env AUSENTE ⇒ carga OK (la aserción no inventa un requisito)', () => {
        const pubkey = withOperator();
        delete process.env.A2A_DEPOSIT_SOLANA_OWNER;
        expect(getSolanaOperatorKeypair().publicKey.toBase58()).toBe(pubkey);
      });

      it('T-315-20: env VACIA ⇒ carga OK (una env seteada a "" es "sin configurar")', () => {
        const pubkey = withOperator();
        process.env.A2A_DEPOSIT_SOLANA_OWNER = '';
        expect(getSolanaOperatorKeypair().publicKey.toBase58()).toBe(pubkey);
      });

      it('T-315-20: owner ≠ operador SIN la declaración ⇒ LANZA, nombrando las DOS envs', () => {
        withOperator();
        const foreign = Keypair.generate().publicKey.toBase58();
        process.env.A2A_DEPOSIT_SOLANA_OWNER = foreign;

        expect(() => getSolanaOperatorKeypair()).toThrow(
          /A2A_DEPOSIT_SOLANA_OWNER/,
        );
        // El mensaje tiene que decir QUE hacer, no sólo que algo está mal.
        expect(() => getSolanaOperatorKeypair()).toThrow(
          /A2A_DEPOSIT_SOLANA_OWNER_IS_DEDICATED=true/,
        );
        // Y por qué importa: el dinero aterrizaría donde no se puede pagar desde.
        expect(() => getSolanaOperatorKeypair()).toThrow(/cannot pay from/);
      });

      it("T-315-20: owner ≠ operador CON ..._IS_DEDICATED='true' ⇒ carga OK (afirmación del operador)", () => {
        const pubkey = withOperator();
        process.env.A2A_DEPOSIT_SOLANA_OWNER =
          Keypair.generate().publicKey.toBase58();
        process.env.A2A_DEPOSIT_SOLANA_OWNER_IS_DEDICATED = 'true';
        expect(getSolanaOperatorKeypair().publicKey.toBase58()).toBe(pubkey);
      });

      it("T-315-20: la salida es ESTRICTA — 'TRUE'/'1'/'yes' NO declaran nada y sigue lanzando", () => {
        // Con `Boolean(env)` cualquier string apagaría el control. La salida es una
        // afirmación deliberada, así que exige el literal exacto.
        withOperator();
        process.env.A2A_DEPOSIT_SOLANA_OWNER =
          Keypair.generate().publicKey.toBase58();
        for (const v of ['TRUE', 'True', '1', 'yes', 'on', '']) {
          process.env.A2A_DEPOSIT_SOLANA_OWNER_IS_DEDICATED = v;
          _resetSolanaChain();
          expect(() => getSolanaOperatorKeypair(), `valor=${v}`).toThrow(
            /A2A_DEPOSIT_SOLANA_OWNER/,
          );
        }
      });

      it('T-315-20: el guard NO se saltea con un reintento — no se cachea antes de la aserción', () => {
        // ⚠️ Si `_operator` se asignara ANTES del chequeo, el primer llamado lanzaría
        // y el SEGUNDO devolvería el keypair cacheado sin re-chequear. Un guard que
        // se evade reintentando no es un guard.
        withOperator();
        process.env.A2A_DEPOSIT_SOLANA_OWNER =
          Keypair.generate().publicKey.toBase58();
        expect(() => getSolanaOperatorKeypair()).toThrow();
        expect(() => getSolanaOperatorKeypair()).toThrow();
        expect(() => getSolanaOperatorKeypair()).toThrow();
      });

      it('T-315-20 (CD-3): el mensaje del throw NO contiene el secreto', () => {
        const kp = Keypair.generate();
        const b58 = base58Encode(kp.secretKey);
        process.env.SOLANA_OPERATOR_PRIVATE_KEY = b58;
        // El flag es precondición de la aserción desde BLQ-BAJO-1. Su andamiaje
        // ("efectivamente lanzó") es lo que cazó la omisión.
        process.env.A2A_SOLANA_DEPOSIT_ENABLED = 'true';
        process.env.A2A_DEPOSIT_SOLANA_OWNER =
          Keypair.generate().publicKey.toBase58();

        let msg = '';
        try {
          getSolanaOperatorKeypair();
        } catch (e) {
          msg = e instanceof Error ? e.message : String(e);
        }
        // Andamiaje: efectivamente lanzó.
        expect(msg).not.toBe('');
        expect(msg).not.toContain(b58);
        expect(msg).not.toContain(b58.slice(0, 32));
        // Las dos pubkeys SI pueden aparecer: son públicas por definición.
        expect(msg).toContain(kp.publicKey.toBase58());
      });

      // ── FIX-PACK AR · BLQ-BAJO-1: el runbook no puede brickear la SALIDA ────
      it('BLQ-BAJO-1: con el DEPOSITO APAGADO, un owner distinto NO tira el settle de salida', () => {
        // ⚠️ EL ESCENARIO ES EL RUNBOOK CORRECTO, NO UN ERROR EXOTICO. El propio
        // `.env.example` manda: migración → setear el owner → **y el flag AL FINAL**.
        // Entre el paso 2 y el 3 el depósito está apagado. Sin esta condición, un
        // operador que además se olvida de `..._IS_DEDICATED` deja de settlear TODO
        // Solana de salida (`payment.ts`) sin que exista un solo depósito que
        // proteger: el guard cobraba antes de tener nada que cuidar.
        const kp = Keypair.generate();
        process.env.SOLANA_OPERATOR_PRIVATE_KEY = base58Encode(kp.secretKey);
        process.env.A2A_SOLANA_DEPOSIT_ENABLED = 'false';
        process.env.A2A_DEPOSIT_SOLANA_OWNER =
          Keypair.generate().publicKey.toBase58();

        expect(getSolanaOperatorKeypair().publicKey.toBase58()).toBe(
          kp.publicKey.toBase58(),
        );
      });

      it('BLQ-BAJO-1: el flag AUSENTE tampoco enciende la aserción (default = camino apagado)', () => {
        const kp = Keypair.generate();
        process.env.SOLANA_OPERATOR_PRIVATE_KEY = base58Encode(kp.secretKey);
        delete process.env.A2A_SOLANA_DEPOSIT_ENABLED;
        process.env.A2A_DEPOSIT_SOLANA_OWNER =
          Keypair.generate().publicKey.toBase58();

        expect(getSolanaOperatorKeypair().publicKey.toBase58()).toBe(
          kp.publicKey.toBase58(),
        );
      });

      it("BLQ-BAJO-1: y el control NO se debilitó — con el flag en 'true' el mismo caso SIGUE lanzando", () => {
        // Andamiaje contra el fix de más: si condicionar el guard lo hubiera apagado
        // siempre, los dos tests de arriba pasarían igual y no probarían nada.
        const kp = Keypair.generate();
        process.env.SOLANA_OPERATOR_PRIVATE_KEY = base58Encode(kp.secretKey);
        process.env.A2A_SOLANA_DEPOSIT_ENABLED = 'true';
        process.env.A2A_DEPOSIT_SOLANA_OWNER =
          Keypair.generate().publicKey.toBase58();

        expect(() => getSolanaOperatorKeypair()).toThrow(/cannot pay from/);
      });

      it('T-315-20: tolera whitespace alrededor del owner (un .env copy-pasteado lo trae)', () => {
        const pubkey = withOperator();
        process.env.A2A_DEPOSIT_SOLANA_OWNER = `  ${pubkey}\n`;
        // Sin el `.trim()`, esto lanzaría por un salto de línea invisible: un
        // fail-loud por un carácter que el operador no puede ver es una trampa.
        expect(getSolanaOperatorKeypair().publicKey.toBase58()).toBe(pubkey);
      });
    });
  });
});
