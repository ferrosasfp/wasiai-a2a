/**
 * Orchestrate Routes — Goal-based orchestration with LLM planning
 *
 * WKH-13: orchestrationId generated here (not in service),
 * passed to service, always available for response/error.
 * WKH-18: Backpressure + timeout preHandlers, structured logging, error boundary.
 */

import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
// WKH-305 (CR MNR-3): módulo LEAF (cero imports de runtime) — la MISMA
// definición de las reglas de forma que usan el borde de `/compose` y el service.
import { validateInputMappingShape } from '../lib/compose-input-mapping.js';
import { CONTRACTING_LOOP_DETECTED } from '../lib/contracting-chain.js';
import type { DownstreamSkipCode } from '../lib/downstream-skip-code.js';
import {
  extractRawKey,
  requirePaymentOrA2AKey,
} from '../middleware/a2a-key.js';
import { createBackpressureHandler } from '../middleware/backpressure.js';
import { contractingGuardHandler } from '../middleware/contracting-guard.js';
import { noteDownstreamSkips } from '../middleware/event-tracking.js';
import { requireForwardKey } from '../middleware/forward-key.js';
import { orchestrateRateLimit } from '../middleware/rate-limit.js';
import { createTimeoutHandler } from '../middleware/timeout.js';
import { resolveAgentPriceUsdc } from '../services/agent-price.js';
import { getProtocolFeeRate } from '../services/fee-charge.js';
import { orchestrateService } from '../services/orchestrate.js';
import {
  resolveQuoteCaller,
  signQuote,
  verifyQuote,
} from '../services/orchestrate-quote.js';
import type {
  OrchestratePlanResult,
  ResolvedComposeStep,
} from '../types/index.js';

type OrchestrateBody = {
  goal: string;
  budget: number;
  preferCapabilities?: string[];
  maxAgents?: number;
};

// WKH-131 (HU-128): body de POST /orchestrate/execute. El cliente reenvía el
// plan aprobado (orchestrationId + steps) y el cap (maxQuotedCostUsdc). Los
// precios del cliente NO se reciben — el route los re-resuelve server-side (CD-2).
type OrchestrateExecuteBody = {
  orchestrationId: string;
  // HU-208: `ResolvedComposeStep[]` — el JSON schema de abajo exige
  // `agent: {type:'string', minLength:1}` en cada item, así que Fastify ya
  // garantiza en el borde lo que el tipo afirma. `/orchestrate/execute` NO
  // acepta steps por capacidad.
  steps: ResolvedComposeStep[];
  maxQuotedCostUsdc: number;
  budget: number;
  preferCapabilities?: string[];
  maxAgents?: number;
  /**
   * WKH-303: quote firmado emitido por `/plan`. OPCIONAL — su ausencia preserva el
   * comportamiento de hoy byte a byte (precio re-resuelto en vivo contra maxQuotedCostUsdc).
   */
  quote?: string;
};

/**
 * WKH-127 (CD-8): marca skip ANTES del middleware de débito. orchestrate debita
 * el costo real post-plan en el service (Opción B); el middleware NO debe debitar
 * el placeholder $1. El flag se respeta SOLO en el path master del middleware
 * (deleg/session lo ignoran — CD-9).
 */
async function markSkipMiddlewareDebitHandler(
  request: FastifyRequest,
): Promise<void> {
  request.skipMiddlewareDebit = true;
}

/**
 * WKH-305 (CR MNR-3): valida la FORMA de `inputFromPrevious` ANTES del
 * middleware de pago, igual que hace `validateComposeBodyHandler` en
 * `routes/compose.ts`.
 *
 * POR QUÉ HACE FALTA ACÁ: el schema de `steps[]` de esta ruta **no declara
 * `additionalProperties: false`**, así que ajv NO remueve las claves que no
 * conoce — un `inputFromPrevious` malformado llega intacto al handler y de ahí al
 * service. Sin este preHandler:
 *   · el rechazo llegaba DESPUÉS del débito del step 0, o sea que un body
 *     inválido costaba un débito y su reembolso en vez de un error gratis;
 *   · S8 (mapeo en el step 0) no se aplicaba nunca por esta ruta, así que el
 *     integrador recibía un error que apuntaba al lugar equivocado.
 *
 * Las REGLAS no se duplican: son las mismas de `lib/compose-input-mapping.ts`,
 * el mismo módulo que consumen el borde de `/compose` y el resolvedor del
 * service. Acá sólo se traduce al shape de error de esta ruta.
 *
 * Idiom Fastify 5: `return reply.status(...).send(...)` aborta la cadena.
 */
async function validateStepInputMappingHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const steps = (request.body as { steps?: unknown } | undefined)?.steps;
  if (!Array.isArray(steps)) return;
  for (let i = 0; i < steps.length; i++) {
    const mappingErr = validateInputMappingShape(steps[i], i);
    if (mappingErr) {
      return reply.status(400).send({
        error: `Step ${i}: ${mappingErr.message}`,
        code: 'VALIDATION_ERROR',
        step: i,
        requestId: request.id,
      });
    }
  }
}

const orchestrateRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: OrchestrateBody }>(
    '/',
    {
      config: { rateLimit: orchestrateRateLimit() },
      schema: {
        body: {
          type: 'object',
          required: ['goal', 'budget'],
          properties: {
            goal: { type: 'string', minLength: 1, maxLength: 2000 },
            budget: { type: 'number', exclusiveMinimum: 0, maximum: 100000 },
            maxAgents: { type: 'integer', minimum: 1, maximum: 20 },
            preferCapabilities: {
              type: 'array',
              items: { type: 'string', maxLength: 100 },
              maxItems: 20,
            },
          },
        },
      },
      preHandler: [
        // WKH-360 (AC-5/AC-6): la CAPA 2 va PRIMERA de las TRES cadenas de
        // orchestrate, antes de `markSkipMiddlewareDebitHandler` y por lo tanto
        // antes de cualquier decision de debito. Las tres la necesitan: las tres
        // desembocan en `executeApprovedPlan`, que es donde vive el unico debito
        // del step-0 de orchestrate.
        contractingGuardHandler,
        // WKH-65: forward-key (optional, env-gated) runs BEFORE backpressure/timeout/payment.
        // Returns [] when WASIAI_V2_FORWARD_KEY is unset → no-op spread.
        ...requireForwardKey(),
        createBackpressureHandler(),
        createTimeoutHandler(
          parseInt(process.env.TIMEOUT_ORCHESTRATE_MS ?? '120000', 10),
        ),
        // WKH-127 (CD-8): marca skip ANTES del middleware de débito.
        markSkipMiddlewareDebitHandler,
        ...requirePaymentOrA2AKey({
          description:
            'WasiAI Orchestration Service — Goal-based AI agent orchestration',
        }),
      ],
    },
    async (request, reply: FastifyReply) => {
      const orchestrationId = crypto.randomUUID();

      try {
        const body = request.body;

        request.log.info({ orchestrationId }, 'Orchestration started');

        // BLQ-2: bail early if timeout already sent 504
        if (reply.sent) return;

        // Array PRESTADO al pipeline para los motivos INTERNOS de skip del leg
        // downstream. Es un INPUT y no un campo del resultado porque abajo se hace
        // `reply.send({ ..., ...result })` sin schema: todo lo que viva en el
        // resultado sale por HTTP, y estos codigos son los que se genericizan
        // justamente para no salir de casa.
        const downstreamSkipCauses: DownstreamSkipCode[] = [];
        const result = await orchestrateService.orchestrate(
          {
            downstreamSkipCauses,
            goal: body.goal.trim(),
            budget: body.budget,
            preferCapabilities: body.preferCapabilities,
            maxAgents: body.maxAgents,
            // WKH-61: propagar el row del caller para scoping per-step en compose
            // HU-DOUBLE-PAY — la credencial CRUDA del caller, derivada con la
            // MISMA extracción que usa el middleware de auth (`extractRawKey`:
            // `x-a2a-key` O `Authorization: Bearer wasi_a2a_*`).
            //
            // POR QUÉ FALTABA Y POR QUÉ IMPORTA: `orchestrate.ts:1216` pasa
            // `a2aKey: request.a2aKey` a `composeService.compose`, pero NINGUNA de
            // las tres rutas HTTP poblaba ese campo — sólo lo poblaba el tool MCP
            // (`mcp/tools/orchestrate.ts`). Como la propiedad es opcional,
            // compilaba, y por HTTP `a2aKey` llegaba SIEMPRE `undefined`. Efecto
            // medible: `compose.invokeAgent` no le reenviaba al agente el
            // `x-a2a-key` del caller (el forward a registries system-trusted de
            // `compose.ts`), y —hasta este fix— el gate `!a2aKey` del segundo leg
            // de salida daba SIEMPRE true, así que el doble pago alcanzaba también
            // a los callers PREPAGOS por este camino.
            //
            // Es el MISMO desajuste que la auditoría C2 (2026-07-01) arregló en
            // `/compose` (`routes/compose.ts`), y que nunca se replicó acá.
            // `/compose` es un endpoint único; orchestrate son TRES, y los tres
            // tienen que derivarla igual o vuelve a divergir.
            a2aKey: extractRawKey(request),
            scopingKeyRow: request.a2aKeyRow,
            // WKH-101 (DT-11): contexto de delegación propagado a compose.
            delegationContext: request.delegationContext,
            // WKH-121 (BLQ-ALTO-1): contexto de key-session propagado a compose
            // para que el cap de sesión se respete en los steps 1..N. Espejo de
            // delegationContext.
            keySessionContext: request.keySessionContext,
            // WKH-104 (TD-COMMENT): chainId resuelto y propagado para TODOS los
            // callers (master keys y sesiones delegadas), para que el débito
            // per-step de steps 1..N use el chainId del bundle resuelto en el
            // middleware. Desde WKH-102 ya no es exclusivo de delegación.
            chainId: request.resolvedChainId,
            // WKH-360 (AC-7): la traza de contratacion entrante YA VALIDADA por
            // `contractingGuardHandler` (primer preHandler de esta cadena). Baja al
            // service y de ahi a compose, que es quien la EMITE. Ausente ⇒ cadena
            // vacia / profundidad 0, o sea el 100% del trafico de hoy.
            contractingChain: request.contractingChain,
            contractingDepth: request.contractingDepth,
            // WKH-360 (fix-pack AR/CR BLQ-MED-1): el `Host` por el que entro ESTA
            // peticion. Sin esto, con `BASE_URL` y `A2A_SELF_HOSTS` ausentes el
            // conjunto de identidad queda vacio y el SITIO 2 se saltea entero por su
            // gate `selfHosts.length > 0` => el step-0 de esta ruta queda SIN guard
            // de dinero. Baja tambien a compose (SITIOS 3 y 4).
            selfHostHint: request.hostname,
          },
          orchestrationId,
        );

        // BLQ-2: bail early if timeout fired during orchestration
        if (reply.sent) return;

        const kiteTxHash = request.paymentTxHash;
        // WKH-61: pipeline.errorCode === 'SCOPE_DENIED' → 403 (legacy 200 path).
        // TD-WKH-61-2: la limpieza completa del mapeo `pipeline.success===false`
        // → 4xx queda fuera de scope; solo agregamos el branch SCOPE_DENIED.
        // WKH-360: el corte del SITIO 2 (bucle de contratación, pre-débito) sale
        // como 400. Cae en la misma familia de status que el resto de los rechazos
        // de dominio sobre un body bien formado; NO se estrena un 508.
        const status =
          result.pipeline.errorCode === 'SCOPE_DENIED'
            ? 403
            : result.pipeline.errorCode === CONTRACTING_LOOP_DETECTED
              ? 400
              : 200;
        // WKH-127 (AC-4): el service decidió el fallback $1 → seteamos el header acá
        // (el service no recibe reply, CD-7).
        if (result.debitFallback) {
          reply.header('x-debit-fallback', 'registry-miss');
        }
        // WKH-127: saldo post-débito (y post-refund) real — el middleware lo saltó
        // bajo skipMiddlewareDebit, así que lo escribe el route con el valor del service.
        if (result.remainingBudgetUsd !== undefined) {
          reply.header('x-a2a-remaining-budget', result.remainingBudgetUsd);
        }
        // WKH-191x: retiene los skip-codes PÚBLICOS del pipeline para que el evento
        // los persista (`a2a_events.metadata.downstreamSkips`). Aditivo puro: NO lee
        // ni cambia nada del money-path, sólo copia lo que ya viaja en el response.
        noteDownstreamSkips(
          request,
          result.pipeline.steps,
          downstreamSkipCauses,
        );
        // WKH-360 (CD-19): el `error_code` top-level de familia 1, para que un
        // cliente matchee UN solo string sin tener que mirar dentro de `pipeline`.
        // El VALOR sale de la misma constante del leaf que usa el camel de adentro.
        return reply.status(status).send({
          kiteTxHash,
          ...result,
          ...(result.pipeline.errorCode === CONTRACTING_LOOP_DETECTED && {
            error_code: CONTRACTING_LOOP_DETECTED,
            layer: 'direct',
          }),
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Orchestration failed';
        request.log.error(
          { orchestrationId, err: message },
          'Orchestration failed',
        );
        // Attach orchestrationId to the error for the error boundary
        const wrappedErr = err instanceof Error ? err : new Error(message);
        (wrappedErr as Error & { orchestrationId?: string }).orchestrationId =
          orchestrationId;
        throw wrappedErr;
      }
    },
  );

  // ─── WKH-131: POST /orchestrate/plan ──────────────────────────
  // discover + LLM/greedy planning + price-resolution. Cero debit, cero compose,
  // cero settle (CD-1). Devuelve un quote (maxQuotedCostUsdc) + planStatus.
  // preHandlers IDÉNTICOS a `/` (CD-7/AC-12) — incluido markSkipMiddlewareDebit.
  fastify.post<{ Body: OrchestrateBody }>(
    '/plan',
    {
      config: { rateLimit: orchestrateRateLimit() },
      schema: {
        body: {
          type: 'object',
          required: ['goal', 'budget'],
          properties: {
            goal: { type: 'string', minLength: 1, maxLength: 2000 },
            budget: { type: 'number', exclusiveMinimum: 0, maximum: 100000 },
            maxAgents: { type: 'integer', minimum: 1, maximum: 20 },
            preferCapabilities: {
              type: 'array',
              items: { type: 'string', maxLength: 100 },
              maxItems: 20,
            },
          },
        },
      },
      preHandler: [
        // WKH-360 (AC-5/AC-6): la CAPA 2 va PRIMERA de las TRES cadenas de
        // orchestrate, antes de `markSkipMiddlewareDebitHandler` y por lo tanto
        // antes de cualquier decision de debito. Las tres la necesitan: las tres
        // desembocan en `executeApprovedPlan`, que es donde vive el unico debito
        // del step-0 de orchestrate.
        contractingGuardHandler,
        ...requireForwardKey(),
        createBackpressureHandler(),
        createTimeoutHandler(
          parseInt(process.env.TIMEOUT_ORCHESTRATE_MS ?? '120000', 10),
        ),
        // WKH-127 (CD-8): marca skip ANTES del middleware de débito (idéntico a `/`).
        markSkipMiddlewareDebitHandler,
        ...requirePaymentOrA2AKey({
          description:
            'WasiAI Orchestration Service — Goal-based AI agent orchestration (plan)',
        }),
      ],
    },
    async (request, reply: FastifyReply) => {
      const orchestrationId = crypto.randomUUID();

      try {
        const body = request.body;

        request.log.info({ orchestrationId }, 'Orchestration plan started');

        // BLQ-2: bail early if timeout already sent 504
        if (reply.sent) return;

        const plan = await orchestrateService.planOrchestration(
          {
            goal: body.goal.trim(),
            budget: body.budget,
            preferCapabilities: body.preferCapabilities,
            maxAgents: body.maxAgents,
            // HU-DOUBLE-PAY — la credencial CRUDA del caller, derivada con la
            // MISMA extracción que usa el middleware de auth (`extractRawKey`:
            // `x-a2a-key` O `Authorization: Bearer wasi_a2a_*`).
            //
            // POR QUÉ FALTABA Y POR QUÉ IMPORTA: `orchestrate.ts:1216` pasa
            // `a2aKey: request.a2aKey` a `composeService.compose`, pero NINGUNA de
            // las tres rutas HTTP poblaba ese campo — sólo lo poblaba el tool MCP
            // (`mcp/tools/orchestrate.ts`). Como la propiedad es opcional,
            // compilaba, y por HTTP `a2aKey` llegaba SIEMPRE `undefined`. Efecto
            // medible: `compose.invokeAgent` no le reenviaba al agente el
            // `x-a2a-key` del caller (el forward a registries system-trusted de
            // `compose.ts`), y —hasta este fix— el gate `!a2aKey` del segundo leg
            // de salida daba SIEMPRE true, así que el doble pago alcanzaba también
            // a los callers PREPAGOS por este camino.
            //
            // Es el MISMO desajuste que la auditoría C2 (2026-07-01) arregló en
            // `/compose` (`routes/compose.ts`), y que nunca se replicó acá.
            // `/compose` es un endpoint único; orchestrate son TRES, y los tres
            // tienen que derivarla igual o vuelve a divergir.
            a2aKey: extractRawKey(request),
            scopingKeyRow: request.a2aKeyRow,
            delegationContext: request.delegationContext,
            keySessionContext: request.keySessionContext,
            chainId: request.resolvedChainId,
          },
          orchestrationId,
        );

        if (reply.sent) return;

        // WKH-132 (fee transparency, AC-1/DT-2): tasa explícita del protocol fee,
        // derivada de la ÚNICA fuente de verdad getProtocolFeeRate() (fee-charge.ts)
        // — la MISMA que produce protocolFeeUsdc, nunca recalculada ni hardcodeada
        // (CD-1). Se expresa en porcentaje (getProtocolFeeRate() * 100, ej. 1 = 1%).
        // Refleja el rate EFECTIVO post-clamp del env (AC-5), nunca el crudo inválido.
        // Solo en planStatus 'ready' (hubo pipeline con fee); en los early-returns
        // protocolFeeUsdc es 0 y feeRatePercent se OMITE para no reportar un fee
        // "cobrado" engañoso sin pipeline (AC-2). Aditivo, no rompe compat (CD-4).
        const feeRatePercent =
          plan.planStatus === 'ready'
            ? Number((getProtocolFeeRate() * 100).toFixed(6))
            : undefined;

        // WKH-132 (BLQ-MED-1 fix): protocolFeeUsdc REPORTADO = fee real cost-based =
        // round(totalCostUsdc × getProtocolFeeRate()), derivado de la MISMA fuente que
        // feeRatePercent → reconcilia por construcción (protocolFeeUsdc ==
        // totalCostUsdc × feeRatePercent/100). ANTES se reportaba el residual del techo
        // (maxQuotedCostUsdc − totalCostUsdc), inflado por PLACEHOLDER_FEE_USD en steps
        // sin precio → NO reconciliaba. maxQuotedCostUsdc queda como el TECHO/cap del
        // /execute (invariante: maxQuotedCostUsdc ≥ totalCostUsdc + protocolFeeUsdc).
        // Este valor es SOLO el reportado en el quote: NO cambia el cobro real de
        // /execute (pipeline.totalCostUsdc × rate) ni el cap que enforcea (money-path
        // intacto). En early-returns (planStatus != 'ready') el fee reportado es 0.
        const protocolFeeUsdc =
          plan.planStatus === 'ready'
            ? Number((plan.totalCostUsdc * getProtocolFeeRate()).toFixed(6))
            : plan.protocolFeeUsdc;

        // WKH-303 (AC-1): quote firmado que congela precio E IDENTIDAD por step
        // durante 10 minutos. Se emite SOLO si se cumplen las cinco condiciones:
        //   1. el plan está 'ready';
        //   2. hay secreto configurado (`quoteHmacKey()`);
        //   3. el caller es bindeable (key / delegación / sesión; x402 no lo es);
        //   4. hay al menos un step y todos traen slug;
        //   5. TODO `costPerStep[i]` es finito y > 0.
        // La quinta es deliberada: un step sin precio resuelto cotiza 0 y hoy se cobra
        // con PLACEHOLDER_FEE_USD. Congelar 0 sería congelar un revenue leak; congelar
        // el placeholder sería congelar un número que nunca se cotizó. No emitir quote
        // deja al cliente con el comportamiento de hoy, que no empeora.
        // Si falla cualquiera, ambos campos quedan `undefined` y JSON.stringify los
        // omite → respuesta byte-idéntica a la de antes (mismo mecanismo que feeRatePercent).
        const quoteCaller = resolveQuoteCaller(request);
        const canQuote =
          plan.planStatus === 'ready' &&
          // ⚠️ Este `quoteCaller !== null` está ENMASCARADO por el del ternario de
          // abajo, que es el que TypeScript necesita para el narrowing antes de
          // pasarlo como `caller`. Se deja a propósito, para que la lista de las
          // cinco condiciones de emisión se lea completa en un solo lugar — pero
          // conviene saber que es redundante: una mutación que lo borre NO cambia
          // nada observable (fue exactamente lo que escondió al mutante M19, que
          // sólo muere si además se fabrica un caller en el ternario). Si algún día
          // se saca, hay que verificar que el narrowing del ternario siga en pie.
          quoteCaller !== null &&
          plan.steps.length >= 1 &&
          plan.steps.length === plan.costPerStep.length &&
          plan.steps.every(
            (step) => typeof step.agent === 'string' && step.agent.length > 0,
          ) &&
          plan.costPerStep.every(
            (price) => Number.isFinite(price) && price > 0,
          );

        const signedQuote =
          canQuote && quoteCaller !== null
            ? signQuote({
                orchestrationId: plan.orchestrationId,
                caller: quoteCaller,
                steps: plan.steps.map((step, i) => ({
                  agent: step.agent,
                  registry: step.registry ?? null,
                  priceUsdc: plan.costPerStep[i] as number,
                })),
              })
            : null;

        if (signedQuote !== null) {
          // CD-10: NUNCA el token, el payload ni el secreto en el log.
          request.log.info(
            {
              orchestrationId: plan.orchestrationId,
              stepCount: plan.steps.length,
              expiresAt: signedQuote.expiresAtIso,
            },
            '[orchestrate.quote.issued]',
          );
        }

        // Solo los campos PÚBLICOS del OrchestratePlanResult (pick). Los internos
        // (plannedCostUsd, feeUsdc, billingKeyRow, discoveredAgents, etc.) NO se
        // serializan al cliente. Sin débito → sin header x-a2a-remaining-budget.
        // feeRatePercent undefined → JSON.stringify lo omite (AC-2).
        return reply.status(200).send({
          orchestrationId: plan.orchestrationId,
          planStatus: plan.planStatus,
          steps: plan.steps,
          costPerStep: plan.costPerStep,
          totalCostUsdc: plan.totalCostUsdc,
          protocolFeeUsdc,
          feeRatePercent,
          maxQuotedCostUsdc: plan.maxQuotedCostUsdc,
          reasoning: plan.reasoning,
          consideredAgents: plan.consideredAgents,
          // WKH-303: `undefined` ⇒ JSON.stringify los omite ⇒ back-compat sin condicionales.
          quote: signedQuote?.token,
          quoteExpiresAt: signedQuote?.expiresAtIso,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Orchestration plan failed';
        request.log.error(
          { orchestrationId, err: message },
          'Orchestration plan failed',
        );
        const wrappedErr = err instanceof Error ? err : new Error(message);
        (wrappedErr as Error & { orchestrationId?: string }).orchestrationId =
          orchestrationId;
        throw wrappedErr;
      }
    },
  );

  // ─── WKH-131: POST /orchestrate/execute ───────────────────────
  // Recibe el plan aprobado (steps) + el cap (maxQuotedCostUsdc). Re-resuelve los
  // precios server-side (cache-bust), rechaza 409 QUOTE_STALE si el precio drifteó
  // por encima del cap; si no, ejecuta el pipeline real idéntico al atómico.
  // markSkipMiddlewareDebitHandler OBLIGATORIO (CD-NEW-5: anti double-charge $1).
  fastify.post<{ Body: OrchestrateExecuteBody }>(
    '/execute',
    {
      config: { rateLimit: orchestrateRateLimit() },
      schema: {
        body: {
          type: 'object',
          required: ['orchestrationId', 'steps', 'maxQuotedCostUsdc', 'budget'],
          properties: {
            orchestrationId: { type: 'string', minLength: 1 },
            steps: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['agent', 'input'],
                properties: {
                  agent: { type: 'string', minLength: 1 },
                  registry: { type: 'string' },
                  input: { type: 'object' },
                  passOutput: { type: 'boolean' },
                },
              },
            },
            maxQuotedCostUsdc: { type: 'number', minimum: 0 },
            budget: { type: 'number', exclusiveMinimum: 0, maximum: 100000 },
            // WKH-303: NO va en `required` — sin quote, el camino de hoy intacto (AC-6).
            quote: { type: 'string', minLength: 1, maxLength: 8192 },
            maxAgents: { type: 'integer', minimum: 1, maximum: 20 },
            preferCapabilities: {
              type: 'array',
              items: { type: 'string', maxLength: 100 },
              maxItems: 20,
            },
          },
        },
      },
      preHandler: [
        // WKH-360 (AC-5/AC-6): la CAPA 2 va PRIMERA de las TRES cadenas de
        // orchestrate, antes de `markSkipMiddlewareDebitHandler` y por lo tanto
        // antes de cualquier decision de debito. Las tres la necesitan: las tres
        // desembocan en `executeApprovedPlan`, que es donde vive el unico debito
        // del step-0 de orchestrate.
        contractingGuardHandler,
        ...requireForwardKey(),
        createBackpressureHandler(),
        createTimeoutHandler(
          parseInt(process.env.TIMEOUT_ORCHESTRATE_MS ?? '120000', 10),
        ),
        // WKH-127/CD-NEW-5 (RIESGO-4): OBLIGATORIO — el service debita el step-0
        // post-plan; sin skip el middleware debitaría el placeholder $1 (double-charge).
        // WKH-305 (CR MNR-3): ANTES del débito — un mapeo malformado es 400 gratis.
        validateStepInputMappingHandler,
        markSkipMiddlewareDebitHandler,
        ...requirePaymentOrA2AKey({
          description:
            'WasiAI Orchestration Service — Goal-based AI agent orchestration (execute)',
        }),
      ],
    },
    async (request, reply: FastifyReply) => {
      // BLQ-MED-1 (AR fix): el orchestrationId interno (clave de idempotencia del
      // fee, de débito y de telemetría) se GENERA server-side, igual que el
      // atómico (L90) y /plan (L197). NUNCA se usa el id que manda el cliente como
      // clave de billing: reusarlo permitiría replay del pipeline real cobrando el
      // protocol fee una sola vez (chargeProtocolFee → already-charged) → revenue
      // leak. Cada llamada a /execute produce un id único → cada ejecución cobra
      // su fee. El id del plan que envía el cliente queda SOLO como correlación.
      const orchestrationId = crypto.randomUUID();
      // Correlación plan→execute para analytics (NO se usa para billing/fee/idempotencia).
      const planId = request.body.orchestrationId;

      try {
        const body = request.body;

        request.log.info(
          { orchestrationId, planId },
          'Orchestration execute started',
        );

        // BLQ-2: bail early if timeout already sent 504
        if (reply.sent) return;

        const steps = body.steps;

        // ─── WKH-303: redención del quote firmado (G1-G6) ───────────────────
        // TODOS los guards corren ANTES de la primera llamada a executeApprovedPlan,
        // que es la única línea que mueve dinero. Ninguna capa anterior debita en esta
        // ruta (markSkipMiddlewareDebitHandler está en el preHandler). De ahí sale la
        // garantía ESTRUCTURAL de "0 débito" en todo camino de rechazo (CD-3/CD-7).
        // Orden de barato a caro: la criptografía es local, la existencia del agente es red.
        const rejectQuote = (
          statusCode: number,
          errorCode: string,
        ): FastifyReply => {
          // CD-10: nunca el token, el payload ni el secreto.
          request.log.warn(
            { orchestrationId, planId, error_code: errorCode },
            '[orchestrate.quote.rejected]',
          );
          return reply
            .status(statusCode)
            .send({ error_code: errorCode, requiresNewQuote: true });
        };

        let frozenPrices: number[] | null = null;
        const rawQuote = body.quote;
        if (rawQuote === undefined) {
          // Omitir el quote es el camino de compatibilidad hacia atrás y está bien:
          // se cobra el precio vivo bajo el techo declarado. Pero un cliente que
          // PODÍA tener garantía de precio y no la reenvió degrada, sin ninguna
          // señal, a "te cobro el precio nuevo que no aprobaste" — que es el bug que
          // esta HU vino a matar. Un SDK que se olvide de reenviar el campo lo
          // produce en silencio. Este log es lo que permite MEDIR cuántas
          // ejecuciones corren sin garantía, un número que hoy no existe.
          // Solo se emite si el caller es bindeable: un caller x402 nunca pudo tener
          // quote, así que para él no hay nada degradado que reportar.
          if (resolveQuoteCaller(request) !== null) {
            request.log.info(
              { orchestrationId, planId, stepCount: body.steps.length },
              '[orchestrate.quote.absent]',
            );
          }
        }
        if (rawQuote !== undefined) {
          const quoteCaller = resolveQuoteCaller(request);
          // G3a: un caller no bindeable (x402/anónimo) no puede redimir NINGÚN quote.
          if (quoteCaller === null) {
            return rejectQuote(403, 'QUOTE_CALLER_MISMATCH');
          }

          // G1/G2/G3b: firma, vigencia y binding. `verifyQuote` nunca tira.
          const verified = verifyQuote(rawQuote, quoteCaller);
          if (!verified.ok) {
            // 🔴 Un quote roto NUNCA degrada al camino de precio vivo: si el caller
            // presentó un quote, o se honra o se rechaza. Caer al precio vivo le
            // cobraría un número que no aprobó, que es exactamente el bug de la HU.
            const status =
              verified.code === 'QUOTE_EXPIRED'
                ? 409
                : verified.code === 'QUOTE_CALLER_MISMATCH'
                  ? 403
                  : 400;
            return rejectQuote(status, verified.code);
          }
          const payload = verified.payload;

          // G4: cantidad de steps.
          if (steps.length !== payload.steps.length) {
            return rejectQuote(400, 'QUOTE_STEP_MISMATCH');
          }

          // G5: identidad congelada por step. Se RECHAZA, no se corrige: sobreescribir
          // el request con la identidad del quote dejaría al cliente ejecutando un
          // agente distinto del que pidió, con un `input` pensado para otro.
          for (let i = 0; i < steps.length; i++) {
            const requested = steps[i];
            const frozen = payload.steps[i];
            if (requested === undefined || frozen === undefined) {
              return rejectQuote(400, 'QUOTE_STEP_MISMATCH');
            }
            if (requested.agent !== frozen.a) {
              return rejectQuote(400, 'QUOTE_STEP_MISMATCH');
            }
            if ((requested.registry ?? null) !== frozen.r) {
              return rejectQuote(400, 'QUOTE_STEP_MISMATCH');
            }
          }

          // G6 (CD-6): el agente congelado tiene que seguir vivo. Mismo resolver del
          // money-path; `null` ⟺ no resuelve en NINGÚN registry habilitado (borrado,
          // desactivado, o registry deshabilitado). El precio vivo que devuelve se usa
          // SOLO para el log de delta: JAMÁS para debitar.
          const prices: number[] = [];
          for (let i = 0; i < payload.steps.length; i++) {
            const frozen = payload.steps[i];
            if (frozen === undefined) {
              return rejectQuote(400, 'QUOTE_STEP_MISMATCH');
            }
            const livePrice = await resolveAgentPriceUsdc(
              frozen.a,
              frozen.r ?? undefined,
              true,
            );
            if (livePrice === null) {
              return rejectQuote(409, 'QUOTE_AGENT_UNAVAILABLE');
            }
            const frozenPrice = Number(frozen.p);
            if (livePrice !== frozenPrice) {
              request.log.warn(
                {
                  orchestrationId,
                  step: i,
                  frozenUsd: frozenPrice,
                  liveUsd: livePrice,
                  deltaUsd: Number((livePrice - frozenPrice).toFixed(8)),
                },
                '[orchestrate.quote.price-delta]',
              );
            }
            prices.push(frozenPrice);
          }
          frozenPrices = prices;

          request.log.info(
            {
              orchestrationId,
              planId,
              stepCount: payload.steps.length,
              ttlRemainingSec: payload.exp - Math.floor(Date.now() / 1000),
            },
            '[orchestrate.quote.redeemed]',
          );
        }

        // Re-derivación del plan server-side (CD-2/CD-NEW-6): los precios del
        // cliente se IGNORAN. costPerStep se re-resuelve con resolveAgentPriceUsdc;
        // plannedCostUsd (base del débito step-0) = precio de steps[0] server-side
        // (NUNCA de costPerStep del cliente). WKH-132: feeUsdc = totalCostUsdc * rate
        // (cost-based); sólo seedea la reserva maxBudget, no el fee cobrado.
        // WKH-303: con un quote válido, el precio NO se re-resuelve — se usa el
        // congelado, que es la garantía que el caller aprobó (CD-12: se lee de un
        // solo lugar, `payload.steps[i]`, tanto para el step-0 como para 1..N).
        const costPerStep: number[] = [];
        if (frozenPrices !== null) {
          costPerStep.push(...frozenPrices);
        } else {
          for (const step of steps) {
            const price = await resolveAgentPriceUsdc(
              step.agent,
              step.registry,
            );
            costPerStep.push(typeof price === 'number' ? price : 0);
          }
        }
        // CD-NEW-6: base del débito step-0 server-side (resolveAgentPriceUsdc),
        // NO costPerStep[0] re-usado del cliente — se vuelve a leer del step real.
        // `steps` tiene minItems:1 por schema → step0 siempre definido (guard sin
        // non-null assertion, convención del codebase).
        const step0 = steps[0];
        const step0FrozenPrice = frozenPrices?.[0];
        const step0Price =
          step0FrozenPrice !== undefined
            ? step0FrozenPrice
            : step0
              ? await resolveAgentPriceUsdc(step0.agent, step0.registry)
              : null;
        const plannedCostUsd = typeof step0Price === 'number' ? step0Price : 0;
        const feeRate = getProtocolFeeRate();
        const totalCostUsdc = costPerStep.reduce((sum, c) => sum + c, 0);
        // WKH-132: base del fee = costo real resuelto server-side, NO budget.
        // Sólo seedea plan.feeUsdc (reserva maxBudget); el fee REALMENTE cobrado
        // se deriva de pipeline.totalCostUsdc dentro de executeApprovedPlan.
        const feeUsdc = Number((totalCostUsdc * feeRate).toFixed(6));

        // WKH-127 (CD-9/CD-11/CD-15): billingKeyRow solo en el path master Agent Key
        // SIN delegación/session (espejo del atómico).
        const billingKeyRow =
          request.delegationContext || request.keySessionContext
            ? undefined
            : request.a2aKeyRow;

        const plan: OrchestratePlanResult = {
          // server-side execution-id (clave de idempotencia/fee/débito).
          orchestrationId,
          planStatus: 'ready',
          steps,
          costPerStep,
          totalCostUsdc,
          protocolFeeUsdc: feeUsdc,
          maxQuotedCostUsdc: body.maxQuotedCostUsdc,
          reasoning: 'execute: plan re-derived server-side',
          consideredAgents: [],
          plannedCostUsd,
          feeUsdc,
          usedFallback: false,
          debitFallback: false,
          billingKeyRow,
          discoveredAgents: [],
        };

        // Array PRESTADO al pipeline para los motivos INTERNOS de skip del leg
        // downstream. Es un INPUT y no un campo del resultado porque abajo se hace
        // `reply.send({ ..., ...result })` sin schema: todo lo que viva en el
        // resultado sale por HTTP, y estos codigos son los que se genericizan
        // justamente para no salir de casa.
        const downstreamSkipCauses: DownstreamSkipCode[] = [];
        const result = await orchestrateService.executeApprovedPlan(
          {
            downstreamSkipCauses,
            goal: '',
            budget: body.budget,
            preferCapabilities: body.preferCapabilities,
            maxAgents: body.maxAgents,
            // HU-DOUBLE-PAY — la credencial CRUDA del caller, derivada con la
            // MISMA extracción que usa el middleware de auth (`extractRawKey`:
            // `x-a2a-key` O `Authorization: Bearer wasi_a2a_*`).
            //
            // POR QUÉ FALTABA Y POR QUÉ IMPORTA: `orchestrate.ts:1216` pasa
            // `a2aKey: request.a2aKey` a `composeService.compose`, pero NINGUNA de
            // las tres rutas HTTP poblaba ese campo — sólo lo poblaba el tool MCP
            // (`mcp/tools/orchestrate.ts`). Como la propiedad es opcional,
            // compilaba, y por HTTP `a2aKey` llegaba SIEMPRE `undefined`. Efecto
            // medible: `compose.invokeAgent` no le reenviaba al agente el
            // `x-a2a-key` del caller (el forward a registries system-trusted de
            // `compose.ts`), y —hasta este fix— el gate `!a2aKey` del segundo leg
            // de salida daba SIEMPRE true, así que el doble pago alcanzaba también
            // a los callers PREPAGOS por este camino.
            //
            // Es el MISMO desajuste que la auditoría C2 (2026-07-01) arregló en
            // `/compose` (`routes/compose.ts`), y que nunca se replicó acá.
            // `/compose` es un endpoint único; orchestrate son TRES, y los tres
            // tienen que derivarla igual o vuelve a divergir.
            a2aKey: extractRawKey(request),
            scopingKeyRow: request.a2aKeyRow,
            delegationContext: request.delegationContext,
            keySessionContext: request.keySessionContext,
            chainId: request.resolvedChainId,
            // WKH-360 (AC-7): la traza de contratacion entrante YA VALIDADA por
            // `contractingGuardHandler` (primer preHandler de esta cadena). Baja al
            // service y de ahi a compose, que es quien la EMITE. Ausente ⇒ cadena
            // vacia / profundidad 0, o sea el 100% del trafico de hoy.
            contractingChain: request.contractingChain,
            contractingDepth: request.contractingDepth,
            // WKH-360 (fix-pack AR/CR BLQ-MED-1): el `Host` por el que entro ESTA
            // peticion. Sin esto, con `BASE_URL` y `A2A_SELF_HOSTS` ausentes el
            // conjunto de identidad queda vacio y el SITIO 2 se saltea entero por su
            // gate `selfHosts.length > 0` => el step-0 de esta ruta queda SIN guard
            // de dinero. Baja tambien a compose (SITIOS 3 y 4).
            selfHostHint: request.hostname,
            // gate AC-3: el cap aprobado por el cliente.
            //
            // WKH-303: con un quote válido el cap gate NO corre. Ese gate re-resuelve
            // todos los precios en vivo y tira 409 QUOTE_STALE si la suma supera el
            // techo — aplicarlo acá le rechazaría la ejecución a un caller que TIENE
            // garantía de precio, por un precio vivo que ya no lo afecta. Además es
            // redundante: la suma congelada es ≤ el techo por construcción, porque el
            // techo se derivó de esos mismos precios en `/plan`.
            // Spread condicional (CD-20): con `exactOptionalPropertyTypes` activo, pasar
            // `maxQuotedCostUsdc: undefined` NO es lo mismo que no pasar la propiedad.
            ...(frozenPrices === null && {
              maxQuotedCostUsdc: body.maxQuotedCostUsdc,
            }),
            // WKH-303: precios congelados para los steps 1..N (el step-0 va por
            // plannedCostUsd). Ausente sin quote ⇒ compose usa el precio vivo, como hoy.
            ...(frozenPrices !== null && { frozenStepPricesUsd: frozenPrices }),
          },
          plan,
          orchestrationId,
        );

        if (reply.sent) return;

        // AC-3/AC-5: precio drifteó por encima del cap → 409 QUOTE_STALE, cero debit.
        if ('__quoteStale' in result) {
          return reply.status(409).send({
            error_code: 'QUOTE_STALE',
            currentCostUsdc: result.currentCostUsdc,
            maxQuotedCostUsdc: result.maxQuotedCostUsdc,
          });
        }

        const kiteTxHash = request.paymentTxHash;
        // Mismo mapeo de status/headers que `/` (CD-6).
        // WKH-360: mismo mapeo que `/` — el corte del SITIO 2 sale 400.
        const status =
          result.pipeline.errorCode === 'SCOPE_DENIED'
            ? 403
            : result.pipeline.errorCode === CONTRACTING_LOOP_DETECTED
              ? 400
              : 200;
        if (result.debitFallback) {
          reply.header('x-debit-fallback', 'registry-miss');
        }
        if (result.remainingBudgetUsd !== undefined) {
          reply.header('x-a2a-remaining-budget', result.remainingBudgetUsd);
        }
        // WKH-191x: ver el comentario del handler atómico (aditivo, telemetría).
        noteDownstreamSkips(
          request,
          result.pipeline.steps,
          downstreamSkipCauses,
        );
        // WKH-360 (CD-19): el `error_code` top-level de familia 1, para que un
        // cliente matchee UN solo string sin tener que mirar dentro de `pipeline`.
        // El VALOR sale de la misma constante del leaf que usa el camel de adentro.
        return reply.status(status).send({
          kiteTxHash,
          ...result,
          ...(result.pipeline.errorCode === CONTRACTING_LOOP_DETECTED && {
            error_code: CONTRACTING_LOOP_DETECTED,
            layer: 'direct',
          }),
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Orchestration execute failed';
        request.log.error(
          { orchestrationId, planId, err: message },
          'Orchestration execute failed',
        );
        const wrappedErr = err instanceof Error ? err : new Error(message);
        (wrappedErr as Error & { orchestrationId?: string }).orchestrationId =
          orchestrationId;
        throw wrappedErr;
      }
    },
  );
};

export default orchestrateRoutes;
