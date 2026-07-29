/**
 * Orchestrate quote freeze (WKH-303) — cotización firmada, stateless, TTL 10 min.
 *
 * POR QUÉ EXISTE: entre `POST /orchestrate/plan` (cotiza) y `POST /orchestrate/execute`
 * (ejecuta y debita) hay una ventana en la que el precio de un agente puede cambiar. Sin
 * este módulo, `/execute` re-resuelve el precio en vivo y lo único que lo frena es un techo
 * declarado por el cliente (`maxQuotedCostUsdc`): si el precio cambió pero quedó debajo del
 * techo, se debita el precio nuevo SIN QUE NADIE LO HAYA APROBADO.
 *
 * El quote congela PRECIO **E** IDENTIDAD por step. Congelar solo el precio dejaría abierto
 * el ataque "ejecutar otro agente al precio del primero".
 *
 * ⚠️ COMPROMISO ACEPTADO Y DELIBERADO: un quote se puede redimir MÁS DE UNA VEZ dentro de
 * sus 10 minutos. No hay tracking de "ya usado" porque eso exigiría storage durable, que
 * está explícitamente descartado (AC-7). No es doble cobro: cada redención ejecuta el
 * pipeline de verdad y debita su propio importe (dos redenciones = dos ejecuciones = dos
 * débitos); lo que se repite es la GARANTÍA DE PRECIO, honrada dos veces. Tampoco es un
 * bypass de límites: cada redención pasa por `budgetService.debit` con budget, daily limit,
 * cap por destino y caps de delegación/sesión intactos. Daño acotado: durante ≤ 10 min un
 * caller puede ejecutar N pipelines al precio viejo, y solo cuando el precio SUBIÓ.
 * Si algún día se exige single-use, hay que revisar la decisión de no-storage (la forma
 * natural sería la tabla de nonces que ya existe para signed-auth).
 * 🔴 PROHIBIDO "mitigar un poco" con un anti-replay en memoria del proceso: sería estado no
 * durable, inconsistente entre instancias e invisible en el contrato.
 *
 * Módulo LEAF a propósito: solo `node:crypto`. Sin acceso a base de datos, sin caché
 * externa, sin Fastify. Es lo que hace que el quote sea autocontenido (AC-7).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Prefijo del token; permite rotar el formato sin ambigüedad. */
export const QUOTE_VERSION = 'v1';

/**
 * Los 10 minutos de la garantía, en segundos.
 * 🔴 SIN override por env a propósito: una variable que alargue esta ventana sería una
 * palanca silenciosa sobre el money-path (cuanto más larga, más grande el delta que el
 * gateway absorbe cuando el precio sube).
 */
export const QUOTE_TTL_SECONDS = 600;

/** Tolerancia de `iat` en el futuro, por deriva de reloj entre instancias. */
export const QUOTE_CLOCK_SKEW_SECONDS = 60;

/** Techo de tamaño del token, chequeado ANTES de decodificar nada. */
export const QUOTE_MAX_TOKEN_CHARS = 8192;

/** Nombre del secreto, en un solo lugar. */
export const QUOTE_ENV_VAR = 'ORCHESTRATE_QUOTE_HMAC_KEY';

const HMAC_HEX_RE = /^[0-9a-f]{64}$/;

/** Credencial exacta a la que queda atado el quote. */
export interface QuoteCaller {
  kind: 'delegation' | 'session' | 'key';
  id: string;
}

/** Step tal como lo entrega el plan, antes de congelarse. */
export interface QuoteStepInput {
  agent: string;
  registry: string | null;
  priceUsdc: number;
}

/** Step congelado dentro del payload firmado. Claves cortas: el token viaja por la red. */
export interface QuoteStepPayload {
  /** slug del agente */
  a: string;
  /** precio en USDC como string de 8 decimales */
  p: string;
  /** registry (`null` = el default del gateway) */
  r: string | null;
}

export interface QuotePayload {
  /** HMAC del caller: el id crudo NUNCA entra al payload (el base64url es legible). */
  bind: string;
  /** epoch segundos — `iat + QUOTE_TTL_SECONDS` */
  exp: number;
  /** epoch segundos — emisión */
  iat: number;
  /** orchestrationId del plan. SOLO correlación: prohibido usarlo como clave de billing. */
  oid: string;
  steps: QuoteStepPayload[];
  v: 1;
}

export type QuoteVerifyFailureCode =
  | 'QUOTE_INVALID'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_CALLER_MISMATCH';

export type QuoteVerifyResult =
  | { ok: true; payload: QuotePayload }
  | { ok: false; code: QuoteVerifyFailureCode };

export interface SignedQuote {
  token: string;
  expiresAtIso: string;
}

/**
 * Contexto del caller, tipado ESTRUCTURALMENTE para no importar Fastify acá.
 * Espeja las props que el request ya lleva tras el middleware de auth.
 */
