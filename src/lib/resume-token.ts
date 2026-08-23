/**
 * Token de reanudación de un pipeline suspendido (WKH-225) — firmado, atado a
 * una credencial, con vencimiento propio.
 *
 * POR QUÉ EXISTE: un step de `/compose` puede quedar ESPERANDO a una persona
 * (típicamente: el agente devuelve una URL a la que alguien va a entrar). El
 * pipeline no termina dentro del request HTTP; el estado queda durable en
 * `a2a_suspended_runs` y el caller vuelve después con este token a
 * `POST /compose/resume`. El token es la única prueba de que quien vuelve es
 * quien dejó el pipeline a medias.
 *
 * Módulo LEAF a propósito: sólo `node:crypto`. Sin base de datos, sin caché
 * externa, sin Fastify, sin tipos traídos de `types/index.ts`. El motivo no es
 * estético — es el mismo que ya está escrito en `orchestrate-quote.ts` y en
 * `compose-limits.ts`: media docena de suites del money-path mockean los
 * módulos gordos COMPLETOS con factories sin `importOriginal`, así que un
 * export traído de uno de ellos llega `undefined` bajo test. Un archivo sin
 * dependencias no lo moquea nadie, y el testigo `T-TOK-LEAF` lee ESTE fuente y
 * se cae si aparece cualquier otro `from`.
 *
 * ⛔ SIN ANTI-REPLAY EN MEMORIA DEL PROCESO. Sería estado no durable,
 * inconsistente entre instancias e invisible en el contrato. El single-use vive
 * donde puede ser atómico: el RPC `claim_suspended_run`, bajo `FOR UPDATE`.
 *
 * 🔴 LO QUE NO SE COPIA DEL EXEMPLAR, Y ES LA DIFERENCIA QUE IMPORTA.
 * `orchestrate-quote.ts` acepta A PROPÓSITO que un quote se redima más de una
 * vez, "porque cada redención ejecuta el pipeline de verdad y debita su propio
 * importe". Ese razonamiento NO se transfiere: un resume redimido dos veces
 * ejecutaría DOS VECES la cola de un pipeline que el caller pagó UNA. Acá el
 * single-use no es una comodidad, es la corrección.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Prefijo del token; permite rotar el formato sin ambigüedad. */
export const RESUME_VERSION = 'v1';

/**
 * 🔴 SEPARACIÓN DE DOMINIO. La firma se calcula sobre
 * `` `resume|<version>.<payload>` ``, con este prefijo, mientras que el quote
 * firma `` `<version>.<payload>` `` pelado. Sumado a que cada uno usa SU PROPIO
 * secreto, un quote no puede verificar como resume ni al revés ni aunque
 * alguien configure el mismo valor en las dos variables de entorno. El testigo
 * es `T-TOK-4`, y prueba las dos direcciones.
 */
export const RESUME_SIGNING_DOMAIN = 'resume|';

/**
 * Nombre del secreto, en un solo lugar.
 *
 * 🔴 SIN fallback a ningún otro secreto del sistema. Reusar el del quote —o el
 * de recibos— acoplaría dos subsistemas: rotar uno invalidaría el otro en
 * silencio, y una filtración de cualquiera de los dos permitiría forjar los dos
 * tipos de token. Ausente o vacío ⇒ fail-closed.
 */
export const RESUME_ENV_VAR = 'COMPOSE_RESUME_HMAC_KEY';

/** Nombre de la variable que fija el techo del TTL, en un solo lugar. */
export const SUSPEND_MAX_TTL_ENV_VAR = 'SUSPEND_MAX_TTL_SECONDS';

/** Techo de tamaño del token, chequeado ANTES de decodificar nada. */
export const RESUME_MAX_TOKEN_CHARS = 8192;

/** Tolerancia de `iat` en el futuro, por deriva de reloj entre instancias. */
export const RESUME_CLOCK_SKEW_SECONDS = 60;

/**
 * Piso duro del TTL de una suspensión, en segundos. MEDIDO, no elegido: el
 * `/compose` que suspende tiene su propio techo de wall-clock
 * (`TIMEOUT_COMPOSE_MS`, default 180000 ms) y por debajo de ese 504 la
 * suspensión no compra nada — el caller recibiría el timeout antes de poder
 * volver. Un segundo más que el timeout es el mínimo que tiene sentido.
 */
export const SUSPEND_MIN_TTL_SECONDS = 181;

/**
 * Techo por defecto del TTL, en segundos (24 h).
 *
 * MEDIDO también: es el MISMO número que este repo ya eligió, dos veces y de
 * forma independiente, para las otras dos credenciales con las que "una persona
 * vuelve" — `LINK_MAX_TTL_SECONDS` de los invocation links y
 * `SESSION_MAX_TTL_SECONDS` de las sesiones de key. Elegir un tercer número
 * distinto para la misma clase de espera sería inventar.
 */
