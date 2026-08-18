/**
 * WKH-360 — identidad propia del gateway y traza de contratación entre
 * coordinadores A2A.
 *
 * ─── POR QUÉ ES UN MÓDULO LEAF (cero imports) ───────────────────────────────
 * Lo consumen CUATRO capas distintas: un route (`routes/compose.ts`), dos
 * services (`services/compose.ts`, `services/orchestrate.ts`) y un middleware
 * (`middleware/contracting-guard.ts`). Y **63 archivos de test mockean
 * `../adapters/registry.js`** con factories sin `importOriginal`; el mismo hazard
 * con `../services/discovery.js` ya rompió 12 y 84 tests en otra HU
 * (`src/lib/discovery-fetch-limit.ts:1-11` lo documenta). Un archivo sin
 * dependencias no puede quedar `undefined` en ninguna suite porque ninguna lo
 * mockea. Precedentes en este repo: `compose-limits.ts`,
 * `discovery-fetch-limit.ts`, `downstream-skip-code.ts`, `pricing-constants.ts`.
 *
 * `process.env` SÍ se lee acá (es un global, no un import), igual que
 * `self-published-auth.ts:115` y `discovery-fetch-limit.ts:75`. Lo que NO va:
 * ningún `import` del repo, ningún logging (los call-sites loguean) y ninguna
 * decisión de dinero. Este módulo devuelve VEREDICTOS; quien cobra o no cobra es
 * el call-site.
 *
 * ─── EL PUNTO FINAL DEL HOSTNAME, MEDIDO (CD-15) ────────────────────────────
 * ⛔ NO reusar `canonicalizeHostKey` de `src/lib/self-published-auth.ts:89-105`.
 * Su docblock (`:82`) afirma que produce el host "(minúsculas, punycode, SIN
 * PUNTO FINAL)" y **eso es falso**. Medido en `3823580` con
 * `node -e "console.log(new URL('https://EXAMPLE.com./x').hostname)"`:
 *
 *     new URL('https://EXAMPLE.com./x').hostname  ===  'example.com.'   ⚠️ con punto
 *     new URL('https://EXAMPLE.COM/x').hostname   ===  'example.com'
 *
 * El punto final SOBREVIVE. Reusar esa función creyendo el comentario deja un
 * bypass de UNA TECLA: `https://<self>./compose` no matchearía la identidad y el
 * guard anti-bucle aplaudiría. Por eso `canonicalizeHost` de acá replica los
 * pasos 1-6 de esa función **verbatim en comportamiento** y agrega el **paso 7**
 * (strip del punto final), que es el aporte de esta HU. El over-claim de ese
 * docblock ajeno queda REPORTADO (NC-6) y NO se arregla desde acá: ese archivo
 * está en el camino de credenciales y está fuera del Scope IN.
 *
 * ⚠️ Que hoy el borde de Railway conteste 404 a la variante con punto final
 * (medido: `…up.railway.app./health` → 404 vs `…up.railway.app/health` → 200)
 * **NO es un guard y no cuenta como mitigación**: es política de ruteo por Host
 * de un hosting, que cambia el día que se agrega un dominio propio o se mueve el
 * deploy.
 *
 * ─── LOS 8 VALORES DE PROFUNDIDAD, MEDIDOS (CD-14) ──────────────────────────
 * Por qué la profundidad NO se lee con `parseInt` ni con `Number`. Medido en
 * `3823580` con `node -e`:
 *
 *   valor      | parseInt(v,10) | Number(v)   | ^[0-9]{1,3}$ | decisión
 *   -----------|----------------|-------------|--------------|------------------
 *   ausente    | —              | —           | —            | 0 (caller directo)
 *   '0'..'999' | igual          | igual       | sí           | valor
 *   '1e9'      | 1          ⚠️  | 1000000000  | no           | RECHAZO
 *   ''         | NaN            | 0       ⚠️  | no           | RECHAZO
 *   ' 2'       | 2          ⚠️  | 2           | no           | RECHAZO
 *   '2abc'     | 2          ⚠️  | NaN         | no           | RECHAZO
 *   '0x10'     | 0              | 16          | no           | RECHAZO
 *   '1000'     | 1000           | 1000        | no           | RECHAZO por forma
 *
 * Las cuatro filas con ⚠️ son el motivo de la regla. Tres de ellas producen un
 * número **plausible y MENOR al techo**: el modo de falla no es un error visible,
 * es **un guard que aplaude**. `'1e9'` leído como `1` es un atacante declarando
 * profundidad mil millones y pasando como si fuera el primer salto; `''` leído
 * como `0` es un **reseteo del contador** a pedido de un tercero.
 *
 * Por eso: presente-pero-ilegible se **RECHAZA**, nunca se degrada a 0. Ausente
 * SÍ es 0, y eso no es una concesión: es el 100% del tráfico de hoy (los 25
 * agentes descubribles en prod no emiten estos headers), y tratarlo como rechazo
 * rompería todos los callers.
 *
 * La conversión dígito-a-número es manual (`digitsToInt`) justamente para que en
 * este archivo no exista ningún `parseInt` ni `Number(` en el camino de la
 * profundidad.
 *
 * ─── LA DERIVACIÓN DEL TECHO POR DEFAULT = 2 (no es un número elegido) ──────
 * El costo de un bucle NO es lineal en la profundidad: es **exponencial con base
 * `MAX_COMPOSE_STEPS`**. Datos medidos en `3823580`: fan-out por nivel
 * = `MAX_COMPOSE_STEPS` = 5 (`src/lib/compose-limits.ts:38`); peor caso del
 * débito por step = `PLACEHOLDER_FEE_USD` = 1.0 (`src/lib/pricing-constants.ts:16`);
 * gas overhead = 0 en testnet y sin env (`src/services/compose.ts:433`); el techo
 * de exposición por pipeline se entrega SIN configurar ⇒ `+Infinity`
 * (`src/lib/stranded-payment.ts:342-348`); y `maxBudget: 0`/ausente sigue
 * significando SIN LÍMITE.
 *
 * Con techo `D` los débitos posibles son `Σ_{k=1..D} 5^k = (5^(D+1) − 5)/4`:
 *
 *   D          | peticiones | débitos | peor caso USD | ¿cubre la tesis del deck?
 *   -----------|------------|---------|---------------|--------------------------
 *   1          | 6          | 5       | $5            | no: prohíbe que un
 *              |            |         |               | coordinador que nos
 *              |            |         |               | contrata contrate a otro
 *   2 (default)| 31         | 30      | $30           | sí
 *   3          | 156        | 155     | $155          | un nivel de más sin caso
 *   sin techo  | sin cota   | sin cota| sólo lo frena el saldo de la key
 *
 * **2 es el número más chico que cubre la tesis publicada** (plataforma →
 * nosotros → otro coordinador → agentes). Subirlo cuesta ×5 por nivel.
 *
 * ⚠️ **El techo NO detecta ciclos: ACOTA COSTO.** Los ciclos los detecta la traza
 * (paso 5 de `readInboundContracting`). El techo existe para el ciclo que la traza
 * NO PUEDE VER: el que pasa por un intermediario que no reenvía los headers.
 * Confundir las dos cosas es un over-claim.
 *
 * ⚠️ Y los otros techos del servicio NO frenan un bucle:
 *  · el timeout (`middleware/timeout.ts:8-25`) hace un `setTimeout` que manda un
 *    504 y NADA MÁS: no aborta el pipeline, así que un bucle sigue gastando
 *    después del 504;
 *  · el rate-limit de `/orchestrate` es 10/60 s con store EN PROCESO y key
 *    `request.ip`, y `TRUST_PROXY` es opt-in con default `false`
 *    (`src/lib/env.ts:53`), así que detrás del borde de Railway los callers
 *    externos podrían compartir un bucket. El valor de `TRUST_PROXY` en prod NO
 *    se pudo verificar (NC-2): esto se escribe con las dos lecturas y no como
 *    garantía.
 *
 * ─── LO QUE ESTE MÓDULO NO CIERRA ──────────────────────────────────────────
 * · **El transitivo contra un adversario.** La capa 2 depende de que la
 *   contraparte reenvíe los headers ⇒ es BEST-EFFORT (ver
 *   `CONTRACTING_LAYER2_BEST_EFFORT_NOTE`, que va en el BODY del error para que el
 *   caller lo sepa). Contra alguien que los borra a propósito lo que queda en pie
 *   es la capa 1 (identidad del destino) y el techo.
 * · **El bypass por IP literal.** La comparación es POR NOMBRE:
 *   `https://69.46.46.64/compose` no matchea. Residual declarado (R-3 /
 *   TD-360-2), NO cerrado acá. `A2A_SELF_HOSTS` acepta un literal si un operador
 *   lo necesita.
 * · **Un `302` de un tercero hacia nosotros.** `ssrf-dispatcher` sigue redirects
 *   a mano y sólo revalida SSRF por hop, así que la capa 1 no lo ve al momento de
 *   decidir. Lo que sí ocurre es que los headers de acá NO están en los 4
 *   `CREDENTIAL_HEADERS` que ese módulo borra por hop, así que la traza sobrevive
 *   el salto y la capa 2 lo caza en el inbound del siguiente gateway.
 */

