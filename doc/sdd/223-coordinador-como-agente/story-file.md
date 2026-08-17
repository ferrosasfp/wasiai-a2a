# Story File — WKH-360 / `223-coordinador-como-agente`

> **Contrato autocontenido para F3. Todo lo que necesitás está acá. NO hace falta abrir el SDD.**
> Fuentes: `doc/sdd/223-coordinador-como-agente/sdd.md` (1359 líneas) + `work-item.md` (373 líneas,
> 12 AC, 8 DT, 10 CD) + los `auto-blindaje.md` de `220`, `221` y `222`.
>
> **Todos los números y todos los `archivo:línea` de este documento se RE-DERIVARON en `3823580`
> durante F2.5, corriendo el comando, no copiándolos del SDD.** Donde el SDD y el árbol no
> coinciden, **manda el árbol** y está dicho en **§16** — no está tapado.
>
> | Campo | Valor |
> |---|---|
> | HU | WKH-360 · carpeta `223-coordinador-como-agente` · fila `doc/sdd/_INDEX.md:215` |
> | Repo | `/home/ferdev/.openclaw/workspace/wasiai-a2a` — ⛔ **NADA de `chaski-v3` ni de los `wt-*`** |
> | Rama | `feat/223-wkh-360-coordinador-agente` — ⚠️ **NO EXISTE, la creás vos** (§9.0) |
> | Base | `3823580` (`main`) · working tree limpio salvo el `sdd.md` sin trackear de esta HU |
> | Gate | `SPEC_APPROVED` dado el 2026-08-17 (gate clínico). F2.5 no reabre ningún AC ni ningún CD |
> | Tipo | feature · **money-path** · QUALITY · SDD_MODE full |
> | Baseline **corrido por F2.5** en `3823580` | `Test Files 280 passed \| 6 skipped (286)` · `Tests 5441 passed \| 19 skipped (5460)` · `suite_exit=0` · `tsc --noEmit` **exit 0** · `test/ownership-filter-guard.test.ts` **13 passed (13)** |
> | Prod medido hoy (2026-08-17) | `POST /discover {}` → `total 25`; hosts `wasiai-v2.vercel.app` (22) + `wasiai-remittance-agents.vercel.app` (3); **0 apuntan al gateway**. `GET /.well-known/agent.json` → **9 claves**, `authentication.schemes: []` |

---

## 0 · Las diez cosas que no se pueden perder

Si sólo leés una sección, que sea ésta. Cada punto tiene su lugar operativo más abajo.

1. **EL GUARD DE CAPA 1 VA EN CUATRO SITIOS, NO EN UNO.** Y **tres** de los cuatro son guards de
   dinero. El work-item decía "antes del débito (`compose.ts:545-573`)", que es **correcto para los
   steps 1..N y FALSO para el step 0**: el step 0 de `/compose` lo debita el **middleware**
   (`src/middleware/a2a-key.ts:1222` / `:1231`, montado en `src/routes/compose.ts:867`), que corre
   **antes de que `composeService` exista**; y el step 0 de `/orchestrate` lo debita el **service**
   (`src/services/orchestrate.ts:1149`) antes de llamar a compose (`:1213`). Los cuatro sitios y su
   punto de inserción exacto: **§4**.
2. **El orden corte-antes-del-débito es la MITAD del valor de la HU. Cada sitio lleva su test de
   ORDEN, no sólo de resultado.** "Rechaza con 400" no prueba nada: hay que asertar **cero llamadas**
   a `budgetService.debit` y **cero** a `ssrfFetch`. Tres mutantes (`MUT-01/02/03`) existen sólo para
   eso: mueven el guard **debajo** del débito y tienen que morir. §4.5 y §11.
3. **El Sitio 4 (`invokeAgent`) NO es un guard de dinero y está PROHIBIDO presentarlo como tal**
   (CD-17). Corre después del débito de `src/services/compose.ts:545-553`: si dispara, ya se cobró.
   Su comentario tiene que decirlo, su log es **`error`** (no `warn`), y su test es de ORDEN. §4.4.
4. **La validación del header entrante tiene un ORDEN NORMATIVO de seis pasos** y el `split` va
   **DESPUÉS** del techo de largo (CD-16). Cada paso existe por un input hostil **medido**: `'1e9'`
   que `parseInt` lee como **1**, `''` que `Number` lee como **0** (reseteo del contador), 8 KB antes
   del split. La tabla completa con las mediciones de hoy: **§5**.
5. **PROHIBIDO leer la profundidad con `parseInt` o con `Number`** (CD-14). Sólo `^[0-9]{1,3}$`. Y
   **presente-pero-ilegible se RECHAZA**, nunca se degrada a 0.
6. **CD-1: la única bandera admisible es una allow-list vacía por default.** Un `=== 'true'` con
   default OFF **shippea el guard apagado** — y ésa es la convención por default del repo
   (`.nexus/project-context.md:252-268`), así que aplicarla sin pensar es el error natural. **Esta HU
   no shippea NINGUNA bandera** (§6, `T-FLAG-1`).
7. **CD-6: el best-effort de la Capa 2 va declarado en el BODY del error**, no sólo en un comentario.
   El texto es **una constante del leaf** (`CONTRACTING_LAYER2_BEST_EFFORT_NOTE`) para que el mensaje
   que emite el código y el que asserta el test no puedan divergir.
8. **AC-8 tiene un NÚMERO, no una promesa: 0 de 25.** Los 25 agentes descubribles en prod
   (medido hoy, §1.3) salen de `wasiai-v2.vercel.app` (22) y `wasiai-remittance-agents.vercel.app`
   (3): **cero** apuntan al host del gateway. El caso legítimo tiene que quedar **byte-idéntico**, y
   cada test de corte tiene su **gemelo positivo** (CD-7).
9. **AC-9: la Capa 1 no consulta NINGÚN header del caller.** Un request sin ningún header de
   contratación se rechaza igual si el destino es propio (`T-L1-6`). Auto-inmunidad = BLOQUEANTE.
10. **PROHIBIDO reusar `canonicalizeHostKey` de `src/lib/self-published-auth.ts:89-105` para la
    identidad del guard.** Su docblock (`:82`) afirma que deja el host *"sin punto final"* y **es
    falso**, medido: `new URL('https://EXAMPLE.com./x').hostname === 'example.com.'`. Reusarla
    creyendo el comentario deja un bypass de una tecla. Se **reescribe** en el leaf, con el strip
    explícito. §3.2 y §16.11.

---

## 1 · Contexto compacto

### 1.1 · Qué se construye y por qué

El gateway ya publica su propia Agent Card A2A en `GET /.well-known/agent.json`
(`src/routes/well-known.ts:9-17`) y la embebe en `/capabilities`
(`src/routes/capabilities.ts:33`). El deck ya publicó la tesis: *"el coordinador es, a su vez, un
agente A2A: cualquier plataforma puede contratar el pipeline completo como un solo agente"*. Faltan
tres cosas, y la del medio mueve plata:

1. **La carta existe y no dice cómo contratarla.** 9 claves, `authentication.schemes: []`
   (`src/services/agent-card.ts:228-230`), sin precio ni endpoint por skill. Medido en prod hoy.
2. **No existe ningún guard anti-bucle.** El único control sobre el destino de una invocación mira
   **rangos de IP** (`isBlockedAddress`, `src/lib/ssrf-dispatcher.ts:99`; revalidación pre-fetch en
   `src/services/compose.ts:1489-1503`). La URL pública del gateway resuelve a una IP **pública**:
   contratarse a sí mismo pasa ese guard sin tocarlo. Y el invoke outbound **no emite** header de
   profundidad ni de traza (`src/services/compose.ts:1424-1431`): el dato con el que un guard
   transitivo podría decidir **no existe, hay que crearlo**.
3. **El fee en cascada es invisible en `/compose`.** Lo dice el propio código
   (`src/routes/compose.ts:1050-1053`) y la respuesta es `reply.send({ kiteTxHash, ...result })`
   (`:1127`), mientras `/orchestrate/plan` sí declara `protocolFeeUsdc` / `feeRatePercent`
   (`src/routes/orchestrate.ts:439-440`).

### 1.2 · ⛔ El límite del alcance, escrito en tu cara

**Lo que esta HU NO cierra, y afirmar lo contrario es violación:**

- ⛔ **NO cierra el bucle transitivo contra un adversario.** La Capa 2 depende de que la contraparte
  reenvíe los headers. Contra alguien que los borra a propósito lo que queda en pie es la **Capa 1**
  y los techos. **PROHIBIDO escribir "bucle transitivo cerrado" a secas** (CD-6): ni en el código, ni
  en un comentario, ni en el commit message, ni en el `auto-blindaje.md`, ni en el resumen al
  orquestador.
- ⛔ **NO cierra el bypass por IP literal.** `https://69.46.46.64/compose` **no matchea** por nombre.
  Es **R-3, residual declarado, no cerrado** (§13). Escribirlo como cerrado es violación.
- ⛔ **NO afirma que hoy haya un drenaje de fondos en curso.** Lo medido es que el guard **no existe**
  y que la ruta al bucle está abierta. Lo que hoy frena el caso directo es **accidental**: el bearer
  del caller sólo se reenvía si el registry es system-trusted
  (`src/services/compose.ts:1445-1448`, `ownerRef === SYSTEM_OWNER_REF`). *Acotar no es cerrar*, y
  tampoco es "hay pérdida hoy".
- ⛔ **NO se publica el gateway en su propio `/discover`** (DT-1). El motivo es mecánico antes que de
  neutralidad: como fila del catálogo, `/compose` podría elegirlo por ranking y `/orchestrate` desde
  el planner, o sea que el catálogo propio **fabricaría** el bucle que esta HU corta.
- ⛔ **NO se construye un publicador automático en catálogos externos** (DT-2). W3 entrega la carta
  completa y el **procedimiento escrito**. NC-4 sigue abierto (§13).
- ⛔ **NO se toca el modelo de fees.** El fee sobre fee es legítimo: esta HU lo hace **visible**.

### 1.3 · La línea base, medida por F2.5 (no heredada)

```
commit                3823580   (HEAD == base; branch main; tree limpio salvo el sdd.md sin trackear)
tsc --noEmit          exit 0
ownership guard       Test Files 1 passed (1) · Tests 13 passed (13)
suite completa        Test Files 280 passed | 6 skipped (286)
                      Tests 5441 passed | 19 skipped (5460)   · suite_exit=0
prod /.well-known     9 claves · authentication.schemes: [] · url https://wasiai-a2a-production.up.railway.app
prod POST /discover   total=25 · wasiai-v2.vercel.app (22) · wasiai-remittance-agents.vercel.app (3)
                      · gateway: 0
```

Reproducción exacta en **§15**. ⚠️ **`suite_exit=0` se lee de `cmd; rc=$?`, NUNCA de `cmd | tail`**
(CD-13): el pipe mide el exit de `tail`, y el wrapper `rtk` de este shell **corrompe la salida
redirigida con exit 0**. Los dos empujan al verde falso. Y `grep` acá está reescrito a `rtk grep`,
que **deforma la salida**: usá `/usr/bin/grep` o `command grep` para todo lo que sea evidencia.

---

## 2 · Los 12 Acceptance Criteria (textuales) y su mapa

Se heredan **sin reabrirse**.

| AC | Texto (abreviado, el normativo es el del work-item) | Wave | Tests |
|---|---|---|---|
| **AC-1** | `GET /.well-known/agent.json` declara, además de lo de hoy: (a) **precio** de cada skill contratable **o la forma de obtenerlo**, (b) **esquema(s) de auth/pago** aceptados (hoy `[]`), (c) **endpoint concreto** por skill. Sigue **gratis y sin rate-limit** (`src/routes/well-known.ts:11`, `config: { rateLimit: false }`) | W3 | `T-CARD-1/2/3` |
| **AC-2** | La carta se construye desde **una sola** función (`buildSelfAgentCard`) y `/capabilities` **sigue derivando** de ella (`src/routes/capabilities.ts:33`, `:64-72`), sin segunda expresión | W3 | `T-CARD-3/4` |
| **AC-3** | IF un dato nuevo no se resuelve en runtime → **OMITIR el campo**; nunca `0`, `null` ni placeholder (patrón de `src/services/agent-card.ts:169-190`) | W3 | `T-CARD-5/6` |
| **AC-4** | Bucle **DIRECTO**: destino resuelto ∈ identidad propia ⇒ rechazo **antes del débito** (`src/services/compose.ts:545-553`), **antes** de cualquier settle downstream (`:1555`), con `errorCode` propio y estable, y **sin emitir** la petición HTTP (`:1516`) | W1 | `T-L1-1..7` |
| **AC-5** | Bucle **TRANSITIVO**: traza entrante que ya nos contiene ⇒ **mismo `errorCode`** que AC-4, antes de cobrar | W2 | `T-L2-1/2/3`, `T-CHAIN-1/2` |
| **AC-6** | Techo de profundidad: `depth >= techo` ⇒ rechazo antes de cobrar. Techo ausente **o ilegible** ⇒ **default del código**, y "ilegible" **NO** es "sin techo" (fail-closed) | W2 | `T-DEPTH-1..6` |
| **AC-7** | Propagación: al invocar un agente, emitir la cadena de contratación y la profundidad **incrementada** (hoy el invoke sólo emite `Content-Type`, credenciales y condicionalmente `x-a2a-key`) | W2 | `T-PROP-1/2/3` |
| **AC-8** | Caso legítimo **byte-idéntico**: mismo status, mismo body, mismo cobro, misma cantidad de settles. Cubre (a) un coordinador **externo** contratándonos y (b) nosotros contratando agentes normales, **incluido un pipeline de `MAX_COMPOSE_STEPS`** | W1–W4 | `T-L1+1/+2/+3`, `T-L2+1/+2`, `T-FEE-6/7` |
| **AC-9** | **Sin auto-inmunidad**: AC-4 no exige cooperación de la contraparte. La cooperación es necesaria **sólo** para el transitivo, y esa limitación queda escrita **en el código y en la respuesta de error** | W1/W2 | `T-L1-6`, `T-L2-2` |
| **AC-10** | `/compose` 200 declara de forma **aditiva** el fee de protocolo de **este** gateway | W4 | `T-FEE-1/2/3` |
| **AC-11** | Fee de orquestación **ajeno** expuesto por separado. Si el agente no lo declara ⇒ **marcado como no declarado**, nunca `0` | W4 | `T-FEE-4/5/6` |
| **AC-12** | Los campos de AC-10/AC-11 son **estrictamente aditivos** en las dos respuestas | W4 | `T-FEE-7` |

---

## 3 · Contratos exactos (el código que sí va literal)

### 3.1 · `src/lib/contracting-chain.ts` — **NUEVO, módulo leaf, CERO imports**

**Por qué leaf, medido y no supuesto**: lo van a consumir un route, dos services y un middleware, y
**63 archivos de test mockean `../adapters/registry.js`** con factories sin `importOriginal`; el
mismo hazard con `../services/discovery.js` ya rompió 12 y 84 tests en otra HU
(`src/lib/discovery-fetch-limit.ts:1-11` lo documenta). Precedentes de leaf en este repo:
`src/lib/compose-limits.ts` (38 líneas), `src/lib/discovery-fetch-limit.ts`,
`src/lib/downstream-skip-code.ts`.

**Regla del leaf**: `process.env` **SÍ** se lee acá (es global, no un import) — igual que
`src/lib/self-published-auth.ts:115` y `src/lib/discovery-fetch-limit.ts:75`. Lo que **NO** va:
ningún `import` de otro módulo del repo, ningún logging (los call-sites loguean) y ninguna decisión
de dinero.

Superficie exportada **exacta** (esto es el contrato; no lo renombres):

