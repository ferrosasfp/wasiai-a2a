/**
 * HU-193: credit-back del débito step-0 para el RESIDUO del riel PREPAGO.
 *
 * ── CUÁNDO USAR ESTO Y CUÁNDO NO ──────────────────────────────────────────
 *
 * Esto NO es la herramienta principal de la HU: la principal es NO COBRAR
 * (`middleware/charged-route.ts`). Esto cubre sólo el residuo — los rechazos que
 * NO se pueden adelantar porque dependen de I/O o de saber quién llama
 * (ownership del recurso, estado terminal, existencia en la DB).
 *
 * Sólo aplica al riel PREPAGO (Agent Key / delegación / key-session), donde hay
 * un saldo interno que acreditar. El caller x402 pagó on-chain y no tiene cuenta
 * con nosotros: acá se detecta por `!request.a2aKeyRow` y la función es un no-op.
 * Su residuo se documenta en el contrato público (`doc/INTEGRATION.md`), no se
 * inventa un refund on-chain.
 *
 * ── ANTES DE LLAMARLA: ¿PUDO HABERSE MOVIDO EL VALOR? ─────────────────────
 *
 * Lección de HU-192 (`adapters/errors.ts` → `GaslessValueDisposition`):
 * reembolsar en TODO error puede ser peor que el bug, porque un adapter puede
 * lanzar DESPUÉS de broadcastear y el refund regala la transferencia más el
 * saldo. Los call-sites de esta función (`/registries`, `/tasks`) no mueven
 * valor on-chain ni invocan agentes downstream: el único movimiento posible es
 * el propio débito, y los rechazos que la llaman ocurren ANTES de cualquier
 * escritura confirmada. Un fallo AMBIGUO (p.ej. la DB tira después de commitear
 * el insert, y no sabemos si el recurso quedó creado) NO debe llamarla — ver el
 * 500 de `POST /tasks` en el work-item.
 *
 * ── NO PUEDE REEMBOLSAR DE MÁS (invariantes) ──────────────────────────────
 *
 *   1. `resolvedChainId === undefined` ⟹ return. Ese campo lo setea SÓLO un
 *      branch de pago del middleware (`resolveTargetChain`); el middleware
 *      auth-only (`requireA2AKey`, que NO debita) no lo setea. Es lo que impide
 *      acreditar en una ruta que nunca debitó.
 *   2. `!request.a2aKeyRow` ⟹ no hubo débito de budget (riel x402) ⟹ return.
 *   3. `skipMiddlewareDebit` ⟹ el middleware no debitó (rutas `/orchestrate*`) ⟹
 *      return.
 *   4. El monto sale de `resolveStep0DebitUsd`, la MISMA función con la que el
 *      middleware calculó el débito → el crédito nunca puede exceder al débito.
 *   5. `step0RefundApplied` ⟹ a lo sumo UN crédito por request, aunque un
 *      handler futuro llame dos veces.
 *
 * Ownership guard (CLAUDE.md): las 4 variantes de credit reciben el `owner_ref`
 * del caller autenticado; bajo delegación/sesión se usa el refund DUAL-LEDGER
 * simétrico al débito (`debit_delegation_and_parent` / `debit_session_and_parent`),
 * nunca sólo el parent.
 *
 * Best-effort: NUNCA lanza ni cambia el status de la respuesta. Si el credit no
 * revierte nada, queda señal (log + `refundOutbox` para el sweep).
 *
 * Mismo mecanismo que `routes/compose.ts:refundComposeStep0` (HU-188) y
 * `routes/gasless.ts:refundGaslessDebit` (HU-192): `budgetService.credit*` +
 * `refundOutbox`. No se inventa nada nuevo. Esas dos NO se refactorizan a esta
 * función porque cada una tiene aritmética propia (`alreadySpentUsd` del prefijo
 * ya settleado en compose; el todo-o-nada del transfer en gasless) y son
 * money-path ya auditado.
 */

import type { FastifyRequest } from 'fastify';
import { budgetService } from '../services/budget.js';
import { refundOutbox } from '../services/refund-outbox.js';
import { refundIdemKey, requestRefundIdemBase } from './refund-idem.js';
import { resolveStep0DebitUsd } from './step0-debit.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** HU-193: invariante anti-doble-refund (ver `refundStep0Debit`). */
    step0RefundApplied?: boolean;
  }
}

