/**
 * La cuenta de depósito Solana (WKH-315 · AC-4 / AC-11 / AC-12 / AC-14).
 *
 * Resuelve **a dónde** tiene que transferir el depositante y **si** el camino de
 * entrada por Solana está habilitado. Es config pura: cero red, cero DB, cero firma.
 *
 * ── POR QUE ESTE MODULO EXISTE, EN VEZ DE REUSAR `resolveTreasury` (CD-5) ────
 *
 * `resolveTreasury('solana-devnet')` no fallaba: era PEOR. Buscaba
 * `A2A_DEPOSIT_TREASURY_SOLANA`, lo testeaba contra `/^0x[0-9a-fA-F]{40}$/` —que una
 * pubkey base58 no puede pasar— y **caía al fallback**
 * `privateKeyToAccount(OPERATOR_PRIVATE_KEY).address`. O sea: devolvía **una dirección
 * EVM como destino esperado de un depósito Solana, en silencio**.
 *
 * El fallback silencioso es exactamente cómo esa función se volvió un landmine, así
 * que acá **NO HAY NINGUN FALLBACK**. Env ausente o inválida ⇒ `null` ⇒ el camino de
 * depósito Solana está apagado. Un camino apagado es ruidoso y recuperable; un destino
 * equivocado es plata que aterriza donde nadie la puede tocar.
 *
 * ── EL DESTINO ES LA ATA, NO EL OWNER (CD-5) ────────────────────────────────
 *
 * En Solana los tokens no viven en la wallet: viven en una cuenta asociada al par
 * (mint, owner). Publicar el owner como destino haría que un depositante mandara USDC
 * a una dirección que no es la que recibe el USDC. Se deriva la ATA con el MISMO
 * derivador que usa el camino de salida (`getAssociatedTokenAddressSync`,
 * `payment.ts`), sin red.
 *
 * ── CERO `Keypair` (AC-12 / CD-4) ───────────────────────────────────────────
 *
 * Este módulo **nunca** carga la llave del operador: un depósito no requiere que el
 * gateway firme nada — el depositante paga su propio fee. Además, `chain.ts` LANZA si
 * `SOLANA_OPERATOR_PRIVATE_KEY` no está seteada, así que tocar el keypair acá haría
 * que un proceso que sólo quiere RECIBIR depósitos dependa de la llave que FIRMA.
 *
 * ── Y NO SE LEE `SOLANA_ADAPTER_ENABLED` ────────────────────────────────────
 *
 * El flag del rail tiene un choke-point único en `registry.ts` y la regla explícita de
 * que el resolver y los adapters NO lo leen. El AND con el rail es **estructural**:
 * sin ese flag no hay bundle, y `POST /auth/deposit` contesta `CHAIN_NOT_SUPPORTED`
 * antes de llegar acá.
 */

import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { isValidSolanaAddress } from '../../lib/wallet-format.js';
import { getSolanaUsdcMint } from './chain.js';

/**
 * Pubkey base58 dueña de la cuenta de depósito, desde `A2A_DEPOSIT_OWNER_SOLANA`.
 * `null` si la env falta o no es una pubkey Solana bien formada.
 *
 * **PROHIBIDO cualquier fallback** — ver la cabecera. El `| null` no viola CD-3: es
 * una lectura de env LOCAL, sin sistema externo y sin tercer valor posible; el
 * verificador lo traduce a `DEPOSIT_ACCOUNT_NOT_CONFIGURED`, que sí es un estado de la
 * unión discriminada.
 */
export function resolveSolanaDepositOwner(): string | null {
  const raw = process.env.A2A_DEPOSIT_OWNER_SOLANA;
  if (raw === undefined || raw === '') return null;
  const owner = raw.trim();
  // Se valida con el MISMO predicado que el resto del repo usa para una wallet
  // Solana (charset base58 + decode a exactamente 32 bytes). Un validador paralelo
  // acá sería una segunda definición de "pubkey válida" que puede divergir.
  if (!isValidSolanaAddress(owner)) return null;
  return owner;
}

/**
 * La **ATA de depósito**: la cuenta de token asociada al par (USDC mint, owner). Es el
 * destino REAL que se publica y contra el que el verificador compara (CD-5).
 *
 * `null` si el owner no está configurado, o si `PublicKey`/el derivador rechazan algún
 * input. Cualquier throw se traduce a `null` y **no se propaga**: esta función la
 * consumen una ruta pública (`GET /auth/deposit-info`) y un verificador que nunca
 * lanza.
 *
 * Sin red: `getAssociatedTokenAddressSync` es derivación determinística de PDA.
 */
export function resolveSolanaDepositAta(): string | null {
  const owner = resolveSolanaDepositOwner();
  if (owner === null) return null;
  try {
    return getAssociatedTokenAddressSync(
      new PublicKey(getSolanaUsdcMint()),
      new PublicKey(owner),
    ).toBase58();
  } catch {
    // Un mint mal configurado (`SOLANA_USDC_MINT_DEVNET` con basura) o un owner que
    // pasa el predicado de formato pero que `PublicKey` rechaza. Las dos son errores
    // de config del operador, y las dos apagan el camino en vez de adivinar.
    return null;
  }
}

/**
 * `true` si el camino de ENTRADA por Solana está habilitado. **Choke-point único**: ni
 * la ruta ni el verificador leen la env por su cuenta.
 *
 * Dos condiciones, las dos necesarias:
 *   1. `A2A_DEPOSIT_ENABLED_SOLANA === 'true'` — comparación de string ESTRICTA;
 *   2. la cuenta de depósito está configurada.
 *
 * ⚠️ **PROHIBIDO `Boolean(process.env.A2A_DEPOSIT_ENABLED_SOLANA)`** (exemplar:
 * `escrowModeEnabled` en `routes/auth/parsers.ts`). Con `Boolean(...)`, el string
 * `'false'` es TRUTHY: un operador que escribe `A2A_DEPOSIT_ENABLED_SOLANA=false`
 * para APAGAR el camino de entrada de dinero lo estaría ENCENDIENDO. Sólo `'true'`
 * exacto enciende; `'1'`, `'TRUE'`, `'yes'`, `''` y la ausencia dejan OFF (default
 * fail-safe).
 *
 * ⚠️ Y el flag propio existe A PROPOSITO, separado de `SOLANA_ADAPTER_ENABLED`:
 * encender el rail de SALIDA (pagarle a un agente) y abrir un camino de ENTRADA de
 * dinero son dos decisiones distintas. Un solo flag obligaría a elegir entre "no puedo
 * settlear" y "publiqué una cuenta de depósito sin verificador cableado".
 */
export function isSolanaDepositEnabled(): boolean {
  if (process.env.A2A_DEPOSIT_ENABLED_SOLANA !== 'true') return false;
  return resolveSolanaDepositOwner() !== null;
}