```ts
export const CONTRACTING_CHAIN_HEADER = 'x-a2a-contracting-chain';
export const CONTRACTING_DEPTH_HEADER = 'x-a2a-contracting-depth';
export const SELF_HOSTS_ENV = 'A2A_SELF_HOSTS';
export const DEPTH_MAX_ENV = 'A2A_CONTRACTING_DEPTH_MAX';

/** CD-6/CD-19: UN solo texto, consumido por el body del error, por la carta y por los tests. */
export const CONTRACTING_LAYER2_BEST_EFFORT_NOTE: string;

/** CD-19: UN solo string por código. Se consumen desde las DOS superficies (§8). */
export const CONTRACTING_LOOP_DETECTED = 'CONTRACTING_LOOP_DETECTED';
export const CONTRACTING_DEPTH_EXCEEDED = 'CONTRACTING_DEPTH_EXCEEDED';
export const CONTRACTING_DEPTH_MALFORMED = 'CONTRACTING_DEPTH_MALFORMED';
export const CONTRACTING_CHAIN_MALFORMED = 'CONTRACTING_CHAIN_MALFORMED';

/** Default del techo. Derivado con números en §5.3, NO elegido. */
export const DEFAULT_CONTRACTING_DEPTH_MAX = 2;

export function canonicalizeHost(raw: string): string | null;
export function resolveSelfHosts(hint?: string): { hosts: string[]; canonicalId: string | null };
export function classifySelfHostsEnv():
  | { state: 'absent' }
  | { state: 'configured'; hosts: string[] }
  | { state: 'invalid'; reason: string };
/** Igual que `assertDepositMinimumEnv` (`src/lib/env.ts:107-131`): throw si inválida, texto de warn si ausente, null si OK. */
export function assertSelfHostsEnv(): string | null;
export function resolveContractingDepthMax(): number;          // fail-closed al default del código
export function isContractingDepthMaxMisconfigured(): boolean;  // para el log de arranque

export type ContractingHeaderVerdict =
  | { ok: true; chain: string[]; depth: number }
  | { ok: false; code: typeof CONTRACTING_LOOP_DETECTED; layer: 'chain' }
  | { ok: false; code: typeof CONTRACTING_DEPTH_EXCEEDED; depth: number; depthMax: number }
  | { ok: false; code: typeof CONTRACTING_DEPTH_MALFORMED }
  | { ok: false; code: typeof CONTRACTING_CHAIN_MALFORMED; reason: string };

/** Los seis pasos de §5, en ese orden. */
export function readInboundContracting(
  h: { chain: string | string[] | undefined; depth: string | string[] | undefined },
  selfHosts: string[],
  depthMax: number,
): ContractingHeaderVerdict;

/** Capa 1. `url` vacío/ilegible ⇒ `false` + el caller loguea (§4.1, TRAMPA 1). */
export function isSelfDestination(url: string | undefined, selfHosts: string[]): boolean;

/** AC-7. `{}` si `canonicalId` es null (CD-18: nunca una traza sin nuestro eslabón). */
export function buildOutboundContractingHeaders(
  chain: string[], depth: number, canonicalId: string | null,
): Record<string, string>;

/** AC-11, W4. UNA definición, dos direcciones (lee lo que nosotros escribimos). */
export function readCoordinatorFee(raw: Record<string, unknown>):
  | undefined                                   // sin `protocolFeeStatus` ⇒ no es coordinador
  | { declared: true; usdc: number }
  | { declared: false };
```

**Docblock obligatorio del archivo** (esto es contenido, no adorno): por qué es leaf; la tabla de §5.1
(los 8 valores de profundidad medidos); la medición del punto final (`new URL('https://EXAMPLE.com./x').hostname
=== 'example.com.'`) **con el commit al lado**; y la derivación numérica del techo de §5.3.

### 3.2 · `canonicalizeHost` — y por qué NO se importa la que ya existe

```
canonicalizeHost(raw):
  1. si raw.trim() !== raw  ó  raw.length === 0            → null
  2. si raw incluye '/', '@' o ':'                          → null   (esquema, userinfo, puerto, IPv6)
  3. parsed = new URL('https://' + raw)   (catch → null)
  4. si parsed.port !== '' ó username/password !== ''       → null
  5. si pathname !== '/' ó search !== '' ó hash !== ''      → null
  6. h = parsed.hostname ; si h.length === 0                → null
  7. ⚠️ si h termina en '.'  →  h = h.slice(0, -1)          ← EL PASO QUE NO EXISTE HOY (CD-15)
  8. return h
```

Los pasos 1-6 son `canonicalizeHostKey` de `src/lib/self-published-auth.ts:89-105`, **verbatim en
comportamiento**. El **paso 7 es nuevo y es el punto de la HU**.

⛔ **PROHIBIDO importar `canonicalizeHostKey`** (además de que ese módulo **no es leaf**):

- su docblock, `src/lib/self-published-auth.ts:82`, afirma que produce el host *"(minúsculas,
  punycode, **sin punto final**)"* y **es falso**. Medido hoy: `new URL('https://EXAMPLE.com./x').hostname`
  devuelve `'example.com.'` — el punto final **sobrevive**;
- es exactamente **la frase que haría que alguien reuse esa función creyendo que ya normaliza**, y en
  el guard de identidad eso es un bypass de una tecla;
- ese over-claim queda **reportado como MENOR fuera de scope** (NC-6, §13). ⛔ **No lo arregles acá**:
  ese archivo está en el camino de credenciales y no es del Scope IN.

**Comparación por `hostname`, a propósito**: puerto y esquema se **ignoran**. `https://yo:8443/x` y
`http://yo/x` **siguen siendo yo**. Ignorarlos es la dirección fail-closed (rechaza más, nunca menos).
Mutante `MUT-07` (comparar `url.host`, con puerto) tiene que morir.

### 3.3 · `resolveSelfHosts(hint?)` — el conjunto de identidad

```
hosts = ∅
if (process.env.BASE_URL)   hosts ∪= { canonicalizeHost(hostname(BASE_URL)) }
hosts ∪= { canonicalizeHost(h) : h ∈ split(process.env.A2A_SELF_HOSTS, ',') }
if (hint)                   hosts ∪= { canonicalizeHost(hint) }
canonicalId = primer elemento en ese ORDEN (BASE_URL → primer A2A_SELF_HOSTS → hint), o null
```

**Por qué NO se usa `resolveBaseUrl` (`src/services/agent-card.ts:67-76`) como fuente única**, tres
motivos medidos:

1. sus ramas 2 y 3 dependen de headers del caller (`x-forwarded-proto` y `request.hostname`, que es
   el `Host` o el `X-Forwarded-Host` con `trustProxy` activo). Una identidad que el caller puede
   mover es una identidad que el caller puede **vaciar**;
2. **necesita un `FastifyRequest`**, y el loop de `executePipeline` no lo tiene: recibe un
   `ComposeRequest` (`src/types/index.ts:989`) que no lo lleva;
3. está importado en **4 archivos de producción** y **ninguno** es del camino de compose/orchestrate
   (`src/services/agent-card.ts`, `src/routes/capabilities.ts`, `src/routes/agent-card.ts`,
   `src/routes/well-known.ts` — medido con `/usr/bin/grep -rln resolveBaseUrl src/`).

**Por qué el `hint` del request es admisible aunque el caller lo influya** — leelo, porque es lo que
el AR va a atacar: el conjunto se usa **únicamente como predicado de negación**. Agrandarlo sólo
puede producir **más rechazos**, nunca menos. Un caller que mande `Host: victima-agente.com` logra
que el gateway **se niegue** a llamar a `victima-agente.com` **en su propio request**: es un auto-DoS
de una petición, no un bypass. **Esa monotonía es la propiedad**, y va escrita en el docblock.

**Por qué el `hint` hace falta**: sin él, un deploy sin `BASE_URL` ni `A2A_SELF_HOSTS` tiene conjunto
**vacío** y la Capa 1 queda **inerte** — el escenario que CD-1 prohíbe. Con el `hint`, el caso común
del bucle (el caller le pega a `https://gw/compose` y el step apunta a `https://gw/...`) se corta
**sin ninguna configuración**.

**`canonicalId` no lleva env nueva.** Un `A2A_GATEWAY_ID` suelto sería un **cuarto** lugar donde
"quién soy" puede divergir; derivarlo es lo que garantiza que la traza que emitimos sea comparable
con el conjunto que comparamos. (Este repo ya se rompió por tener dos lectores de un mismo concepto:
`src/lib/agent-category.ts` se extrajo por eso.)

### 3.4 · Estado de la configuración: dos niveles + publicado en `/health`

Patrón exacto de `src/lib/env.ts:107-131` (`assertDepositMinimumEnv`):

- **Presente-pero-ilegible ⇒ THROW en el arranque, en cualquier `NODE_ENV`.** `A2A_SELF_HOSTS='https://gw'`
  (con esquema) o con una entrada duplicada es el caso en el que el operador **cree** tener la
  identidad puesta. `T-ENV-1`.
- **Conjunto env VACÍO ⇒ `log.warn` ruidoso al arrancar**, con el texto que dice qué queda cubierto
  (el `hint` por request) y qué no (los alias que no son el host por el que entró la petición).
  **NO THROW**: no se pudo verificar el valor de `BASE_URL` en el Railway de prod (NC-1, §13) y
  voltear el servicio por eso es un radio de explosión mayor que el problema. `T-ENV-2`.
- **`GET /health` publica el estado** (aditivo, sin valores sensibles):
  `contractingGuard: { selfHostCount: n, depthMax: d, source: 'env' | 'request-only' }`.
  Un host no es un secreto — `POST /discover` ya publica el `invokeUrl` de los 25 agentes.
  Precedentes en el mismo handler: `...getStrandedHealthField()` (`src/index.ts:253`, HU-306,
  `.nexus/project-context.md:426`) y `solanaPayoutRoute` (`:264`).