/** Header con la cadena de contratación (CSV de hostnames canónicos). */
export const CONTRACTING_CHAIN_HEADER = 'x-a2a-contracting-chain';

/** Header con la profundidad de contratación (entero decimal). */
export const CONTRACTING_DEPTH_HEADER = 'x-a2a-contracting-depth';

/** Env con los hostnames propios adicionales (CSV). */
export const SELF_HOSTS_ENV = 'A2A_SELF_HOSTS';

/** Env con el techo de profundidad de contratación. */
export const DEPTH_MAX_ENV = 'A2A_CONTRACTING_DEPTH_MAX';

/**
 * CD-6/CD-19 — UN solo texto para la limitación de la capa 2, consumido por el
 * BODY del error, por la Agent Card y por los tests.
 *
 * Vive acá, y no como literal en cada call-site, para que el mensaje que EMITE el
 * código y el que ASSERTA el test no puedan divergir: si divergen, la promesa que
 * el caller lee y la que el test verifica dejan de ser la misma frase.
 */
export const CONTRACTING_LAYER2_BEST_EFFORT_NOTE =
  'La deteccion de bucles TRANSITIVOS es BEST-EFFORT: depende de que cada ' +
  'intermediario reenvie los headers x-a2a-contracting-chain y ' +
  'x-a2a-contracting-depth. Una contraparte que los borra no queda cubierta por ' +
  'esta capa; contra ese caso lo que queda en pie es el rechazo por identidad ' +
  'del destino y el techo de profundidad.';

/** CD-19: UN solo string por código, consumido desde las DOS superficies. */
export const CONTRACTING_LOOP_DETECTED = 'CONTRACTING_LOOP_DETECTED';
export const CONTRACTING_DEPTH_EXCEEDED = 'CONTRACTING_DEPTH_EXCEEDED';
export const CONTRACTING_DEPTH_MALFORMED = 'CONTRACTING_DEPTH_MALFORMED';
export const CONTRACTING_CHAIN_MALFORMED = 'CONTRACTING_CHAIN_MALFORMED';

/**
 * Techo de profundidad por default. **Derivado con números** en el docblock de
 * arriba (tabla `D`), no elegido: es el más chico que cubre la tesis publicada.
 */
export const DEFAULT_CONTRACTING_DEPTH_MAX = 2;

/** Techo máximo aceptable para la env (un techo enorme es un techo apagado). */
const DEPTH_MAX_ENV_CEILING = 64;

/**
 * Techo MÍNIMO aceptable para la env. `0` cerraría el 100% del tráfico y en este
 * repo un `0` significa "sin límite" en las formas vecinas; `1` es el ajuste más
 * restrictivo con caso de uso. Ver el bloque de `resolveContractingDepthMax`.
 */
const DEPTH_MAX_ENV_FLOOR = 1;

/** Largo máximo de un hostname según DNS. */
const MAX_HOSTNAME_CHARS = 253;

/** Tope absoluto del header de cadena, independiente del techo configurado. */
const CHAIN_HEADER_ABSOLUTE_MAX_CHARS = 4096;

/** Sólo dígitos ASCII, 1 a 3. Ver la tabla de los 8 valores en el docblock. */
const DECIMAL_1_TO_3_DIGITS = /^[0-9]{1,3}$/;

/**
 * Techo del monto que un coordinador ajeno puede DECLARAR como fee (fix-pack
 * AR/BLQ-BAJO-1). Este número lo escribe un TERCERO en el body de su respuesta.
 *
 * ⚠️ Es un techo de **REPRESENTABILIDAD, no de plausibilidad**, y la diferencia
 * importa: un coordinador que declara $100.000.000 sigue publicándose tal cual,
 * porque el gateway no tiene forma de saber qué es plausible en el negocio de otro.
 * Lo que se prohíbe es que el número entre en un rango donde la aritmética que
 * hacemos con él deje de ser aritmética.
 *
 * Derivación, con los números al lado:
 *  · el rollup suma a lo sumo `MAX_COMPOSE_STEPS` = 5 montos
 *    (`src/lib/compose-limits.ts:38`; no se importa porque este módulo es leaf);
 *  · publica `Number(sum.toFixed(6))`, o sea 6 decimales;
 *  · `Number.MAX_SAFE_INTEGER / 1e6 === 9007199254.740992` (medido) es la suma más
 *    grande con la que esos 6 decimales siguen siendo exactos.
 * Con `1e9` por monto, la suma máxima es `5e9 < 9.007e9` ⇒ el redondeo nunca miente
 * y `Infinity` es inalcanzable por esta vía. Testigos: `T-U-FEE-7`, `T-U-ROLL-6`.
 */
