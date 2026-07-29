/**
 * HU-306 (AC-5) — el indicador de que la plata varada está CRECIENDO.
 *
 * QUÉ PROBLEMA RESUELVE. Las dos primeras piezas de esta HU dejan constancia de cada run
 * varado y lo listan en el panel admin. Las dos son PULL: alguien tiene que acordarse de
 * mirar. Un residuo que se acumula despacio no se ve mirando de vez en cuando — se ve
 * cuando alguien pregunta por qué no cierran los números. Esto es la pata PUSH: un campo
 * en `/health` que el health-monitor del trípode ya sabe leer (`degradedPath`), sin cron
 * nuevo, sin webhook nuevo y sin una línea de código nueva en el monitor.
 *
 * ─── EL CAMPO TIENE TRES ESTADOS, Y ESO ES EL PUNTO ────────────────────────────────
 *
 *   ausente     el umbral no está configurado ⟹ feature OFF ⟹ CERO queries y `/health`
 *               byte-idéntico a antes de esta HU.
 *   false       SE COMPUTÓ y no hay breach.
 *   true        breach: la exposición acumulada en la ventana superó el umbral.
 *   'unknown'   NO SE PUEDE AFIRMAR que no haya breach: nunca se computó, la última
 *               computación falló, o el dato está rancio.
 *
 * POR QUÉ `'unknown'` Y NO `false`. Es la misma doctrina que AC-4 aplicada al tercer
 * pilar: una lista vacía por caída de la base se lee igual que "no hay nada retenido",
 * que es la peor mentira posible. Un `false` por caída de la base dice "no hay nada que
 * reportar" en el ÚNICO canal que existe para gritarlo. Una caída de la base no es
 * ausencia de problema: es ausencia de información, y las dos cosas no se escriben igual.
 * `'unknown'` es TRUTHY, así que el `degradedPath` del monitor lo lee como degradado y
 * alerta con severidad `warning` — que es exactamente lo correcto: hay plata para
 * reconciliar, no hay un outage.
 *
 * ─── CÓMO SE COMPUTA SIN COSTO EN EL REQUEST PATH (CD-10) ──────────────────────────
 *
 * Snapshot en memoria. `/health` lo lee SINCRÓNICAMENTE y, si está rancio, dispara un
 * refresh en segundo plano (`void`, con su `.catch`). NUNCA hay un `await` a la base en
 * el handler, NUNCA tira, y como mucho sale UNA query por `REFRESH_MS` aunque `/health`
 * reciba miles de hits. SIN `setInterval` a propósito: un timer suelto filtra en los
 * tests y deja el proceso vivo en el shutdown.
 */

import { getLogger } from '../lib/logger.js';
import { reconciliationService } from './reconciliation.js';

const log = getLogger('stranded-alert');

/** Nombre del campo en `/health`. Es el `degradedPath` que se configura en el monitor. */
export const STRANDED_HEALTH_FIELD = 'strandedExposureBreached';

/** Como mucho una query por minuto, sin importar cuántos hits reciba `/health`. */
const REFRESH_MS = 60_000;

/**
 * A partir de acá el dato deja de ser afirmable. No es lo mismo que `REFRESH_MS`: entre
 * uno y otro el snapshot es viejo pero todavía representativo (la ventana es de 60 min).
 * Pasado esto —refreshes que vienen fallando, proceso sin tráfico— el campo dice
 * `'unknown'` en vez de repetir una respuesta que ya no se sostiene.
 */
const STALE_MS = 5 * REFRESH_MS;

export type StrandedHealthValue = boolean | 'unknown';

interface Snapshot {
  value: StrandedHealthValue;
  computedAt: number;
}

let snapshot: Snapshot | null = null;
let lastAttemptAt = 0;
let inFlight = false;

/**
 * Umbral en USD de exposición ACUMULADA en la ventana. Ausente, vacío o ilegible ⟹
 * `null` ⟹ feature OFF (patrón `getDriftThresholdAtomic`: se lee en CADA llamada, nunca
 * al importar el módulo).
 *
 * El valor recomendado sale de `recommendedAlertThresholdUsd` (10 × la cota de un
 * pipeline). Un `0` o un negativo NO se aceptan como "alertar siempre": sería un canal
 * de alerta gritando en cada request, o sea un canal que se aprende a ignorar.
 */
