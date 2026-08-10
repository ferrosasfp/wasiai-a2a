/**
 * Tasks Routes — A2A Protocol task management
 * WKH-23 (baseline)
 * WKH-54 (ownership isolation): every endpoint now requires an A2A key or
 *        x402 payment and filters by `request.a2aKeyRow.owner_ref`.
 *
 * HU-193 (no-charge-before-validating): los endpoints que COBRAN lo hacen por $1
 * (`PLACEHOLDER_FEE_USD`) en el middleware de pago, ANTES del handler. Todo lo
 * que este plugin rechaza por FORMA (UUID inválido, body no-objeto, status fuera
 * del enum, append sin nada que appendear) se decide en la cadena pre-cobro
 * (`middleware/charged-route.ts`), así que ya no se cobra por ellos.
 * (HU-197: los dos GET ya no cobran nada, así que salieron de esa cadena.)
 *
 * HU-193 fix-pack (BLQ-BAJO-1): los handlers pueden terminar en un 500 si el
 * service lanza, y los cinco cobraban sin devolver nada. De los TRES que hoy
 * cobran, los dos `PATCH` reembolsan y el ÚNICO que se queda con el débito es
 * `POST /` — porque un insert que pudo commitear deja un recurso entregado. Está
 * declarado con su status en `doc/INTEGRATION.md` §5.1: el contrato público NO
 * promete costo neto cero. (HU-197: los dos GET ya no reembolsan porque ya no
 * cobran; un 500 de lectura cuesta $0 desde el principio.)
 *
 * ══ HU-197 — CONSULTAR EL ESTADO DE UNA TAREA ES GRATIS ════════════════════
 *
 * DECISIÓN: se cobra por CREAR y por MUTAR una task, no por PREGUNTAR por ella.
 * Los dos GET (y sus HEAD hermanos) pasan de $1 por llamada a $0.
 *
 * POR QUÉ: el ciclo de vida A2A que nosotros mismos publicamos pide hacer
 * polling del estado (`submitted` → `working` → `completed`). A $1 por lectura,
 * un poll cada 5 segundos costaba 720 USD/hora: el precio peleaba contra las
 * instrucciones de integración. Y cobrar la lectura es cobrar dos veces el mismo
 * trabajo — el valor está en ejecutarlo, no en informar sobre él.
 *
 * CÓMO (y por qué NO se implementó como "precio 0"): las dos lecturas dejan de
 * pasar por el middleware de pago y usan `requireA2AKey` (auth-only, WKH-173):
 * autentica master/delegación/sesión y setea `a2aKeyRow` SIN resolver chain, SIN
 * debitar y SIN montar el riel x402. Consecuencias buscadas:
 *
 *   1. no hay débito prepago ni settle on-chain que reembolsar;
 *   2. NO SE EMITE NINGÚN CHALLENGE x402. Poner `amountUsd: 0` habría dejado un
 *      402 con `maxAmountRequired: 0` — una ceremonia vacía que confunde al
 *      integrador y lo puede hacer firmar una autorización por nada. Una lectura
 *      gratis no pide pago: sin middleware de pago, el challenge es imposible por
 *      construcción, no por configuración;
 *   3. GRATIS ≠ PÚBLICO: siguen exigiendo credencial (403 A2A_KEY_REQUIRED sin
 *      ella) y siguen filtrando por `owner_ref` — son recursos con dueño;
 *   4. los `refundStep0Debit` de los dos GET se ELIMINARON. Sin débito no hay
 *      nada que devolver, y un credit sin débito INFLA el budget. Hoy la
 *      invariante #1 de `refundStep0Debit` (`resolvedChainId === undefined` ⟹
 *      return, y auth-only no lo setea) ya lo haría no-op, pero dejar código de
 *      dinero inalcanzable es exactamente lo que en este repo ya salió mal.
 *
 * EFECTOS COLATERALES DECLARADOS de las dos lecturas (ambos correctos si no se
 * cobra): (a) ya no devuelven el header `x-a2a-remaining-budget` ni
 * `x-a2a-payment-chain` (no hay chain de cobro que resolver); (b) ya no pueden
 * fallar con 403 DAILY_LIMIT / INSUFFICIENT_BUDGET — una key sin saldo puede
 * seguir consultando el estado de sus tareas, que es justo el punto; (c) con una
 * credencial INVÁLIDA y a la vez un pedido malformado, la respuesta pasa de 400 a
 * 403 KEY_NOT_FOUND: antes el check de forma corría antes del lookup porque el
 * lookup cobraba; sin cobro, el orden natural es autenticar primero.
 *
 * LO QUE NO CAMBIA: `POST /` (crear) y los dos `PATCH` (mutar) siguen cobrando
 * $1 con la MISMA cadena `chargedRoute` (validación de forma pre-cobro + refund
 * del residuo). Mutar escribe estado: eso es trabajo, y se paga.
 *
 * ⚠️ CAMBIO DE CONTRATO (declarado): el riel x402 anónimo NO PUEDE operar acá.
 * Todos los endpoints derivan el tenant de `request.a2aKeyRow.owner_ref` y el
 * middleware x402 nunca setea `a2aKeyRow` (no aporta identidad de tenant; ver
 * WKH-63). Antes, un caller x402 pagaba on-chain y recibía **500** — porque
 * `getOwnerRef` lanzaba — sin recurso y sin reembolso posible. Ahora el pedido
 * se rechaza con **403 A2A_KEY_REQUIRED antes de cobrar**. El status cambia
 * (402/500 → 403) y el caller deja de perder plata por un rechazo garantizado.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { refundStep0Debit } from '../lib/step0-refund.js';
import { isValidUUID } from '../lib/uuid.js';
import { requireA2AKey } from '../middleware/a2a-key.js';
import {
  chargedRoute,
  type PreChargeCheck,
  requireA2AKeyPresence,
} from '../middleware/charged-route.js';
import {
  TaskNotFoundError,
  TerminalStateError,
  taskService,
} from '../services/task.js';
import type { Task, TaskState } from '../types/index.js';
import { TASK_STATES } from '../types/index.js';

/**
 * Extract the authenticated caller's owner_ref from the request.
 * Middleware `requirePaymentOrA2AKey` guarantees `request.a2aKeyRow` is
 * set for all authenticated paths. A missing value is treated as an auth
 * bug (defense-in-depth 500).
 *
 * HU-193: el caller x402 (que NO tiene `a2aKeyRow`) ya no llega hasta acá — lo
 * corta `requireA2AKeyPresence` en la cadena pre-cobro, con 403 y sin cobrar.
 * Este throw queda como defensa de un bug de auth, no como camino alcanzable.
 */