/**
 * Motivo del refund — sólo para logs/outbox (auditoría post-mortem). Formato
 * `<ruta>.<caso>` para poder agrupar por endpoint en el ledger de outbox.
 */
export type Step0RefundReason = string;

export async function refundStep0Debit(
  request: FastifyRequest,
  reason: Step0RefundReason,
): Promise<void> {
  const keyRow = request.a2aKeyRow;
  const chainId = request.resolvedChainId;
  if (
    request.skipMiddlewareDebit ||
    !keyRow ||
    chainId === undefined ||
    request.step0RefundApplied
  ) {
    return;
  }
  const amountUsd = resolveStep0DebitUsd(request);
  if (!(amountUsd > 0)) return;

  // Se marca ANTES del await: si un handler llamara dos veces (o dos caminos de
  // error se encadenaran), la segunda entra al early-return de arriba.
  request.step0RefundApplied = true;

  // HU-194: clave del refund LÓGICO. Un solo refund step-0 por request (garantía
  // #5 de arriba) ⟹ un solo slot. La MISMA clave va al credit y al outbox: si el
  // credit commitea y su respuesta se pierde, el reintento del sweep es un no-op
  // del lado de Postgres en vez de un segundo crédito.
  const idem = {
    idemKey: refundIdemKey({
      keyId: keyRow.id,
      chainId,
      operationId: requestRefundIdemBase(request),
      slot: 'step0',
    }),
  };

  try {
    const creditRes = request.delegationContext
      ? await budgetService.creditDelegation(
          request.delegationContext.delegationId,
          request.delegationContext.ownerRef,
          request.delegationContext.keyId,
          chainId,
          amountUsd,
          idem,
        )
      : request.keySessionContext
        ? await budgetService.creditSession(
            request.keySessionContext.sessionId,
            request.keySessionContext.ownerRef,
            request.keySessionContext.keyId,
            chainId,
            amountUsd,
            idem,
          )
        : // M3 (auditoría, vía compose): el refund tiene que ser SIMÉTRICO al
          // débito. Si el débito pasó por dest-policy (`composeDestination`),
          // el credit también, o el ledger del cap por destino queda
          // desbalanceado. Hoy ninguna ruta de esta HU setea el destino (sólo
          // `/compose` lo hace), pero la simetría se decide acá, no en el
          // call-site.
          request.composeDestination
          ? await budgetService.creditWithDest(
              keyRow.id,
              chainId,
              amountUsd,
              keyRow.owner_ref,
              request.composeDestination,
              idem,
            )
          : await budgetService.credit(
              keyRow.id,
              chainId,
              amountUsd,
              keyRow.owner_ref,
              idem,
            );
    if (!creditRes.success) {
      // Sin msg crudo de PG (F-05). No cambia el status code.
      request.log.error(
        { keyId: keyRow.id, chainId, amountUsd, reason },
        '[step0.refund-failed]',
      );
      // success:false ⟹ nada se aplicó ⟹ encolar para reintento confiable
      // (invariante anti-doble-refund: sólo se encola cuando NO revirtió nada).
      await refundOutbox.enqueueRefund({
        keyId: keyRow.id,
        chainId,
        amountUsd,
        ownerRef: keyRow.owner_ref,
        destination: request.composeDestination ?? null,
        reason: `${reason}:refund-failed`,
        idemKey: idem.idemKey,
      });
      return;
    }
    request.log.info(
      { keyId: keyRow.id, chainId, amountUsd, reason },
      'step0.refunded',
    );
  } catch (e) {
    request.log.error(
      { detail: e instanceof Error ? e.message : String(e), reason },
      '[step0.refund-threw]',
    );
    await refundOutbox
      .enqueueRefund({
        keyId: keyRow.id,
        chainId,
        amountUsd,
        ownerRef: keyRow.owner_ref,
        destination: request.composeDestination ?? null,
        reason: `${reason}:refund-threw`,
        // HU-194: MISMA clave que el `refund-failed` de arriba y que el credit
        // que acaba de tirar. Ése es el punto: el `catch` no sabe si el crédito
        // commiteó, y con esta clave da igual — el sweep no puede duplicarlo.
        idemKey: idem.idemKey,
      })
      .catch((outboxErr) =>
        request.log.error(
          {
            detail: outboxErr instanceof Error ? outboxErr.message : 'unknown',
          },
          '[step0.refund-outbox-threw]',
        ),
      );
  }
}