export const SUSPEND_DEFAULT_MAX_TTL_SECONDS = 86400;

const HMAC_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * La credencial EXACTA a la que queda atado el token.
 *
 * ⚠️ SE DECLARA ACÁ Y NO SE IMPORTA DE `types/index.ts`, aunque el tipo
 * `ResumeCaller` de allá tenga esta misma forma. No es duplicación por
 * descuido: importarlo rompería la propiedad LEAF que `T-TOK-LEAF` verifica
 * leyendo este fuente. TypeScript es estructural, así que el tipo de allá entra
 * acá sin conversión y las dos formas no pueden divergir en silencio: el día
 * que una gane un campo obligatorio, el call-site deja de compilar.
 */
export interface ResumeTokenCaller {
  kind: 'delegation' | 'session' | 'key';
  id: string;
}

/** Payload firmado. Claves cortas: el token viaja por la red. */
export interface ResumePayload {
  /** HMAC de la credencial: el id crudo NUNCA entra al payload (el base64url es legible). */
  bind: string;
  /** epoch segundos — vencimiento del TOKEN (fast-fail; la autoridad es la fila). */
  exp: number;
  /** epoch segundos — emisión */
  iat: number;
  /** `id` de la fila de `a2a_suspended_runs`. Correlación y log; nunca credencial. */
  rid: string;
  v: 1;
}

/**
 * ⚠️ DOS CÓDIGOS, NO TRES — divergencia deliberada del exemplar.
 *
 * `verifyQuote` distingue `QUOTE_CALLER_MISMATCH` de `QUOTE_INVALID`, y acá NO:
 * un binding a otra credencial devuelve `RESUME_INVALID`, el mismo código que
 * una firma rota. Un código propio le diría al atacante "este token es
 * auténtico, sólo que no es tuyo", que es exactamente la información que el 404
 * disclosure-safe del claim se ocupa de no dar. Las dos superficies tienen que
 * mentir igual o la más habladora anula a la otra.
 */
export type ResumeVerifyFailureCode = 'RESUME_INVALID' | 'RESUME_EXPIRED';

export type ResumeVerifyResult =
  | { ok: true; payload: ResumePayload }
  | { ok: false; code: ResumeVerifyFailureCode };

export interface SignedResumeToken {
  token: string;
  expiresAtIso: string;
}

/**
 * Contexto del caller, tipado ESTRUCTURALMENTE para no importar Fastify acá.
 * Espeja las props que el request ya lleva tras el middleware de auth.
 */
export interface ResumeCallerContext {
  delegationContext?: { delegationId: string } | undefined;
  keySessionContext?: { sessionId: string } | undefined;
  a2aKeyRow?: { id: string } | undefined;
}

/**
 * Secreto dedicado del resume. Ausente o vacío ⇒ `null`, y el llamador decide
 * (fail-closed). NUNCA lanza.
 */
export function resumeHmacKey(): string | null {
  const secret = process.env[RESUME_ENV_VAR];
  if (typeof secret !== 'string' || secret.length === 0) return null;
  return secret;
}

/**
 * Techo del TTL. Lee env con fail-safe: NaN o `<= 0` ⇒ el default de 24 h
 * (espejo exacto de `maxTtlSeconds` en `agent-link.ts` y `key-session.ts`).
 *
 * Un techo por debajo del piso duro se ignora: dejar configurar un máximo menor
 * que el mínimo produciría un rango vacío, o sea que NINGUNA suspensión sería
 * posible y el motivo viviría en una variable de entorno.
 */
export function suspendMaxTtlSeconds(): number {
  const raw = Number(
    process.env[SUSPEND_MAX_TTL_ENV_VAR] ?? SUSPEND_DEFAULT_MAX_TTL_SECONDS,
  );
  if (!Number.isFinite(raw) || raw <= 0) return SUSPEND_DEFAULT_MAX_TTL_SECONDS;
  if (raw < SUSPEND_MIN_TTL_SECONDS) return SUSPEND_DEFAULT_MAX_TTL_SECONDS;
  return Math.floor(raw);
}

/**
 * TTL efectivo de una suspensión, en segundos, o `null` si lo pedido no es
 * aceptable.
 *
 * DEFAULT = MÁXIMO, igual que `agent-link.ts` (`let ttl = maxTtlSeconds();`).
 * No pedir TTL es lo normal —el caller no sabe cuánto va a tardar la persona— y
 * un default corto convertiría el caso normal en el caso que vence.
 *
 * `null` (y no un clamp silencioso) cuando el valor pedido está fuera de rango:
 * recortar a escondidas le devolvería al caller un `expiresAt` que no pidió y
 * que probablemente no mire. El CHECK de la columna dice lo mismo en la base.
 */