const COORDINATOR_FEE_MAX_USDC = 1_000_000_000;

/**
 * Convierte 1..3 dígitos ASCII a número **sin `parseInt` ni `Number`** (CD-14).
 *
 * Precondición: el argumento YA pasó `DECIMAL_1_TO_3_DIGITS`. Con esa
 * precondición el resultado está en `[0, 999]` y no puede ser `NaN`.
 *
 * Existe para que en este archivo no haya ningún `parseInt`/`Number(` en el
 * camino de la profundidad: la regla es verificable con un grep, y una regla que
 * se verifica con un grep no se relaja sin que se note.
 */
function digitsToInt(digits: string): number {
  let out = 0;
  for (let i = 0; i < digits.length; i += 1) {
    out = out * 10 + (digits.charCodeAt(i) - 48);
  }
  return out;
}

/**
 * Un header repetido llega como `string[]`, y eso **es ausencia**.
 * Patrón `pick` de `src/middleware/a2a-key.ts:187-195`.
 */
function pickSingleHeader(
  raw: string | string[] | undefined,
): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * Canonicaliza un host a la forma comparable con `new URL(x).hostname`.
 *
 * Pasos 1-6: `canonicalizeHostKey` (`src/lib/self-published-auth.ts:89-105`),
 * verbatim en COMPORTAMIENTO. **Paso 7: el strip del punto final**, que esa
 * función NO hace aunque su docblock diga que sí (medido; ver el encabezado).
 *
 * Devuelve `null` para cualquier cosa que no sea EXACTAMENTE un host: con
 * esquema, con puerto, con userinfo, con path/query/fragment, con espacios en los
 * bordes, IPv6 entre corchetes.
 */
export function canonicalizeHost(raw: string): string | null {
  // 1 · bordes: un valor con espacios es un valor que el operador escribió mal.
  if (raw.trim() !== raw || raw.length === 0) return null;
  // 2 · esquema, userinfo, puerto, IPv6.
  if (raw.includes('/') || raw.includes('@') || raw.includes(':')) return null;
  let parsed: URL;
  try {
    // 3 · el parser de la plataforma hace minúsculas + punycode gratis.
    parsed = new URL(`https://${raw}`);
  } catch {
    return null;
  }
  // 4 · puerto/userinfo que se colaron por otra vía.
  if (parsed.port !== '') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  // 5 · path/query/fragment.
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    return null;
  }
  const host = parsed.hostname;
  // 6 · host vacío.
  if (host.length === 0) return null;
  // 7 ⚠️ EL PASO QUE NO EXISTE EN `canonicalizeHostKey` (CD-15). Sin esto,
  //     `https://<self>./compose` es un bypass de identidad de una tecla.
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

/**
 * Extrae el host de un `BASE_URL` que puede venir como URL completa o como host
 * pelado. Monótono: si no se puede leer, no aporta nada al conjunto.
 */
function hostFromBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    return canonicalizeHost(new URL(trimmed).hostname);
  } catch {
    return canonicalizeHost(trimmed);
  }
}

/**
 * Estado de `A2A_SELF_HOSTS`, en los tres valores que el arranque necesita
 * distinguir (mismo contrato que `classifyDepositMinimumEnv`).
 *
 * `invalid` incluye los DUPLICADOS a propósito: dos entradas que canonicalizan al
 * mismo host (`GW.example.com` y `gw.example.com.`) son el caso en el que el
 * operador cree tener DOS alias cubiertos y tiene uno.
 */
export function classifySelfHostsEnv():
  | { state: 'absent' }
  | { state: 'configured'; hosts: string[] }
  | { state: 'invalid'; reason: string } {
  const raw = process.env[SELF_HOSTS_ENV];
  if (raw === undefined || raw.trim().length === 0) return { state: 'absent' };

  const entries = raw.split(',');
  const hosts: string[] = [];
  for (const entry of entries) {
    const canonical = canonicalizeHost(entry.trim());
    if (canonical === null) {
      return {
        state: 'invalid',
        reason: `la entrada "${entry}" no es un hostname pelado`,
      };
    }
    if (hosts.includes(canonical)) {
      return {
        state: 'invalid',
        reason: `la entrada "${entry}" esta DUPLICADA (canonicaliza a "${canonical}")`,
      };
    }
    hosts.push(canonical);
  }
  return { state: 'configured', hosts };
}

/**
 * Assertion de arranque. MISMO contrato que `assertDepositMinimumEnv`
 * (`src/lib/env.ts:107-131`): **throw** si la env está presente pero ilegible,
 * **texto de warn** si el conjunto que sale de la config está vacío, `null` si
 * está OK.
 *
 * Las dos causas se tratan distinto A PROPÓSITO:
 *  · PRESENTE PERO ILEGIBLE → THROW, en cualquier `NODE_ENV`. Es el caso en el que
 *    el operador **cree** tener la identidad puesta (`A2A_SELF_HOSTS='https://gw'`
 *    con esquema, o con una entrada duplicada). Es un typo que se arregla en
 *    segundos y, al no bootear, la revisión anterior sigue sirviendo.
 *  · CONJUNTO VACÍO → warn ruidoso, NO throw. No se pudo verificar el valor de
 *    `BASE_URL` en el Railway de prod (NC-1) y voltear el servicio por eso es un
 *    radio de explosión mayor que el problema. El conjunto vacío tampoco deja el
 *    guard inerte **en el camino HTTP**: el `hint` (el `Host` por el que entró la
 *    petición) viaja desde el route hasta los cuatro sitios y cubre el bucle
 *    directo sin ninguna configuración.
 *
 * ⛔ **QUÉ NO CUBRE EL `hint`** — la frase de arriba vale para el camino HTTP y para
 * nada más. Sin `A2A_SELF_HOSTS` quedan afuera, MEDIDO:
 *  1 · los **ALIAS** propios distintos del host por el que entró la petición
 *      (dominio propio vs dominio de Railway vs literal de IP): un caller que nos
 *      pega por el alias A y pide un step contra el alias B no queda cortado;
 *  2 · los **CALLERS NO-HTTP**, que no tienen `Host` que pasar: el tool MCP
 *      (`src/mcp/tools/orchestrate.ts`) y `src/services/inbound-task.ts` llaman al
 *      service directo, sin `FastifyRequest`. Para esos dos caminos el guard
 *      depende de `BASE_URL`/`A2A_SELF_HOSTS` y de nada más. Testigos: `T-L1+6`,
 *      `T-L1+9`, `T-PROP-2`;
 *  3 · el eslabón que ANUNCIAMOS (`canonicalId`) sale del `Host` cuando no hay
 *      config, o sea de un valor que el caller influye — ver la salvedad en
 *      `resolveSelfHosts`.
 * Por eso setear `A2A_SELF_HOSTS` es **paso del deploy**, no una mejora opcional.
 */
