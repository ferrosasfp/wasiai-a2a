/**
 * Operator Address — WKH-316 · la dirección propia del gateway, por familia de VM.
 *
 * Existe para UN solo guard: que un agente no pueda declarar como billetera de
 * cobro (`payment.contract`) la dirección del propio gateway. Lo consume
 * `payment-spec-writer.ts` (paso 7 de `validatePaymentBlock`).
 *
 * Módulo LEAF: sus únicos imports estáticos son `viem/accounts` y el logger.
 *
 * ⚠️ EL IMPORT DE SOLANA ES DINÁMICO A PROPÓSITO (CD-13). Un
 * `import { getSolanaOperatorKeypair } from '../adapters/solana/chain.js'` en el
 * top-level arrastraría `@solana/web3.js` a TODO proceso que sirva rutas, porque
 * este módulo lo va a importar `routes/agents.ts`. Es exactamente lo que evita
 * `src/adapters/registry.ts`, cuyos imports de top-level (`:1-16`) son sólo
 * `lib/logger`, `chain-resolver` y tipos: cada adapter entra por `await import()`.
 *
 * ⚠️ NUNCA LANZA. Es la única garantía que el caller necesita, y no es gratis del
 * lado Solana: `getSolanaOperatorKeypair()` (`../adapters/solana/chain.ts:84`) no
 * es un getter puro — loguea (`:95`) y corre la aserción de coherencia
 * depósito↔operador de WKH-315 (`:137-149`), **que lanza**. Si el proceso todavía
 * no había cargado el keypair, este módulo sería el primero en dispararla. Por eso
 * el `catch` **no puede ser silencioso**: se loguea `PAYTO_OPERATOR_CHECK_SKIPPED`
 * con el mensaje, server-side. Un error de configuración que hoy explota ruidoso
 * en el settle no puede volverse mudo porque alguien publicó una ficha.
 */

import { privateKeyToAccount } from 'viem/accounts';
import { getLogger } from './logger.js';

const log = getLogger('operator-address');

/** Familias de VM para las que el gateway puede tener dirección propia. */
export type OperatorFamily = 'evm' | 'solana';

/**
 * Cache por proceso Y POR FAMILIA, **incluido el `null`**.
 *
 * El `null` se cachea a propósito: sin eso, un deploy sin
 * `SOLANA_OPERATOR_PRIVATE_KEY` re-intentaría el `await import()` de
 * `@solana/web3.js` en cada publicación. Se usa un `Map` con `has()` en vez de
 * `?? undefined` porque `null` es un valor resuelto legítimo, no un "todavía no".
 *
 * Consecuencia declarada: el log de `PAYTO_OPERATOR_CHECK_SKIPPED` sale **una
 * vez por familia y por proceso**, no una vez por request. Para un test que
 * quiera re-ejercitar la resolución, la salida es `vi.resetModules()` + re-import
 * dinámico: este módulo NO exporta un reset (no hay caller de producción que lo
 * necesite, y exportarlo sería una superficie para vaciar el guard en caliente).
 */
const cache = new Map<OperatorFamily, string | null>();

function resolveEvm(): string | null {
  // Mismo patrón que `resolveTreasury` (`../adapters/deposit-verifier.ts:167-175`).
  const pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk) {
    log.info(
      { code: 'PAYTO_OPERATOR_CHECK_SKIPPED', family: 'evm' },
      'operator address unresolvable: OPERATOR_PRIVATE_KEY not set',
    );
    return null;
  }
  try {
    return privateKeyToAccount(pk as `0x${string}`).address;
  } catch (err) {
    log.warn(
      {
        code: 'PAYTO_OPERATOR_CHECK_SKIPPED',
        family: 'evm',
        err: err instanceof Error ? err.message : String(err),
      },
      'operator address unresolvable: OPERATOR_PRIVATE_KEY did not derive',
    );
    return null;
  }
}

async function resolveSolana(): Promise<string | null> {
  try {
    const chain = await import('../adapters/solana/chain.js');
    return chain.getSolanaOperatorKeypair().publicKey.toBase58();
  } catch (err) {
    // El mensaje va al log del servidor y NUNCA al cliente: puede nombrar envs
    // (`A2A_DEPOSIT_OWNER_SOLANA`) y pubkeys. Secretos no incluye — el propio
    // `getSolanaOperatorKeypair` tiene prohibido meter el secret en sus errores
    // (`../adapters/solana/chain.ts:81-82`).
    log.warn(
      {
        code: 'PAYTO_OPERATOR_CHECK_SKIPPED',
        family: 'solana',
        err: err instanceof Error ? err.message : String(err),
      },
      'operator address unresolvable: solana keypair did not load',
    );
    return null;
  }
}

/**
 * Dirección propia del gateway para `family`, o `null` si este proceso no la
 * puede resolver. **Nunca lanza.**
 *
 * `null` NO significa "no coincide": significa "no se pudo comparar". El caller
 * (`validatePaymentBlock`, paso 7) degrada explícitamente — acepta el bloque y
 * marca `operatorCheckSkipped` — en vez de rechazar publicaciones legítimas
 * porque a este deploy le falta una env de firma.
 */
export async function resolveOperatorAddress(
  family: OperatorFamily,
): Promise<string | null> {
  if (cache.has(family)) return cache.get(family) ?? null;

  const resolved = family === 'evm' ? resolveEvm() : await resolveSolana();
  cache.set(family, resolved);
  return resolved;
}