export interface QuoteCallerContext {
  delegationContext?: { delegationId: string } | undefined;
  keySessionContext?: { sessionId: string } | undefined;
  a2aKeyRow?: { id: string } | undefined;
}

/**
 * Secreto dedicado del quote.
 *
 * 🔴 SIN fallback a ningún otro secreto del sistema (CD-5). Reusar
 * `RECEIPT_SIGNING_SECRET` u otro acoplaría dos subsistemas: rotar uno invalidaría el otro
 * en silencio, y una filtración de cualquiera de los dos permitiría forjar quotes.
 * Ausente o vacío → `null`, y el llamador decide (fail-closed). Nunca lanza.
 */
export function quoteHmacKey(): string | null {
  const secret = process.env[QUOTE_ENV_VAR];
  if (typeof secret !== 'string' || secret.length === 0) return null;
  return secret;
}

/**
 * ÚNICA fuente de verdad del binding (CD-12): la usan emisión Y redención.
 *
 * La precedencia espeja cómo se enruta el débito en el middleware. Si acá se invirtiera, un
 * quote emitido bajo delegación quedaría atado a la key padre y podría redimirlo cualquier
 * otra sesión de esa key.
 *
 * `null` = caller no bindeable (x402 / anónimo): no se emite quote y no se puede redimir uno.
 */