export function resolveSuspendTtlSeconds(
  requested: number | undefined,
): number | null {
  const max = suspendMaxTtlSeconds();
  if (requested === undefined) return max;
  if (typeof requested !== 'number' || !Number.isInteger(requested))
    return null;
  if (requested < SUSPEND_MIN_TTL_SECONDS || requested > max) return null;
  return requested;
}

/**
 * ÚNICA fuente de verdad del binding: la usan emisión Y redención.
 *
 * La precedencia espeja cómo se enruta el débito en el middleware de auth
 * (delegación → sesión → key). Si acá se invirtiera, un pipeline suspendido
 * bajo delegación quedaría atado a la key padre y podría reanudarlo cualquier
 * otra sesión de esa key.
 *
 * `null` = caller no bindeable (x402 / anónimo): no se emite token y no se
 * puede redimir uno.
 */
export function resolveResumeCaller(
  ctx: ResumeCallerContext,
): ResumeTokenCaller | null {
  const delegationId = ctx.delegationContext?.delegationId;
  if (typeof delegationId === 'string' && delegationId.length > 0) {
    return { kind: 'delegation', id: delegationId };
  }
  const sessionId = ctx.keySessionContext?.sessionId;
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    return { kind: 'session', id: sessionId };
  }
  const keyId = ctx.a2aKeyRow?.id;
  if (typeof keyId === 'string' && keyId.length > 0) {
    return { kind: 'key', id: keyId };
  }
  return null;
}

/**
 * HMAC de la credencial. El `kind` entra al material firmado para que una
 * delegación y una sesión que compartan UUID no colisionen.
 *
 * El binding es a la CREDENCIAL EXACTA, no al owner: el mismo dueño con otra de
 * sus keys no puede reanudar el pipeline. El `owner_ref` es otro guard, en otra
 * capa, y sirve para otra cosa.
 */
export function computeResumeBinding(caller: ResumeTokenCaller): string | null {
  const secret = resumeHmacKey();
  if (secret === null) return null;
  return createHmac('sha256', secret)
    .update(`resume-bind:v1:${caller.kind}:${caller.id}`, 'utf8')
    .digest('hex');
}

/**
 * SHA-256 hex del token. Es lo ÚNICO que se persiste (la columna es
 * `token_hash`, `UNIQUE`): una filtración de la base no entrega tokens
 * reanudables.
 *
 * Vive en este módulo y no en el service porque `node:crypto` ya está acá y
 * porque emisión y búsqueda tienen que derivar el hash con la MISMA función:
 * dos implementaciones del "mismo" hash es cómo se rompe una búsqueda por
 * igualdad sin que ningún test lo note.
 */
export function resumeTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Payload canónico: claves en orden alfabético EXPLÍCITO. */
function buildCanonicalResumePayload(payload: ResumePayload): string {
  return JSON.stringify({
    bind: payload.bind,
    exp: payload.exp,
    iat: payload.iat,
    rid: payload.rid,
    v: payload.v,
  });
}