function getOwnerRef(request: FastifyRequest): string {
  const ownerRef = request.a2aKeyRow?.owner_ref;
  if (!ownerRef) {
    throw new Error('auth middleware did not populate a2aKeyRow.owner_ref');
  }
  return ownerRef;
}

// ── HU-193: validaciones de FORMA (puras y síncronas) ───────────────────────
// Cada una es la MISMA función que usa el handler como defense-in-depth. El
// guard REAL es el check pre-cobro; el del handler protege contra un
// reordenamiento futuro de la cadena de preHandlers (patrón `validateComposeBody`,
// HU-188).

const A2A_KEY_REQUIRED_MESSAGE =
  'Task management requires an authenticated a2a-key. The x402 anonymous path has no tenant identity, so it cannot own or read tasks.';

type RejectionBody = { error: string };

/** Params `:id` con formato UUID. */
function validateTaskId(params: unknown): RejectionBody | null {
  const id = (params as { id?: unknown } | undefined)?.id;
  if (typeof id !== 'string' || !isValidUUID(id)) {
    return { error: 'Invalid UUID format' };
  }
  return null;
}

/** Body presente y objeto (el 400 histórico `Invalid request body`). */
function validateObjectBody(body: unknown): RejectionBody | null {
  if (body === null || typeof body !== 'object') {
    return { error: 'Invalid request body' };
  }
  return null;
}

/** `status` dentro del enum A2A (query string del list, body del PATCH). */
function validateStatusValue(status: unknown): RejectionBody | null {
  if (!status || !TASK_STATES.includes(status as TaskState)) {
    return { error: `Invalid status: ${status}` };
  }
  return null;
}