export function assertSelfHostsEnv(): string | null {
  const status = classifySelfHostsEnv();
  if (status.state === 'invalid') {
    throw new Error(
      `${SELF_HOSTS_ENV} esta MAL ESCRITA: ${status.reason}. La variable ESTA ` +
        'presente, asi que no es un olvido: es el valor lo que el gateway no ' +
        'puede leer, y con el ilegible el conjunto de identidad propia queda ' +
        'INCOMPLETO — el guard anti-bucle no reconoceria como propio el host que ' +
        'el operador creyo haber declarado. Formato aceptado: hostnames PELADOS ' +
        'separados por coma, sin esquema, sin puerto, sin path y sin repetir ' +
        '(por ejemplo "gw.example.com,alias.example.com"). Se rechazan: ' +
        '"https://gw" (esquema), "gw:8443" (puerto), "gw/x" (path) y entradas ' +
        'duplicadas. Se rechaza el arranque para no quedar con la identidad a ' +
        'medias y sin aviso. Ver .env.example.',
    );
  }
  // El conjunto NO es sólo esta env: `BASE_URL` tambien aporta.
  if (resolveSelfHosts().hosts.length > 0) return null;
  return (
    `${SELF_HOSTS_ENV} NO ESTA CONFIGURADA y BASE_URL tampoco aporta un host ` +
    'legible, asi que el conjunto de identidad propia derivado de la ' +
    'configuracion esta VACIO. Lo que SIGUE cubierto: el bucle directo POR HTTP, ' +
    'usando el Host de cada peticion como hint (agrandar ese conjunto solo puede ' +
    'producir MAS rechazos, nunca menos). Lo que NO queda cubierto, y por eso ' +
    'esto es un warning y no una nota: (1) los ALIAS propios distintos del host ' +
    'por el que entro la peticion — dominio propio, dominio de Railway, literal ' +
    'de IP; (2) los callers que NO son HTTP y por lo tanto no tienen Host que ' +
    'pasar: el tool MCP y el ruteo in-process de inbound-task; (3) el eslabon con ' +
    'el que nos anunciamos hacia afuera sale del Host entrante, que lo influye el ' +
    'caller. GET /health publica contractingGuard.selfHostCount para confirmar el ' +
    `estado despues del deploy. Setea ${SELF_HOSTS_ENV} con tus hostnames ` +
    'separados por coma. Ver .env.example.'
  );
}

/**
 * El conjunto de identidad propia y el eslabón con el que nos anunciamos.
 *
 * Fuentes, EN ESTE ORDEN: `BASE_URL` → `A2A_SELF_HOSTS` → el `hint` del request.
 * `canonicalId` es el PRIMER elemento en ese orden, o `null` si el conjunto queda
 * vacío. **No lleva env propia**: un `A2A_GATEWAY_ID` suelto sería un cuarto
 * lugar donde "quién soy" puede divergir, y derivarlo es lo que garantiza que la
 * traza que EMITIMOS sea comparable con el conjunto que COMPARAMOS. (Este repo ya
 * se rompió por tener dos lectores de un mismo concepto: `lib/agent-category.ts`
 * se extrajo por eso.)
 *
 * ─── POR QUÉ EL `hint` DEL REQUEST ES ADMISIBLE AUNQUE EL CALLER LO INFLUYA ──
 * Leer esto antes de marcarlo como agujero, porque es lo primero que parece uno.
 * Este conjunto se usa **únicamente como PREDICADO DE NEGACIÓN**: agrandarlo sólo
 * puede producir **MÁS rechazos, nunca menos**. Un caller que mande
 * `Host: victima-agente.com` consigue que el gateway **se niegue** a llamar a
 * `victima-agente.com` **en su propia petición**: es un auto-DoS de UN request, no
 * un bypass ni un ataque a un tercero. **Esa monotonía es la propiedad**, y es la
 * razón por la que NO se usa `resolveBaseUrl` (`services/agent-card.ts:67-76`)
 * como fuente única: sus ramas 2 y 3 dependen de headers del caller, o sea que
 * una identidad que el caller puede MOVER es una identidad que el caller puede
 * **VACIAR** — y vaciarla sí sería un bypass. Además `resolveBaseUrl` necesita un
 * `FastifyRequest`, y el loop de `executePipeline` no tiene ninguno.
 *
 * Sin el `hint`, un deploy sin `BASE_URL` ni `A2A_SELF_HOSTS` tendría conjunto
 * VACÍO y la capa 1 quedaría INERTE: exactamente el escenario que CD-1 prohíbe.
 *
 * ⚠️ **DÓNDE NO LLEGA EL ARGUMENTO DE MONOTONÍA: `canonicalId`.** Lo de arriba vale
 * para `hosts`, que se usa como predicado de NEGACIÓN. `canonicalId` es otra cosa:
 * es el eslabón con el que nos ANUNCIAMOS hacia afuera, y es el PRIMERO del orden
 * `BASE_URL` → `A2A_SELF_HOSTS` → `hint`. Con las dos envs puestas el caller no lo
 * puede mover (testigo: `T-L1-2d`). **Sin ninguna env, sale del `Host` entrante**, y
 * ahí un caller que forja el `Host` nos hace emitir una traza con un eslabón que no
 * es el nuestro — o sea que el gateway de al lado leería una cadena que no nos
 * contiene y no tendría razón para frenar. Se acepta igual porque la alternativa
 * medida es PEOR: sin `hint` el `canonicalId` es `null` y **no se emite ninguna
 * traza**, con lo cual el vecino tampoco nos ve Y ADEMÁS su contador de profundidad
 * nunca avanza. Lo que cierra este caso no es un guard: es setear `A2A_SELF_HOSTS`.
 */
export function resolveSelfHosts(hint?: string): {
  hosts: string[];
  canonicalId: string | null;
} {
  const hosts: string[] = [];
  const add = (host: string | null): void => {
    if (host !== null && !hosts.includes(host)) hosts.push(host);
  };

  const baseUrl = process.env.BASE_URL;
  if (baseUrl !== undefined) add(hostFromBaseUrl(baseUrl));

  const envStatus = classifySelfHostsEnv();
  if (envStatus.state === 'configured') {
    for (const host of envStatus.hosts) add(host);
  }

  if (hint !== undefined) add(canonicalizeHost(hint.trim()));

  return { hosts, canonicalId: hosts.length > 0 ? (hosts[0] as string) : null };
}