/** Firma sobre el string CRUDO con dominio, nunca sobre el objeto parseado. */
function computeResumeSignature(signingInput: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${RESUME_SIGNING_DOMAIN}${signingInput}`, 'utf8')
    .digest('hex');
}

/** Comparación constante-temporal. Formato ANTES de `Buffer.from`, longitud ANTES de comparar. */
function hexEqual(a: string, b: string): boolean {
  if (!HMAC_HEX_RE.test(a) || !HMAC_HEX_RE.test(b)) return false;
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, 'hex');
    bufB = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Emite el token de reanudación. Devuelve `null` (nunca lanza) si:
 *  · no hay secreto configurado,
 *  · no hay caller bindeable,
 *  · el `runId` viene vacío,
 *  · el TTL pedido no es aceptable.
 *
 * Que devuelva `null` en vez de lanzar es lo que le permite al llamador tratar
 * "no se pudo emitir" como "este pipeline NO suspende" sin un `try` alrededor
 * de una decisión de dinero.
 */
export function signResumeToken(input: {
  runId: string;
  caller: ResumeTokenCaller;
  ttlSeconds: number;
  nowMs?: number;
}): SignedResumeToken | null {
  const secret = resumeHmacKey();
  if (secret === null) return null;

  const bind = computeResumeBinding(input.caller);
  if (bind === null) return null;

  if (typeof input.runId !== 'string' || input.runId.length === 0) return null;

  const ttl = resolveSuspendTtlSeconds(input.ttlSeconds);
  if (ttl === null) return null;

  const nowMs = typeof input.nowMs === 'number' ? input.nowMs : Date.now();
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + ttl;

  const payload: ResumePayload = { bind, exp, iat, rid: input.runId, v: 1 };

  const encoded = Buffer.from(
    buildCanonicalResumePayload(payload),
    'utf8',
  ).toString('base64url');
  const signingInput = `${RESUME_VERSION}.${encoded}`;
  const signature = computeResumeSignature(signingInput, secret);

  return {
    token: `${signingInput}.${signature}`,
    expiresAtIso: new Date(exp * 1000).toISOString(),
  };
}

/** Valida la FORMA del payload decodificado. Devuelve `null` si algo no cierra. */
function parseResumePayload(raw: unknown): ResumePayload | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const candidate = raw as Record<string, unknown>;

  if (candidate.v !== 1) return null;
  if (typeof candidate.bind !== 'string' || !HMAC_HEX_RE.test(candidate.bind)) {
    return null;
  }
  if (typeof candidate.rid !== 'string' || candidate.rid.length === 0) {
    return null;
  }
  if (!Number.isInteger(candidate.iat) || !Number.isInteger(candidate.exp)) {
    return null;
  }

  return {
    bind: candidate.bind,
    exp: candidate.exp as number,
    iat: candidate.iat as number,
    rid: candidate.rid,
    v: 1,
  };
}

/**
 * Verifica el token. NUNCA lanza: cualquier entrada malformada devuelve un
 * código.
 *
 * ORDEN LOAD-BEARING — la firma se valida ANTES de leer el payload:
 *  1. forma y tamaño del token
 *  2. secreto presente (fail-closed: sin secreto no se acepta NINGÚN resume)
 *  3. estructura del token (3 partes, prefijo, firma hex de 64)
 *  4. HMAC sobre el string crudo con su dominio + `timingSafeEqual`
 *  5. recién ahora: decodificar, parsear y validar la forma del payload
 *  6. vigencia (`exp`) y `iat` no-futuro
 *  7. binding al caller
 *
 * ⚠️ El `exp` viaja DENTRO del payload que estamos verificando: leerlo antes de
 * validar el HMAC sería confiar en un campo que el atacante controla. PROHIBIDO
 * invertirlo.
 *
 * ⚠️ Y el `exp` de acá NO ES LA AUTORIDAD sobre el vencimiento del run — es un
 * fast-fail, espejo del pre-claim "cero DB write" de `agent-link.ts`. La
 * autoridad es `expires_at` comparado contra `NOW()` DENTRO de
 * `claim_suspended_run`, donde los dos lados de la comparación salen del mismo
 * reloj. Por eso `RESUME_EXPIRED` no es un final: el llamador sigue yendo a la
 * base, que es la única que puede marcar la fila `expired` y dejar constancia
 * del residuo. Lo que SÍ es final es `RESUME_INVALID`: ahí no se toca la base.
 */
export function verifyResumeToken(
  token: string,
  caller: ResumeTokenCaller,
  nowMs?: number,
): ResumeVerifyResult {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, code: 'RESUME_INVALID' };
  }
  if (token.length > RESUME_MAX_TOKEN_CHARS) {
    return { ok: false, code: 'RESUME_INVALID' };
  }

  const secret = resumeHmacKey();
  if (secret === null) {
    return { ok: false, code: 'RESUME_INVALID' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, code: 'RESUME_INVALID' };
  const [version, encoded, signature] = parts as [string, string, string];
  if (version !== RESUME_VERSION) return { ok: false, code: 'RESUME_INVALID' };
  if (encoded.length === 0) return { ok: false, code: 'RESUME_INVALID' };
  if (!HMAC_HEX_RE.test(signature)) {
    return { ok: false, code: 'RESUME_INVALID' };
  }

  const expected = computeResumeSignature(`${version}.${encoded}`, secret);
  if (!hexEqual(expected, signature)) {
    return { ok: false, code: 'RESUME_INVALID' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, code: 'RESUME_INVALID' };
  }
  const payload = parseResumePayload(parsed);
  if (payload === null) return { ok: false, code: 'RESUME_INVALID' };

  const nowSec = Math.floor(
    (typeof nowMs === 'number' ? nowMs : Date.now()) / 1000,
  );
  if (nowSec >= payload.exp) return { ok: false, code: 'RESUME_EXPIRED' };
  if (payload.iat > nowSec + RESUME_CLOCK_SKEW_SECONDS) {
    return { ok: false, code: 'RESUME_INVALID' };
  }

  const expectedBind = computeResumeBinding(caller);
  if (expectedBind === null) return { ok: false, code: 'RESUME_INVALID' };
  if (!hexEqual(expectedBind, payload.bind)) {
    return { ok: false, code: 'RESUME_INVALID' };
  }

  return { ok: true, payload };
}