⚠️ **`/health` NO vive en `src/routes/`**: está registrado **inline** en `src/index.ts:236-266`.
🔴 **Y está DUPLICADO**: `src/__tests__/e2e/setup.ts:341-358` replica el handler, y el propio código
lo advierte en `src/index.ts:250-252` (*"La MISMA línea está en `src/__tests__/e2e/setup.ts`, que
duplica este handler porque este módulo hace `await initAdapters()` a nivel de módulo"*). **El campo
va en LOS DOS**, o el e2e afirma un `/health` que no es el de prod. El SDD no lo dice; medido en F2.5.

### 3.5 · Campos nuevos del `ComposeRequest` y del `StepResult`

```ts
// ComposeRequest (src/types/index.ts:989) — ADITIVOS, poblados por el preHandler de la Capa 2
contractingChain?: string[] | undefined;
contractingDepth?: number | undefined;

// StepResult (src/types/index.ts:1144) — ADITIVO (AC-11)
coordinatorFee?: { declared: true; usdc: number } | { declared: false } | undefined;

// ComposeResult.errorCode (src/types/index.ts:1091) — de 3 valores a 5
errorCode?: 'SCOPE_DENIED' | 'DEST_CAP_EXCEEDED' | 'INPUT_MAPPING_FAILED'
          | 'CONTRACTING_LOOP_DETECTED' | 'CONTRACTING_DEPTH_EXCEEDED';
```

⚠️ **Todo lo que viva en el `ComposeResult` SALE POR HTTP.** No es una suposición: lo declara el
docstring de `src/types/index.ts:1027-1030` — *"Los dos routes hacen `reply.send({ …, ...result })`
sin schema de respuesta, así que TODO lo que viva en el resultado sale por HTTP al caller"*. Por eso
la cadena y la profundidad van en el **REQUEST** (nunca en el resultado) y `coordinatorFee` es
público **a propósito** (AC-11). ⛔ **No agregues nada más al `ComposeResult`.**

**Los dos `errorCode` nuevos NO agregan rama de status.** Caen en el `default` de `let status = 400`
(`src/routes/compose.ts:1026-1031`), exactamente como `INPUT_MAPPING_FAILED`
(`src/types/index.ts:1086-1090`). ⛔ **PROHIBIDO estrenar `508 Loop Detected`**: agrega una rama de
status y un código que ningún cliente de este ecosistema maneja, por cero información que el
`errorCode` no dé.

### 3.6 · Extensión de `resolveAgentDestination` — 🔴 y su TRAMPA de tsc

`src/services/agent-price.ts:105-115` ya resuelve el `Agent` **completo** y **descarta** el
`invokeUrl` en el `return` de `:114`. Se extiende:

```ts
// src/services/agent-price.ts:105-115
export async function resolveAgentDestination(
  agentSlug: string,
  registryName?: string,
): Promise<{ registry: string; slug: string; invokeUrl: string } | null> {
  // ...
  return { registry: agent.registry, slug: agent.slug, invokeUrl: agent.invokeUrl };
}
```

`Agent.invokeUrl` es **requerido** (`src/types/index.ts` → `interface Agent` en `:374`), así que en
producción **siempre** está poblado. Un call-site de producción (`src/routes/compose.ts:729-732`),
cero llamadas nuevas a discovery, cero cambios en `deriveComposeDestination`
(`src/routes/compose.ts:66-75`, parámetro estructural `{registry, slug}`: una propiedad de más en un
objeto **no literal** no dispara excess-property check).

🔴 **TRAMPA MEDIDA EN F2.5 (el SDD no la tiene): tres mocks TIPADOS rompen `tsc` si el campo es
requerido.** Hay que editarlos **en W1**, en el mismo commit:

| Archivo:línea | Hoy devuelve | Qué agregar |
|---|---|---|
| `src/routes/compose.test.ts:416-419` | `{ registry: 'wasiai', slug: 'myagent' }` | `invokeUrl: 'https://agente-ajeno.example/run'` |
| `src/routes/compose.no-debit-on-abort.test.ts:241-244` | `{ registry: 'wasiai', slug: 'free-but-real' }` | idem, host **ajeno** |
| `src/__tests__/e2e/compose-flow.test.ts:230` | `{ registry: 'wasiai', slug: 'kyc' }` | idem, host **ajeno** |

Y **una cuarta que NO rompe tsc pero SÍ el runtime**: `src/middleware/x402.non-evm-inbound.test.ts:143-147`
es un **factory de `vi.mock`** (no está type-checked) que devuelve `{slug, registry, payment}` **sin
`invokeUrl`**. Por eso `isSelfDestination` recibe `string | undefined` y con `undefined` devuelve
`false` **sin tirar**, y el call-site loguea a `warn` (§4.1, TRAMPA 1).

⚠️ **CD-22 aplica de lleno acá**: estás tocando fixtures que otros tests usan como discriminante. Un
refixture **apaga un testigo sin poner nada en rojo** (dos instancias medidas en WKH-345,
`222-…/auto-blindaje.md:196-250`). Después de editar esos 4 archivos: **re-corré la suite completa** y
**re-contá los rojos de `MUT-02`**.

Los otros 10 sitios que mockean `resolveAgentDestination` devuelven `null` o son factories con
`mockResolvedValue(null)` y **no requieren cambio**: `compose.capability.test.ts:51`,
`compose.field-mapping.test.ts:53`/`:195`, `compose.no-charge-on-validation-error.test.ts:78`/`:436`/`:807`,
`compose.no-debit-on-abort.test.ts:62`/`:178`/`:214`, `compose.downstream-skips.test.ts:71`,
`compose.fee.test.ts:79`, `compose.test.ts:126`, `e2e/compose-flow.test.ts:91`.

### 3.7 · La firma de `invokeAgent` — 6.º parámetro OPCIONAL, no negociable

`src/services/compose.ts:1373-1396` es **posicional** con 5 parámetros
(`agent, input, a2aKey?, logger?, intentId?`). Se agrega un **6.º opcional**:

```ts
contracting?: { chain: string[]; depth: number; canonicalId: string | null },
```

**Tiene que ser opcional**: medido, hay **33 call-sites de test en 4 archivos** que la llaman con 2 ó
3 argumentos (`compose.ssrf.test.ts` ×4, `compose.selfpublished-auth.test.ts` ×9,
`compose.test.ts` ×11, `compose.outbound-legs.test.ts` ×9). Hacerlo requerido rompe los 33.
Los **2 call-sites de producción** (`src/services/compose.ts:618-624` y `:969-975`) lo pasan.

---

## 4 · Los CUATRO sitios del guard de Capa 1 (M-1 convertido en trabajo)

**Tres son guards de dinero. El cuarto NO, y decirlo es obligatorio.** Cada uno corta **antes de un
débito distinto**, y por eso ninguno reemplaza a otro.

```
   petición entrante   ┌─────────────────────────────────────────────┐
   /compose            │ preHandler NUEVO (Capa 2, inbound)          │ ← AC-5/AC-6, W2
   /orchestrate*       │  traza me contiene → LOOP                   │   ANTES de todo
                       │  depth >= techo    → DEPTH_EXCEEDED         │
                       │  header ilegible   → *_MALFORMED            │
                       └──────────────┬──────────────────────────────┘
   /compose            ┌──────────────▼──────────────────────────────┐
   sólo                │ SITIO 1 · resolveComposePriceHandler        │ ← AC-4 step 0, W1
                       │  (routes/compose.ts, tras :735)             │   💰 ANTES del middleware
                       └──────────────┬──────────────────────────────┘
                       ┌──────────────▼──────────────────────────────┐
                       │ requirePaymentOrA2AKey  ← EL DÉBITO         │   a2a-key.ts:1222/:1231
                       └──────────────┬──────────────────────────────┘
   /orchestrate*       ┌──────────────▼──────────────────────────────┐
   sólo                │ SITIO 2 · executeApprovedPlan, tras el cap  │ ← AC-4 step 0, W1
                       │  (services/orchestrate.ts, tras :1115)      │   💰 ANTES de :1149
                       └──────────────┬──────────────────────────────┘
                       ┌──────────────▼──────────────────────────────┐
                       │ SITIO 3 · loop de executePipeline, por step  │ ← AC-4 steps 1..N, W1
                       │  (services/compose.ts, tras :376)           │   💰 ANTES de :545
                       └──────────────┬──────────────────────────────┘
                       ┌──────────────▼──────────────────────────────┐
                       │ SITIO 4 · invokeAgent, pre-fetch            │ ← bloqueo de EMISIÓN, W1
                       │  (services/compose.ts, tras :1503)          │   ⛔ NO es guard de dinero
                       └─────────────────────────────────────────────┘
```

### 4.1 · SITIO 1 — `/compose`, step 0 · 💰 el que el work-item no tenía

**Archivo**: `src/routes/compose.ts`, dentro de `resolveComposePriceHandler` (def en `:688-838`).
**Punto exacto**: **inmediatamente después de `:735`** (el cierre de
`const composeDestination = resolved ? deriveComposeDestination(resolved) : undefined;`) y **antes de
`:737`** (el guard `price === 0 && resolved === null`).

**Por qué ahí corta antes del dinero**: este handler está en el array de preHandlers en `:866`, y
`...requirePaymentOrA2AKey(` está en **`:867`** — **después**. El array completo es `:845-885`.
El idiom para abortar es el que este archivo ya usa **tres veces**: `return reply.status(...).send(...)`
(`:719-722`, `:756-759`, `:833-836`), y el propio código explica por qué funciona
(`:715-718`: *"para abortar el preHandler lifecycle ANTES del middleware de debit"*).

```ts
// tras :735
if (resolved && isSelfDestination(resolved.invokeUrl, selfHosts)) {
  return reply.status(400).send({
    error: '...',                                  // texto del leaf
    error_code: CONTRACTING_LOOP_DETECTED,
    layer: 'direct',
  });
}
```

**Shape del body**: `error` + `error_code` (**snake**, familia 1 — §8) + `layer`. Los tres hermanos
de este mismo handler (`:719`, `:756`, `:833`) envían **sólo** `{error, error_code}`; no agregues
`requestId` acá para no divergir de ellos (`:923-928` sí lo lleva, pero ése es el route handler y usa
`code`, familia 2).

**El `selfHosts` de este sitio lleva `hint`**: `request.hostname` (el único sitio de los cuatro donde
hay un `FastifyRequest`). Los sitios 2/3/4 usan sólo el conjunto de env.

⛔ **PROHIBIDO poner el guard en `augmentX402ChallengeAmount`** (`src/routes/compose.ts:434`), aunque
ya recorra los steps 1..N pre-débito: sus **dos** call-sites lo envuelven en `.catch()`
(`:785-794` y `:815-820`). Un guard dentro de un bloque best-effort es un guard que se puede tragar.
Los steps 1..N los cubre el Sitio 3.

🔴 **TRAMPA 1 — `invokeUrl` undefined en runtime.** `isSelfDestination(undefined, …)` devuelve
`false` **y no tira**, y el call-site loguea `warn` con `{ slug }` (nunca la URL). Es un estado que
**producción no puede producir** (`Agent.invokeUrl: string` requerido) pero que un factory de
`vi.mock` sí (medido: `src/middleware/x402.non-evm-inbound.test.ts:143-147`). Un `throw` ahí rompería
suites por un motivo que no es el de la HU.

### 4.2 · SITIO 2 — `/orchestrate*`, todos los steps del plan · 💰

**Archivo**: `src/services/orchestrate.ts`, dentro de `executeApprovedPlan` (def en `:1061`).
**Punto exacto**: **inmediatamente después de `:1115`** (el cierre del cap gate) y **antes de `:1117`**
(el price-fallback).

**Por qué ahí**: el comentario que ya está en `:1099-1100` declara ese punto textualmente —
*"Cap gate (AC-3/AC-4/AC-5) — ANTES del price-fallback y de cualquier `budgetService.debit` o
`composeService.compose`"*. El guard nuevo se para exactamente ahí, o sea **antes de
`budgetService.debit` de `:1149`** (bloque `:1132-1157`) y antes de `composeService.compose` de
`:1213`.

**Cubre las TRES rutas de orchestrate** porque las tres desembocan acá **y** las tres apagan el
débito del middleware con `markSkipMiddlewareDebitHandler` (def `:71-75`; en el array en
`src/routes/orchestrate.ts:146`, `:288`, `:515`): en orchestrate **el único débito del step 0 es el
del service**.

**De dónde sale el `invokeUrl` acá**: se llama la **MISMA** `resolveAgentDestination` del Sitio 1,
**por step**. ⛔ **PROHIBIDO cruzar `plan.discoveredAgents` (`src/types/index.ts:1398`) contra
`plan.steps[i].agent` a mano**: sería una segunda expresión de la resolución y divergiría en
`/orchestrate/execute`, donde los steps vienen del body del cliente. Costo: N lookups con cache de
60 s (`src/services/agent-price.ts:16`) — y en `/execute` ese lookup **ya ocurre** dentro de
`quoteMaxCostUsdc` (`src/services/orchestrate.ts:1012`, llamada en `:1103-1106`).

**Forma del corte**: `executeApprovedPlan` no tiene `reply`. Devuelve por el canal que ese método ya
usa para los cortes pre-débito — el mismo patrón del `__quoteStale` de `:1109-1113` — y el route lo
mapea a 400 con `error_code` (familia 1, como `src/routes/orchestrate.ts:564` y `:806`).

### 4.3 · SITIO 3 — el loop del pipeline, steps 1..N · 💰 (y anti-drift del preflight)

**Archivo**: `src/services/compose.ts`, dentro del `for` de `:334`.
**Punto exacto**: **inmediatamente después de `:376`** (el cierre del bloque de scoping `:351-376`) y
**antes de `:377`** (el comentario WKH-305 que precede a `resolveStepInput` de `:400`).

Tres razones para ese punto, las tres **leídas del comentario que ya está ahí** (`:377-399`):

- el débito per-step está en `:545-553`, muy abajo ⇒ CD-3 satisfecho con margen;
- `getStepGasOverheadUsd` (`:433`) **LANZA** en mainnet sin configurar, así que un bucle no puede
  reportarse como un error de gas;
- la autorización va primero (doctrina escrita en `:385-386`): un caller sin scope recibe
  `SCOPE_DENIED` (403, `:366`) y no un error de bucle. Los dos rechazan antes de cobrar, así que el
  orden entre ellos no es una decisión de dinero.

Cubre el happy-path (`invokeAgent` en `:617-624`) **y el retry adaptativo** (`:968-975`) porque los
dos están dentro de la misma iteración.

**Forma del corte**: `return { success: false, output: null, steps: results, totalCostUsdc: totalCost,
totalLatencyMs: totalLatency, error: '...', errorCode: CONTRACTING_LOOP_DETECTED }` — copiando la
forma del `SCOPE_DENIED` de `:359-374`. Acá el nombre de la clave es **`errorCode` (camel)**, familia 3.

**Este sitio es AUTORITATIVO aunque los Sitios 1 y 2 ya hayan pasado**: el precio tiene cache de 60 s
y el catálogo puede cambiar entre el preflight y la ejecución. Un destino que era ajeno cuando se
cotizó puede ser propio cuando se ejecuta.

### 4.4 · SITIO 4 — `invokeAgent`, pre-fetch · ⛔ NO es guard de dinero (CD-17)

**Archivo**: `src/services/compose.ts`, **después del `catch` del SSRF que cierra en `:1503`** y
**antes de `ssrfFetch` (`:1516-1520`)**.

AC-4 exige que **no se emita la petición HTTP saliente**, y `:1516` es el **único `ssrfFetch` de
invocación de agentes de todo `src/`** (los otros son de discovery y de dos tools MCP): es el
choke-point.

**Y es exactamente el sitio equivocado para el dinero**: un throw acá lo agarra el catch per-step, o
sea **después** del débito de `:545-553`, cuyo reembolso es **best-effort** (`refundStepDebit`,
`:704`). Por lo tanto, y esto es CD-17:

- su comentario dice, en el código, que **éste NO es el guard de CD-3** sino el bloqueo de emisión de
  último recurso;
- si dispara, loguea a **`error`** (no `warn`) con un mensaje que dice que el guard pre-débito **no
  corrió** y que hay residuo con reembolso best-effort;
- `T-L1-7` fija el ORDEN con el Sitio 3 stubeado a no-op.

⛔ **PROHIBIDO** que ningún comentario, log, test name, commit message o resumen presente el Sitio 4
como el guard que satisface AC-4/CD-3.

### 4.5 · El test de ORDEN, por sitio (esto es la mitad del valor de la HU)

| Sitio | Débito que tiene por delante | Qué asserta el test de orden | Mutante |
|---|---|---|---|
| 1 | `src/middleware/a2a-key.ts:1222`/`:1231` vía `routes/compose.ts:867` | `budgetService.debit` **0 llamadas** | `MUT-02` |
| 2 | `src/services/orchestrate.ts:1149` | `budgetService.debit` **0 llamadas** | `MUT-03` |
| 3 | `src/services/compose.ts:545` | `debit` llamado **exactamente i veces** (los steps previos), **no** la i+1; `ssrfFetch` **no** llamado para ese step | `MUT-01` |
| 4 | ninguno (ya se debitó) | `ssrfFetch` **0 llamadas** + se logueó a **`error`** | borrar el Sitio 4 |

⛔ **Un test que sólo asserta el 400 NO cumple.** El veredicto del AR sobre CD-3 se juega acá.

---

## 5 · La Capa 2: el contrato del header y su orden de validación

### 5.1 · Los dos headers

Familia `x-a2a-*`, que en este repo es la de **protocolo A2A** (`x-a2a-key`, `x-a2a-nonce`,
`x-a2a-signature`, `x-a2a-timestamp`, `x-a2a-payment-chain`, `x-a2a-remaining-budget`), a diferencia
de `x-wasiai-*`, que es interno. Otro coordinador tiene que poder hablar esto.

| Header | Forma | Ausente significa |
|---|---|---|
| `x-a2a-contracting-chain` | CSV de hostnames canónicos, en orden de contratación | cadena vacía |
| `x-a2a-contracting-depth` | entero decimal, `^[0-9]{1,3}$` | **0** |

**Lectura**: patrón `pick` de `src/middleware/a2a-key.ts:187-195` — `typeof h === 'string' ? h : undefined`.
Un header repetido llega como `string[]` y **eso es `undefined`**, o sea ausente.

**Ausente = 0 / vacío NO es una concesión**: es el **100% del tráfico de hoy**, y tratarlo como
rechazo rompe todos los callers (CD-2). Lo que **no** puede tratarse como ausencia es
**presente-pero-ilegible**, porque ahí el reseteo del contador **es el ataque**, no un accidente.

### 5.2 · Los seis pasos, EN ESTE ORDEN (CD-16, normativo)

| # | Paso | Rechazo | El input hostil que lo justifica (medido hoy) |
|---|---|---|---|
| **1** | **Largo** del header de cadena ≤ `min((253+1) × (depthMax+1), 4096)`. Con `depthMax=2` ⇒ **762** | `CONTRACTING_CHAIN_MALFORMED` | un header de **8192 caracteres**. Va **ANTES del `split`** para no materializar un arreglo grande a pedido de un tercero (misma clase que `previewDeclaredMaxLimit`, `src/lib/discovery-fetch-limit.ts:81-90`) |
| **2** | **Cantidad** de elementos ≤ `depthMax + 1` | idem | **400 elementos válidos** de 5 caracteres: pasa el paso 1 y no debe pasar |
| **3** | **Forma**: `canonicalizeHost(e) !== null` para **todos** | idem | un elemento basura al lado de los válidos es la forma de meter ruido para que un lector laxo pierda el nuestro. **Se rechaza, NO se ignora** |
| **4** | **Profundidad**: ausente ⇒ 0; `^[0-9]{1,3}$` ⇒ valor; **cualquier otra cosa ⇒ rechazo** | `CONTRACTING_DEPTH_MALFORMED` | los 6 valores de la tabla de abajo |
| **5** | **Membresía**: `selfHosts ∩ elementos ≠ ∅` | `CONTRACTING_LOOP_DETECTED` + `layer:'chain'` | `x-a2a-contracting-chain: otro-gw, <SELF>., tercero` (mayúsculas **y** punto final) |
| **6** | **Techo**: `depth >= depthMax` | `CONTRACTING_DEPTH_EXCEEDED` | `>` en vez de `>=` deja pasar exactamente el nivel del techo |

Los pasos 1-4 son rechazos **seguros**: un header forjado sólo puede hacer fallar **la petición que
lo trae**. No hay forma de usarlos contra un tercero.

**Los 8 valores de profundidad, medidos hoy con `node -e`** (esta tabla va al docblock del leaf):

| Valor | `parseInt(v,10)` | `Number(v)` | `^[0-9]{1,3}$` | Qué hace el diseño |
|---|---|---|---|---|
| ausente | — | — | — | **0** (caller directo; el 100% del tráfico de hoy) |
| `'0'`…`'999'` | igual | igual | ✅ | valor |
| `'1e9'` | **`1`** ⚠️ | `1000000000` | ❌ | **RECHAZO** |
| `''` | `NaN` | **`0`** ⚠️ | ❌ | **RECHAZO** (como 0 sería un **reseteo del contador**) |
| `' 2'` | **`2`** ⚠️ | `2` | ❌ | **RECHAZO** |
| `'2abc'` | **`2`** ⚠️ | `NaN` | ❌ | **RECHAZO** |
| `'0x10'` | `0` | `16` | ❌ | **RECHAZO** |
| `'1000'` | `1000` | `1000` | ❌ | **RECHAZO por forma**, antes de comparar |

Las cuatro filas con ⚠️ son la razón de CD-14. Tres de ellas producen un número **plausible y menor
al techo**: el modo de falla no es un error, es **un guard que aplaude**.

### 5.3 · El techo: `A2A_CONTRACTING_DEPTH_MAX`, default **2** derivado con números

`^[0-9]{1,3}$` en `[0, 64]`. Ausente **o ilegible** ⇒ **el default del código**, jamás `Infinity`
(patrón de `src/lib/discovery-fetch-limit.ts:74-79` y de `readPipelineCeilingUsd`,
`src/lib/stranded-payment.ts:351-356`), **más** un `warn` al arrancar cuando el valor es ilegible
(porque un techo que cae al default en silencio es el caso en que el operador cree tener otro número).

El costo de un bucle **no es lineal en la profundidad: es exponencial con base `MAX_COMPOSE_STEPS`**.
Datos medidos: fan-out por nivel = `MAX_COMPOSE_STEPS = 5` (`src/lib/compose-limits.ts:38`); peor
caso del débito por step = `PLACEHOLDER_FEE_USD = 1.0` (`src/lib/pricing-constants.ts:16`); gas
overhead = **0** en testnet y sin env (`src/services/compose.ts:433`) y **no hay ninguna red mainnet
inicializada** (`.nexus/project-context.md:154`); techo de exposición por pipeline **se entrega sin
configurar** ⇒ `+Infinity` (`src/lib/stranded-payment.ts:342-348`); `maxBudget: 0` o ausente sigue
significando **sin límite**.

Con techo `D` los débitos posibles son `Σ_{k=1..D} 5^k = (5^(D+1) − 5)/4`:

| `D` | peticiones a la app | débitos | peor caso USD | ¿cubre el caso del deck? |
|---|---|---|---|---|
| 1 | 6 | 5 | $5 | ❌ prohíbe que nos contrate un coordinador que a su vez contrate a otro |
| **2** | **31** | **30** | **$30** | ✅ plataforma → nosotros → otro coordinador → agentes |
| 3 | 156 | 155 | $155 | un nivel de más sin caso de uso |
| hoy (sin techo) | **sin cota** | sin cota | sólo lo frena el saldo de la key | — |

**Default = 2**: el número más chico que cubre la tesis publicada. Esta tabla va **pegada en
`.env.example`** para que subirlo sea una decisión con el número al lado (×5 por nivel).

⚠️ **Y el techo NO detecta ciclos: acota costo.** Los ciclos los detecta la traza (paso 5). El techo
existe para el ciclo que la traza **no puede ver** — el que pasa por un intermediario que no reenvía
los headers. **Confundir las dos cosas es el over-claim que CD-6 prohíbe.**

**Los otros techos NO frenan un bucle, y hay que saberlo para no apoyarse en ellos:**

- **El timeout no frena nada.** `createTimeoutHandler` (`src/middleware/timeout.ts:8-25`) hace un
  `setTimeout` que **manda un 504 y nada más**: no aborta el pipeline (el route lo asume, maneja
  `reply.sent` después de que compose terminó). Es la clase *"un techo hecho con `Promise.race` no
  frena el trabajo"*, acá sin ni siquiera el `race`. Un bucle sigue gastando después del 504.
- **El rate-limit acota y, con la config default, se lo cobra a los demás.** `orchestrateRateLimit()`
  (`src/middleware/rate-limit.ts:52-58`) es **10 / 60 s** (`.env.example:571`, `:573`), store **en
  proceso** (no hay Redis en este servicio), key `request.ip`; y `TRUST_PROXY` es **opt-in con
  default `false`** (`src/lib/env.ts:53`, `:55`), así que detrás del borde de Railway **todos los
  callers externos podrían compartir un bucket** — el problema que `src/lib/env.ts:30-37` ya
  documenta. ⚠️ **El valor de `TRUST_PROXY` en prod NO se pudo verificar** (NC-2, §13): esto se
  escribe con las dos lecturas y **no** como garantía.
- **`PIPELINE_EXPOSURE_CEILING_USD` y el `maxBudget` del caller no frenan nada hoy**: el primero se
  entrega apagado, el segundo tiene `0`/ausente = sin límite.

### 5.4 · AC-7 · La emisión, y qué NO se toca

En `src/services/compose.ts:1424-1431`, las dos claves nuevas van **después de `Content-Type`** y
**ANTES del spread de las credenciales** (`...selfPublishedAuthHeaders` en `:1429`, `...authHeaders`
en `:1430`), para no poder pisar una credencial por accidente:

```ts
const headers: Record<string, string> = {
  'Content-Type': 'application/json',
  ...buildOutboundContractingHeaders(chain, depth, canonicalId),   // ← acá
  ...selfPublishedAuthHeaders,
  ...authHeaders,
};
```

- **Sin `canonicalId` NO se emite NINGUNO de los dos** (CD-18). Emitir una cadena sin nuestro eslabón
  es peor que no emitir nada: el siguiente gateway leería una traza que **afirma no contenernos**. Ese
  caso loguea `warn` una vez por invocación. `T-PROP-2`, `MUT-16`.
- **CD-4 intacto**: no se toca `validateRegistryUrl` (`:1490`), ni `ssrfFetch` (`:1516`), ni
  `isBlockedAddress`. El guard nuevo mira **identidad**; el viejo mira **rangos de IP**. Son
  ortogonales y se quedan separados.
- ⛔ **`src/lib/ssrf-dispatcher.ts` NO entra al Scope IN** (CD-23), y hay un motivo medido: sigue
  redirects a mano (`:417-481`) y sólo revalida SSRF por hop, así que un `invokeUrl` de tercero que
  responda `302 → https://<nosotros>/compose` **no lo ve la Capa 1**; pero `CREDENTIAL_HEADERS` son
  **4 nombres explícitos** (`:286-291`) y los nuestros **no están**, así que **la traza sobrevive el
  hop** y la Capa 2 lo caza en el inbound. Tocar ese archivo cambiaría además discovery y dos tools
  MCP, por cero ganancia.

### 5.5 · Los ataques de URL, medidos uno por uno

| Variante del destino | `new URL(...).hostname` | ¿matchea `gw.example.com`? | Cómo lo cierra el diseño |
|---|---|---|---|
| `https://GW.EXAMPLE.COM/compose` | `gw.example.com` | **sí** | gratis (`new URL` baja a minúsculas) |
| `https://gw.example.com./compose` | **`gw.example.com.`** | **NO** ⚠️ | el paso 7 de `canonicalizeHost` (CD-15) |
| `https://пример.рф/` vs `https://xn--e1afmkfd.xn--p1ai/` | los dos `xn--e1afmkfd.xn--p1ai` | **sí** | gratis (punycode) |
| `https://gw.example.com:8443/compose` | `gw.example.com` (`port='8443'`) | **sí** | se compara **sólo `hostname`** (§3.2) |
| `https://user:pw@gw.example.com/` | `gw.example.com` | **sí** | gratis (userinfo no entra al hostname) |
| `https://69.46.46.64/compose` (nuestra IP) | `69.46.46.64` | **NO** ⚠️ | **RESIDUAL DECLARADO, R-3, §13. NO se cierra acá** |
| `https://tercero.example/r` → `302 → https://gw/compose` | `tercero.example` al momento del guard | **NO** | lo caza la **Capa 2** vía la traza, que sobrevive el hop (§5.4) |

⚠️ **Que hoy Railway conteste 404 a la variante con punto final NO es un guard y no cuenta como
mitigación.** Medido: `…up.railway.app./health` → **404**, `…up.railway.app/health` → **200**. Eso es
política de ruteo por Host de un hosting, que cambia el día que se agrega un dominio propio o se
mueve el deploy. Es la clase *"lo que frena es accidental, no un guard"*.

---

## 6 · Constraint Directives, en forma operativa

Los **10 del work-item** se heredan íntegros. Los **13 del SDD** (CD-11..CD-23) también. Acá están
en forma de acción.

### OBLIGATORIO

- **CD-2 / AC-8 · el caso legítimo queda byte-idéntico.** Ni status, ni body, ni monto cobrado, ni
  cantidad de settles. El control es un pipeline completo sin recursión comparado contra la línea
  base (`T-L1+1`).
- **CD-3 · el corte ocurre antes de CUALQUIER movimiento de plata**, en los **tres** caminos de
  débito (§4.5). Un AR que encuentre el guard después del `debit` o después del
  `signAndSettleDownstream` marca **BLOQUEANTE** — aunque los otros sitios estén bien puestos.
- **CD-6 · la limitación de la Capa 2 va escrita en el código Y en el body del error.** El texto es
  `CONTRACTING_LAYER2_BEST_EFFORT_NOTE`, **constante del leaf**, así que el mensaje que emite el
  código y el que asserta el test **no pueden divergir** (`T-L2-2`).
- **CD-7 · cada AC de corte tiene su GEMELO POSITIVO.** Un test de rechazo sin su par que prueba que
  lo legítimo pasa no distingue "el guard funciona" de "rompí el endpoint". Los gemelos son
  `T-L1+1/+2/+3`, `T-L2+1/+2`, `T-FEE-6`, `T-CARD-4`.
- **CD-9 · sin hardcodes.** Ni la URL propia, ni los alias, ni el techo, ni ningún identificador de
  gateway. Todo por env, con default en el código y fail-closed ante valor ilegible.
- **CD-10 · TypeScript strict, sin `any` explícito**, y los campos nuevos de respuesta con el patrón
  `...(x !== undefined && { x })` — `exactOptionalPropertyTypes` está **activo** (`tsconfig.json`).
- **CD-11 · re-medir las citas que la propia wave desplazó.** Ver §7.
- **CD-12 · toda cifra, hash o consecuencia lleva el comando que la produjo y el commit del árbol.**
  Prueba de bolsillo antes de escribir una frase: *¿qué corrida la pone en rojo si deja de ser
  cierta?* Si la respuesta es "ninguna, porque acá está mockeado", la frase **no va**, o va
  **declarada como no medible**. ⛔ Ningún hash se escribe antes de existir (`git rev-parse` sobre
  cada uno).
- **CD-15 · quitar el punto final en las DOS puntas de la comparación** (§3.2).
- **CD-16 · el orden de validación de §5.2 es normativo**, con el `split` **después** del largo.
- **CD-17 · el Sitio 4 NO se presenta como el guard de CD-3** (§4.4): comentario que lo dice, log a
  **`error`**, y test de ORDEN.
- **CD-18 · nunca emitir la traza sin nuestro eslabón** (§5.4).
- **CD-19 · un `errorCode`/`error_code` = UNA constante del leaf**, consumida por las dos superficies
  (`T-CODE-1`).
- **CD-21 · reescribir, EN EL MISMO COMMIT, las prosas que esta HU vuelve falsas.** Concretamente
  `src/routes/compose.ts:1050-1053`, que afirma *"en compose (a diferencia de orchestrate) ningún
  campo de fee se serializa en el response"*. Control:
  `/usr/bin/grep -rn "ningún campo de fee" src/ doc/`.
- **CD-22 · una wave que cambia un fixture que otra usa como testigo RE-CUENTA los rojos del mutante
  correspondiente.** Aplica literalmente a los 4 fixtures de §3.6. Si un mutante da **un** rojo, ése
  es el **único testigo** y hay que escribirlo **en el testigo**, no sólo en el `.md`.

### PROHIBIDO

- ⛔ **CD-1 · que la Capa 1 quede detrás de una bandera con default OFF.** La convención del repo es
  `=== 'true'` estricto y default OFF (`.nexus/project-context.md:252-268`), y **aplicada acá sin
  pensar shippea el guard apagado**. La única bandera admisible sería una **allow-list de
  auto-contratación legítima, vacía por default = denegar**. **Esta HU NO shippea ninguna**: hoy no
  existe ningún caso legítimo de auto-contratación (0 de 25, §1.3), y shippear un knob sin caso de
  uso es shippear el knob que alguien va a llenar. Si aparece el caso, entra como **TD-360-1** con la
  forma que CD-1 prescribe. Control: `T-FLAG-1` (§10).
- ⛔ **CD-4 · sacar, debilitar o mover el guard SSRF existente** (`src/services/compose.ts:1489-1503`,
  `src/lib/ssrf-dispatcher.ts`). El guard nuevo es **aditivo y ortogonal**. Colapsarlos reabre el que
  ya está cerrado.
- ⛔ **CD-5 · emitir `0` donde el dato no se pudo obtener.** Ni en la carta, ni en el fee en cascada.
  Tercer valor explícito o campo **omitido**.
- ⛔ **CD-8 · tocar una query sobre una tabla con `owner_ref` sin su filtro.** Ver §12.
- ⛔ **CD-13 · adjudicar un veredicto con el exit code de un pipe.** Nunca `cmd | tail; echo $?` (mide
  `tail`), nunca redirección a través del wrapper `rtk` (corrompe con exit 0). Se usa `cmd; rc=$?`,
  `PIPESTATUS[0]`, `node ./node_modules/vitest/vitest.mjs run` y `./node_modules/.bin/tsc` a pelo.
  Para adjudicar un `archivo:línea`, la sonda imprime el **número pegado al texto** (`grep -n`,
  `awk 'NR==n{print NR": "$0}'`); ⛔ `sed -n 'Np;Mp'` imprime en **orden de ARCHIVO** y ya produjo un
  hallazgo falso.
- ⛔ **CD-14 · leer la profundidad con `parseInt` o `Number`** (§5.2).
- ⛔ **CD-20 · cerrar W3 sin haber medido el hazard del mock de `adapters/registry`** (§9, W3).
- ⛔ **CD-23 · tocar `src/lib/ssrf-dispatcher.ts`, `src/lib/url-validator.ts` y
  `src/lib/downstream-payment.ts`.** Los tres quedan fuera por medición (§5.4 para el primero; NC-3
  para el tercero).

---

## 7 · CD-11 · El protocolo de edición y de citas

**Los tres `auto-blindaje.md` DONE más recientes tienen el MISMO defecto**, así que ya no es
anécdota: **"mis propias ediciones corrieron las líneas que yo citaba"** —
`220-…/auto-blindaje.md:25-36`, `221-…:36-57`, `:128-160`, `:185-224`, `222-…:134-192`. En `221` el
mismo defecto volvió **dentro de su propia corrección**; en `222` un "fix declarado" arregló 2 de 6
citas y **apagó la sospecha** sobre las otras 4.

**El control que funciona no es cuidado. Es este, después de la ÚLTIMA edición de cada wave:**

```bash
BASE=3823580
for f in $(git diff --name-only $BASE); do
  echo "=== $f"; git diff -U0 $BASE -- "$f" | /usr/bin/grep '^@@'
done
```

Cada `@@` da el **punto de inserción** y el **delta**. Para **toda** cita al propio archivo con número
mayor a ese punto: re-medir comparando **CONTENIDO** (`HOY[n]` vs `BASE[n − delta]`), **nunca**
número. Si `delta neto == tamaño del archivo` ⇒ archivo 100% nuevo ⇒ no puede tener nada desplazado
(esa mitad es gratis).

**Edición LÍNEA-NEUTRA obligatoria** en cualquier bloque que tenga auto-citas. Los archivos de esta
HU con más citas entrantes hacia abajo, y por lo tanto los más caros de crecer en el medio:
`src/services/compose.ts` (1571 líneas), `src/routes/compose.ts` (1132),
`src/services/orchestrate.ts` (1540), `src/types/index.ts` (2107).

**El segundo patrón de las 3, y baja a CD-12**: *"escribí un número/hash/consecuencia que no medí,
con el mismo tono que los que sí medí"* — `220:38-48` (casi copié un conteo del CR), `221:98-124`
(tres afirmaciones infalsificables **dentro de su propio archivo**), `222:8-36` (copié del Story File
"la suite queda ciega" y **eran 13 rojos, 11 fuera**), `222:109-130` (**un hash de commit inventado
con forma correcta**), `222:254-290` (un mutante al que le cargó **2 rojos preexistentes**).

---

## 8 · La trampa de shape: este repo tiene TRES nombres de clave para el código de error

| Capa | Clave | Citas medidas | Cuándo |
|---|---|---|---|
| **preHandler · rechazo de dominio** | `error_code` (**snake**) | `src/routes/compose.ts:721`, `:758` (`AGENT_NOT_FOUND`), `:835` (`REGISTRY_UNAVAILABLE`); `src/routes/orchestrate.ts:564`, `:806` (`QUOTE_STALE`) | el pedido es válido en forma y el gateway lo rechaza |
| **preHandler · validación de forma** | `code` | `src/routes/compose.ts:144`, `:154`, `:925` (`VALIDATION_ERROR`), `:352`; `src/routes/orchestrate.ts:108` | el body está mal armado |
| **resultado del pipeline** | `errorCode` (**camel**) | `src/types/index.ts:1091`; serializado por el `...result` de `src/routes/compose.ts:1041-1044` y `:1127` | el pipeline arrancó y falló |

**Los guards nuevos usan `error_code`** (familia 1): un bucle de contratación es un rechazo de dominio
sobre un body bien formado, igual que `AGENT_NOT_FOUND`. ⛔ **NO `code`**, que en este repo señala
forma.

**Consecuencia inevitable, y va escrita**: el mismo bucle sale como `error_code` si lo caza un
preHandler (Sitios 1, 2 y la Capa 2) y como `errorCode` si lo caza el loop (Sitio 3). **No se unifica
acá** (sería rediseñar el shape de error global, Scope OUT explícito), pero **el STRING es una sola
constante del leaf** (CD-19) y `T-CODE-1` lo fija en las dos superficies: un cliente matchea **un
solo valor** aunque tenga que mirar dos claves.

---

## 9 · Waves

**Un commit por wave**, y **el criterio de salida corrido va en el mensaje del commit** (los números
reales, no "todo verde"). `W0` es serial. `W3` es paralelizable de verdad contra `W1`/`W2` (no
comparte ningún archivo). `W4` depende de `W2`.

### 9.0 · Antes de empezar

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
git rev-parse HEAD                      # tiene que dar 3823580  (⚠️ NO uses `git log --oneline`:
                                        #   el wrapper rtk FILTRA los merge commits)
git status --porcelain                  # sólo el sdd.md sin trackear de esta HU
git switch -c feat/223-wkh-360-coordinador-agente
```

**Y re-corré la línea base ANTES de escribir una línea** (§15, A-5). Si no da
`5441 passed | 19 skipped` y `exit 0`, **pará y avisá**: el árbol no es el que se especificó.

### Wave 0 — serial · el leaf, los tipos y el `.env.example`. **Cero comportamiento.**

| Archivo | Qué entra |
|---|---|
| `src/lib/contracting-chain.ts` | **NUEVO**. Toda la superficie de §3.1. **Cero imports.** Docblock con: por qué es leaf, la tabla de §5.2, la medición del punto final con su commit, y la derivación del techo de §5.3 |
| `src/lib/contracting-chain.test.ts` | **NUEVO**. Los 8 valores de profundidad, las 6 variantes de host, largo/conteo/forma de la cadena, el fail-closed del techo, la monotonía de `resolveSelfHosts` |
| `src/types/index.ts` | `ComposeResult.errorCode` **+2** valores (`:1091`); `StepResult.coordinatorFee?` (`:1144`); `AgentCard.contracting?` (`:1679`); `AgentSkill.endpoint?`/`pricing?` (`:1673`); `ComposeRequest.contractingChain?`/`contractingDepth?` (`:989`). **SÓLO tipos** |
| `.env.example` | `A2A_SELF_HOSTS` y `A2A_CONTRACTING_DEPTH_MAX`, con la tabla de §5.3 **pegada**. Ninguna de las dos existe hoy (medido: `/usr/bin/grep -rn "A2A_SELF_HOSTS\|A2A_CONTRACTING_DEPTH_MAX" src/ test/ .env.example` → **vacío**) |

**Criterio de salida de W0** (los cuatro, con el número en el commit message):
1. `./node_modules/.bin/tsc --noEmit; echo $?` → **0**
2. `node ./node_modules/vitest/vitest.mjs run > /tmp/w0.txt 2>&1; echo $?` → **0**, y
   `280 passed | 6 skipped` / **`5441 + N` passed** donde `N` = los `it` nuevos del leaf.
   ⚠️ **Un cambio de tipos que mueva un test preexistente es una SEÑAL, no ruido**: paralo y explicalo.
3. `/usr/bin/grep -c "^import" src/lib/contracting-chain.ts` → **0**
4. Los **dos mutantes de calibración** de §11 corridos, con su resultado anotado.

### Wave 1 — el bucle DIRECTO (Capa 1) · 💰 **si la HU se cortara acá, ya cierra el caso peor**

| Archivo | Qué entra |
|---|---|
| `src/services/agent-price.ts` | `resolveAgentDestination` devuelve además `invokeUrl` (§3.6) |
| `src/routes/compose.test.ts`, `src/routes/compose.no-debit-on-abort.test.ts`, `src/__tests__/e2e/compose-flow.test.ts` | los 3 mocks tipados de §3.6 (`:416-419`, `:241-244`, `:230`) — **CD-22: re-contar rojos después** |
| `src/routes/compose.ts` | **SITIO 1** tras `:735` (§4.1) |
| `src/services/orchestrate.ts` | **SITIO 2** tras `:1115` (§4.2) |
| `src/services/compose.ts` | **SITIO 3** tras `:376` (§4.3) · **SITIO 4** tras `:1503` con el comentario de CD-17 (§4.4) |
| `src/index.ts` | `assertSelfHostsEnv()` + log de arranque con la forma de `:173-182` (`setting`/`hosts`/`count`) · el `contractingGuard` de `/health` en `:240-265` |
| `src/__tests__/e2e/setup.ts` | el **MISMO** campo en el `/health` duplicado de `:341-358` (§3.4) |
| tests | `T-L1-1..7`, `T-L1+1..3`, `T-ENV-1/2`, `T-FLAG-1` |

**Criterio de salida**: tsc 0 · suite verde con el conteo **por encima** del baseline · los mutantes
`MUT-01`, `MUT-02`, `MUT-03`, `MUT-06`, `MUT-07`, `MUT-11` **corridos** con su par (rojos, sha).

### Wave 2 — el bucle TRANSITIVO, el techo y la propagación (Capa 2 + AC-7)

| Archivo | Qué entra |
|---|---|
| `src/middleware/contracting-guard.ts` | **NUEVO**. El preHandler inbound: llama `readInboundContracting` y, si `ok`, deja `request.contractingChain` / `request.contractingDepth`. Aborta con el shape `error_code` (familia 1, §8) |
| `src/middleware/contracting-guard.test.ts` | **NUEVO** |
| `src/routes/compose.ts` | el preHandler nuevo **al PRINCIPIO** del array `:845-885` — **antes** de `validateComposeBodyHandler` (`:857`) — y threading de los dos campos al `composeService.compose` |
| `src/routes/orchestrate.ts` | idem en las **TRES** cadenas (`:137`, `:281`, `:505`), **antes** de `markSkipMiddlewareDebitHandler` (`:146`, `:288`, `:515`) |
| `src/services/orchestrate.ts` | propagación al `composeService.compose` de `:1213-1240` |
| `src/services/compose.ts` | **AC-7**: los dos headers en `:1424-1431` vía `buildOutboundContractingHeaders`, **antes del spread de credenciales** (§5.4); 6.º parámetro de `invokeAgent` (§3.7) y los **2** call-sites (`:618-624`, `:969-975`) |
| tests | `T-L2-1..3`, `T-CHAIN-1/2`, `T-DEPTH-1..6`, `T-L2+1/+2`, `T-PROP-1..3`, `T-CODE-1` |

**Criterio de salida**: tsc 0 · suite verde · `MUT-04`, `MUT-05`, `MUT-08`, `MUT-09`, `MUT-10`,
`MUT-15`, `MUT-16` corridos.

### Wave 3 — la carta (paralelizable, otro worktree)

**PRIMERO la medición de CD-20, antes de escribir el campo.** F2.5 ya la corrió y da **hazard cero
hoy**, pero **hay que re-correrla** porque es una propiedad del árbol:

```bash
/usr/bin/grep -rn "vi.mock(.*adapters/registry" src/ test/ | wc -l          # F2.5 midió: 63
node ./node_modules/vitest/vitest.mjs run \
  src/services/agent-card.test.ts src/routes/agent-card.test.ts \
  src/routes/agent-card.selfpublished.test.ts src/routes/capabilities.inbound-chains.test.ts
```

**Lo que F2.5 midió, y que decide el camino**: de los **63** archivos que mockean
`../adapters/registry.js`, **53 no declaran `getInboundPaymentChainKeys`** — pero de los que cargan un
consumidor de la carta (`src/routes/well-known.ts`, `src/routes/capabilities.ts`,
`src/routes/agent-card.ts`, `src/__tests__/e2e/setup.ts`) **el único que mockea `adapters/registry` es
`src/__tests__/e2e/setup.ts:168-173`, y SÍ declara `getInboundPaymentChainKeys` con
`importOriginal`**. Y `src/routes/capabilities.inbound-chains.test.ts:80-93` **mockea
`../services/agent-card.js` completo**, así que es **inmune**. ⇒ **camino A viable: `agent-card.ts`
puede importar `../adapters/registry.js`.** Si la re-medición dice otra cosa, el camino B es resolver
el `ctx` en los dos routes y mudar `resolveSelfCardContext` al leaf. **Los dos caminos están
decididos; cuál se toma lo dice el número, no la comodidad.**

| Archivo | Qué entra |
|---|---|
| `src/services/agent-card.ts` | `resolveSelfCardContext()` (**un** call-site, desde `buildSelfAgentCard` mismo ⇒ AC-2 estricto) + `buildSelfAgentCard` (`:197-245`) con `endpoint`/`pricing` por skill, `authentication.schemes` **derivado** y `contracting` |
| `src/routes/well-known.test.ts` | 🔴 **NUEVO** — medido: `well-known.ts` **no tiene suite propia** (`ls src/routes/ \| grep well` → sólo `well-known.ts`) |
| `src/routes/well-known.ts`, `src/routes/capabilities.ts` | **sólo** si CD-20 obliga al camino B. Si no: **cero cambios** (`/capabilities` deriva de la carta en `:33` y hereda todo por `methods: card.skills`, `:70`) |
| `doc/` | la decisión **DT-1** escrita y el procedimiento de registro externo (la tabla de NC-4, §13) |
| tests | `T-CARD-1..6` |

**Las tres fuentes de la carta, una por dato — ninguna inventada:**

| Dato de AC-1 | Fuente ÚNICA | Cita |
|---|---|---|
| **(b) esquemas de auth/pago** | `bearer` **siempre** (el carril de agent key prepaga no está gateado); `x402` **sólo si** `getInboundPaymentChainKeys().length > 0` | `src/adapters/registry.ts:532`, que usa `acceptsInboundPayment` (`:522`), declarada *"la ÚNICA definición de la asimetría"* en `:518` |
| **(a) precio** | **No hay precio fijo**: el gateway cobra una **tasa** sobre el costo ejecutado. `feeRatePercent = getProtocolFeeRate() * 100`, **la misma expresión** que ya usa `/orchestrate/plan` | `src/services/fee-charge.ts:133`; `src/routes/orchestrate.ts:350-353` |
| **(c) endpoint por skill** | el prefijo con el que se registra cada ruta | `src/index.ts:271` (`/discover`), `:273` (`/compose`), `:274` (`/orchestrate`) |

**Sobre (a)**: declarar un `priceUsdc` por skill sería **fabricar una oferta**, que es justo lo que
AC-3 prohíbe. Lo honesto: (i) los precios de los agentes son **pass-through**, (ii) el gateway cobra
`feeRatePercent` sobre el costo realmente ejecutado, (iii) el precio exacto de un pipeline se
**cotiza** en `POST /orchestrate/plan`, que ya devuelve `costPerStep`, `totalCostUsdc`,
`protocolFeeUsdc` y `maxQuotedCostUsdc` (`src/routes/orchestrate.ts:433-447`) y **no cobra**. La
carta declara el **modelo** y apunta al **cotizador** — que es lo que AC-1 admite con su *"o la forma
de obtenerlo"*.

**Sobre (c)**: escribir los tres paths a mano en `agent-card.ts` es una segunda expresión del
registro de rutas de `src/index.ts:270-291`, y **`tsc` no las ata**. El control es **mecánico**:
`T-CARD-3` arranca la app con `fastify.inject()` y verifica que cada `endpoint` declarado responda
**distinto de 404**.

**Shape aditivo** (`...(x !== undefined && { x })`, patrón de `src/services/agent-card.ts:169-190`):

```ts
// AgentSkill
endpoint?: { method: 'POST'; path: string };
pricing?: { model: 'free' }
        | { model: 'protocol-fee-on-executed-cost'; feeRatePercent: number; quoteEndpoint: string };
// AgentCard
contracting?: { depthMax: number; chainHeader: string; depthHeader: string; bestEffortNote: string };
```

`model: 'free'` para `discover` **no es fe**: medido, `/usr/bin/grep -n "requirePaymentOrA2AKey\|preHandler"
src/routes/discover.ts` **no devuelve nada**, y `T-CARD-2` lo fija con un `inject` sin credencial que
espera **distinto de 402**.

**AC-3, y cuál es su caso REAL** (hay que decirlo, porque afirmar que "cualquier campo puede omitirse"
sin poder producir la omisión es prosa): `getProtocolFeeRate()` **nunca falla** (clamp a `[0, 0.10]`
con default `0.01`, `src/services/fee-charge.ts:106-108`, `:133`) y los endpoints son estáticos. **El
caso que sí ocurre es el esquema de pago**: si ninguna chain inicializada acepta cobro de entrada,
`x402` **no se lista** — y es alcanzable **hoy**, porque `solana-devnet` sale con
`acceptsInboundPayment: false` en prod (`.nexus/project-context.md:152`). `T-CARD-5` monta ese caso.

⚠️ `src/routes/capabilities.inbound-chains.test.ts:252` congela con `Object.keys(body).sort()` el
conjunto **top-level** de `/capabilities` (12 campos, T-SRC-06) y **mockea la carta entera**
(`:80-93`, `skills: []` en `:88`). ⇒ los campos nuevos de la carta **no lo mueven**, y `T-CARD-4` **no
puede vivir en ese archivo** sin quitarle el mock. Va en `src/routes/well-known.test.ts` (nuevo) o en
`src/services/agent-card.test.ts` (que **no mockea nada**).

**Criterio de salida**: tsc 0 · suite verde · la medición de CD-20 escrita con su número y su sha ·
el doc de DT-1 existe (⚠️ si lo referenciás desde código, `test/docs-referenced-by-code-exist.test.ts`
exige que la ruta **resuelva**).

### Wave 4 — el fee en cascada (depende de W2)

| Archivo | Qué entra |
|---|---|
| `src/lib/contracting-chain.ts` | `readCoordinatorFee` — **una** definición, dos direcciones |
| `src/services/compose.ts` | lectura del sobre sobre el `data` **CRUDO** de `:1538`, **ANTES** del colapso `data.result ?? data` de `:1539`; `coordinatorFee` en el return de `invokeAgent` (`:1382-1396`, `:1565-1569`), en los **dos** call-sites (`:617-624`, `:968-975`) y en el `ctx` de `finishSuccessfulStep` (`:1123-1155`) |
| `src/routes/compose.ts` | `protocolFeeUsdc` / `feeRatePercent` / `protocolFeeStatus` + rollup en `:1127`. **CD-21: reescribir `:1050-1053` en este mismo commit** |
| `src/routes/orchestrate.ts`, `src/services/orchestrate.ts` | rollup en el atómico y en `/execute` (los dos ya devuelven `protocolFeeUsdc`, `src/services/orchestrate.ts:1246-1248`). **`/plan` NO se toca** |
| tests | `T-FEE-1..7` |

**El fee propio en `/compose` (AC-10)**, aditivo, con los **mismos nombres** que `/orchestrate` para
no estrenar un segundo vocabulario:

```ts
protocolFeeUsdc?: number;                                   // sólo charged | already-charged
feeRatePercent: number;                                     // getProtocolFeeRate() * 100, 6dp
protocolFeeStatus: 'charged' | 'not_charged' | 'unknown';    // el tercer valor
```

Mapeo desde `FeeChargeResult` (`src/services/fee-charge.ts:75-90`, que ya es una unión de **4**
estados):

| `feeResult.status` | `protocolFeeStatus` | `protocolFeeUsdc` |
|---|---|---|
| `charged` | `'charged'` | `feeResult.feeUsdc` (`src/routes/compose.ts:1095` ya lo lee) |
| `already-charged` | `'charged'` | `feeResult.feeUsdc` |
| `skipped` (`WALLET_UNSET`, `:260`) | `'not_charged'` | **OMITIDO** |
| `failed` (`:251`), o el `catch` del route | `'unknown'` | **OMITIDO** |

Los dos OMITIDOS son **CD-5 y no cosmética**: en `skipped` el `feeUsdc` que trae el resultado es el
monto **calculado y no cobrado** (reportarlo como cobrado es una afirmación falsa con formato de
dato); en `failed` la disposición es **desconocida, no cero** — este mismo archivo importa
`hasBroadcastEvidence` (`src/services/fee-charge.ts:22`) justamente porque **un HTTP que falla no
prueba que no se transmitió**. Es *"no pude preguntar" ≠ "no pasó"*.

⛔ **El `txHash` del fee NO se serializa.** Publicar el hash de la transferencia del fee expone el
movimiento de la wallet de plataforma; el caller necesita el **monto**. (Y es la razón por la que
`feeChargeTxHash` sigue sin declararse — biome `noUnusedVariables`.)

**El fee AJENO (AC-11) se LEE, no se estima.** La señal de que el ejecutor de un step es un
coordinador es que su respuesta trae **el mismo sobre que nosotros emitimos**:

| Lo que trae la respuesta del agente | Qué se pone en el `StepResult` |
|---|---|
| **sin** `protocolFeeStatus` | **nada** → campo ausente (no es un coordinador) |
| `protocolFeeStatus === 'charged'` **y** `protocolFeeUsdc` finito `> 0` | `coordinatorFee: { declared: true, usdc }` |
| `protocolFeeStatus` presente, cualquier otro caso | `coordinatorFee: { declared: false }` |

La primera fila es la que preserva AC-8/CD-2 **para el 100% del tráfico de hoy**: los 25 agentes de
prod no emiten ese campo. ⛔ **Nunca `usdc: 0`.**

**El rollup**, una función pura sobre `StepResult[]`, tres call-sites:

```ts
cascadedOrchestrationFeeUsdc?: number;                    // suma de los declarados; ausente si no hubo ninguno
cascadedOrchestrationFeeStatus?: 'complete' | 'partial';  // 'partial' ⟺ ≥1 coordinador sin declarar
```

**Ningún step coordinador ⇒ los dos campos ausentes ⇒ respuesta byte-idéntica.**
`/orchestrate/plan` **no se toca**: es una cotización, no hubo ejecución, y el fee ajeno no es
conocible antes de invocar. Agregarle un campo de cascada sería **inventar un dato**.

⚠️ **GOTCHA que no se debe pisar**: en la tabla `a2a_protocol_fees`, `fee_usdc` es **la pata de
PLATAFORMA post-split, no el total**. Lo dice el código que hace el INSERT:
`src/services/fee-charge.ts:428` escribe `fee_usdc: platformAmount`, el comentario de `:429-431` lo
declara *"money-path invariante, sin tocar"*, y el total vive en `fee_total_usdc` (`:432`).
⇒ los campos nuevos se llaman `protocolFeeUsdc` y `cascadedOrchestrationFeeUsdc`, **nunca** `feeUsdc`
ni `fee_usdc`; y **no se leen de la tabla**: salen de `FeeChargeResult` y de la respuesta del agente.

**AC-12**: todo lo anterior son **claves nuevas**. `T-FEE-7` compara `Object.keys` del 200 contra la
línea base y exige que el conjunto viejo sea **subconjunto** del nuevo, con los mismos valores.

**Criterio de salida**: tsc 0 · suite verde · `MUT-12`, `MUT-13`, `MUT-14` corridos · el
`/usr/bin/grep -rn "ningún campo de fee" src/ doc/` de CD-21 **vacío en `src/`**.

### Wave 5 — cierre (sin código de producción)

1. El barrido de citas de **§7** (CD-11), como tarea propia y no de paso.
2. Los **18** mutantes de §11 corridos, cada uno con `(MEDIDO: exit=N, M rojos, en <sha>)`.
3. `doc/sdd/223-coordinador-como-agente/auto-blindaje.md` — **cada** error tuyo, con causa raíz y
   "aplicar en".
4. `doc/sdd/223-coordinador-como-agente/implementation-log.md`.
5. Verificación final: `ls -l` **y** `git ls-tree` sobre cada artefacto que declares escrito. Son
   **dos fallas distintas** (existe en disco / está trackeado), y este repo ya midió 5 veces el
   "reporte declarado que no existe".

⛔ **Cero commits que el orquestador no haya pedido. Cero `_INDEX.md`** (eso es de `nexus-docs`).

---

## 10 · Los 43 tests, con MUTANTE y SITIO DE APLICACIÓN EXACTO

> Framework `vitest`. Convención del repo: `*.test.ts` **al lado del archivo**.
> Piso: **≥1 `it` por AC** (mapa en §2). Los `T-*+` son los gemelos positivos de CD-7.
> ⚠️ **Cada mutante hay que CORRERLO** (§11). Las celdas de rojos dicen *a medir* porque un conteo de
> `it` rojos es **una propiedad del ÁRBOL, no del mutante**: en `222` un mutante llegó al `.md` con
> **2 rojos preexistentes** cargados a su cuenta.

| ID | AC/CD | Wave | Qué monta | Qué asserta | MUTANTE — sitio exacto | rojos |
|---|---|---|---|---|---|---|
| `T-L1-1` | AC-4 | W1 | `/compose` 1 step con `invokeUrl` = `https://<self>/compose` | 400 + `error_code:'CONTRACTING_LOOP_DETECTED'` + **cero** llamadas a `budgetService.debit` | en `src/routes/compose.ts`, borrar el bloque nuevo insertado tras `:735` | a medir |
| `T-L1-2` | AC-4, CD-3 | W1 | igual pero en `steps[2]` de un pipeline de 3 | `errorCode` (camel) en el `...result`; `debit` llamado **2** veces (steps 0,1) y **no** la 3.ª; `ssrfFetch` **no** llamado para ese step | en `src/services/compose.ts`, mover el bloque de tras `:376` a **después** de `:553` | a medir |
| `T-L1-3` | AC-4, CD-3 | W1 | `/orchestrate` con un step propio | rechazo **antes** de `budgetService.debit` de `src/services/orchestrate.ts:1149` | mover el bloque de tras `:1115` a **después** de `:1157` | a medir |
| `T-L1-4` | AC-4, CD-15 | W1 | destino `https://<self>./compose` (punto final) | **rechazo** | en `contracting-chain.ts`, borrar el paso 7 de `canonicalizeHost` | a medir |
| `T-L1-5` | AC-4 | W1 | destino `https://<SELF>:8443/compose` | **rechazo** | en `contracting-chain.ts`, comparar `url.host` en vez de `url.hostname` | a medir |
| `T-L1-6` | **AC-9** | W1 | destino propio, request **SIN ningún header** de contratación | **rechazo igual** | condicionar la Capa 1 a la presencia de la traza | a medir |
| `T-L1-7` | AC-4, CD-17 | W1 | destino propio + Sitio 3 stubeado a no-op | el Sitio 4 corta, `ssrfFetch` **no** llamado, y se logueó a **`error`** | en `src/services/compose.ts`, borrar el bloque nuevo de tras `:1503` | a medir |
| `T-L1+1` | **AC-8**, CD-7 | W1 | pipeline de `MAX_COMPOSE_STEPS` (**5**) contra hosts ajenos | 200, mismo body, mismo `totalCostUsdc`, **5** débitos, **5** `ssrfFetch` | invertir el predicado (`!isSelfDestination`) | a medir |
| `T-L1+2` | **AC-8** | W1 | los **dos hosts reales de prod** (`wasiai-v2.vercel.app`, `wasiai-remittance-agents.vercel.app`) como destinos | los dos **pasan** | agregar `.vercel.app` al conjunto de identidad | a medir |
| `T-L1+3` | AC-8, CD-1 | W1 | `A2A_SELF_HOSTS` ausente **y** `BASE_URL` ausente **y** sin `hint` | pipeline normal **200** (el guard no puede inventar identidad) + el `warn` de arranque emitido | hacer que el conjunto vacío **rechace todo** | a medir |
| `T-FLAG-1` | **CD-1** | W1 | barrido textual | **ninguna** env nueva gatea el corte: `/usr/bin/grep -rn "=== 'true'" src/lib/contracting-chain.ts src/middleware/contracting-guard.ts` **vacío**, y el corte funciona con `process.env` limpio | agregar un `if (process.env.X === 'true')` alrededor del corte | a medir |
| `T-L2-1` | AC-5 | W2 | `x-a2a-contracting-chain: <self>` | 400 `CONTRACTING_LOOP_DETECTED` con `layer:'chain'`, **cero** débitos | borrar el paso 5 de `readInboundContracting` | a medir |
| `T-L2-2` | AC-5, **CD-6** | W2 | igual | el body del error **contiene** `CONTRACTING_LAYER2_BEST_EFFORT_NOTE` **textual** | borrar la nota del body | a medir |
| `T-L2-3` | AC-5, CD-15 | W2 | cadena `otro-gw, <SELF>., tercero` | rechazo | no canonicalizar los elementos de la cadena | a medir |
| `T-CHAIN-1` | AC-5, **CD-16** | W2 | header de cadena de **8192** caracteres | 400 `CONTRACTING_CHAIN_MALFORMED`, y `split` **NO ejecutado** (espía) | mover el chequeo de largo **después** del `split` | a medir |
| `T-CHAIN-2` | AC-5 | W2 | **400** elementos válidos | rechazo por **conteo** | borrar el paso 2 | a medir |
| `T-DEPTH-1` | AC-6 | W2 | `depth: '2'`, techo default | 400 `CONTRACTING_DEPTH_EXCEEDED`, cero débitos | cambiar `>=` por `>` | a medir |
| `T-DEPTH-2` | AC-6, **CD-14** | W2 | `depth: '1e9'` | 400 `CONTRACTING_DEPTH_MALFORMED` (**no** pasa como 1) | usar `Number.parseInt(v,10)` | a medir |
| `T-DEPTH-3` | AC-6, **CD-14** | W2 | `depth: ''` | 400 `CONTRACTING_DEPTH_MALFORMED` (**no** pasa como 0) | usar `Number(v)` | a medir |
| `T-DEPTH-4` | AC-6, CD-14 | W2 | `' 2'`, `'2abc'`, `'0x10'`, `'1000'` (**4 sub-casos**) | los 4 rechazados | relajar el regex a `^\d+$` (mata el 4.º) o a `/\d+/` (mata los 3 primeros) | a medir ×2 |
| `T-DEPTH-5` | AC-6 | W2 | `A2A_CONTRACTING_DEPTH_MAX='abc'` + `depth:'2'` | rechazo (cayó al **default del código**, no a sin techo) + `warn` de arranque | `?? Number.POSITIVE_INFINITY` en `resolveContractingDepthMax` | a medir |
| `T-DEPTH-6` | AC-6 | W2 | env **ausente** + `depth:'2'` | rechazo | ídem | a medir |
| `T-L2+1` | **AC-8**, CD-7 | W2 | `chain:'otro-gw.example'`, `depth:'1'`, techo 2 | **200**, mismo body/costo/settles que sin headers | rechazar toda cadena no vacía | a medir |
| `T-L2+2` | **AC-8** | W2 | **sin** ninguno de los dos headers (el 100% del tráfico de hoy) | 200 **byte-idéntico** a la línea base | tratar la ausencia de `depth` como malformado | a medir |
| `T-PROP-1` | AC-7 | W2 | pipeline de 2 steps, entrada `chain:'a.example'`, `depth:'0'` | los `ssrfFetch` salen con `chain:'a.example,<self>'` y `depth:'1'` | no incrementar la profundidad | a medir |
| `T-PROP-2` | AC-7, **CD-18** | W2 | `canonicalId === null` | **ninguno** de los dos headers se emite + `warn` | emitir la cadena sin nuestro eslabón | a medir |
| `T-PROP-3` | AC-7, **CD-4** | W2 | pipeline normal | `Content-Type`, `x-a2a-key` y las credenciales del registry salen **iguales** a la línea base | poner los headers nuevos **después** del spread de credenciales (`src/services/compose.ts:1430`) | a medir |
| `T-CODE-1` | AC-4/AC-5, **CD-19** | W2 | el mismo bucle por preHandler y por loop | los dos strings salen de **la misma constante** del leaf | escribir el literal a mano en una de las dos capas | a medir |
| `T-CARD-1` | AC-1 | W3 | `GET /.well-known/agent.json` | cada skill trae `endpoint` y `pricing`; `authentication.schemes` **no vacío**; `contracting.depthMax` presente | borrar el bloque nuevo de `buildSelfAgentCard` | a medir |
| `T-CARD-2` | AC-1 | W3 | ídem | la ruta sigue **gratis y sin rate-limit** (`config.rateLimit === false`, `src/routes/well-known.ts:11`) y `/discover` responde **≠402** sin credencial | quitar `rateLimit: false` de `:11` | a medir |
| `T-CARD-3` | AC-1, AC-2 | W3 | `fastify.inject()` a **cada** `endpoint` declarado por la carta | ninguno da **404** | renombrar el prefijo `/compose` en `src/index.ts:273` | a medir |
| `T-CARD-4` | **AC-2** | W3 | `GET /capabilities` | `methods`/`name`/`url` **siguen derivando** de la carta (`src/routes/capabilities.ts:65-70`) y el conjunto de claves crece sin perder ninguna | duplicar los skills a mano en `capabilities.ts` | a medir |
| `T-CARD-5` | AC-3 | W3 | registry donde `getInboundPaymentChainKeys()` es **vacío** | `x402` **no aparece** en `schemes`, y **no** aparece `x402: false` ni `null` | listar `x402` incondicionalmente | a medir |
| `T-CARD-6` | AC-3, **CD-5** | W3 | ídem | **ningún** campo nuevo de la carta vale `0` ni `null` (barrido recursivo del JSON) | poner `feeRatePercent: 0` como placeholder | a medir |
| `T-FEE-1` | AC-10 | W4 | `chargeProtocolFee` → `charged` | `protocolFeeUsdc === feeResult.feeUsdc`, `protocolFeeStatus==='charged'`, `feeRatePercent === getProtocolFeeRate()*100` | recalcular el fee con un literal en vez de `getProtocolFeeRate()` | a medir |
| `T-FEE-2` | AC-10, **CD-5** | W4 | → `skipped(WALLET_UNSET)` | `protocolFeeStatus==='not_charged'` y `protocolFeeUsdc` **AUSENTE** | reportar `feeResult.feeUsdc` en `skipped` | a medir |
| `T-FEE-3` | AC-10, **CD-5** | W4 | → `failed` | `protocolFeeStatus==='unknown'` y `protocolFeeUsdc` **AUSENTE** | mapear `failed` a `'not_charged'` | a medir |
| `T-FEE-4` | AC-11 | W4 | agente que responde `{protocolFeeStatus:'charged', protocolFeeUsdc:0.02, …}` | `steps[i].coordinatorFee === {declared:true,usdc:0.02}`, `cascadedOrchestrationFeeUsdc===0.02`, `…Status==='complete'` | leer el sobre **después** del colapso de `src/services/compose.ts:1539` | a medir |
| `T-FEE-5` | AC-11, **CD-5** | W4 | agente que responde `{protocolFeeStatus:'unknown'}` sin monto | `coordinatorFee==={declared:false}`, `…Status==='partial'`, y **ningún `0`** en el body | poner `usdc: 0` cuando no declara | a medir |
| `T-FEE-6` | **AC-8**, CD-7 | W4 | agente normal (sin `protocolFeeStatus`) | `coordinatorFee` **ausente** y los dos campos de rollup **ausentes** | marcar todo step como `{declared:false}` | a medir |
| `T-FEE-7` | **AC-12** | W4 | 200 de `/compose` y de `/orchestrate` | el `Object.keys` de la línea base es **subconjunto** del nuevo, con los mismos valores | renombrar `totalCostUsdc` | a medir |
| `T-ENV-1` | CD-1, §3.4 | W1 | `A2A_SELF_HOSTS='https://gw'` (con esquema) | `assertSelfHostsEnv()` **LANZA** | degradar a `[]` en silencio | a medir |
| `T-ENV-2` | §3.4, NC-1 | W1 | `A2A_SELF_HOSTS` ausente | devuelve el string de **warn** (no lanza) y `/health` publica `source:'request-only'` | **lanzar** en el caso ausente (voltearía prod) | a medir |
| `T-OWN-1` | **CD-8** | todas | — | `test/ownership-filter-guard.test.ts` sigue en **`13 passed (13)`** | agregar una query sin `.eq('owner_ref', …)` | a medir |

---

## 11 · Protocolo de mutación y los 18 mutantes

### 11.1 · Las reglas (CD-12 / CD-13), no negociables

1. **Cada mutante se corre contra la suite COMPLETA**, nunca contra los archivos tocados.
   Precedente medido: WKH-345 cantó verde con **2 rojos en el árbol** que su corrida dirigida no
   podía ver (`222-…/auto-blindaje.md:40-75`), y el radio de impacto **no se deduce del directorio**.
2. **Sin pipes, sin redirección a través del wrapper.** `node ./node_modules/vitest/vitest.mjs run > /tmp/m.txt 2>&1; rc=$?`.
   El número de `it` rojos sale de la línea **`Tests N failed`**, ⛔ **nunca de contar líneas `×`**.
3. **Respaldo POR COPIA** (`cp archivo /tmp/archivo.bak`), restauración verificada con `md5sum`.
   ⛔ **JAMÁS `git checkout --`** para restaurar: en otra HU borró 90 líneas sin commitear.
4. **Contá la aguja y exigí `== 1`.** Si el texto del mutante aparece 2 veces, mutaste dos sitios y
   el veredicto no vale.
5. **Leé el TEXTO de la falla, no sólo el exit code.** Un mutante que mata *por el motivo equivocado*
   es indistinguible de uno que mata si sólo mirás el exit.
6. **Antes de atribuirle un rojo a un mutante, corré la suite SIN el mutante en ese mismo commit.**
   La resta es lo único que separa la víctima del preexistente.
7. **Si un mutante da UN solo rojo**, ése es el **único testigo**: se escribe **en el testigo** (no
   sólo en el `.md`) que es el único, con el número medido y el aviso de que **refixturear su input lo
   apaga igual que borrarlo** (CD-22).
8. Cada anotación lleva **`(MEDIDO: exit=N, M rojos, en <sha>)`**. **Sin el sha el número se podre
   solo.**
9. El control final de cada mutante es **`git status --short` completo** (no el diff del archivo
   tocado): así se ven los `.bak` y los archivos a medio restaurar. Baseline: sólo el `sdd.md` y los
   artefactos de esta HU.

### 11.2 · Los DOS de calibración, corridos PRIMERO (en W0, contra el árbol base)

| ID | Mutación | Sitio exacto | Esperado | rojos |
|---|---|---|---|---|
| **CAL-MUERE** | `PLACEHOLDER_FEE_USD = 1.0` → `2.0` | `src/lib/pricing-constants.ts:16` | **TIENE que morir** (varios rojos de comportamiento en el camino de dinero) | a medir |
| **CAL-VIVE** | insertar una línea de comentario `// calibración` al final del archivo | `src/lib/compose-limits.ts` (38 líneas) | **TIENE que vivir**: `0 failed` | a medir |

⛔ **Si alguno no da lo esperado, el instrumento está roto y NINGÚN veredicto de §11.3 vale.**

### 11.3 · Los 16 obligatorios

⚠️ **Renombrados a `MUT-01..MUT-16`.** El SDD los llama `M-1..M-16` y **usa los mismos nombres
`M-1..M-5` para sus cinco hallazgos medidos**: "M-1" significa dos cosas distintas en el SDD. Acá
`MUT-*` son mutantes y no hay ambigüedad.

| # | Mutación | Sitio de aplicación — **ancla textual** | Debe morir | rojos |
|---|---|---|---|---|
| `MUT-01` | mover el guard del **Sitio 3** debajo del débito | `src/services/compose.ts`: mover el bloque insertado tras el cierre del `if (scopingKeyRow)` (hoy `:376`) a después del `const debitResult = await budgetService.debit(` (hoy `:545`) | `T-L1-2` | a medir |
| `MUT-02` | mover el guard del **Sitio 1** después del débito | `src/routes/compose.ts`: mover el bloque de `resolveComposePriceHandler` al route handler, después de `...requirePaymentOrA2AKey(` (hoy `:867`) | `T-L1-1` | a medir |
| `MUT-03` | mover el guard del **Sitio 2** después del débito | `src/services/orchestrate.ts`: mover el bloque de después del cap gate (hoy `:1115`) a después del `if (!debitRes.success)` (hoy `:1158`) | `T-L1-3` | a medir |
| `MUT-04` | `Number.parseInt(depth, 10)` en lugar del regex | `src/lib/contracting-chain.ts`, paso 4 de `readInboundContracting` | `T-DEPTH-2`, `T-DEPTH-4` | a medir |
| `MUT-05` | `Number(depth)` en lugar del regex | ídem | `T-DEPTH-3` | a medir |
| `MUT-06` | borrar el strip del punto final | `src/lib/contracting-chain.ts`, paso 7 de `canonicalizeHost` | `T-L1-4`, `T-L2-3` | a medir |
| `MUT-07` | comparar `url.host` en vez de `url.hostname` | `src/lib/contracting-chain.ts`, `isSelfDestination` | `T-L1-5` | a medir |
| `MUT-08` | `?? Number.POSITIVE_INFINITY` en el techo | `src/lib/contracting-chain.ts`, `resolveContractingDepthMax` | `T-DEPTH-5`, `T-DEPTH-6` | a medir |
| `MUT-09` | chequeo de largo **después** del `split` | `src/lib/contracting-chain.ts`, pasos 1-2 de `readInboundContracting` | `T-CHAIN-1` | a medir |
| `MUT-10` | `>` en lugar de `>=` en el techo | `src/lib/contracting-chain.ts`, paso 6 | `T-DEPTH-1` | a medir |
| `MUT-11` | invertir el predicado de identidad | `src/lib/contracting-chain.ts`, `isSelfDestination` | `T-L1+1` **y ~toda la suite**: es el **control negativo** de que el instrumento puede dar rojo de comportamiento | a medir |
| `MUT-12` | leer el sobre **después** de `data.result ?? data` | `src/services/compose.ts`, mover la lectura de después de `const data = (await response.json())` (hoy `:1538`) a después de `const output = data.result ?? data;` (hoy `:1539`) | `T-FEE-4` | a medir |
| `MUT-13` | `usdc: 0` cuando el coordinador no declara | `src/lib/contracting-chain.ts`, `readCoordinatorFee` | `T-FEE-5` | a medir |
| `MUT-14` | reportar `feeUsdc` en `skipped` | `src/routes/compose.ts`, el mapeo de `feeResult.status` (§9, W4) | `T-FEE-2` | a medir |
| `MUT-15` | headers nuevos **después** del spread de credenciales | `src/services/compose.ts`: mover la llamada a `buildOutboundContractingHeaders` debajo de `...authHeaders,` (hoy `:1430`) | `T-PROP-3` | a medir |
| `MUT-16` | emitir la cadena sin `canonicalId` | `src/lib/contracting-chain.ts`, `buildOutboundContractingHeaders` | `T-PROP-2` | a medir |

---

## 12 · Ownership guard del repo — por wave

**El diseño es NO tocar ninguna tabla** (DT-7 / DT-J: todo el estado viaja en la petición; sin tabla,
sin migración). Wave por wave:

| Wave | ¿Toca alguna query sobre una tabla con `owner_ref`? | Régimen |
|---|---|---|
| W0 | **No** — módulo leaf sin imports + tipos + `.env.example` | ninguno |
| W1 | **No** — routes/services ya existentes, sin query nueva | ninguno |
| W2 | **No** — middleware nuevo que sólo lee headers | ninguno |
| W3 | **No** — `agent-card.ts` + `adapters/registry.ts` (funciones puras sobre bundles) | ninguno |
| W4 | **No** — lee de `FeeChargeResult` y de la respuesta del agente, **nunca de la tabla** | ninguno |

**Si alguna wave termina tocando una query, la regla aplica SIN excepción** (`CLAUDE.md` → Ownership
Guard): el filtro `.eq('owner_ref', <value>)` va, y la firma que recibe un `keyId` lleva un
`ownerId: string` (**no** `string | undefined`).

**El control no es esa frase**: es que `test/ownership-filter-guard.test.ts` corre en cada `npm test`
y que en `3823580` da **`Tests 13 passed (13)`** (medido por F2.5). El universo de tablas lo **deriva**
`deriveTables()` en `test/ownership-filter-guard.scanner.ts:243`; ⛔ **no te apoyes en ningún número
escrito a mano: derivalo**.

⚠️ **Y leé lo que ese guardián NO hace, porque su verde es fácil de sobre-leer**: verifica
**PRESENCIA** del filtro, **no su VALOR**, y **no mira los `supabase.rpc(...)`**. Que dé 13 verde no
prueba nada sobre esta HU más allá de "no introdujo un sitio sin filtro".

---

## 13 · Los residuales y los `[NEEDS CLARIFICATION]` — copiados con su ⛔

**Ninguno se puede cerrar en esta HU.** Van acá para que AR/CR los juzguen y para que **nadie los
convierta en una afirmación**.

| # | Lo que queda abierto | ⛔ Lo que está PROHIBIDO escribir |
|---|---|---|
| **R-3 / TD-360-2** | **Bypass por IP literal.** `https://69.46.46.64/compose` no matchea porque la comparación es **por NOMBRE**. Cerrarlo pediría resolver DNS de nuestros propios hosts por step: caro, inestable (las IPs de Railway rotan) y solapado con el módulo SSRF. Dos acotaciones medidas: el borde de Railway rutea **por Host** y un `https://` a una IP falla la validación de certificado. `A2A_SELF_HOSTS` acepta un literal si un operador lo necesita | ⛔ que la Capa 1 "cierra el bucle directo" **sin calificar** que es por nombre |
| **R-4** | **La Capa 2 NO cierra el transitivo contra un adversario** que borra headers. Lo que queda en pie es la Capa 1 y el techo | ⛔ "bucle transitivo cerrado" a secas (CD-6) |
| **TD-360-1** | La **allow-list** de auto-contratación legítima, con la forma de CD-1, si aparece un caso | ⛔ shippearla en esta HU |
| **NC-1** | **¿Está seteada `BASE_URL` en el Railway de prod? MEDICIÓN INCONCLUSA, con las dos lecturas.** Un `GET /.well-known/agent.json` con `X-Forwarded-Proto: http` devuelve `url` en `https://`, lo que es compatible con **(a)** `BASE_URL` seteada (gana la rama 1 de `resolveBaseUrl`) **y** con **(b)** Railway reescribiendo el header. No se distingue desde afuera. **El diseño no depende de la respuesta**: conjunto vacío ⇒ `warn`, no `throw`, y `/health` publica `selfHostCount` para confirmarlo **después del deploy**. *Pregunta al founder*: ¿`BASE_URL` tiene valor en `wasiai-a2a-production`? ¿Y cuáles son los hosts para `A2A_SELF_HOSTS` si hay dominio propio? | ⛔ escribir que `BASE_URL` está (o no está) seteada en prod |
| **NC-2** | **¿`TRUST_PROXY` está seteada en prod?** Cambia si el rate-limit buckeatea por IP real o si todos comparten uno (`src/lib/env.ts:30-37`, `:50-70`). Afecta **la narrativa** de cuánto DoS colateral produce un bucle, **no el diseño** | ⛔ afirmar que el rate-limit acota (o no acota) el bucle en prod |
| **NC-4** | **¿Qué catálogos A2A externos aceptan hoy una publicación abierta?** Sigue sin verificarse desde el repo. Medido: 2 registries vivos en prod, 25 agentes en dos hosts; Kite sigue `a2aSupport: none` y bloqueado por falta de API (`.nexus/project-context.md:474`); **ERC-8004 sobre Base es un registro de IDENTIDAD, no un catálogo de agentes**. **DT-2 se mantiene**: W3 entrega carta + procedimiento, **no** un publicador. La tabla que W3 tiene que escribir: **Kite** (verificar que exista endpoint de alta pública / bloqueado); **`wasiai-v2`, nuestro propio marketplace** (verificar que listarnos ahí **no** nos meta en nuestro propio `/discover` — DT-1 — y que el `invokeUrl` publicado no sea el nuestro; **decisión del founder**); **directorios de terceros** (x402 Bazaar, Agentic.Market: ¿alta abierta o curada?, qué campos exigen, ¿republican el `invokeUrl`?); **ERC-8004** (que se entienda que **no reemplaza** el registro) | ⛔ nombrar un catálogo como "donde nos vamos a publicar" sin el OK del founder |
| **NC-5** | **Drift documental, fuera de scope.** `.nexus/project-context.md` cita `acceptsInboundPayment` en `registry.ts:510-512` y `getInboundPaymentChainKeys` en `:520-525`; los reales son **`:522`** y **`:532`**. Y ese archivo dice **"23 agentes descubribles"** (`:479`) cuando hoy son **25** (medido por F2.5). **No lo arregla esta HU** | ⛔ arreglarlo acá (scope drift) y ⛔ citar el `:510-512` como si fuera real |
| **NC-6** | **Over-claim en un docblock ajeno.** `src/lib/self-published-auth.ts:82` afirma *"sin punto final"* y es **falso** (medido). No es agujero de seguridad ahí (el peor caso es credencial que no sale), pero **es exactamente la frase que haría que alguien reuse esa función para el guard de identidad**. **Candidato a MENOR, fuera de scope** | ⛔ reusar `canonicalizeHostKey` para la identidad del guard · ⛔ "arreglar" ese archivo en esta HU |
| **NC-3** | **RESUELTO en F2, se copia para que no se reabra**: `src/lib/downstream-payment.ts` **NO** entra al Scope IN. `signAndSettleDownstream` se invoca en `src/services/compose.ts:1555`, o sea **después** de `ssrfFetch` (`:1516`), que está después del débito (`:545-553`) y del Sitio 3. Un step cortado **nunca llega** a esa línea | — |

---

## 14 · Scope

### IN — sólo estos archivos

| Archivo | Acción | Wave | Disciplina |
|---|---|---|---|
| `src/lib/contracting-chain.ts` | **crear** | W0 (+W4) | **cero imports**; `process.env` sí |
| `src/lib/contracting-chain.test.ts` | **crear** | W0 | |
| `src/middleware/contracting-guard.ts` | **crear** | W2 | sólo lee headers; no decide dinero |
| `src/middleware/contracting-guard.test.ts` | **crear** | W2 | |
| `src/routes/well-known.test.ts` | **crear** | W3 | 🔴 no existe suite hoy |
| `src/types/index.ts` (2107 líneas) | modificar | W0 | **sólo tipos**; línea-neutra donde haya auto-citas |
| `src/services/agent-price.ts` (123) | modificar | W1 | el `return` de `:114` |
| `src/routes/compose.ts` (1132) | modificar | W1, W2, W4 | Sitio 1 tras `:735`; preHandler al principio de `:845`; fee en `:1127`; **CD-21 en `:1050-1053`** |
| `src/services/compose.ts` (1571) | modificar | W1, W2, W4 | Sitios 3 y 4; headers en `:1424-1431`; sobre antes de `:1539`; 6.º param de `invokeAgent` |
| `src/services/orchestrate.ts` (1540) | modificar | W1, W2, W4 | Sitio 2 tras `:1115`; propagación en `:1213`; rollup |
| `src/routes/orchestrate.ts` (844) | modificar | W2, W4 | preHandler en las **tres** cadenas; rollup. **`/plan` NO** |
| `src/services/agent-card.ts` (246) | modificar | W3 | `buildSelfAgentCard` `:197-245` + `resolveSelfCardContext` |
| `src/index.ts` (407) | modificar | W1 | `assertSelfHostsEnv()` + log + `/health` en `:240-265` |
| `src/__tests__/e2e/setup.ts` | modificar | W1 | el `/health` **duplicado** de `:341-358` |
| `src/routes/compose.test.ts`, `src/routes/compose.no-debit-on-abort.test.ts`, `src/__tests__/e2e/compose-flow.test.ts` | modificar | W1 | los 3 mocks tipados de §3.6 — **CD-22** |
| `.env.example` (1356) | modificar | W0 | las dos envs + la tabla de §5.3 |
| `doc/` (decisión DT-1 + procedimiento) | crear | W3 | |
| `doc/sdd/223-coordinador-como-agente/{implementation-log,auto-blindaje}.md` | crear | W5 | |

Tests nuevos al lado de su archivo, según la convención del repo.

### OUT — no se toca, con el motivo

- ⛔ **`src/lib/ssrf-dispatcher.ts`, `src/lib/url-validator.ts`, `src/lib/downstream-payment.ts`**
  (CD-23 / CD-4 / NC-3).
- ⛔ **`src/lib/self-published-auth.ts`** — su over-claim se **reporta** (NC-6), no se arregla acá.
- ⛔ **`POST /orchestrate/plan`** no gana ningún campo de cascada: sería inventar un dato.
- ⛔ **Publicar el gateway en su propio `/discover`** (DT-1) ni construir un auto-registrador (DT-2).
- ⛔ **El bucle de DISCOVERY** (registrar como `registry` el propio `/discover`). Es un vector real y
  contiguo — `POST /registries` valida forma y SSRF y nada más, sin control de identidad propia — pero
  **no mueve plata** (`/discover` es gratis) y tiene circuit-breaker por registry. **Candidato a
  WKH-361**, y **comparte este módulo leaf** ⇒ va **después**, nunca en paralelo.
- ⛔ **Cambiar el modelo de fees** ni tocar `fee_usdc` / `fee_total_usdc`.
- ⛔ **RLS a nivel Postgres** (WKH-SEC-02 / TD-SEC-01).
- ⛔ **Rediseñar el shape de error global** ni los `errorCode` existentes más allá de agregar dos.
- ⛔ **`chaski-v3`, `wasiai-facilitator`, y cualquier `wt-*`**: ni un archivo.
- ⛔ **`doc/sdd/_INDEX.md`**: lo cierra `nexus-docs`.
- ⛔ **`.nexus/project-context.md`**: su drift se reporta (NC-5), no se arregla.

---

## 15 · Comandos de verificación (copiables, sin pipes para adjudicar)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a

# A-1 · línea base (correr ANTES de tocar nada, y al cierre de cada wave)
./node_modules/.bin/tsc --noEmit; echo "tsc_exit=$?"                       # 0
node ./node_modules/vitest/vitest.mjs run > /tmp/base.txt 2>&1; echo "suite_exit=$?"
tail -6 /tmp/base.txt        # 280 passed | 6 skipped (286) · 5441 passed | 19 skipped (5460)
node ./node_modules/vitest/vitest.mjs run test/ownership-filter-guard.test.ts   # 13 passed (13)

# A-2 · los parseos hostiles (van al docblock del leaf, con el sha)
node -e "
console.log(Number.parseInt('1e9',10), Number.parseInt(' 2',10), Number.parseInt('2abc',10));
console.log(Number.parseInt('0x10',10), Number(''));
console.log(/^[0-9]{1,3}\$/.test('1e9'));
console.log(new URL('https://EXAMPLE.com./x').hostname);      // example.com.   ⚠️
console.log(new URL('https://EXAMPLE.COM/x').hostname);       // example.com
console.log(new URL('https://пример.рф/').hostname);          // xn--e1afmkfd.xn--p1ai
console.log(new URL('https://gw.example.com:8443/').hostname, new URL('https://gw.example.com:8443/').port);
console.log(new URL('https://user:pw@gw.example.com/').hostname);
"

# A-3 · los 25 agentes de prod (AC-8). GRATIS y read-only: /discover no cobra.
#      ⛔ NO invoques /compose ni /orchestrate contra prod: mueven plata.
/usr/bin/curl -s --max-time 25 -X POST \
  https://wasiai-a2a-production.up.railway.app/discover \
  -H 'Content-Type: application/json' -d '{}' -o /tmp/disc.json
python3 -c "
import json,collections; from urllib.parse import urlparse
d=json.load(open('/tmp/disc.json')); print('total', d['total'])
c=collections.Counter(urlparse(a['invokeUrl']).hostname for a in d['agents'])
[print(f'{n:3d}  {h}') for h,n in c.most_common()]"

# A-4 · CD-20, antes de escribir el campo de W3
/usr/bin/grep -rn "vi.mock(.*adapters/registry" src/ test/ | wc -l      # F2.5 midió 63
node ./node_modules/vitest/vitest.mjs run \
  src/services/agent-card.test.ts src/routes/agent-card.test.ts \
  src/routes/agent-card.selfpublished.test.ts src/routes/capabilities.inbound-chains.test.ts

# A-5 · CD-11, al cierre de CADA wave
BASE=3823580
for f in $(git diff --name-only $BASE); do
  echo "=== $f"; git diff -U0 $BASE -- "$f" | /usr/bin/grep '^@@'
done

# A-6 · CD-21 (tiene que quedar vacío en src/ al cerrar W4)
/usr/bin/grep -rn "ningún campo de fee" src/ doc/

# A-7 · el leaf es leaf
/usr/bin/grep -c "^import" src/lib/contracting-chain.ts     # 0
```

---

## 16 · Divergencias medidas entre el SDD y el árbol de HOY (⚠️ no son ablandamientos)

Este Story File **no cambió ningún AC ni ningún CD**. Lo de abajo son mediciones de F2.5 que
**agregan** trabajo o precisan un número. Van acá, aparte, para que AR/CR las juzguen.

1. 🔴 **El SDD dice "TRES sitios" y son CUATRO, y se contradice a sí mismo.** Su §4.3 se titula *"La
   Capa 1 vive en TRES sitios"* y su hallazgo M-1 dice *"El guard de Capa 1 vive en TRES sitios, no
   uno"*, pero enumera **§4.3.1, §4.3.2, §4.3.3 y §4.3.4** y su propio Readiness Check (ítem 4) dice
   **"✅ §4.3 (4 sitios)"**. **Manda CUATRO** (§4). Precisión que el SDD tampoco reparte: **tres de
   los cuatro son guards de dinero** (cada uno corta antes de un débito distinto) y el cuarto no lo
   es (CD-17). Los **dos** que el work-item no tenía —y que son el aporte de M-1— son el Sitio 1 y el
   Sitio 2.
2. 🔴 **Tres mocks TIPADOS rompen `tsc` al extender `resolveAgentDestination`**, y el SDD dice "un
   solo call-site en producción" sin mencionarlos: `src/routes/compose.test.ts:416-419`,
   `src/routes/compose.no-debit-on-abort.test.ts:241-244`,
   `src/__tests__/e2e/compose-flow.test.ts:230`. **Sin editarlos, W1 no compila.** Más una cuarta que
   no rompe tsc pero sí el runtime: el factory de `src/middleware/x402.non-evm-inbound.test.ts:143-147`
   devuelve `{slug, registry, payment}` **sin `invokeUrl`**, y por eso `isSelfDestination` acepta
   `string | undefined` sin tirar (§4.1, TRAMPA 1). **Y editar esos fixtures es CD-22**: hay que
   re-contar los rojos de `MUT-02` después.
3. 🔴 **`/health` está DUPLICADO en `src/__tests__/e2e/setup.ts:341-358`** y el SDD sólo dice que vive
   inline en `src/index.ts`. El propio código lo advierte (`src/index.ts:250-252`). **El campo
   `contractingGuard` va en los DOS**, o el e2e afirma un `/health` que no es el de prod.
4. 🔴 **`src/routes/well-known.ts` NO TIENE SUITE PROPIA** (medido: en `src/routes/` sólo existe
   `well-known.ts`). `T-CARD-1/2/3` implican **crear** `src/routes/well-known.test.ts`, que el SDD no
   lista.
5. 🔴 **`T-CARD-4` no puede vivir en `capabilities.inbound-chains.test.ts`**: ese archivo **mockea
   `../services/agent-card.js` completo** (`:80-93`, con `skills: []` en `:88`), así que es **inmune**
   a los cambios de la carta; y su `Object.keys` de `:252` congela sólo el **top-level** de
   `/capabilities`. Va en `well-known.test.ts` o en `src/services/agent-card.test.ts` (que no mockea
   nada). El SDD lo daba por vivible ahí.
6. **La medición de CD-20 ya está hecha, y da hazard CERO hoy**: 63 archivos mockean
   `adapters/registry`, **53 sin `getInboundPaymentChainKeys`**, pero de los que cargan un consumidor
   de la carta **el único que lo mockea es `src/__tests__/e2e/setup.ts:168-173` y SÍ lo declara** (con
   `importOriginal`). ⇒ **camino A viable**. Igual hay que **re-medirlo** en W3: es una propiedad del
   árbol, no del SDD.
7. **La tabla de tests del SDD tiene 43 filas, no 36.** Su Readiness Check ítem 12 dice "§7 (36
   tests)". Contadas una por una: 43 (§10 acá, con una fila más: `T-FLAG-1`, el control ejecutable de
   CD-1, que el SDD dejaba sin test). ⇒ **44 en este Story File**.
8. **Colisión de nombres en el SDD**: `M-1..M-5` son sus **hallazgos** y `M-1..M-16` son sus
   **mutantes**. "M-1" significa dos cosas. Acá los mutantes son `MUT-01..MUT-16` (§11.3).
9. **`resolveComposePriceHandler` empieza en `:688`, no en `:700`.** El SDD la cita como `:700-838`;
   `:700` es el `if (steps.length === 0)`. El rango real de la función es **`:688-838`**.
10. **`src/routes/compose.ts:259` es un campo de `log.warn`, no un body de respuesta.** El SDD lo
    lista en la familia "preHandler, rechazo de dominio" junto a `:721`/`:758`/`:835`, que sí son
    `reply.send`. No cambia la conclusión (los guards nuevos usan `error_code`), pero el ejemplo no
    sirve como precedente de shape de respuesta.
11. **El hallazgo colateral está CONFIRMADO por medición propia**: el docblock de
    `src/lib/self-published-auth.ts:82` dice *"(minúsculas, punycode, sin punto final)"* y
    `new URL('https://EXAMPLE.com./x').hostname` devuelve **`'example.com.'`**. ⇒ §3.2 **PROHÍBE**
    reusar `canonicalizeHostKey` para la identidad del guard, con el motivo escrito. El arreglo de esa
    prosa queda como **NC-6, fuera de scope**.
12. **Largos que el SDD dice de más o de menos, sin consecuencia pero para que nadie los re-mida**:
    `src/lib/self-published-auth.ts` tiene **252** líneas (el SDD dice 253) y `src/routes/compose.ts`
    tiene **1132** (el work-item dice 1133).
13. **`assertSelfPublishedAuthEnv()` devuelve `string[]`**, no `string | null`. El patrón "throw si
    ilegible / texto de warn si ausente / null si OK" que `assertSelfHostsEnv` tiene que copiar es el
    de **`assertDepositMinimumEnv` (`src/lib/env.ts:107-131`)**. El SDD cita los dos exemplars sin
    distinguir cuál firma se copia.
14. **Los conteos del SDD que RE-VERIFIQUÉ y COINCIDEN** (los digo para que nadie los re-mida por las
    dudas): suite `280 passed | 6 skipped` / `5441 passed | 19 skipped`, exit 0 · `tsc --noEmit` 0 ·
    ownership guard `13 passed (13)` · prod `total 25` con 22/3 y **0 al gateway** · carta de prod con
    **9 claves** y `schemes: []` · `MAX_COMPOSE_STEPS = 5` · `PLACEHOLDER_FEE_USD = 1.0` ·
    `getProtocolFeeRate` default `0.01`, rango `[0.0, 0.10]` · `MAX_REDIRECT_HOPS = 5` y
    `CREDENTIAL_HEADERS` de **4** nombres · `orchestrateRateLimit` **10 / 60000** · `TRUST_PROXY`
    default **`false`** · `deriveTables()` en `test/ownership-filter-guard.scanner.ts:243` · la fila
    `223` en `doc/sdd/_INDEX.md:215` · `acceptsInboundPayment` en `registry.ts:522` y
    `getInboundPaymentChainKeys` en `:532` · el débito del step-0 de `/compose` en
    `src/middleware/a2a-key.ts:1222`/`:1231` · **todos** los `archivo:línea` de §3, §4, §5 y §9.
15. **Lo que NO cambié y me pareció discutible** (queda para AR, no lo toqué): el SDD deja la forma
    del corte del **Sitio 2** sin fijar (`executeApprovedPlan` no tiene `reply`). Lo prescribí por el
    canal que ese método ya usa para cortes pre-débito (el patrón del `__quoteStale` de
    `src/services/orchestrate.ts:1109-1113`), porque estrenar un `throw` en ese punto pasaría por el
    catch del route y perdería el `error_code`. Si AR prefiere otra forma, es un cambio chico — pero
    entonces hay que decidir **qué status devuelve `/orchestrate/execute`** para un corte que no es
    `QUOTE_STALE`.

---

## 17 · Done Definition

- [ ] Los **12 AC** implementados, cada uno con ≥1 test que lo cubre (mapa en §2).
- [ ] `./node_modules/.bin/tsc --noEmit` → **exit 0**.
- [ ] `node ./node_modules/vitest/vitest.mjs run` **todo verde**, con `Test Files` y `Tests` **por
      encima** del baseline `280/5441`, y **cero** tests preexistentes movidos sin explicación.
- [ ] `test/ownership-filter-guard.test.ts` sigue en **`13 passed (13)`** (§12).
- [ ] **CD-3 medido en los TRES caminos de débito**: `T-L1-1`, `T-L1-2`, `T-L1-3` verdes **con sus
      asserts de ORDEN** (cero llamadas a `debit`), y `MUT-01/02/03` **corridos y muertos**.
- [ ] **CD-17**: el Sitio 4 tiene su comentario, loguea a **`error`**, y `T-L1-7` verde. **Ningún
      texto** de la HU lo presenta como el guard de dinero.
- [ ] **CD-14**: `T-DEPTH-2/3/4` verdes; `/usr/bin/grep -n "parseInt\|Number(" src/lib/contracting-chain.ts`
      **no** devuelve nada en el camino de la profundidad.
- [ ] **CD-16**: `T-CHAIN-1` verde **con el espía sobre `split`** (no sólo con el 400).
- [ ] **CD-1**: `T-FLAG-1` verde. **Cero envs nuevas gatean el corte.**
- [ ] **CD-6**: la nota best-effort está en el **body** del error y sale de la constante del leaf
      (`T-L2-2`).
- [ ] **CD-7**: los gemelos positivos verdes: `T-L1+1/+2/+3`, `T-L2+1/+2`, `T-FEE-6`, `T-CARD-4`.
- [ ] **AC-8 medido con el número**: `T-L1+2` usa **los dos hosts reales de prod** y los dos pasan.
- [ ] **CD-21**: `src/routes/compose.ts:1050-1053` reescrito **en el commit de W4**, y
      `/usr/bin/grep -rn "ningún campo de fee" src/` **vacío**.
- [ ] **CD-5**: ningún `0` fabricado. `T-FEE-2/3/5` y `T-CARD-6` verdes.
- [ ] **CD-11**: el barrido de §7 corrido **como tarea propia** al cierre de cada wave, con las citas
      re-medidas por **CONTENIDO**.
- [ ] **CD-12 / §11**: los **18** mutantes (16 + 2 de calibración) **CORRIDOS**, sin pipes,
      restauración verificada con `md5sum`, y **cada uno anotado con `(MEDIDO: exit=N, M rojos, en
      <sha>)`**. Los dos de calibración **primero**.
- [ ] **CD-22**: los 4 fixtures de §3.6 editados **con re-conteo** de los rojos del mutante afectado.
- [ ] **CD-20**: la medición del hazard de `adapters/registry` corrida en W3, con su número y su sha,
      y el camino (A o B) **justificado por el número**.
- [ ] **§1.2 respetado**: ninguna frase del código, de un comentario, del commit message, del
      `auto-blindaje.md` ni del resumen al orquestador afirma que (a) el bucle transitivo está cerrado
      contra un adversario, (b) el bypass por IP literal está cerrado, o (c) hay drenaje de fondos en
      curso hoy.
- [ ] **Los residuales y NC de §13 siguen marcados**, ninguno convertido en afirmación.
- [ ] **Un commit por wave**, con el criterio de salida **corrido** y sus números en el mensaje.
      ⚠️ **Comillas SIMPLES o `-F`**: los backticks en `git commit -m "..."` **se ejecutan**.
- [ ] `git status --short` sin nada que no sea de la HU.
- [ ] `auto-blindaje.md` escrito: **cada** error tuyo, con causa raíz y "aplicar en".
- [ ] Cada artefacto declarado escrito, verificado con **`ls -l` Y `git ls-tree`** (son dos fallas
      distintas).
- [ ] ⛔ **Cero commits** que el orquestador no haya pedido. ⛔ **Cero `_INDEX.md`**. ⛔ **Cero
      `chaski-v3`, cero `wt-*`.**