/**
 * Techo de profundidad efectivo. Ausente **o ilegible** ⇒ el default DEL CÓDIGO,
 * jamás `Infinity` (patrón de `discovery-fetch-limit.ts:74-79` y de
 * `readPipelineCeilingUsd`, `stranded-payment.ts:351-356`).
 *
 * Un techo que cae al default EN SILENCIO es el caso en el que el operador cree
 * tener otro número, así que el arranque además avisa —
 * ver `contractingDepthMaxWarning`.
 *
 * ─── POR QUÉ `0` NO ES UN VALOR ACEPTADO (fix-pack, AR/BLQ-MED-3) ──────────
 * Acá `0` se trataba como legible, y el rango publicado era `[0, 64]`. Medido:
 * `readInboundContracting(sin headers, [self], 0)` ⇒ `CONTRACTING_DEPTH_EXCEEDED`,
 * o sea **el 100% del tráfico rechazado** — un caller directo tiene profundidad 0
 * y el corte es `depth >= depthMax`. Las tres razones por las que ahora cae al
 * default en vez de obedecerse:
 *
 *  1 · **El repo enseña lo contrario para esta MISMA forma.** `maxBudget: 0` y el
 *      ceiling de exposición ausente significan *sin límite* (ver la tabla de
 *      arriba). Un operador que escribe `0` pidiendo "sin tope" **apagaría el
 *      money-path entero**, que es lo más lejos posible de lo que pidió.
 *  2 · **No había señal de arranque**: `0` era legible, así que el warn no salía.
 *      El único síntoma era un 400 cuyo texto manda a buscar un bucle **en el
 *      caller**, o sea el lugar equivocado.
 *  3 · **No existe caso de uso**: `1` ya es el ajuste más restrictivo útil (prohíbe
 *      que un coordinador que nos contrata contrate a otro).
 *
 * Para apagar el servicio no es por acá: se apaga el deploy. Rango aceptado:
 * `[1, 64]`. Testigos: `T-U-MAX-6` y `T-U-MAX-6b`.
 *
 * ⚠️ ASIMETRÍA DELIBERADA con el paso 4 de `readInboundContracting`, y NO se
 * unifican: acá el valor se `trim`ea y en el header NO. CD-14 prohíbe el parseo
 * laxo de la profundidad DEL HEADER porque la controla un TERCERO, y ahí `' 2'`
 * leído como `2` es el ataque (`parseInt(' 2', 10) === 2`). Esta env la escribe el
 * OPERADOR: un espacio de más en un panel de Railway no es un adversario, y ante
 * cualquier cosa que no sean dígitos igual cae al default. Igualar los dos
 * caminos "por consistencia" rompería uno de los dos. Test: `T-U-MAX-7`.
 */
export function resolveContractingDepthMax(): number {
  const raw = process.env[DEPTH_MAX_ENV];
  if (raw === undefined) return DEFAULT_CONTRACTING_DEPTH_MAX;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return DEFAULT_CONTRACTING_DEPTH_MAX;
  if (!DECIMAL_1_TO_3_DIGITS.test(trimmed)) {
    return DEFAULT_CONTRACTING_DEPTH_MAX;
  }
  const value = digitsToInt(trimmed);
  if (value > DEPTH_MAX_ENV_CEILING) return DEFAULT_CONTRACTING_DEPTH_MAX;
  // `0` NO se obedece: cerraría el 100% del tráfico. Ver el bloque del docblock.
  if (value < DEPTH_MAX_ENV_FLOOR) return DEFAULT_CONTRACTING_DEPTH_MAX;
  return value;
}

/**
 * El texto del `warn` de arranque cuando el techo configurado NO se está usando, o
 * `null` si el valor efectivo es el que el operador escribió.
 *
 * ⚠️ Devuelve el TEXTO y no un `boolean`, y el cambio es del fix-pack
 * (AR/BLQ-MED-3). Antes esto era `isContractingDepthMaxMisconfigured(): boolean` y
 * el booleano **no podía distinguir los dos motivos**, que necesitan mensajes
 * distintos y hasta opuestos:
 *  · ilegible (`'1O'`) ⇒ "el valor que pusiste no está haciendo nada";
 *  · `0` ⇒ "el valor que pusiste **cerraría el servicio**, y para apagarlo no es
 *    por acá".
 * Un operador que lee el primer texto ante un `0` sale a buscar un typo que no
 * existe. MISMO contrato que `assertSelfHostsEnv()` de este archivo, que ya
 * devuelve `string | null` para exactamente este uso.
 */
export function contractingDepthMaxWarning(): string | null {
  const raw = process.env[DEPTH_MAX_ENV];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const common =
    `El gateway esta usando el DEFAULT DEL CODIGO (${DEFAULT_CONTRACTING_DEPTH_MAX}), ` +
    `no el numero que configuraste. Rango aceptado: enteros de ` +
    `${DEPTH_MAX_ENV_FLOOR} a ${DEPTH_MAX_ENV_CEILING}. Ver .env.example.`;

  if (!DECIMAL_1_TO_3_DIGITS.test(trimmed)) {
    return (
      `${DEPTH_MAX_ENV} esta SETEADA pero es ILEGIBLE ("${trimmed}"). ` +
      'Fail-closed al default es deliberado (un techo que se cae a "sin limite" ' +
      `seria el guard apagado), pero el valor que pusiste no esta haciendo nada. ${common}`
    );
  }
  const value = digitsToInt(trimmed);
  if (value < DEPTH_MAX_ENV_FLOOR) {
    return (
      `${DEPTH_MAX_ENV}=0 NO SE OBEDECE, a proposito. Con techo 0 se rechazaria ` +
      'el 100% DEL TRAFICO: un caller directo tiene profundidad 0 y el corte es ' +
      '`depth >= techo`. En este repo un 0 significa SIN LIMITE en las formas ' +
      'vecinas (maxBudget, el ceiling de exposicion), asi que un 0 aca es casi ' +
      'siempre alguien pidiendo "sin tope" y apagando el money-path entero. ' +
      'Para apagar el servicio no es por aca: se apaga el deploy. ' +
      `Si querias el ajuste mas restrictivo util, es 1. ${common}`
    );
  }
  if (value > DEPTH_MAX_ENV_CEILING) {
    return (
      `${DEPTH_MAX_ENV}=${value} supera el tope de ${DEPTH_MAX_ENV_CEILING} ` +
      '(un techo enorme es un techo apagado, y el costo del bucle crece x5 por ' +
      `nivel). ${common}`
    );
  }
  return null;
}

/**
 * Tope de caracteres del header de cadena, en función del techo.
 * `min((253+1) × (depthMax+1), 4096)`. Con `depthMax=2` ⇒ **762**.
 *
 * Se evalúa **ANTES del `split`** (CD-16) para no materializar un arreglo grande a
 * pedido de un tercero: misma clase que `previewDeclaredMaxLimit`
 * (`discovery-fetch-limit.ts:81-90`), donde lo que se acota es lo que un tercero
 * puede hacernos construir.
 */
function chainHeaderMaxChars(depthMax: number): number {
  return Math.min(
    (MAX_HOSTNAME_CHARS + 1) * (depthMax + 1),
    CHAIN_HEADER_ABSOLUTE_MAX_CHARS,
  );
}

export type ContractingHeaderVerdict =
  | { ok: true; chain: string[]; depth: number }
  | { ok: false; code: typeof CONTRACTING_LOOP_DETECTED; layer: 'chain' }
  | {
      ok: false;
      code: typeof CONTRACTING_DEPTH_EXCEEDED;
      depth: number;
      depthMax: number;
    }
  | { ok: false; code: typeof CONTRACTING_DEPTH_MALFORMED }
  | { ok: false; code: typeof CONTRACTING_CHAIN_MALFORMED; reason: string };

