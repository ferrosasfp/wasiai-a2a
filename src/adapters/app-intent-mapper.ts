/**
 * APP Intent Mapper (WKH-141) — adaptador interno PURO, outbound-only.
 *
 * Single responsibility: traducir resultados YA-VALIDADOS de nuestras operaciones
 * de pago (`charge` x402, `session`/`upto` WKH-135) al vocabulario de intents del
 * OKX Agent Payments Protocol (APP), produciendo un `AppIntentEnvelope` versionado.
 *
 * INVARIANTES (Constraint Directives heredados):
 *  - CD-1: NO inbound. Este módulo NUNCA se importa desde una route handler como
 *    parser de un payload APP ajeno. Es sólo declaración (getSupportedAppIntents)
 *    + mapeo outbound (map*ToApp).
 *  - CD-3: honestidad horneada. `alignment:'conceptual'` + `disclaimer` son campos
 *    NO opcionales del envelope. El disclaimer NUNCA contiene "certified"/"100%".
 *  - CD-5: función PURA. CERO imports de infra (db/redis/viem/fetch/fs) y CERO
 *    `process.env`. Sólo `import type`. Testeable sin mocks de infra. El feature
 *    flag NO vive acá — vive en `agent-card.ts`.
 *  - CD-6 (anti-leak, hereda WKH-137 BLQ-1): allow-list explícita. PROHIBIDO
 *    `...spread` del input completo hacia el envelope. NUNCA copia ownerRef/
 *    buyerWallet/keyId/sellerRef/payTo/capSignature/funding_wallet/typedData/
 *    budget/error interno. Los inputs (`ChargeMapInput`/etc.) YA son estrechos.
 *  - CD-7 (exactOptionalPropertyTypes): los opcionales se ASIGNAN condicionalmente
 *    (`if (v !== undefined) env.x = v;`), NUNCA `x: cond ? v : undefined`.
 *  - CD-8 (anti-overclaim): SOLO `charge`/`session`/`upto`. NUNCA `escrow`.
 *
 * El mapper NO lanza: los inputs ya vienen validados aguas arriba.
 */
import type {
  AppIntentDescriptor,
  AppIntentEnvelope,
  ChargeMapInput,
  SessionMapInput,
  UptoMapInput,
} from '../types/index.js';

/** Versión del envelope producido por este mapper. */
const ENVELOPE_VERSION = 'wasiai-app-map/v1';

/**
 * Disclaimer honesto de alineamiento conceptual. UN solo source de verdad,
 * consumido también por `agent-card.ts` (WKH-141). CD-3: NUNCA "certified"/
 * "certificado"/"100%".
 */
export const APP_ALIGNMENT_DISCLAIMER =
  'Conceptual vocabulary alignment with the OKX Agent Payments Protocol (APP); not an end-to-end verified interop.';

/** Los 3 intents soportados (CD-8: sin `escrow`). */
const SUPPORTED_INTENTS = ['charge', 'session', 'upto'] as const;

/**
 * Copia allow-listed de los campos comunes del status envelope. Asignación
 * condicional (CD-7); campo por campo (CD-6, sin spread del input).
 */
function assignCommonFields(
  env: AppIntentEnvelope,
  input: {
    status?: AppIntentEnvelope['status'];
    amountUsd?: number | undefined;
    chainId?: number | undefined;
    txHash?: string | null | undefined;
  },
): void {
  if (input.status !== undefined) env.status = input.status;
  if (input.amountUsd !== undefined) env.amountUsd = input.amountUsd;
  if (input.chainId !== undefined) env.chainId = input.chainId;
  if (input.txHash !== undefined) env.txHash = input.txHash;
}

/** Mapea un resultado `charge` (x402) al vocabulario APP. */
export function mapChargeToApp(input: ChargeMapInput): AppIntentEnvelope {
  const env: AppIntentEnvelope = {
    vocabulary: 'app',
    envelopeVersion: ENVELOPE_VERSION,
    intent: 'charge',
    alignment: 'conceptual',
    disclaimer: APP_ALIGNMENT_DISCLAIMER,
  };
  assignCommonFields(env, input);
  return env;
}

/** Mapea un resultado `session` (WKH-135) al vocabulario APP. */
export function mapSessionToApp(input: SessionMapInput): AppIntentEnvelope {
  const env: AppIntentEnvelope = {
    vocabulary: 'app',
    envelopeVersion: ENVELOPE_VERSION,
    intent: 'session',
    alignment: 'conceptual',
    disclaimer: APP_ALIGNMENT_DISCLAIMER,
  };
  assignCommonFields(env, input);
  if (input.expiresAt !== undefined) env.expiresAt = input.expiresAt;
  return env;
}

/** Mapea un resultado `upto` (WKH-135) al vocabulario APP. */
export function mapUptoToApp(input: UptoMapInput): AppIntentEnvelope {
  const env: AppIntentEnvelope = {
    vocabulary: 'app',
    envelopeVersion: ENVELOPE_VERSION,
    intent: 'upto',
    alignment: 'conceptual',
    disclaimer: APP_ALIGNMENT_DISCLAIMER,
  };
  assignCommonFields(env, input);
  if (input.expiresAt !== undefined) env.expiresAt = input.expiresAt;
  return env;
}

/**
 * Descriptor estático de los intents soportados, para poblar el Agent Card.
 * CD-8: NUNCA incluye `escrow`.
 */
export function getSupportedAppIntents(): AppIntentDescriptor[] {
  return SUPPORTED_INTENTS.map((intent) => ({
    intent,
    alignment: 'conceptual',
  }));
}
