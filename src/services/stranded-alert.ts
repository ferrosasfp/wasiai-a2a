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
 *               computación falló, el dato está rancio, o la env del umbral está PUESTA
 *               y es ILEGIBLE (fix-pack 2026-07-31 — ver `getStrandedHealthField`: "sin
 *               configurar" y "mal escrita" no son lo mismo y no se escriben igual).
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

/** Nombre de la env del umbral. Se usa acá y en el aviso de arranque. */
export const STRANDED_THRESHOLD_ENV = 'STRANDED_EXPOSURE_ALERT_THRESHOLD_USD';

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
  const raw = process.env[STRANDED_THRESHOLD_ENV];
  if (!raw || raw.trim() === '') return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * En cuál de los TRES estados quedó la config del umbral. **Es la única clasificación que
 * existe**: el aviso de arranque y el campo de `/health` la consumen los dos, y ninguno
 * vuelve a interpretar la env por su cuenta.
 *
 * POR QUÉ IMPORTA QUE SEA UNA SOLA. `getStrandedThresholdUsd()` devuelve `null` para dos
 * situaciones que NO son la misma: "no hay nada configurado" y "hay algo configurado que
 * no se puede leer". Cada consumidor que quiera distinguirlas necesita el chequeo de
 * PRESENCIA (`raw.trim() !== ''`), y ese chequeo escrito dos veces se desincroniza en
 * algún borde (¿un `'   '` cuenta como presente?) — con el resultado de que el arranque
 * diría una cosa y `/health` otra sobre la misma env. Acá está escrito UNA vez; el
 * veredicto de legibilidad no se re-parsea, sale de `getStrandedThresholdUsd()`.
 *
 * Es puro y barato (una lectura de env + un `Number`): se puede llamar por request.
 *
 * ⚠️ POR QUÉ **NO** SE UNIFICA CON `isPipelineCeilingMisconfigured` (`lib/stranded-payment.ts`).
 * Ese predicado hace la misma pregunta ("¿puesta pero ilegible?") sobre OTRA env, y la
 * tentación de sacar un helper genérico es real. No se hace, y no es prolijidad mal
 * entendida: el techo `PIPELINE_EXPOSURE_CEILING_USD` **gobierna el guard de presupuesto
 * de `/compose`**, o sea tráfico que se acepta o se rechaza. Un helper compartido haría
 * que cambiarle a ESTA alerta la definición de "legible" (aceptar un `0`, poner una cota
 * superior, admitir sufijos) le cambie en silencio el criterio al techo que decide si un
 * pipeline corre. Se estaría acoplando un canal de observabilidad con un control de
 * dinero para ahorrar cuatro líneas. Cada env es autoritativa sobre su propio parseo y
 * cada una tiene sus tests; si divergen, no se rompe nada, porque no comparten consumidor.
 */
export type StrandedThresholdState = 'unset' | 'active' | 'unreadable';

export function getStrandedThresholdState(): StrandedThresholdState {
  const raw = process.env[STRANDED_THRESHOLD_ENV];
  if (raw === undefined || raw.trim() === '') return 'unset';
  // Presente. Que sirva o no lo decide LA MISMA función que usa el camino de alerta.
  return getStrandedThresholdUsd() === null ? 'unreadable' : 'active';
}

/**
 * Lo que el arranque tiene que decir sobre el umbral (fix-pack observabilidad 2026-07-31).
 *
 * QUÉ PROBLEMA RESUELVE. `PIPELINE_EXPOSURE_CEILING_USD` ya se delata al arrancar cuando
 * está puesta y es ilegible (`isPipelineCeilingMisconfigured` → `src/index.ts`). El
 * umbral, que es EL QUE DECIDE SI SUENA LA ALERTA, no decía nada: se leía en un solo
 * lugar y sólo cuando el camino de alerta corría. Un `19` escrito `1O` no produce un
 * error, produce UNA ALERTA QUE NUNCA SUENA, y eso es indistinguible de que no haya nada
 * que alertar. O sea: el guard que avisa cuando algo va mal no avisaba cuando él mismo
 * estaba mal configurado.
 *
 * TRES ESTADOS, NO DOS (misma doctrina que el campo de `/health`):
 *
 *   `unset`       ausente ⟹ la alerta está apagada A PROPÓSITO. Se dice, no se grita:
 *                 no es un error.
 *   `active`      puesta y legible ⟹ se imprime EL VALOR que quedó activo, para que el
 *                 operador lo confirme desde el log y no desde el panel del hosting.
 *   `unreadable`  puesta e ilegible ⟹ se grita, como el techo. Colapsar esto con `unset`
 *                 sería exactamente el error que este aviso viene a corregir.
 *
 * EL VALOR SALE DE `getStrandedThresholdUsd()`, NO DE UN RE-PARSEO. Si el arranque
 * dijera `19` y el camino de alerta usara otro número, el log MIENTE, y un log que miente
 * es peor que no tenerlo. Por eso acá no se vuelve a interpretar la env: se llama a la
 * MISMA función que usa `refreshStrandedExposure`, y el número del mensaje sale de esa
 * misma variable.
 *
 * NO CAMBIA NINGUNA POLÍTICA: esto es observabilidad. Con la env ausente la alerta sigue
 * apagada y `/health` sigue byte-idéntico (AC-10).
 */
export interface StrandedThresholdStartupReport {
  state: StrandedThresholdState;
  /** `warn` sólo para el estado que amerita un grito. */
  level: 'info' | 'warn';
  setting: typeof STRANDED_THRESHOLD_ENV;
  /** El número activo, o el crudo que no se pudo leer, o `(unset)`. */
  value: number | string;
  message: string;
}

/** Se evalúa UNA vez, al arrancar (`src/index.ts`). No cuesta nada por request. */
export function describeStrandedThresholdStartup(): StrandedThresholdStartupReport {
  const raw = process.env[STRANDED_THRESHOLD_ENV];
  // La MISMA lectura que usa el camino de alerta. Nunca un re-parseo paralelo.
  const thresholdUsd = getStrandedThresholdUsd();
  // …y la MISMA clasificación que usa `/health`: este aviso no decide por su cuenta qué
  // cuenta como "ausente", porque entonces el arranque y `/health` podrían discrepar.
  const state = getStrandedThresholdState();

  // El `raw === undefined` de la derecha NO es una segunda regla: una env sin definir es
  // `unset` por construcción de `getStrandedThresholdState`. Está para que el compilador
  // sepa que más abajo, en el caso ilegible, hay un string crudo que mostrar.
  if (state === 'unset' || raw === undefined) {
    return {
      state: 'unset',
      level: 'info',
      setting: STRANDED_THRESHOLD_ENV,
      value: '(unset)',
      message:
        `${STRANDED_THRESHOLD_ENV} NO ESTA CONFIGURADA: la alerta de exposicion varada esta APAGADA a proposito. ` +
        'El campo `strandedExposureBreached` no aparece en /health y no se hace ni una query. ' +
        'Esto NO ES UN ERROR: seteala (USD, positivo) si queres encenderla. Ver .env.example.',
    };
  }

  // El `thresholdUsd === null` de la derecha NO es una segunda regla: por construcción de
  // `getStrandedThresholdState` una env presente es `unreadable` exactamente cuando esa
  // función devuelve `null`. Está para que el compilador sepa que abajo hay un número.
  if (state === 'unreadable' || thresholdUsd === null) {
    return {
      state: 'unreadable',
      level: 'warn',
      setting: STRANDED_THRESHOLD_ENV,
      value: raw,
      message:
        `⚠️  ${STRANDED_THRESHOLD_ENV} esta PUESTA pero es ILEGIBLE (valor: "${raw}"): ` +
        'la alerta de exposicion varada NO SUENA y no se hace ni una query, igual que si la variable no existiera. ' +
        'El sintoma de esto es una alerta que NUNCA suena, y eso se ve igual que "no hay nada que alertar": ' +
        `por eso /health publica \`${STRANDED_HEALTH_FIELD}: "unknown"\` mientras el valor no se pueda leer. ` +
        'Corregi el valor (USD, positivo, punto decimal: 19 o 19.5). Ver .env.example.',
    };
  }

  return {
    state: 'active',
    level: 'info',
    setting: STRANDED_THRESHOLD_ENV,
    value: thresholdUsd,
    message:
      `${STRANDED_THRESHOLD_ENV} ACTIVA en USD ${thresholdUsd}: la alerta de exposicion varada suena cuando la ` +
      'exposicion acumulada en la ventana supera ese monto. Es el mismo numero que usa el camino de alerta, no una copia.',
  };
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
 * ─── LA CONFIG DEL UMBRAL TAMBIÉN TIENE TRES ESTADOS ACÁ (fix-pack 2026-07-31) ──────
 *
 *   ausente     el campo se OMITE.
 *   ilegible    el campo APARECE diciendo `'unknown'`.
 *   legible     el campo APARECE con el veredicto computado (`true`/`false`/`'unknown'`).
 *
 * QUÉ ESTABA MAL. Esto preguntaba `getStrandedThresholdUsd() === null`, que colapsa las
 * dos primeras filas, así que un `19` escrito `1O` hacía DESAPARECER el campo. Un campo
 * ausente se lee como "no hay problema": el síntoma de un umbral mal escrito era una
 * alerta que nunca suena Y un `/health` mudo, o sea algo indistinguible de que no haya
 * nada que alertar. El aviso de arranque lo delata, pero sale UNA vez en el log del
 * deploy; el monitor, que es lo que corre siempre, no lo mira. `'unknown'` es truthy ⟹ el
 * `degradedPath` alerta, y ese es el punto: **se puede alertar sobre una alerta rota**.
 *
 * POR QUÉ EL CASO AUSENTE SÍ SE SIGUE OMITIENDO (y no es la misma omisión). No hay
 * ambigüedad que reportar: nadie encendió la feature, y eso es una decisión del operador,
 * no un dato que no se pudo conseguir. Reportar `'unknown'` ahí pondría en `degraded` a
 * TODOS los deploys que a propósito no usan la alerta — un canal que grita siempre es un
 * canal que se aprende a ignorar, que es exactamente el daño que este fix-pack combate.
 * Además sostiene AC-10 (`/health` byte-idéntico al de antes de la HU-306 sin la env) y
 * la propiedad de costo CERO (CD-19: ni una query, y el test las cuenta). La diferencia
 * con el caso ilegible es que ahí SÍ hay algo que el operador cree tener y no tiene.
 *
 * NINGUNO DE LOS DOS CASOS TOCA LA BASE: los dos salen antes del refresh de fondo, así
 * que el costo es cero por construcción y no por que `refreshStrandedExposure` casualmente
 * también chequee el umbral.
 *
 * CD-11: acá va SÓLO el booleano de tres estados. Nada de conteos, montos, ids ni slugs
 * — `/health` es público y la exposición acumulada del operador no lo es.
 */
export function getStrandedHealthField():
  | Record<string, never>
  | {
      [STRANDED_HEALTH_FIELD]: StrandedHealthValue;
    } {
  // La MISMA clasificación que usa el aviso de arranque. No se re-lee la env acá.
  const state = getStrandedThresholdState();
  if (state === 'unset') return {};
  if (state === 'unreadable') {
    // Sin snapshot, sin refresh y sin query: no hay umbral contra el cual comparar. Un
    // snapshot viejo tampoco sirve — se computó contra un número que ya no se puede leer.
    return { [STRANDED_HEALTH_FIELD]: 'unknown' };
  }
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