/**
 * Los SEIS pasos de validación del inbound, **en este orden**, que es normativo
 * (CD-16). Cada paso existe por un input hostil concreto:
 *
 *  1 · LARGO del header de cadena ≤ `chainHeaderMaxChars(depthMax)` (762 con
 *      techo 2). Input: un header de **8192 caracteres**. Va **ANTES del `split`**:
 *      si el largo se chequea después, ya materializamos el arreglo que el
 *      atacante pidió.
 *  2 · CANTIDAD de elementos ≤ `depthMax + 1`. Input: **400 elementos válidos de
 *      5 caracteres**, que pasan el paso 1 y no deben pasar.
 *  3 · FORMA: `canonicalizeHost(e) !== null` para TODOS. Input: un elemento basura
 *      al lado de los válidos, que es la forma de meter ruido para que un lector
 *      laxo pierda NUESTRO eslabón. **Se rechaza, NO se ignora.**
 *  4 · PROFUNDIDAD: ausente ⇒ 0; `^[0-9]{1,3}$` ⇒ valor; cualquier otra cosa ⇒
 *      RECHAZO. Los 8 valores medidos están en el docblock del archivo.
 *  5 · MEMBRESÍA: `selfHosts ∩ elementos ≠ ∅` ⇒ bucle. Input:
 *      `otro-gw, <SELF>., tercero` (mayúsculas Y punto final).
 *  6 · TECHO: `depth >= depthMax`. Con `>` en vez de `>=` pasa exactamente el
 *      nivel del techo.
 *
 * Los pasos 1-4 son rechazos **seguros**: un header forjado sólo puede hacer
 * fallar LA PETICIÓN QUE LO TRAE. No hay forma de usarlos contra un tercero.
 *
 * Cada elemento se `trim`ea antes de canonicalizar, a propósito: un CSV con
 * espacios (`"a.example, b.example"`) es interop normal, y trimear NO debilita
 * nada — un atacante que escriba `" <self>"` para esconder nuestro eslabón queda
 * cazado por MEMBRESÍA en vez de por FORMA, o sea rechazado igual.
 */
export function readInboundContracting(
  h: {
    chain: string | string[] | undefined;
    depth: string | string[] | undefined;
  },
  selfHosts: string[],
  depthMax: number,
): ContractingHeaderVerdict {
  const rawChain = pickSingleHeader(h.chain);
  const rawDepth = pickSingleHeader(h.depth);

  // ── PASO 1 · LARGO, antes del `split` (CD-16) ──────────────────────────
  if (
    rawChain !== undefined &&
    rawChain.length > chainHeaderMaxChars(depthMax)
  ) {
    return {
      ok: false,
      code: CONTRACTING_CHAIN_MALFORMED,
      reason: `el header excede ${chainHeaderMaxChars(depthMax)} caracteres`,
    };
  }

  const rawElements =
    rawChain === undefined || rawChain.trim().length === 0
      ? []
      : rawChain.split(',');

  // ── PASO 2 · CANTIDAD ──────────────────────────────────────────────────
  if (rawElements.length > depthMax + 1) {
    return {
      ok: false,
      code: CONTRACTING_CHAIN_MALFORMED,
      reason: `la cadena trae ${rawElements.length} eslabones y el maximo es ${depthMax + 1}`,
    };
  }

  // ── PASO 3 · FORMA ─────────────────────────────────────────────────────
  const chain: string[] = [];
  for (const element of rawElements) {
    const canonical = canonicalizeHost(element.trim());
    if (canonical === null) {
      return {
        ok: false,
        code: CONTRACTING_CHAIN_MALFORMED,
        reason: 'un eslabon de la cadena no es un hostname legible',
      };
    }
    chain.push(canonical);
  }

  // ── PASO 4 · PROFUNDIDAD (CD-14: ni parseInt ni Number) ────────────────
  let depth = 0;
  if (rawDepth !== undefined) {
    if (!DECIMAL_1_TO_3_DIGITS.test(rawDepth)) {
      return { ok: false, code: CONTRACTING_DEPTH_MALFORMED };
    }
    depth = digitsToInt(rawDepth);
  }

  // ── PASO 5 · MEMBRESÍA ─────────────────────────────────────────────────
  for (const link of chain) {
    if (selfHosts.includes(link)) {
      return { ok: false, code: CONTRACTING_LOOP_DETECTED, layer: 'chain' };
    }
  }

  // ── PASO 6 · TECHO ─────────────────────────────────────────────────────
  if (depth >= depthMax) {
    return { ok: false, code: CONTRACTING_DEPTH_EXCEEDED, depth, depthMax };
  }

  return { ok: true, chain, depth };
}

/**
 * El campo `contractingGuard` de `GET /health`. Aditivo y SIN valores sensibles:
 * sale la CANTIDAD de hosts propios, nunca los hosts.
 *
 * ⚠️ VIVE ACÁ, Y NO INLINE EN EL HANDLER, porque `/health` está DUPLICADO: el
 * handler de `src/index.ts` está replicado en `src/__tests__/e2e/setup.ts` (ese
 * módulo hace `await initAdapters()` a nivel de módulo, así que no se puede
 * importar desde un test). Dos objetos literales escritos a mano divergen apenas
 * alguien toque uno; con una función, el e2e verifica EL MISMO campo que sirve
 * prod.
 *
 * Para qué sirve el dato: es la única forma de confirmar DESPUÉS del deploy si
 * `BASE_URL` / `A2A_SELF_HOSTS` quedaron efectivamente puestas — desde afuera no
 * se puede distinguir (NC-1) — y de eso depende si la capa 1 cubre los alias
 * propios o sólo el `Host` por el que entró cada petición.
 *
 * `source: 'request-only'` NO es un error: es información. Dice que el conjunto
 * derivado de la configuración está vacío y que lo único que sostiene la identidad
 * es el `Host` entrante.
 */
export function readContractingGuardHealth(): {
  selfHostCount: number;
  depthMax: number;
  source: 'env' | 'request-only';
} {
  const { hosts } = resolveSelfHosts();
  return {
    selfHostCount: hosts.length,
    depthMax: resolveContractingDepthMax(),
    source: hosts.length > 0 ? 'env' : 'request-only',
  };
}

/** Los cuatro códigos que este módulo puede emitir. */
export type ContractingErrorCode =
  | typeof CONTRACTING_LOOP_DETECTED
  | typeof CONTRACTING_DEPTH_EXCEEDED
  | typeof CONTRACTING_DEPTH_MALFORMED
  | typeof CONTRACTING_CHAIN_MALFORMED;