/** El append necesita al menos `messages` o `artifacts`. */
function validateAppendBody(body: unknown): RejectionBody | null {
  const invalid = validateObjectBody(body);
  if (invalid) return invalid;
  const b = body as { messages?: unknown; artifacts?: unknown };
  if (!b.messages && !b.artifacts) {
    return { error: 'Must provide messages or artifacts to append' };
  }
  return null;
}

const reject = (body: RejectionBody | null) =>
  body ? { status: 400, body } : null;

const taskIdCheck: PreChargeCheck = (input) =>
  reject(validateTaskId(input.params));
const objectBodyCheck: PreChargeCheck = (input) =>
  reject(validateObjectBody(input.body));
const appendBodyCheck: PreChargeCheck = (input) =>
  reject(validateAppendBody(input.body));
/** El `status` del PATCH vive en el body; el del list, en la query. */
const statusBodyCheck: PreChargeCheck = (input) => {
  const invalid = validateObjectBody(input.body);
  if (invalid) return { status: 400, body: invalid };
  return reject(
    validateStatusValue((input.body as { status?: unknown }).status),
  );
};
const tasksRoutes: FastifyPluginAsync = async (fastify) => {
  // WKH-54: all /tasks/* require authentication + ownership isolation.
  // HU-193: la cadena la arma `chargedRoute`, que EXIGE declarar la validación
  // de forma y la pone siempre antes del cobro. `requireA2AKeyPresence` va
  // primero (el riel x402 no puede tener tasks).
  // HU-197: sólo para los que COBRAN — `POST /` y los dos `PATCH`.
  const paymentOpts = {
    // El texto viaja en el challenge x402. Decir "or x402 payment" era falso
    // (el riel anónimo no puede operar acá, HU-193) y las lecturas ya no cobran.
    description:
      'WasiAI A2A Tasks — creating or updating a task requires an a2a-key; reads are free',
  };
  const chargedPreHandlersFor = (checks: PreChargeCheck[]) =>
    chargedRoute({
      validate: [requireA2AKeyPresence(A2A_KEY_REQUIRED_MESSAGE), ...checks],
      payment: paymentOpts,
    });

  /**
   * HU-197: cadena de una LECTURA GRATIS. Auth-only: autentica la credencial
   * (master/delegación/sesión) y setea `a2aKeyRow` para el filtro por
   * `owner_ref`, sin resolver chain, sin debitar y sin riel x402 → ningún
   * challenge posible. Las validaciones de forma de las lecturas viven en el
   * handler (ver cada GET): ya no hay cobro del que adelantarse.
   */
  const freeReadPreHandlers = () => requireA2AKey(A2A_KEY_REQUIRED_MESSAGE);

  /**
   * POST /tasks — Create a new task (AC-2)
   */
  fastify.post<{
    Body: {
      contextId?: string;
      messages?: unknown[];
      artifacts?: unknown[];
      metadata?: Record<string, unknown>;
    };
  }>(
    '/',
    { preHandler: chargedPreHandlersFor([objectBodyCheck]) },
    async (request, reply: FastifyReply) => {
      const body = request.body;
      // HU-193: defense-in-depth (guard real: `objectBodyCheck` pre-cobro).
      const invalid = validateObjectBody(body);
      if (invalid) {
        return reply.status(400).send(invalid);
      }

      // HU-193 fix-pack (BLQ-BAJO-1): este es el ÚNICO camino de este plugin que
      // se queda con el débito. NO se reembolsa a propósito: si el INSERT
      // commiteó y el fallo fue al responder, la task EXISTE y el caller la
      // puede listar y usar — reembolsar regalaría un recurso entregado
      // (lección de HU-192). Sin una señal fiable de "no se escribió nada"
      // (idempotency key) la dirección segura es no devolver. Está declarado en
      // `doc/INTEGRATION.md` §5.1 y en el work-item, con su status (500).
      const task = await taskService.create(getOwnerRef(request), {
        contextId: body.contextId,
        messages: body.messages,
        artifacts: body.artifacts,
        metadata: body.metadata,
      });

      return reply.status(201).send(task);
    },
  );

  /**
   * GET /tasks — List tasks with filters (AC-4)
   * Scoped to the caller's owner_ref.
   *
   * HU-197: LECTURA GRATIS (antes $1). Sin débito, sin settle, sin challenge.
   */
  fastify.get<{
    Querystring: {
      status?: string;
      context_id?: string;
      limit?: string;
    };
  }>(
    '/',
    { preHandler: freeReadPreHandlers() },
    async (request, reply: FastifyReply) => {
      const { status, context_id, limit } = request.query;

      // HU-197: guard ÚNICO del `status` del list (antes era también un check
      // pre-cobro; sin cobro, el handler es el lugar). Se conserva EXACTO el
      // guard histórico (`if (status && ...)`): un `?status=` vacío es falsy y
      // nunca fue un 400, así que sigue sin serlo (contrato sin cambios).
      if (status) {
        const invalid = validateStatusValue(status);
        if (invalid) return reply.status(400).send(invalid);
      }

      const parsedLimit = limit ? parseInt(limit, 10) : undefined;
      const safeLimit =
        parsedLimit !== undefined && Number.isFinite(parsedLimit)
          ? parsedLimit
          : undefined;

      // HU-197: acá vivía un `refundStep0Debit('tasks.list:read-failed')`. Se
      // ELIMINÓ junto con el cobro: sin débito no hay nada que devolver, y un
      // credit sin débito infla el budget. El 500 lo sigue produciendo el error
      // boundary con el mismo status; lo que cambia es que ya costaba $0 antes de
      // fallar.
      const tasks: Task[] = await taskService.list(getOwnerRef(request), {
        status: status as TaskState | undefined,
        contextId: context_id,
        limit: safeLimit,
      });

      return reply.send({ tasks, total: tasks.length });
    },
  );

  /**
   * GET /tasks/:id — Get a task by ID (AC-3)
   * Returns 404 for both "not found" and "not yours" (existence not leaked).
   *
   * HU-197: LECTURA GRATIS (antes $1). Es el endpoint del polling del ciclo de
   * vida A2A — el que hacía que seguir nuestras propias instrucciones costara
   * 720 USD/hora.
   */
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: freeReadPreHandlers() },
    async (request, reply: FastifyReply) => {
      // HU-197: guard ÚNICO del formato del `:id` (antes era también un check
      // pre-cobro). Mismo 400 `Invalid UUID format` que antes.
      const invalidId = validateTaskId(request.params);
      if (invalidId) {
        return reply.status(400).send(invalidId);
      }
      // HU-197: se eliminaron los dos `refundStep0Debit` de este handler
      // (`read-failed` y `not-found`). Sin cobro no hay residuo: el 404 de
      // "no existe / no es tuya" y el 500 de un read fallido ya cuestan $0.
      const task: Task | undefined = await taskService.get(
        getOwnerRef(request),
        request.params.id,
      );
      if (!task) {
        // "No existe" y "no es tuya" siguen siendo indistinguibles a propósito
        // (no se filtra existencia cross-tenant).
        return reply.status(404).send({ error: 'Task not found' });
      }
      return reply.send(task);
    },
  );

  /**
   * PATCH /tasks/:id/status — Update task status (AC-5)
   * ⚠️ DEBE registrarse ANTES que PATCH /:id (CD-12)
   *
   * HU-197: SIGUE COBRANDO $1. Es una MUTACIÓN: escribe una transición de estado
   * (y la valida contra los estados terminales). Lo que se dejó de cobrar es
   * preguntar, no cambiar.
   */
  fastify.patch<{
    Params: { id: string };
    Body: { status: string };
  }>(
    '/:id/status',
    { preHandler: chargedPreHandlersFor([taskIdCheck, statusBodyCheck]) },
    async (request, reply: FastifyReply) => {
      // HU-193: defense-in-depth (guards reales: `taskIdCheck` +
      // `statusBodyCheck`, pre-cobro).
      const invalidId = validateTaskId(request.params);
      if (invalidId) {
        return reply.status(400).send(invalidId);
      }
      const invalidBody = validateObjectBody(request.body);
      if (invalidBody) {
        return reply.status(400).send(invalidBody);
      }
      const { status } = request.body;
      const invalidStatus = validateStatusValue(status);
      if (invalidStatus) {
        return reply.status(400).send(invalidStatus);
      }

      try {
        const task = await taskService.updateStatus(
          getOwnerRef(request),
          request.params.id,
          status as TaskState,
        );
        return reply.send(task);
      } catch (err) {
        if (err instanceof TaskNotFoundError) {
          // HU-193 (residuo): read + ownership → no adelantable. Nada se
          // actualizó.
          await refundStep0Debit(request, 'tasks.patch-status:not-found');
          return reply.status(404).send({ error: 'Task not found' });
        }
        if (err instanceof TerminalStateError) {
          // F-05 (audit 2026-06-29): static client message — the 409 already
          // conveys the terminal-state condition; no raw err.message.
          // HU-193 (residuo): el estado terminal se lee de la fila → no
          // adelantable. La transición fue rechazada, nada cambió.
          await refundStep0Debit(request, 'tasks.patch-status:terminal-state');
          return reply.status(409).send({
            error: 'Task is in a terminal state and cannot be updated',
          });
        }
        // HU-193 fix-pack (BLQ-BAJO-1): cualquier otro fallo (el 500). Se
        // reembolsa. El caso dominante es que NADA se escribió: `updateStatus`
        // primero LEE la fila (un fallo del read no toca nada) y el UPDATE que
        // reporta error tampoco aplicó. Riesgo residual declarado: si el UPDATE
        // hubiera commiteado y sólo se perdiera la respuesta, el reembolso regala
        // una transición ya aplicada — sobre la propia task del caller, por $1, y
        // en una ventana muy angosta. Se acepta ese riesgo y NO el del `create`
        // (que entrega un recurso nuevo, listable y usable). Queda declarado en
        // `doc/INTEGRATION.md` §5.1.
        await refundStep0Debit(request, 'tasks.patch-status:failed');
        throw err;
      }
    },
  );

  /**
   * PATCH /tasks/:id — Append messages/artifacts (AC-6)
   *
   * HU-197: SIGUE COBRANDO $1. Es una MUTACIÓN: appendea messages/artifacts a la
   * task (escritura), no una consulta de estado.
   */
  fastify.patch<{
    Params: { id: string };
    Body: { messages?: unknown[]; artifacts?: unknown[] };
  }>(
    '/:id',
    { preHandler: chargedPreHandlersFor([taskIdCheck, appendBodyCheck]) },
    async (request, reply: FastifyReply) => {
      // HU-193: defense-in-depth (guards reales: `taskIdCheck` +
      // `appendBodyCheck`, pre-cobro).
      const invalidId = validateTaskId(request.params);
      if (invalidId) {
        return reply.status(400).send(invalidId);
      }
      const invalidBody = validateAppendBody(request.body);
      if (invalidBody) {
        return reply.status(400).send(invalidBody);
      }
      const { messages, artifacts } = request.body;

      try {
        const task = await taskService.append(
          getOwnerRef(request),
          request.params.id,
          { messages, artifacts },
        );
        return reply.send(task);
      } catch (err) {
        if (err instanceof TaskNotFoundError) {
          // HU-193 (residuo): read + ownership → no adelantable.
          await refundStep0Debit(request, 'tasks.patch-append:not-found');
          return reply.status(404).send({ error: 'Task not found' });
        }
        if (err instanceof TerminalStateError) {
          // F-05 (audit 2026-06-29): static client message — the 409 already
          // conveys the terminal-state condition; no raw err.message.
          // HU-193 (residuo): estado terminal leído de la fila; nada se appendeó.
          await refundStep0Debit(request, 'tasks.patch-append:terminal-state');
          return reply.status(409).send({
            error: 'Task is in a terminal state and cannot be updated',
          });
        }
        // HU-193 fix-pack (BLQ-BAJO-1): idem `PATCH /:id/status` — mismo
        // razonamiento y mismo riesgo residual declarado.
        await refundStep0Debit(request, 'tasks.patch-append:failed');
        throw err;
      }
    },
  );
};

export default tasksRoutes;
