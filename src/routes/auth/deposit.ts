/**
 * Auth Routes — deposit registration + public deposit configuration.
 *
 * Pure reorganization of `src/routes/auth.ts` (refactor B2, 2026-06-24).
 * POST /deposit       — Register a real, on-chain-verified deposit (WKH-35).
 * GET  /deposit-info  — Public, read-only deposit configuration.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { keccak256, stringToBytes } from 'viem';
import {
  getChainVmFamily,
  normalizeChainSlug,
  resolveChainKey,
} from '../../adapters/chain-resolver.js';
import {
  isEvmChainKey,
  resolveChainFamilyEnvSuffix,
  resolveMinConfirmations,
  resolveTreasury,
  verifyDeposit,
} from '../../adapters/deposit-verifier.js';
import {
  resolveEscrowContract,
  verifyEscrowDeposit,
} from '../../adapters/escrow-verifier.js';
import {
  getAdaptersBundle,
  getInitializedChainKeys,
} from '../../adapters/registry.js';
import { getSolanaNetwork } from '../../adapters/solana/chain.js';
import {
  isSolanaDepositEnabled,
  resolveSolanaDepositAta,
  resolveSolanaDepositOwner,
} from '../../adapters/solana/deposit-account.js';
import { verifySolanaDeposit } from '../../adapters/solana/deposit-verifier.js';
import { isValidSolanaSignature } from '../../lib/wallet-format.js';
import { budgetService } from '../../services/budget.js';
import { eventService } from '../../services/event.js';
import { receiptService } from '../../services/receipt.js';
import {
  DepositAlreadyCreditedError,
  OwnershipMismatchError,
} from '../../services/security/errors.js';
import type { DepositInput } from '../../types/index.js';
import { escrowEnabledForChain, resolveCallerKey } from './parsers.js';

export const depositRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /deposit — Register a real, on-chain-verified deposit (AC-14, WKH-35).
   *
   * Verifies a confirmed ERC-20 deposit on-chain (verify-before-credit, CD-4)
   * and only then credits budget[chainId] atomically (anti-replay + ownership,
   * CD-1/CD-2). The credited chainId comes from the bundle, never the caller (CD-5).
   */
  fastify.post('/deposit', async (req: FastifyRequest, reply: FastifyReply) => {
    // 1. Auth — mismo helper que /me.
    const callerKey = await resolveCallerKey(req);
    if (!callerKey?.is_active) {
      return reply.status(403).send({ error: 'Invalid or inactive API key' });
    }
    const ownerRef = callerKey.owner_ref;

    // 2. Validar input (DepositInput).
    const body = req.body as Partial<DepositInput> | undefined;
    const txHash = body?.tx_hash;
    const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
    // WKH-315 — la referencia se acepta si es un hash EVM **o** una firma Solana.
    //
    // ⚠️ NO ES UN REGEX LAXO (CD-6b). Son dos predicados ESTRUCTURALES ESTRICTOS y
    // MUTUAMENTE EXCLUYENTES: el alfabeto base58 no contiene `'0'`, así que ningún
    // `0x…` puede ser base58; y el charset hex no produce 64 bytes base58. Cualquier
    // otra cosa sigue dando 400 `INVALID_INPUT` en EXACTAMENTE este lugar — el caso
    // `'0xbad'` de la suite existente falla los DOS predicados (CD-1).
    //
    // La coherencia familia↔formato se exige en el paso 3b, DESPUES de resolver la
    // chain, porque moverla acá arriba cambiaría el `error_code` de la rama EVM.
    const isAcceptedTxRef = (t: string) =>
      TX_HASH_RE.test(t) || isValidSolanaSignature(t);
    if (
      !body ||
      typeof body.key_id !== 'string' ||
      body.key_id.trim() === '' ||
      typeof txHash !== 'string' ||
      !isAcceptedTxRef(txHash) ||
      typeof body.chain_id !== 'number' ||
      !Number.isFinite(body.chain_id)
    ) {
      return reply.status(400).send({ error_code: 'INVALID_INPUT' });
    }

    // 2b. Ownership pre-check (defense-in-depth, CD-1): un caller solo fondea SU key.
    if (body.key_id !== callerKey.id) {
      return reply.status(403).send({ error_code: 'OWNERSHIP_MISMATCH' });
    }

    // 3. Resolver chain + bundle (DT-5 / AC-6 / CD-5).
    const headerChain = req.headers['x-payment-chain'];
    const chainKey =
      typeof headerChain === 'string'
        ? resolveChainKey({ headerOverride: headerChain })
        : normalizeChainSlug(String(body.chain_id));
    if (!chainKey) {
      return reply.status(400).send({ error_code: 'CHAIN_NOT_SUPPORTED' });
    }
    const bundle = getAdaptersBundle(chainKey);
    if (!bundle) {
      return reply.status(400).send({ error_code: 'CHAIN_NOT_SUPPORTED' });
    }
    const chainId = bundle.chainConfig.chainId; // CD-5

    // 3b. WKH-315 (M20) — COHERENCIA FAMILIA ↔ FORMATO, con CERO RED.
    //
    // El paso 2 acepta las dos formas de referencia porque todavía no sabe de qué
    // familia es la chain. Acá ya se sabe, así que se exige que coincidan: una firma
    // base58 con `x-payment-chain: avalanche-fuji`, o un `0x…` con
    // `solana-devnet`, es un input incoherente y se rechaza ANTES de salir a la red.
    //
    // ⚠️ VA ANTES DEL PASO 4 A PROPOSITO. Así una firma base58 sobre una chain EVM
    // sigue contestando `INVALID_INPUT`, exactamente como hoy: si estuviera después
    // del match de `chain_id`, ese mismo input pasaría a contestar `CHAIN_MISMATCH` y
    // sería un delta observable del camino EVM (CD-1).
    //
    // Delta observable ÚNICO y declarado de toda la HU:
    // `{tx_hash: <firma base58>, chain_id: <inexistente>}` pasa de `INVALID_INPUT` a
    // `CHAIN_NOT_SUPPORTED`. Antes era INALCANZABLE (toda firma base58 moría en el
    // paso 2), así que ningún cliente EVM existente puede observarlo.
    const refIsSolanaSignature = isValidSolanaSignature(txHash);
    const chainIsSolana = getChainVmFamily(chainKey) === 'solana';
    if (refIsSolanaSignature !== chainIsSolana) {
      return reply.status(400).send({ error_code: 'INVALID_INPUT' });
    }

    // 4. chain_id match (AC-4).
    if (body.chain_id !== chainId) {
      return reply.status(400).send({ error_code: 'CHAIN_MISMATCH' });
    }

    // ── 4a. WKH-315 — SUB-FLUJO SOLANA. Todas sus salidas retornan ────────────
    //
    // La bifurcación es por `bundle.payment.vmFamily`, el discriminante literal de la
    // unión `PaymentAdapter`: narrowea `payment` a `SolanaPaymentAdapter` y hace que
    // el camino viem (`resolveChainObject`, que LANZA para Solana) sea inalcanzable.
    if (bundle.payment.vmFamily === 'solana') {
      const solanaPayment = bundle.payment;
      const result = await verifySolanaDeposit({
        signature: txHash,
        expectedAmountUsd: body.amount,
      });

      if (!result.ok) {
        // Mapeo PROPIO, sobre el tipo PROPIO. El mapeo EVM (la lista literal de
        // `reason` más abajo) NO se toca ⇒ CD-1 se cumple trivialmente.
        //
        // `switch` EXHAUSTIVO y **sin `default`**: el compilador obliga a que todo
        // `SolanaDepositReason` nuevo tenga que decidir su status explícitamente. Un
        // `default: 400` mandaría un futuro "no pude determinar" como negativa medida.
        let status: 400 | 503;
        switch (result.reason) {
          case 'TX_ABSENT':
          case 'TX_FAILED':
          case 'DEPOSIT_NOT_FINALIZED':
          case 'MINT_MISMATCH':
          case 'RECIPIENT_MISMATCH':
          case 'AMOUNT_MISMATCH':
          case 'DEPOSITOR_AMBIGUOUS':
            // Negativa MEDIDA: el caller la distingue por el `error_code`.
            status = 400;
            break;
          case 'DEPOSIT_ACCOUNT_NOT_CONFIGURED':
          case 'DEPOSIT_VERIFICATION_UNKNOWN':
            // "No puedo responder por la cadena o por la config" — espejo de
            // `RPC_UNAVAILABLE` / `ESCROW_CONTRACT_NOT_CONFIGURED` en la rama EVM.
            status = 503;
            break;
        }

        if (result.reason === 'DEPOSIT_VERIFICATION_UNKNOWN') {
          // ── Canal DURABLE del "no pude determinar" (AC-6 / CD-11) ───────────
          //
          // Se REUSA el vocabulario que ya existe para el `unknown` de x402
          // (`error_code` + `valueDisposition: 'unknown'` + un `a2a_events`):
          // inventar otro dejaría dos lenguajes para el mismo estado y ninguna
          // consulta que los cruce.
          req.log.error(
            {
              error_code: 'DEPOSIT_VERIFICATION_UNKNOWN',
              valueDisposition: 'unknown',
              chainKey,
              chainId,
              keyId: callerKey.id,
              signature: txHash,
              detail: result.detail,
            },
            'solana deposit verification UNKNOWN: could not determine on-chain whether this signature credited the deposit account. NO budget was credited and THE PROOF WAS NOT CONSUMED — no row was inserted, so the depositor can present the same signature again once the RPC recovers. No manual reconciliation is needed.',
          );
          // Fire-and-forget con `.catch`: `track()` TIRA si el insert falla, y un
          // problema de telemetría NO puede cambiar la respuesta de un money-path.
          //
          // NO se registra `owner_ref`: `a2a_events` es telemetría global y el
          // `keyId` ya alcanza para reconciliar (mismo criterio que el canal x402).
          void eventService
            .track({
              eventType: 'solana_deposit_unknown',
              status: 'failed',
              metadata: {
                error_code: 'DEPOSIT_VERIFICATION_UNKNOWN',
                valueDisposition: 'unknown',
                chainKey,
                chainId,
                keyId: callerKey.id,
                signature: txHash,
                proofConsumed: false,
                detail: result.detail,
              },
            })
            .catch((trackErr: unknown) => {
              req.log.error(
                {
                  error_code: 'DEPOSIT_VERIFICATION_UNKNOWN_EVENT_FAILED',
                  detail:
                    trackErr instanceof Error ? trackErr.message : 'unknown',
                },
                'solana deposit UNKNOWN could not be persisted as an event — the only remaining record is the log line above',
              );
            });
        }

        return reply.status(status).send({ error_code: result.reason });
      }

      // ── Gate de funding wallet, rama Solana (CD-2 / AC-7 / AC-8) ────────────
      //
      // ⚠️ BLOQUEANTE SI SE SALTEA. Las firmas de una cuenta Solana son PUBLICAS vía
      // `getSignaturesForAddress` sobre la ATA de depósito: un atacante hace polling,
      // toma la firma del depósito ajeno y la presenta como propia. Y el UNIQUE que
      // existe para proteger GARANTIZA QUE EL LEGITIMO PIERDA. Con este gate el
      // ataque termina en 403 **sin insertar fila**, así que el legítimo sigue
      // pudiendo reclamar.
      //
      // Comparación BYTE-EXACTA, CERO `toLowerCase()`: bajar de caja una pubkey
      // base58 la destruye y haría equivalentes dos wallets distintas.
      if (!callerKey.funding_wallet_solana) {
        return reply
          .status(403)
          .send({ error_code: 'FUNDING_WALLET_NOT_BOUND' });
      }
      if (result.depositor !== callerKey.funding_wallet_solana) {
        return reply
          .status(403)
          .send({ error_code: 'FUNDING_WALLET_MISMATCH' });
      }

      // Acreditar. NUNCA antes del verify (CD-4), y `chainId` es SIEMPRE el del
      // bundle, nunca el del caller (CD-5).
      try {
        const balance = await budgetService.registerDeposit(
          callerKey.id,
          chainId,
          result.amountUsd, // el monto DE LA CADENA (AC-1)
          ownerRef,
          txHash,
          solanaPayment.supportedTokens[0]?.symbol,
          'solana',
        );
        void receiptService.emit({
          ownerRef,
          agentKeyId: callerKey.id,
          sessionId: null,
          delegationId: null,
          receiptType: 'deposit_verified',
          amountUsd: result.amountUsd,
          chainId,
          txHash,
          counterparty: null,
          orchestrationId: null,
        });
        return reply.status(200).send({ balance, chain_id: chainId });
      } catch (err) {
        if (err instanceof DepositAlreadyCreditedError) {
          return reply
            .status(409)
            .send({ error_code: 'DEPOSIT_ALREADY_CREDITED' });
        }
        if (err instanceof OwnershipMismatchError) {
          return reply.status(403).send({ error_code: 'OWNERSHIP_MISMATCH' });
        }
        fastify.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'solana deposit failed',
        );
        return reply.status(500).send({ error_code: 'DEPOSIT_FAILED' });
      }
    }

    // 4b. WKH-315 (AC-14 / SDD GAP #2) — el narrowing a `EvmChainKey` que el
    // camino viem necesita. Este guard es INALCANZABLE: no-EVM ⟺ 'solana-devnet'
    // ⟺ `bundle.payment.vmFamily === 'solana'`, que el sub-flujo Solana de arriba
    // ya retornó. Existe para que `tsc` pueda pasarle `chainKey` a `verifyDeposit`
    // y a `resolveTreasury` sin un cast — un cast es una aserción SIN chequeo, y
    // AC-14 pide que la defensa sea el compilador. Desde acá el bloque EVM es
    // byte-idéntico al de antes de esta HU (CD-1).
    if (!isEvmChainKey(chainKey)) {
      return reply.status(400).send({ error_code: 'CHAIN_NOT_SUPPORTED' });
    }

    // 5. Verificar on-chain ANTES de acreditar (AC-1 / CD-4). Selector escrow vs
    // treasury (DT-10): con ESCROW_MODE_ENABLED='true' (estricto, CD-11) se usa
    // el verifier no-custodial; default = treasury intacto (AC-8).
    const result = escrowEnabledForChain(chainKey)
      ? await verifyEscrowDeposit({
          chainKey,
          bundle,
          txHash: txHash as `0x${string}`,
          keyIdHash: keccak256(stringToBytes(callerKey.id)), // §3, VERIFY-AT-IMPL con 126a
          expectedAmountUsd: body.amount,
        })
      : await verifyDeposit({
          chainKey,
          bundle,
          txHash: txHash as `0x${string}`,
          expectedAmountUsd: body.amount,
        });
    if (
      !result.ok ||
      result.amountUsd === undefined ||
      result.from === undefined
    ) {
      // CD-10: RPC_UNAVAILABLE o ESCROW_CONTRACT_NOT_CONFIGURED → 503; resto → 400.
      const reason = result.reason;
      const status =
        reason === 'RPC_UNAVAILABLE' ||
        reason === 'ESCROW_CONTRACT_NOT_CONFIGURED'
          ? 503
          : 400;
      return reply
        .status(status)
        .send({ error_code: reason ?? 'VERIFICATION_FAILED' });
    }

    // 5b. Funding-wallet gate (FIX-1, BLQ-MED-1). El treasury es compartido, así
    // que validar solo `Transfer.to` permite que un atacante front-run del
    // txHash reclame el depósito ajeno. Exigimos que el depositante
    // (Transfer.from) sea la funding wallet previamente bindeada a la key.
    if (!callerKey.funding_wallet) {
      return reply.status(403).send({ error_code: 'FUNDING_WALLET_NOT_BOUND' });
    }
    if (result.from.toLowerCase() !== callerKey.funding_wallet.toLowerCase()) {
      return reply.status(403).send({ error_code: 'FUNDING_WALLET_MISMATCH' });
    }

    // 6. Acreditar atómico (AC-3 / AC-5). NUNCA antes del verify (CD-4).
    try {
      const balance = await budgetService.registerDeposit(
        callerKey.id,
        chainId,
        result.amountUsd,
        ownerRef,
        txHash,
        result.tokenSymbol,
      );
      // 6b. Recibo deposit_verified (AC-11) — best-effort, NUNCA bloquea ni
      // propaga (DT-11). Aplica a AMBOS caminos (no cambia shape ni status →
      // cero regresión AC-8). `emit` es NUNCA-throw, por eso `void` sin await.
      void receiptService.emit({
        ownerRef,
        agentKeyId: callerKey.id,
        sessionId: null,
        delegationId: null,
        receiptType: 'deposit_verified',
        amountUsd: result.amountUsd,
        chainId,
        txHash,
        counterparty: null,
        orchestrationId: null,
      });
      // 7. Respuesta (DepositResponse).
      return reply.status(200).send({ balance, chain_id: chainId });
    } catch (err) {
      if (err instanceof DepositAlreadyCreditedError) {
        return reply
          .status(409)
          .send({ error_code: 'DEPOSIT_ALREADY_CREDITED' });
      }
      if (err instanceof OwnershipMismatchError) {
        return reply.status(403).send({ error_code: 'OWNERSHIP_MISMATCH' });
      }
      fastify.log.error(
        { errorClass: err instanceof Error ? err.constructor.name : 'unknown' },
        'deposit failed',
      );
      return reply.status(500).send({ error_code: 'DEPOSIT_FAILED' });
    }
  });

  /**
   * GET /deposit-info — Public, read-only deposit configuration (WKH-DEPOSIT-INFO).
   *
   * Returns one entry per initialized chain with the data a dev needs to fund
   * an Agent Key: treasury address, ERC-20 token (symbol/address/decimals) and
   * minimum confirmations. No auth, no DB, no RPC — purely env + registry data.
   *
   * CD-1: treasury/min_confirmations come from `deposit-verifier.ts` helpers
   * (single source of truth, no duplication).
   * CD-2/AC-5: NEVER serialize `OPERATOR_PRIVATE_KEY` or any secret. `treasury`
   * is only the resolved address (or `null`), never the private key.
   */
  fastify.get(
    '/deposit-info',
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const networks = getInitializedChainKeys()
        .map((chainKey) => {
          const bundle = getAdaptersBundle(chainKey);
          if (!bundle) return null;
          // WKH-234: deposit-info is an EVM-only listing (Solana deposit =
          // Scope OUT — no viem treasury/token address). Narrow via `vmFamily`;
          // a non-EVM chain is skipped. Byte-identical for the EVM chains.
          const payment = bundle.payment;

          // ── WKH-315 (AC-11 / CD-13) — la entrada Solana ────────────────────
          //
          // Se publica SI Y SOLO SI `isSolanaDepositEnabled()`: publicar una cuenta
          // de depósito sin verificador cableado invitaría a mandar plata que nadie
          // puede acreditar.
          //
          // ⚠️ SIN `treasury` Y SIN `escrow_*`. Los dos son resoluciones EVM, y
          // publicar una address EVM en la entrada Solana es el landmine de
          // `resolveTreasury` con otro nombre: el depositante mandaría USDC de
          // devnet a un string que en Solana no es nada.
          //
          // El destino publicado es `deposit_account` = **la ATA derivada**, y
          // `deposit_account_owner` va aparte para que se pueda auditar la
          // derivación. Los dos son públicos; NINGUNA clave privada aparece acá.
          if (payment.vmFamily === 'solana') {
            if (!isSolanaDepositEnabled()) return null;
            const ata = resolveSolanaDepositAta();
            const owner = resolveSolanaDepositOwner();
            if (ata === null || owner === null) return null;
            const solToken = payment.supportedTokens[0];
            if (!solToken) return null; // CD-3: tolerar supportedTokens vacío
            return {
              chain_id: bundle.chainConfig.chainId,
              slug: chainKey,
              family: resolveChainFamilyEnvSuffix(chainKey),
              vm_family: 'solana' as const,
              cluster: getSolanaNetwork(),
              token: {
                symbol: solToken.symbol,
                mint: solToken.mint,
                decimals: solToken.decimals,
              },
              deposit_account: ata,
              deposit_account_owner: owner,
              // El commitment es un literal del verificador, no una env: se publica
              // para que el depositante sepa que un `confirmed` no alcanza.
              required_commitment: 'finalized' as const,
            };
          }

          if (payment.vmFamily !== 'evm') return null;
          // WKH-315 (AC-14): los DOS guards se conservan A PROPOSITO. El de
          // arriba narrowea `payment` y es el que preserva la conducta observable
          // byte a byte (CD-1); este narrowea `chainKey`, que es lo que
          // `resolveTreasury`/`resolveMinConfirmations` necesitan sin un cast.
          // Redundantes en runtime, no redundantes para el compilador.
          if (!isEvmChainKey(chainKey)) return null;
          const token = payment.supportedTokens[0];
          if (!token) return null; // CD-3: tolerate empty supportedTokens
          // Escrow no-custodial: cuando está activo para esta cadena, el caller
          // deposita al CONTRATO (no a la treasury). Exponemos la dirección
          // (pública, nunca un secreto) para que el front sepa a dónde fondear.
          const escrowActive = escrowEnabledForChain(chainKey);
          return {
            chain_id: bundle.chainConfig.chainId,
            slug: chainKey,
            family: resolveChainFamilyEnvSuffix(chainKey),
            treasury: resolveTreasury(chainKey), // address | null (AC-4)
            escrow_mode: escrowActive,
            escrow_contract: escrowActive
              ? resolveEscrowContract(chainKey)
              : null,
            token: {
              symbol: token.symbol,
              address: token.address,
              decimals: token.decimals,
            },
            min_confirmations: resolveMinConfirmations(chainKey),
          };
        })
        .filter((entry) => entry !== null);

      return reply.status(200).send({ networks });
    },
  );
};