/**
 * CD-19 — UN texto por código, para que el `error` en prosa no divergea entre las
 * tres superficies que lo emiten (preHandler de capa 2, Sitio 1 del route, y el
 * `errorCode` del resultado del pipeline).
 *
 * El del bucle **no afirma que el transitivo esté cerrado**: la nota best-effort
 * la agrega el call-site de la capa 2 desde
 * `CONTRACTING_LAYER2_BEST_EFFORT_NOTE`, que es una constante aparte justamente
 * para que se pueda assertar textual.
 */
export function contractingErrorMessage(code: ContractingErrorCode): string {
  switch (code) {
    case CONTRACTING_LOOP_DETECTED:
      return (
        'Bucle de contratacion: el destino de este paso es este mismo gateway. ' +
        'La peticion se rechaza SIN cobrar y sin emitir la invocacion saliente.'
      );
    case CONTRACTING_DEPTH_EXCEEDED:
      return (
        'Techo de profundidad de contratacion alcanzado. El techo acota el COSTO ' +
        'de una cadena de coordinadores; no es una deteccion de ciclo. La ' +
        'peticion se rechaza sin cobrar.'
      );
    case CONTRACTING_DEPTH_MALFORMED:
      return (
        `El header ${CONTRACTING_DEPTH_HEADER} esta presente pero no es un ` +
        'entero decimal de 1 a 3 digitos. Un valor ilegible NO se degrada a 0: ' +
        'leerlo como 0 seria un reseteo del contador de profundidad a pedido de ' +
        'un tercero. La peticion se rechaza sin cobrar.'
      );
    case CONTRACTING_CHAIN_MALFORMED:
      return (
        `El header ${CONTRACTING_CHAIN_HEADER} esta presente pero no es un CSV ` +
        'de hostnames pelados dentro de los limites de largo y de cantidad. La ' +
        'peticion se rechaza sin cobrar.'
      );
  }
}

/**
 * CAPA 1 — ¿este destino somos nosotros?
 *
 * Compara **sólo el `hostname`**, a propósito: puerto y esquema se IGNORAN, así
 * que `https://yo:8443/x` y `http://yo/x` **siguen siendo yo**. Ignorarlos es la
 * dirección fail-closed (rechaza más, nunca menos); comparar `url.host` (que
 * lleva el puerto) dejaría pasar `https://<self>:8443/compose`.
 *
 * `url` vacío/ilegible ⇒ `false` **y NO tira**. Es un estado que producción no
 * puede producir (`Agent.invokeUrl` es requerido) pero que un factory de
 * `vi.mock` sí (medido: `src/middleware/x402.non-evm-inbound.test.ts:143-147`
 * devuelve `{slug, registry, payment}` sin `invokeUrl`). Un `throw` acá rompería
 * suites por un motivo que no es el de esta HU; el call-site loguea `warn`.
 *
 * Conjunto vacío ⇒ `false`: el guard **no puede inventar identidad**. Ese caso lo
 * cubre el `warn` de arranque, no un rechazo indiscriminado.
 */