export function resolveQuoteCaller(ctx: QuoteCallerContext): QuoteCaller | null {
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
 * HMAC de la credencial. El `kind` entra al material firmado para que una delegación y una
 * sesión que compartan UUID no colisionen. Patrón `hashCallerRef` de `src/lib/caller-hash.ts`.
 *
 * El binding es a la CREDENCIAL EXACTA, no al owner: el mismo dueño con otra de sus keys no
 * puede redimir el quote.
 */
export function computeQuoteBinding(caller: QuoteCaller): string | null {
  const secret = quoteHmacKey();
  if (secret === null) return null;
  return createHmac('sha256', secret)
    .update(`quote-bind:v1:${caller.kind}:${caller.id}`, 'utf8')
    .digest('hex');
}

/** Payload canónico: claves en orden alfabético EXPLÍCITO (patrón `buildCanonicalPayload`). */
function buildCanonicalQuotePayload(payload: QuotePayload): string {
  return JSON.stringify({
    bind: payload.bind,
    exp: payload.exp,
    iat: payload.iat,
    oid: payload.oid,
    steps: payload.steps.map((step) => ({
      a: step.a,
      p: step.p,
      r: step.r,
    })),
    v: payload.v,
  });
}

/** Firma sobre el string CRUDO `"<version>.<b64payload>"`, nunca sobre el objeto parseado. */
function computeQuoteSignature(signingInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signingInput, 'utf8').digest('hex');
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

/** Precio válido para congelar: finito y estrictamente `> 0`. */
function isFreezablePrice(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Emite el quote firmado. Devuelve `null` (nunca lanza) si:
 *  · no hay secreto configurado,
 *  · no hay caller bindeable,
 *  · `steps` viene vacío,
 *  · algún step no tiene slug, o su precio no es finito y `> 0`.
 *
 * Ese último caso es deliberado: un step sin precio resuelto cotiza 0 y hoy se cobra con el
 * fee placeholder. Congelar 0 sería congelar un revenue leak; congelar el placeholder sería
 * congelar un número que nunca se cotizó. No emitir quote deja el comportamiento de hoy.
 */
export function signQuote(input: {
  orchestrationId: string;
  caller: QuoteCaller;
  steps: QuoteStepInput[];
  nowMs?: number;
}): SignedQuote | null {
  const secret = quoteHmacKey();
  if (secret === null) return null;

  const bind = computeQuoteBinding(input.caller);
  if (bind === null) return null;

  if (!Array.isArray(input.steps) || input.steps.length === 0) return null;

  const steps: QuoteStepPayload[] = [];
  for (const step of input.steps) {
    if (typeof step.agent !== 'string' || step.agent.length === 0) return null;
    if (!isFreezablePrice(step.priceUsdc)) return null;
    steps.push({
      a: step.agent,
      p: step.priceUsdc.toFixed(8),
      r: typeof step.registry === 'string' ? step.registry : null,
    });
  }

  const nowMs = typeof input.nowMs === 'number' ? input.nowMs : Date.now();
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + QUOTE_TTL_SECONDS;

  const payload: QuotePayload = {
    bind,
    exp,
    iat,
    oid: input.orchestrationId,
    steps,
    v: 1,
  };

  const encoded = Buffer.from(buildCanonicalQuotePayload(payload), 'utf8').toString(
    'base64url',
  );
  const signingInput = `${QUOTE_VERSION}.${encoded}`;
  const signature = computeQuoteSignature(signingInput, secret);

  return {
    token: `${signingInput}.${signature}`,
    expiresAtIso: new Date(exp * 1000).toISOString(),
  };
}

/** Valida la FORMA del payload decodificado. Devuelve `null` si algo no cierra. */
function parseQuotePayload(raw: unknown): QuotePayload | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;

  if (candidate.v !== 1) return null;
  if (typeof candidate.bind !== 'string' || !HMAC_HEX_RE.test(candidate.bind)) return null;
  if (typeof candidate.oid !== 'string') return null;
  if (!Number.isInteger(candidate.iat) || !Number.isInteger(candidate.exp)) return null;

  const rawSteps = candidate.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return null;

  const steps: QuoteStepPayload[] = [];
  for (const rawStep of rawSteps) {
    if (typeof rawStep !== 'object' || rawStep === null || Array.isArray(rawStep)) return null;
    const step = rawStep as Record<string, unknown>;
    if (typeof step.a !== 'string' || step.a.length === 0) return null;
    if (typeof step.p !== 'string') return null;
    // Un precio de $0 (o negativo, o no numérico) se rechaza AUNQUE LA FIRMA VERIFIQUE: la
    // firma prueba que el token lo emitimos nosotros, no que el número sea cobrable.
    if (!isFreezablePrice(Number(step.p))) return null;
    if (typeof step.r !== 'string' && step.r !== null) return null;
    steps.push({ a: step.a, p: step.p, r: step.r });
  }

  return {
    bind: candidate.bind,
    exp: candidate.exp as number,
    iat: candidate.iat as number,
    oid: candidate.oid,
    steps,
    v: 1,
  };
}

/**
 * Verifica el quote. NUNCA lanza: cualquier entrada malformada devuelve un código.
 *
 * ORDEN LOAD-BEARING (CD-8) — la firma se valida ANTES de leer el payload:
 *  1. forma y tamaño del token
 *  2. secreto presente (fail-closed: sin secreto no se acepta NINGÚN quote, y jamás se cae
 *     al camino de precio vivo teniendo un quote presente)
 *  3. estructura del token (3 partes, prefijo, firma hex de 64)
 *  4. HMAC sobre el string crudo + `timingSafeEqual`
 *  5. recién ahora: decodificar, parsear y validar la forma del payload
 *  6. vigencia (`exp`) y `iat` no-futuro
 *  7. binding al caller
 *
 * ⚠️ El `exp` viaja DENTRO del payload que estamos verificando: leerlo antes de validar el
 * HMAC sería confiar en un campo que el atacante controla. (En `signed-auth.ts` el timestamp
 * viaja en un header aparte, por eso allá el orden es el inverso.) PROHIBIDO invertirlo.
 */
export function verifyQuote(
  token: string,
  caller: QuoteCaller,
  nowMs?: number,
): QuoteVerifyResult {
  // (1) forma y tamaño, antes de decodificar nada
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, code: 'QUOTE_INVALID' };
  }
  if (token.length > QUOTE_MAX_TOKEN_CHARS) {
    return { ok: false, code: 'QUOTE_INVALID' };
  }

  // (2) fail-closed sin secreto
  const secret = quoteHmacKey();
  if (secret === null) {
    return { ok: false, code: 'QUOTE_INVALID' };
  }

  // (3) estructura
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, code: 'QUOTE_INVALID' };
  const [version, encoded, signature] = parts as [string, string, string];
  if (version !== QUOTE_VERSION) return { ok: false, code: 'QUOTE_INVALID' };
  if (encoded.length === 0) return { ok: false, code: 'QUOTE_INVALID' };
  if (!HMAC_HEX_RE.test(signature)) return { ok: false, code: 'QUOTE_INVALID' };

  // (4) HMAC sobre el string CRUDO
  const expected = computeQuoteSignature(`${version}.${encoded}`, secret);
  const signatureOk = hexEqual(expected, signature);
  if (!signatureOk) return { ok: false, code: 'QUOTE_INVALID' };

  // (5) decodificar y validar forma — solo después de que la firma verificó
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, code: 'QUOTE_INVALID' };
  }
  const payload = parseQuotePayload(parsed);
  if (payload === null) return { ok: false, code: 'QUOTE_INVALID' };

  // (6) vigencia
  const nowSec = Math.floor((typeof nowMs === 'number' ? nowMs : Date.now()) / 1000);
  if (nowSec >= payload.exp) return { ok: false, code: 'QUOTE_EXPIRED' };
  // Un `iat` en el futuro más allá del skew significa reloj adelantado (o token fabricado):
  // aceptarlo alargaría la ventana efectiva más allá de los 10 minutos.
  if (payload.iat > nowSec + QUOTE_CLOCK_SKEW_SECONDS) {
    return { ok: false, code: 'QUOTE_INVALID' };
  }

  // (7) binding a la credencial exacta
  const expectedBind = computeQuoteBinding(caller);
  if (expectedBind === null) return { ok: false, code: 'QUOTE_INVALID' };
  if (!hexEqual(expectedBind, payload.bind)) {
    return { ok: false, code: 'QUOTE_CALLER_MISMATCH' };
  }

  return { ok: true, payload };
}