export function getStrandedThresholdUsd(): number | null {
  const raw = process.env.STRANDED_EXPOSURE_ALERT_THRESHOLD_USD;
  if (!raw || raw.trim() === '') return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Ventana en minutos. Default 60 = 15× el período de poleo del monitor. */
export function getStrandedWindowMin(): number {
  const raw = process.env.STRANDED_EXPOSURE_ALERT_WINDOW_MIN;
  if (!raw || raw.trim() === '') return 60;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : 60;
}

/**
 * Recomputa el snapshot. NUNCA tira: ante un fallo deja `'unknown'`, que es la respuesta
 * honesta ("no pudimos saberlo") y además es truthy, así que alerta igual.
 */
export async function refreshStrandedExposure(): Promise<void> {
  const thresholdUsd = getStrandedThresholdUsd();
  if (thresholdUsd === null) return; // OFF: ni una query
  const windowMin = getStrandedWindowMin();
  lastAttemptAt = Date.now();
  try {
    const sinceIso = new Date(Date.now() - windowMin * 60_000).toISOString();
    const { runs, exposureUsd, truncated } =
      await reconciliationService.countStrandedExposureSince(sinceIso);
    // REGLA DE LECTURA (ver `countStrandedExposureSince`): con la lista truncada la suma
    // es una COTA INFERIOR, así que un truncamiento cuenta como breach por sí solo. Nunca
    // puede producir un `false` — que sería el fallo peligroso.
    const breached = truncated || exposureUsd > thresholdUsd;
    const previous = snapshot?.value;
    snapshot = { value: breached, computedAt: Date.now() };
    // Segundo consumidor, gratis: la señal existe en los logs aunque el JSON de targets
    // del monitor todavía no se haya actualizado. Sólo en la TRANSICIÓN, para que el log
    // no repita la misma línea cada minuto mientras dure el breach.
    if (breached && previous !== true) {
      log.error(
        {
          alert: 'COMPOSE_STRANDED_PAYMENT_EXPOSURE_HIGH',
          windowMin,
          thresholdUsd,
          exposureUsd,
          runs,
          truncated,
        },
        '[stranded] accumulated stranded payment exposure crossed the alert threshold — pipelines are failing AFTER paying agents on-chain, and that money does not come back',
      );
    }
  } catch (err) {
    log.error(
      { err },
      '[stranded] the stranded exposure could not be computed — the health field reports "unknown", which is truthy and alerts on purpose',
    );
    snapshot = { value: 'unknown', computedAt: Date.now() };
  }
}

/**
 * El campo aditivo de `/health`. SÍNCRONO, no tira, y no espera a la base (CD-10).
 *
 * Devuelve `{}` cuando el umbral no está configurado: el `/health` de un deploy que no
 * activó la alerta es byte-idéntico al de antes de esta HU (AC-10), y no dispara NI UNA
 * query (CD-19 — el test lo cuenta, no lo supone).
 *
 * CD-11: acá va SÓLO el booleano de tres estados. Nada de conteos, montos, ids ni slugs
 * — `/health` es público y la exposición acumulada del operador no lo es.
 */
export function getStrandedHealthField():
  | Record<string, never>
  | {
      [STRANDED_HEALTH_FIELD]: StrandedHealthValue;
    } {
  if (getStrandedThresholdUsd() === null) return {};
  const now = Date.now();
  const age = snapshot ? now - snapshot.computedAt : Number.POSITIVE_INFINITY;
  // Refresh en segundo plano, acotado por REFRESH_MS y por el vuelo en curso. El
  // `.catch` es obligatorio: `refreshStrandedExposure` ya captura, pero un rechazo
  // inesperado acá sería una unhandled rejection en el handler de health.
  if (age >= REFRESH_MS && !inFlight && now - lastAttemptAt >= REFRESH_MS) {
    inFlight = true;
    void refreshStrandedExposure()
      .catch(() => {
        snapshot = { value: 'unknown', computedAt: Date.now() };
      })
      .finally(() => {
        inFlight = false;
      });
  }
  // Nunca computado o rancio ⟹ no se puede afirmar que no haya breach.
  const value: StrandedHealthValue =
    snapshot && age < STALE_MS ? snapshot.value : 'unknown';
  return { [STRANDED_HEALTH_FIELD]: value };
}

/** TEST-ONLY: limpia el estado del módulo entre tests (patrón `_resetRegistry`). */
export function _resetStrandedAlert(): void {
  snapshot = null;
  lastAttemptAt = 0;
  inFlight = false;
}