export function isSelfDestination(
  url: string | undefined,
  selfHosts: string[],
): boolean {
  if (url === undefined || url.trim().length === 0) return false;
  if (selfHosts.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // `canonicalizeHost` sobre el `hostname` cierra las DOS puntas del punto final
  // (CD-15): el conjunto ya viene canonicalizado y el destino se canonicaliza acá.
  const host = canonicalizeHost(parsed.hostname);
  if (host === null) return false;
  return selfHosts.includes(host);
}

/**
 * AC-11 (W4) — ¿el ejecutor de este step declaró un fee de orquestación propio?
 *
 * **UNA definición, DOS direcciones**: lee exactamente el sobre que NOSOTROS
 * emitimos en el 200 de `/compose` (`protocolFeeStatus` + `protocolFeeUsdc`). Que
 * sea el mismo par de claves en las dos puntas es lo que hace que dos gateways
 * WasiAI encadenados se entiendan sin configuración, y que este lector no pueda
 * quedar desalineado del emisor sin que se note.
 *
 * ⛔ EL FEE AJENO SE **LEE**, NO SE ESTIMA. No hay forma de calcular el fee de otro
 * coordinador desde acá: su tasa es suya. Si no lo declara, el dato NO EXISTE.
 *
 * Los tres casos, y por qué el primero es el que preserva AC-8 para el 100% del
 * tráfico de hoy:
 *  · **sin `protocolFeeStatus`** ⇒ `undefined` ⇒ el campo queda AUSENTE del
 *    `StepResult`. Los 25 agentes descubribles en prod no emiten ese campo, así que
 *    ésta es la rama por la que pasa todo el tráfico existente y la respuesta queda
 *    byte-idéntica.
 *  · **`'charged'` + monto finito, `> 0` y `<= COORDINATOR_FEE_MAX_USDC`** ⇒
 *    `{ declared: true, usdc }`.
 *  · **`protocolFeeStatus` presente, cualquier otro caso** ⇒ `{ declared: false }`.
 *
 * ⛔ **NUNCA `usdc: 0`** (CD-5). "No lo declaró" no es "cobró cero": un cero
 * fabricado es una afirmación falsa con formato de dato, y aguas arriba se sumaría a
 * un rollup como si fuera información. El tercer valor es explícito.
 *
 * `> 0` y no `>= 0` a propósito: un coordinador que declara `charged` con monto 0 se
 * está contradiciendo, y la lectura honesta de una contradicción es "declaró algo que
 * no puedo usar" (`declared: false`), no "cobró cero".
 *
 * ─── POR QUÉ EL ARGUMENTO ES `unknown` Y NO `Record<string, unknown>` ───────
 * Fix-pack AR/BLQ-MED-2. El único call-site lo alimenta con
 * `(await response.json()) as Record<string, unknown>` (`services/compose.ts`), y
 * ese `as` es una PROMESA A `tsc`, NO UN HECHO: el body lo escribe un tercero y
 * `JSON.parse` devuelve felizmente un escalar. Medido:
 *
 *     'protocolFeeStatus' in 'plain-string'   ⇒  TypeError   (NO `false`)
 *     'x' in 42 · 'x' in true · 'x' in null   ⇒  TypeError
 *
 * El `in` **tira** sobre un primitivo. Y el throw no muere acá: lo agarra el catch
 * per-step de `execute()`, que corre **DESPUÉS** del `budgetService.debit` de ese
 * step ⇒ el caller queda **cobrado por un step que ahora falla**, con un body que
 * en el árbol base funcionaba. Por eso el tipo de entrada es el que el dato
 * realmente tiene (`unknown`) y el guard es de RUNTIME.
 *
 * `typeof x === 'object' && x !== null` y nada más: `typeof null === 'object'` (el
 * bug histórico del lenguaje) y `null` también hace tirar al `in`. Un array pasa
 * el guard —`typeof [] === 'object'` y el `in` no tira sobre arrays— y cae por la
 * vía normal: no trae `protocolFeeStatus` ⇒ `undefined`. Testigo: `T-U-FEE-5`.
 *
 * ─── EL TECHO DEL MONTO (fix-pack AR/BLQ-BAJO-1) ────────────────────────────
 * `Number.isFinite` sola no alcanza: `1e300` es finito y **lo escribe un tercero**.
 * Ver `COORDINATOR_FEE_MAX_USDC` para la derivación. Un monto por encima del techo
 * NO es un error del lector: es un coordinador declarando algo que no se puede
 * usar, así que cae en el MISMO tercer valor que ya existe (`declared: false`) y no
 * en un `undefined` —que significaría "no es un coordinador"— ni en un recorte
 * silencioso al techo, que sería publicar un número que nadie declaró.
 */
export function readCoordinatorFee(
  raw: unknown,
): undefined | { declared: true; usdc: number } | { declared: false } {
  if (typeof raw !== 'object' || raw === null) return undefined;
  if (!('protocolFeeStatus' in raw)) return undefined;
  const envelope = raw as Record<string, unknown>;
  const status = envelope.protocolFeeStatus;
  const amount = envelope.protocolFeeUsdc;
  if (
    status === 'charged' &&
    typeof amount === 'number' &&
    Number.isFinite(amount) &&
    amount > 0 &&
    amount <= COORDINATOR_FEE_MAX_USDC
  ) {
    return { declared: true, usdc: amount };
  }
  return { declared: false };
}

/**
 * AC-11 (W4) — el ROLL-UP del fee en cascada de un pipeline.
 *
 * Función pura sobre los `coordinatorFee` de los steps. Tres call-sites (el 200 de
 * `/compose`, el de `/orchestrate` atómico y el de `/orchestrate/execute`) para que
 * las tres superficies no puedan calcularlo distinto.
 *
 * `{}` cuando NINGÚN step fue un coordinador ⇒ los dos campos quedan AUSENTES ⇒
 * respuesta byte-idéntica para el 100% del tráfico de hoy (AC-8).
 *
 * `'partial'` ⟺ hubo al menos un coordinador que NO declaró su monto. Es el tercer
 * valor de CD-5 a nivel de pipeline: sin él, un total que le falta un sumando se
 * leería como un total completo.
 *
 * ─── LAS DOS FORMAS EN QUE ESTO FABRICABA UN NÚMERO (fix-pack AR/BLQ-BAJO-1) ──
 * Los montos los controla un TERCERO, y con eso se llegaba a dos publicaciones
 * falsas. Medido en `71fdaf7`:
 *
 *  1 · **El cero fabricado con status "estoy seguro"**:
 *      `rollUpCascadedFee([{declared:true, usdc:1e-9}])` ⇒
 *      `{cascadedOrchestrationFeeUsdc: 0, status:'complete'}`. El monto era > 0 y
 *      declarado, pero `Number((1e-9).toFixed(6)) === 0` (medido). Publicar ese 0
 *      dice "los coordinadores no cobraron nada", que es justo la afirmación que
 *      CD-5 prohíbe fabricar — y encima con `complete`, o sea sin margen de duda.
 *  2 · **`Infinity` publicado como `null`**: dos montos enormes ⇒ `sum` infinito, y
 *      `JSON.stringify({a: Infinity})` da `{"a":null}` (medido). Un `null` en un
 *      campo de plata es indistinguible de "no aplica".
 *
 * La regla ahora es una sola y cubre las dos: **si el número que se iba a publicar
 * no es un número utilizable, se OMITE y queda sólo el status**. Omitir es el tercer
 * valor que este archivo ya usa en todos lados; publicar un 0 o un `null` es
 * inventar. El `status` se conserva porque SÍ se sabe: hubo cascada.
 *
 * `(1)` ya no se puede alcanzar desde producción —el techo de
 * `COORDINATOR_FEE_MAX_USDC` no lo evita, un monto chiquito es legítimo— así que el
 * caso vive acá. `(2)` sí quedó inalcanzable vía `readCoordinatorFee`, pero esta
 * función es pura y exportada: no confía en su llamador.
 *
 * ⚠️ CÓMO SE LEE EL RESULTADO, incluida la combinación nueva:
 *   los dos campos ausentes        ⇒ ningún step fue un coordinador (AC-8).
 *   status + monto                 ⇒ eso se cobró en cascada.
 *   status `partial` sin monto     ⇒ hubo cascada y NINGUNO declaró cuánto.
 *   status `complete` SIN monto    ⇒ todos declararon, y el total es > 0 pero está
 *                                    por DEBAJO de la resolución publicada (1e-6).
 *                                    NO es cero: es "más chico de lo que este campo
 *                                    puede expresar".
 */
export function rollUpCascadedFee(
  fees: ReadonlyArray<
    { declared: true; usdc: number } | { declared: false } | undefined
  >,
):
  | Record<string, never>
  | {
      cascadedOrchestrationFeeUsdc?: number;
      cascadedOrchestrationFeeStatus: 'complete' | 'partial';
    } {
  const present = fees.filter((f) => f !== undefined);
  if (present.length === 0) return {};
  let sum = 0;
  let anyUndeclared = false;
  for (const fee of present) {
    if (fee.declared) sum += fee.usdc;
    else anyUndeclared = true;
  }
  const status = anyUndeclared ? ('partial' as const) : ('complete' as const);
  // El número que SE IBA a publicar, calculado antes de decidir si se publica.
  const rounded = Number.isFinite(sum) ? Number(sum.toFixed(6)) : Number.NaN;
  // Las TRES razones para omitirlo, todas con la misma consecuencia: se publica el
  // status y NO un número inventado.
  //  · nadie declaró monto ⇒ no hay suma que publicar;
  //  · la suma no es finita ⇒ `JSON.stringify` la sacaría como `null`;
  //  · el redondeo a 6 decimales la lleva a 0 ⇒ publicar 0 afirmaría "no cobraron
  //    nada" sobre montos que SÍ fueron declarados y son > 0.
  if (!Number.isFinite(rounded) || rounded === 0) {
    return { cascadedOrchestrationFeeStatus: status };
  }
  return {
    cascadedOrchestrationFeeUsdc: rounded,
    cascadedOrchestrationFeeStatus: status,
  };
}

/**
 * AC-7 — los headers que salen en cada invocación a un agente.
 *
 * Devuelve `{}` si `canonicalId` es `null` (CD-18). Emitir una cadena SIN nuestro
 * eslabón es **peor que no emitir nada**: el siguiente gateway leería una traza
 * que afirma NO CONTENERNOS, o sea que le estaríamos dando una razón para seguir.
 * El call-site loguea `warn` una vez por invocación en ese caso.
 *
 * La profundidad sale **incrementada**: lo que emitimos es la profundidad DEL
 * SALTO QUE ESTAMOS HACIENDO, no la que recibimos.
 */
export function buildOutboundContractingHeaders(
  chain: string[],
  depth: number,
  canonicalId: string | null,
): Record<string, string> {
  if (canonicalId === null) return {};
  return {
    [CONTRACTING_CHAIN_HEADER]: [...chain, canonicalId].join(','),
    [CONTRACTING_DEPTH_HEADER]: String(depth + 1),
  };
}
