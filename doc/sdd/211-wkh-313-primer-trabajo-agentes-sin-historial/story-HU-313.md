# Story File — HU WKH-313: el carril de estreno para agentes sin historial

> SDD (autoritativo, leelo antes de codear): `doc/sdd/211-wkh-313-primer-trabajo-agentes-sin-historial/sdd.md`
> Work item: `doc/sdd/211-wkh-313-primer-trabajo-agentes-sin-historial/work-item.md`
> Worktree: `/home/ferdev/.openclaw/workspace/wt-313` · Branch: `feat/211-wkh-313-primer-trabajo`
> Modo: **QUALITY** · **money-path** (toca selección de agente) · Estimación **M**
> Repo secundario (**BLOQUEADO**, ver §1): `chaski-v3`
> Verificación de anclas: **2026-07-29**, con `Read`/`Grep` sobre este worktree

Este archivo es tu contrato. **No repite el SDD**: lo referencia por sección (§). Lo que sí está
completo acá es lo que no se puede perder en la traducción a tareas.

---

## 0. Qué se construye, en cuatro frases

`GET /discover?capabilities=remittance-payout&minReputation=2` devuelve **0 agentes** hoy, en vivo:
el único agente que sirve esa capacidad nunca trabajó, así que no tiene score, y el fail-safe del
filtro lo cuenta 0 (`discovery.ts:422-428`). Chaski fija ese piso de 2 en los dos legs de payout, así
que **el leg que entrega la plata no resuelve**.

Esta HU agrega un **carril de estreno**: un agente sin historial puede ser admitido bajo el piso
**sólo si el que consulta lo pide** (`allowTrial` / `constraints.allow_trial`), **conservando su
puntaje real** (o sea: 0, o sea **último en el ranking**), acotado por tres formas de agotamiento
(N liquidadas, primer `failed`, techo de piso T) y por un cupo M por publicador. El piso de Chaski
**se queda en 2**: no se baja nada.

El estado sale de la **misma** query de `a2a_events` que ya alimenta la reputación. Cero persistencia
nueva. Y la lectura devuelve un **tercer valor explícito** (`degraded`): si no pudimos preguntar por
el historial, **no se admite a nadie**.

---

## 1. ⛔⛔ W0.3 (`chaski-v3`) — **NO EJECUTAR** ⛔⛔

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║                                                                                  ║
║   W0.3 ESTÁ BLOQUEADA. NO ABRAS UN EDITOR SOBRE `chaski-v3` EN ESTA HU.           ║
║                                                                                  ║
║   NO edites, NO crees ramas, NO corras tests, NO commitees NADA en                ║
║   /home/ferdev/.openclaw/workspace/chaski-v3                                     ║
║   (sólo LECTURA, y NUNCA `chaski-v3/m5-keys/`).                                   ║
║                                                                                  ║
║   MOTIVO: CD-13 del SDD prohíbe habilitar `allow_trial` en un leg de              ║
║   desembolso a persona física sin un control compensatorio ELEGIDO POR            ║
║   ESCRITO. Los cuatro insumos que W0.3 necesita son `[DECIDE FOUNDER]`            ║
║   (SDD §5) y ninguno tiene respuesta al 2026-07-29:                               ║
║                                                                                  ║
║     N  = liquidadas que dura el estreno        (propuesta 3)   → sin ratificar    ║
║     T  = techo de piso bajo el que aplica      (propuesta 10)  → sin ratificar    ║
║     M  = agentes en estreno por publicador     (propuesta 2)   → sin ratificar    ║
║     CC = control compensatorio del leg de payout (§3.4 SDD)    → SIN ELEGIR       ║
║                                                                                  ║
║   Sin CC elegido, W0.3 no se entrega y la demo no se destraba. Eso NO es una      ║
║   licencia para elegirlo vos. Es un gate de founder.                             ║
║                                                                                  ║
╚══════════════════════════════════════════════════════════════════════════════════╝
```

### 1.1 Qué destraba cada valor (para que el gate sea corto cuando el founder despierte)

| Valor | Qué destraba | Si el founder no contesta |
|---|---|---|
| **N** | Nada en W0.1/W0.2: entra como **env con default 3**. Ratificarlo es cambiar un número de config, no código | W0.1/W0.2 **igual se entregan** con el default documentado como provisorio |
| **T** | Ídem: env con default 10 | Ídem |
| **M** | Ídem: env con default 2 | Ídem |
| **CC** (§3.4 SDD) | **Sólo W0.3.** Es lo único verdaderamente bloqueante | W0.3 no se entrega. El carril queda disponible para capacidades que **no** desembolsan |

**Dato nuevo que este Story File aporta al gate del founder (verificado hoy, no estaba medido en el
SDD §10.3):** **CC-2 es verificable en código y hoy se cumple.**
`chaski-v3/src/infrastructure/chain.ts:99-131` tipa el cluster Solana como el literal `"devnet"`
(`cluster: "devnet"; // única entrada en esta HU`) y `resolveSolanaNetworkConfig()` devuelve
`SOLANA_DEVNET` sin ninguna rama alternativa; `chaski-v3/src/infrastructure/settlement/deposit-attestation.ts:173`
rechaza (`return null`) todo cluster que no sea `"devnet"`. O sea: un gate «estreno sólo con rail
no-mainnet» es hoy **una condición que el código ya satisface y que el compilador defiende**. Eso
hace de CC-2 la opción de costo cero para la semana del 2026-08-03. **Elegirlo sigue siendo del
founder** — este párrafo es insumo para su decisión, no la decisión.

### 1.2 W0.3 planificada (para cuando se desbloquee — NO la ejecutes ahora)

Repo `chaski-v3`, **rama propia, PR propio, otro escritor** (un escritor por repo). Bloqueada además
por W0.1+W0.2 **mergeadas y deployadas** (el gateway tiene que aceptar la clave nueva antes de que
Chaski la mande, si no `compose-step-shape` devuelve **400 `unsupported constraint`**).

| # | Archivo:línea (verificado 2026-07-29) | Qué cambia |
|---|---|---|
| W0.3-a | `src/infrastructure/a2a/gateway-client.ts:32-35` (`export type GatewayConstraints = {`) | Agregar `allow_trial?: boolean`. **Sin esto no compila** (TS2353) mandarlo. **`PAYOUT_MIN_REPUTATION = 2` de `:29` NO se toca** (CD-12) |
| W0.3-b | `app/api/payout/prepare/route.ts:243` (`constraints: { min_reputation: PAYOUT_MIN_REPUTATION }, // CD-5: NUNCA omitir`) | → `{ min_reputation: PAYOUT_MIN_REPUTATION, allow_trial: <CC cumplido> }` |
| W0.3-c | `app/api/a2a/payout/submit/route.ts:390` (mismo literal, `// CD-5/CD-11: MISMO par que prepare`) | Ídem, y **el mismo par que `prepare`**: los dos legs tienen que resolver al MISMO agente (R-4 del SDD) |
| W0.3-d | el control compensatorio elegido (§3.4 SDD) | Vive en Chaski. Con CC-2: gatear `allow_trial` en `resolveSolanaNetworkConfig().cluster === "devnet"` (y para el rail EVM, en un chainId no-mainnet) |
| W0.3-e | `src/infrastructure/a2a/gateway-client.test.ts:117,125` · `app/api/a2a/payout/submit/route.test.ts:1239` · `app/api/payout/prepare/route.test.ts:656` | Los 4 hacen `toEqual({ min_reputation: ... })`, o sea **igualdad exacta**: se ponen rojos al agregar la clave. Se actualizan, **pero `expect(PAYOUT_MIN_REPUTATION).toBeGreaterThan(0)` (`:1240`, `:657`) se CONSERVA intacto** |
| W0.3-f | test nuevo = **T-07** (§6) | `allow_trial` viaja **sólo** cuando el CC se cumple. Mata M7 |

No hace falta tocar el serializador: `gateway-client.ts:177-181` spreadea `constraints` completo
(`...(s.constraints ? { constraints: s.constraints } : {})`), así que la clave nueva viaja sola una
vez que el tipo la admite.

---

## 2. Las siete cosas que no podés diluir al bajarlas a código

Si algo de esta sección no te cierra, **parate y preguntá**. Cada punto es la razón de ser de una
tarea, y es lo que AR va a atacar.

### 2.1 El agente admitido conserva su puntaje real (0) y por eso **ordena último**

Es lo que hace que el carril **no sea un atajo**. El comparador de `discovery.ts:455-463` y el
`repValue` de `:437-440` quedan **byte-idénticos**. Un agente en estreno **nunca** recibe un score
fabricado: entra al conjunto con `computedReputation` **ausente** (o con su score real bajo), así que
`repValue` le da 0 y sólo puede ser elegido cuando **ningún** agente pasa por mérito.

La forma del predicado de admisión **no es negociable**:

```
admitido = (scoreReal >= min)  ||  (trialAdmitido)
             ^^^^^^^^^^^^^^^^     rama de HOY, primero, intacta
```

**PROHIBIDO** escribirlo como `trialAdmitido ? true : scoreReal >= min` invertido, como un `score`
sintético (`score: min`) para "que pase", o como una reasignación de `a.computedReputation`. Cualquiera
de las tres viola **CD-6** y las cazan T-06 (M6) y T-01.

### 2.2 El carril se agota de **tres** formas, y ninguna necesita que alguien intervenga

| Vía | Regla | Nunca |
|---|---|---|
| **Por éxito** | `tasksSettled` llega a **N** ⟹ fuera del carril, se sostiene con su score real (3 liquidadas ⇒ score 6) | No es un contador que alguien decremente |
| **Por fallo** | el **primer** `failed` (`failedCount >= 1`) **ANULA** el carril | **NO es un decremento, NO es "le quedan N-1"**. Es anulación (CD-14) |
| **Por techo** | el que consulta pide `min > T` ⟹ no hay estreno | Pidió un agente probado; el carril no lo finge |

### 2.3 Cupo **M** por publicador, retenidos los **M más antiguos por `created_at`**

Determinista. **PROHIBIDO** el orden del arreglo, **PROHIBIDO** el tiebreak aleatorio de
`lib/ranking-tiebreak.ts` (CD-15). Ante `created_at` empatado, el desempate es `slug` ascendente
(también determinista) — ver §3.3 sobre por qué esto hacía falta.

Por qué el cupo va **antes** de que W0.3 se encienda, y no después (SDD §6): hoy `remittance-payout`
no tiene **ningún** agente con score, así que dos candidatos en estreno empatan en 0 y el desempate
es **aleatorio** (`discovery.ts:454`). Un sybil que publique la misma capability tendría ~50% de
quedarse con el `depositAddress` contra el que el usuario firma el principal de la remesa. Sin cupo,
la ventana de robo es más barata que la remesa que roba.

### 2.4 El standing se lee de una consulta **NO DEGRADADA** — es el bug sistémico del proyecto

Hoy `computeReputationBatch` devuelve **el mismo `Map` vacío** para "nadie tiene historial" y para
"la query falló" (`reputation.ts:242-253`), y `attachReputations` se traga el throw con `catch {}`
(`discovery.ts:550-552`). Con el carril de estreno eso deja de ser inocuo: **"no pude preguntar" se
leería como "no tiene historial" y admitiría a cualquiera bajo el piso.** Es el defecto de clase que
HU-307 pagó siete veces.

Dos consecuencias que tenés que implementar juntas:

1. `computeStandingBatch` devuelve `{ degraded: boolean; standings: Map<...> }`. `degraded: true` ⟹
   **nadie entra por estreno** (y el `excluded` de la respuesta lo dice).
2. **La ausencia de un slug en el Map significa "cero eventos" SÓLO cuando `degraded === false`.**
   Un agente sin ninguna fila en `a2a_events` no aparece en el Map y **es** un `newcomer` legítimo.
   El mismo Map, con `degraded: true`, no autoriza **nada**. La regla se escribe **una vez**, en un
   helper (`standingFor`), y **PROHIBIDO** leer `standings.get(slug)` crudo en el filtro.

Lo mismo vale para el lector del ancla de publicación: si la query de `a2a_agents` falla, **no se
admite a nadie** (no "no tiene ancla ⟹ pasa"). Fail-closed, sin excepción por "es sólo un caso borde".

### 2.5 Opt-in del consumidor. El gateway **no relaja en silencio** un piso que el caller pidió

Default = **no admitir**. Un consumidor que no cambia nada obtiene el comportamiento de hoy, byte por
byte, **incluido el costo de I/O**: sin `allowTrial`, **cero queries nuevas** (CD-9, T-13). El piso de
Chaski se queda en 2 (CD-12) y Chaski manda `allow_trial: true` — cuando W0.3 se desbloquee.

Que el gateway ignore por su cuenta un piso que el caller pidió es **el mismo defecto** que este repo
ya rechaza por escrito dos veces (`discovery.ts:412-417`, `compose-step-shape.ts:148-155`), con el
signo invertido y sobre el camino del dinero.

### 2.6 `verified` **NO se usa** para nada en esta HU

No es requisito de elegibilidad, no es control compensatorio, no se lee, no se escribe, no se
menciona en un predicado. Está **hardcodeado `false`** para todo self-published
(`src/services/agent.ts:141`, `verified: false`) y **no es alcanzable self-service** — el binding
ERC-8004 verificado on-chain sólo asigna `a.identity` (`discovery.ts:528`), que es **otro campo**.
Exigir `verified` rompería los tres legs del flujo insignia y no arreglaría ninguno. Sería teatro.

> El work-item §3 dice que `verified` tiene salida self-service. **Es incorrecto** y el SDD §1 lo
> corrige con archivo:línea. No implementes contra el work-item en este punto.

### 2.7 Ambigüedad del SDD que tuve que resolver para poder darte tareas — **leela**

El SDD tiene **dos lecturas incompatibles** de cuándo un agente es `newcomer`:

- **§3.1 (tabla)**: `newcomer` ⟺ `tasksSettled == 0 && failedCount == 0`.
- **§3.1 (agotamiento) + §3.2 + §3.3(c) + T-04**: el carril dura hasta `tasksSettled = N` (propuesto
  **3**), «*el agente sale del carril y se sostiene con su score real (3 liquidadas ⇒ score 6)*»,
  «*entra al conjunto con su `computedReputation` ausente **(o su score real bajo)***», y T-04 pide
  frontera exacta **N-1 admite, N no**.

Con `N = 3` las dos no pueden ser ciertas a la vez: si `newcomer` exigiera 0 liquidadas, `N` sería
inevitablemente 1 y T-04 no tendría frontera que probar. **Implementá la segunda lectura** (es la que
tres secciones y un test sostienen, y la única para la que el §3.3(c) del SDD hace aritmética):

```
elegible  ⟺  failedCount === 0  &&  tasksSettled < N  &&  min <= T
penalized ⟺  failedCount >= 1   &&  tasksSettled < N          (carril anulado)
scored    ⟺  tasksSettled >= N                                 (fuera del carril, mérito puro)
unknown   ⟺  degraded === true                                 (nunca elegible)
```

**No hay regresión** por esto: la rama de mérito (`scoreReal >= min`) corre **primero y sin cambios**,
así que el comportamiento de hoy es un subconjunto estricto del nuevo. Un agente con 1 liquidada y 0
fallos tiene score 2 real, **pasa el piso 2 por mérito** exactamente como hoy, y además sería elegible
para el carril si el piso fuera más alto y el caller optara.

**Consecuencia de tipos, declarada como desviación:** la firma literal de **DT-4** del SDD
(`AgentStanding = {kind:'scored'; reputation} | {kind:'newcomer'} | {kind:'penalized'}`) **no puede
expresar** un agente con 1-2 liquidadas que es a la vez elegible y **tiene** reputación real que hay
que adjuntar. Por eso el standing lleva **contadores** y la clasificación es una función **pura**
sobre ellos (§4.1). Se respeta el espíritu de DT-4 y CD-8 (una sola expresión del predicado, una sola
expresión del score, `degraded` explícito) pero **no la firma literal**. Está reportado al orquestador
como desviación a ratificar en AR. **Si AR la rechaza, la corrección es de tipos, no de política.**

---

## 3. Contratos nuevos (los escribís en W0.1, todo lo demás depende de ellos)

### 3.1 `src/types/index.ts`

Ancla: **después** de `AgentReputation` (`:303-322`), antes de `AgentCardIdentity` (`:340`).

```ts
/** WKH-313 — contadores crudos del standing. Salen del MISMO accumulator y la
 *  MISMA query que el score (CD-8): no hay una segunda expresión de la cuenta. */
export interface AgentStandingCounters {
  /** Liquidadas pagas, YA capeadas por caller (K) — misma cuenta que alimenta el score. */
  tasksSettled: number;
  successCount: number;
  failedCount: number;
  /** El score real. `null` ⟺ tasksSettled === 0. NUNCA se fabrica (CD-6/AC-7). */
  reputation: AgentReputation | null;
}

/** WKH-313 — clasificación DERIVADA (función pura, `lib/trial-standing.ts`). NO es
 *  campo público de `Agent` (DT-6/CD-10): publicar `penalized` sería una letra escarlata
 *  sin contrato. */
export type AgentStandingKind = 'scored' | 'newcomer' | 'penalized';

/** WKH-313 — resultado del batch. `degraded` es un TERCER valor explícito: NO es un Map
 *  vacío (CD-7). Con `degraded: true` no se admite a NADIE por estreno. */
export interface AgentStandingBatch {
  degraded: boolean;
  standings: Map<string, AgentStandingCounters>;
}
```

Y el badge, **lo único que se surfacea** del carril (ancla: dentro de `Agent`, después de
`computedReputation` en `:294`):

```ts
/** WKH-313 (AC-2/DT-3) — el agente entró bajo el piso por el carril de estreno. El campo
 *  SÓLO existe cuando la admisión ocurrió: un piso relajado en silencio es la clase de bug
 *  que este repo rechaza por escrito. NO lleva `owner_ref` ni la clasificación de standing
 *  (CD-10). */
export interface AgentTrialAdmission {
  granted: true;
  /** El piso que el caller pidió y que este agente NO alcanza por mérito. */
  under_min_reputation: number;
  /** Liquidadas pagas acumuladas (0..N-1). Es el contador que agota el carril. */
  tasks_settled: number;
  /** Las que le quedan de estreno: N - tasks_settled. */
  remaining_settled_tasks: number;
}
```

Cambios en tipos existentes:

| Ancla | Cambio |
|---|---|
| `Agent` (`:263-295`), tras `computedReputation` (`:294`) | `trial?: AgentTrialAdmission;` |
| `DiscoveryQuery` (`:350-374`), tras `minReputation` (`:354`) | `allowTrial?: boolean \| undefined;` con el JSDoc del opt-in (§2.5) |
| `DiscoveryResult.excluded` (`:387`, hoy `{ scope: number }`) | → `{ scope: number; reputation: number; trialAvailable: number }`. **Rompe el typecheck de `capability-resolver.test.ts:133`** (`excluded: { scope: 3 }`): ese doble se actualiza, no se afloja el tipo |
| `ComposeStepConstraints` (`:429-438`), tras `min_reputation` (`:437`) | `allow_trial?: boolean;` (snake_case, como sus dos hermanas — DT-7) |

### 3.2 `src/services/reputation.ts` — la lectura (W0.1)

| Ancla por contenido | Qué hacés |
|---|---|
| `interface RepAccumulator {` (`:72-82`) | **No se toca.** Ya tiene `successCount`, `failedCount` y `settledByCaller`: los tres contadores que hoy se descartan |
| `function computeFromAccumulator(acc: RepAccumulator)` (`:138-171`) | **No se toca la fórmula.** Extraé el cálculo de `tasksSettled` capeado (`:144-146`) a un helper `cappedSettled(acc)` que **las dos** funciones usan, para que no haya dos expresiones del cap (CD-8) |
| `interface ReputationService {` (`:173-188`) | Agregá `computeStandingBatch(slugs: string[]): Promise<AgentStandingBatch>` |
| `async computeReputationBatch(` (`:228-276`) | **Se DERIVA de `computeStandingBatch`**: llama, mapea `standings` → `Map<slug, AgentReputation>` quedándose sólo con `reputation !== null`. Contrato externo **idéntico**: `degraded` ⟹ Map vacío. Con eso `discovery.minreputation.test.ts:218-228` (T-8) sigue verde sin tocarlo |
| el `if (error)` del batch (`:242-253`) | Se muda a `computeStandingBatch`: loguea igual (código, nunca `error.message`) y devuelve `{ degraded: true, standings: new Map() }` |

**Un solo SELECT** (`.in('agent_id', slugs)`, CD-12/anti-N+1). `slugs.length === 0` ⟹
`{ degraded: false, standings: new Map() }` **sin tocar la DB**. `computeReputationForAgent` y su
cache **no se tocan**.

### 3.3 `src/lib/trial-standing.ts` — la política (W0.1, archivo NUEVO)

Módulo **leaf**: sin imports de services ni de `lib/supabase.js`. El motivo está escrito en
`lib/discovery-query.ts:1-10` (los tests de rutas mockean el service completo). Acá viven **N, T, M y
el predicado, una sola vez** (CD-8).

```ts
resolveTrialMaxSettledTasks():       number   // env TRIAL_MAX_SETTLED_TASKS,        default 3
resolveTrialMaxMinReputation():      number   // env TRIAL_MAX_MIN_REPUTATION,       default 10
resolveTrialMaxAgentsPerPublisher(): number   // env TRIAL_MAX_AGENTS_PER_PUBLISHER, default 2

classifyStanding(c: AgentStandingCounters, n = resolveTrialMaxSettledTasks()): AgentStandingKind
isTrialEligible(c: AgentStandingCounters, min: number): boolean   // el ÚNICO predicado
standingFor(slug, batch): AgentStandingCounters | 'unknown'       // §2.4 — degraded ⟹ 'unknown'
selectTrialAdmitted(cands: TrialCandidate[], m = resolve...): Set<string>  // cupo determinista
```

Reglas de estos helpers, todas exigibles:

- **Patrón de env**: idéntico a `resolveScaleFactor` (`reputation.ts:36-40`) —
  `Number.parseInt` + `Number.isFinite(n) && n > 0 ? n : default`. **DT-8**: ausente/inválida ⟹ el
  default, y el default es el valor **conservador**, nunca el permisivo. Una env que no está **no
  apaga el control**.
- `isTrialEligible` es **la única** escritura del predicado. La usan: el filtro, el contador
  `trialAvailable`, el badge y la preselección del cupo (**CD-8**, guard T-17/M17).
- `selectTrialAdmitted` ordena por `(createdAt ?? '', slug)` **ascendente** y toma los primeros M
  **por ancla**. `createdAt` sólo existe para self-published (`a2a_agents.created_at`); para agentes
  federados el `Agent` no lo trae (verificado: `types/index.ts:263-295` no tiene `created_at`), así
  que su orden es `slug` ascendente — determinista igual, y el ancla federada es `registry_id`, o sea
  que sólo decide entre agentes **del mismo registry**. **Es una concreción mía**, no está en el SDD:
  márcala para AR.
- **`slug` como desempate final es obligatorio**: dos filas pueden tener el mismo `created_at` y en
  ese caso el orden del arreglo volvería a decidir — exactamente lo que CD-15 prohíbe. Lo canda T-19.

### 3.4 `.env.example` (W0.1) — ancla: después de `REPUTATION_MAX_TASKS_PER_CALLER=5` (`:848`)

Las tres envs, con el comentario que dice **textualmente** que los valores son **provisorios y
pendientes de ratificación del founder** (SDD §5, `[DECIDE FOUNDER]`), y que la ausencia de la env no
apaga el control. Ejemplo del tono requerido:

```
# WKH-313 — carril de estreno. Los TRES valores son PROVISORIOS (propuesta del SDD §5,
# pendientes de ratificación del founder). Ausente/inválida → el default de código, que es
# el valor CONSERVADOR: la env que falta NO apaga el control.
TRIAL_MAX_SETTLED_TASKS=3          # N — liquidadas pagas que dura el estreno
TRIAL_MAX_MIN_REPUTATION=10        # T — piso máximo bajo el cual aplica el estreno
TRIAL_MAX_AGENTS_PER_PUBLISHER=2   # M — agentes en estreno por publicador
```

**PROHIBIDO** hardcodear 3, 10 o 2 en `discovery.ts`, en `reputation.ts` o en un test que no sea el
del resolver de la env. Cambiarlos después tiene que ser un valor de config, no un cambio de código.

---

## 4. Scope IN — tareas, con ancla, AC, test y mutante

Las líneas están verificadas al **2026-07-29**; **anclá por contenido**, no por número (otras HUs en
vuelo mueven líneas). "Mutante" = la mutación que **debe** poner rojo al test nombrado.

### W0.0 — preparación (sin código)

| # | Tarea | Detalle |
|---|---|---|
| 0.0.1 | `npm ci` en `/home/ferdev/.openclaw/workspace/wt-313` | **El worktree NO tiene `node_modules`** (verificado). Sin esto no corre nada |
| 0.0.2 | Registrar el **baseline** de la suite | `npm test` en limpio. Anotá `N passed \| M skipped` en el done-report: el delta se declara, no se esconde |

### W0.1 — standing de tres estados + `degraded` explícito (**serial, gate**)

| # | Archivo:línea · ancla por contenido | Qué cambia | AC / CD | Test | Mutante |
|---|---|---|---|---|---|
| 1.1 | `src/types/index.ts:322` · tras `export interface AgentReputation { … }` | `AgentStandingCounters`, `AgentStandingKind`, `AgentStandingBatch` (§3.1) | DT-4, CD-7 | `tsc` | — |
| 1.2 | `src/lib/trial-standing.ts` · **archivo nuevo** | N/T/M por env + `classifyStanding` + `isTrialEligible` + `standingFor` + `selectTrialAdmitted` (§3.3) | DT-8, CD-8, CD-15 | `src/lib/trial-standing.test.ts` (nuevo) | **M12** (`<=`→`<` en el techo T), **M19** (empate de `created_at` resuelto por orden de arreglo) |
| 1.3 | `src/services/reputation.ts:144-146` · `const K = resolveMaxTasksPerCaller();` | Extraer `cappedSettled(acc)`; `computeFromAccumulator` **la usa** (una sola expresión del cap) | CD-8 | `reputation.test.ts` (existente, no-regresión) | — |
| 1.4 | `src/services/reputation.ts:228-276` · `async computeReputationBatch(` | Nace `computeStandingBatch`; `computeReputationBatch` **se deriva** de ella. El `if (error)` (`:242-253`) devuelve `{ degraded: true, standings: new Map() }` | **AC-9**, **CD-7** | **T-10** + `reputation.test.ts:268` (no-regresión: error ⟹ Map vacío) | **M10** (volver a devolver Map vacío indistinguible / tratar `degraded` como `newcomer`) |
| 1.5 | `src/services/reputation.ts:173-188` · `export interface ReputationService {` | Firma de `computeStandingBatch` | DT-4 | `tsc` | — |
| 1.6 | `.env.example:848` · tras `REPUTATION_MAX_TASKS_PER_CALLER=5` | Las 3 envs con la nota de provisionalidad (§3.4) | SDD §5 | `trial-standing.test.ts` (defaults + env inválida) | **M23** (default permisivo: `?? Infinity` en T, o `0` en M) |

**Verificación de W0.1**: `npx tsc --noEmit` limpio + `npm test` con la suite de reputación verde.
**Nadie empieza W0.2 antes de eso.**

### W0.2 — canal de admisión opt-in + cupo + superficie honesta

| # | Archivo:línea · ancla por contenido | Qué cambia | AC / CD | Test | Mutante |
|---|---|---|---|---|---|
| 2.1 | `src/lib/discovery-query.ts:112` · tras `export function parseLimit(` | `InvalidAllowTrialError` (`code: 'INVALID_ALLOW_TRIAL'`) + `parseAllowTrial(raw)`: ausente/`''`/`null` ⟹ `undefined`; `true`/`'true'` ⟹ `true`; `false`/`'false'` ⟹ `undefined`; **cualquier otra cosa ⟹ throw**. Patrón exacto de `parseMinReputation` (`:25-57`) | DT-7 | **T-14** (`discovery-query.test.ts`) | **M14b** (`Boolean(raw)` ⟹ `'maybe'` pasa como `true`) |
| 2.2 | `src/routes/discover.ts:23-44` · `function parseFiltersOr400(` | Suma `allowTrial` al retorno y `InvalidAllowTrialError` al `catch` (`:34-42`) | DT-7, AC-1 | **T-14** (`routes/discover.minreputation.test.ts`) | **M14c** (validar sólo en GET) |
| 2.3 | `src/routes/discover.ts:83-92` (Querystring) y `:129-138` (Body) + los dos `discoveryService.discover({…})` (`:104-113`, `:164-173`) | `allowTrial` en **GET y POST**, en **simetría**. Actualizar el JSDoc del contrato (`:51-78`) | DT-7 | **T-14** (GET y POST parsean igual) | **M14c** |
| 2.4 | `src/lib/compose-step-shape.ts:156` · `const allowed = new Set(['max_price_usdc', 'min_reputation']);` | Agregar `'allow_trial'` **y** validarlo booleano (no numérico: `validateNumericConstraint` no sirve). No-booleano ⟹ 400 `VALIDATION_ERROR` | DT-7 | **T-14** (`compose-step-shape.test.ts`) | **M14** (no agregarlo al allowlist ⟹ 400 `unsupported constraint`) |
| 2.5 | `src/services/agent.ts:440` · tras `async listAsAgents(): Promise<Agent[]> { … }` | `listPublisherAnchors(slugs: string[])`: **un** SELECT `slug, owner_ref, created_at` de `a2a_agents` con `.in('slug', slugs).eq('enabled', true)`. Devuelve **discriminado**: `{ degraded: true }` \| `{ degraded: false; anchors: Map<slug,{ownerRef,createdAt}> }`. **NUNCA throw, NUNCA Map vacío por error** | CD-7, CD-10, CD-12 | **T-11**, **T-21** | **M21** (error ⟹ Map vacío ⟹ "sin ancla, pasa igual") |
| 2.6 | `src/services/discovery.ts:542-554` · `async attachReputations(agents: Agent[])` | Pasa a devolver el `AgentStandingBatch` (usa `computeStandingBatch`). **El `catch {}` de `:550-552` deja de tragarse el fallo**: traduce a `{ degraded: true, standings: new Map() }`. Sigue adjuntando `computedReputation` **igual que hoy** (omitido si no hay) | AC-9, CD-7 | **T-10** | **M10** |
| 2.7 | `src/services/discovery.ts:402` · `await this.attachReputations(allAgents);` | Guardar el batch en una **local** (`const standingBatch = await …`). El standing **NO** es campo de `Agent` (DT-6) | CD-10 | **T-16** | **M16** (adjuntarlo como campo público) |
| 2.8 | `src/services/discovery.ts:422-428` · `if (query.minReputation != null) {` | **Dentro de ese mismo bloque** (CD-11: **NO MOVER** el filtro), el predicado pasa a `scoreReal >= min \|\| trialAdmitted.has(a.slug)`. `trialAdmitted` se calcula **antes del filter**, en el mismo bloque: (i) `eligible = allAgents.filter(a => isTrialEligible(standingFor(a.slug, batch), min))`; (ii) si `eligible.length > 0 && query.allowTrial === true` ⟹ leer anclas y `selectTrialAdmitted`; (iii) si no ⟹ `Set` vacío | **AC-4, AC-5, AC-8, AC-10, CD-6, CD-11, CD-14** | **T-02 T-04 T-05 T-06 T-09 T-11 T-12** | **M1 M4 M5 M6 M9 M11 M12** |
| 2.9 | ídem, tras armar `trialAdmitted` | Badge: para cada admitido, `a.trial = { granted: true, under_min_reputation: min, tasks_settled, remaining_settled_tasks }`. **Nunca** tocar `a.computedReputation` ni `a.reputation` | **AC-2**, CD-2, CD-6 | **T-02**, **T-06** | **M2** (admitir sin marcar), **M6** (score sintético) |
| 2.10 | `src/services/discovery.ts:367` · `let excludedByScope = 0;` y `:501` · `excluded: { scope: excludedByScope },` | Contar `excludedByReputation` (los que el piso descartó, **pre-sort/pre-slice**) y `trialAvailable`; devolverlos en `excluded`. El early-return de `:222` (`{ agents: [], total: 0, registries: [] }`) puede seguir omitiendo `excluded` (es opcional) | **AC-3**, CD-2, CD-8 | **T-03**, **T-17** | **M3** (contar post-`slice` o fijo 0), **M17** (predicado divergente en el contador), **M22** (contar al admitido también como excluido) |
| 2.11 | `src/services/capability-resolver.ts:100-102` · `if (constraints?.min_reputation !== undefined) {` | Mapear `constraints.allow_trial` → `query.allowTrial` | DT-7 | **T-15** | **M20b** (no mapearlo ⟹ Chaski pide y no pasa nada) |
| 2.12 | `src/services/capability-resolver.ts:162-165` · la clave del memo (`` `${capability}::${JSON.stringify({ p: …, r: … })}` ``) | **Agregar `allow_trial` a la clave.** Sin eso, dos steps de la misma capability con opt-in distinto comparten resolución: uno recibe un agente que **no pidió** aceptar | AC-2, R-4 | **T-20** | **M20** (dejar la clave como está) |
| 2.13 | `src/services/capability-resolver.ts:69` (`reason: 'no_candidates' \| 'excluded_by_scope';`) y `:119-136` | Tercer `reason: 'excluded_by_reputation'`, evaluado **después** de `excluded_by_scope`. El `reason` ya viaja solo al 422 (`compose.ts:420` → `routes/compose.ts:352`): no hay mapa exhaustivo que tocar | **DT-10** | **T-15** | **M15** (colapsar a `no_candidates`) |

**Verificación de W0.2**: `npx tsc --noEmit` + `npm run lint` + `npm test`. Vas a ver rojo en
`capability-resolver.test.ts:133` (el doble `excluded: { scope: 3 }` ya no typechequea): se **completa**
el doble, no se afloja el tipo.

### W1 — que el vacío deje de ser mudo (cierre de superficie; paralelizable con W2)

| # | Archivo · ancla | Qué cambia | AC | Test |
|---|---|---|---|---|
| 1.a | `src/routes/discover.minreputation.test.ts:34` · `describe('minReputation: validación en la ruta'` | Extender: `excluded.reputation` y `trialAvailable` llegan al JSON de **GET y POST** | AC-3 | **T-03** |
| 1.b | `src/routes/compose.capability.test.ts:383` · `expect(res.json().reason).toBe('excluded_by_scope');` | Test hermano: conjunto vaciado **por el piso** ⟹ `reason: 'excluded_by_reputation'` en el 422 | DT-10 | **T-15b** |

### W2 — documentación y contrato (paralelizable con W1)

| # | Archivo:línea | Qué cambia |
|---|---|---|
| 2.a | `doc/INTEGRATION.md:256-257` · «*An agent with no settled tasks scores `0` and is **excluded** whenever `minReputation > 0`*» | Hoy el doc queda **mintiendo**. Documentá: el carril, el **opt-in** (default = comportamiento de hoy), el badge `trial`, `excluded.reputation` / `trialAvailable`, y que **`total` sube** cuando hay admitidos con `allowTrial=true` (R-5 del SDD: cambio observable para quien pagina) |
| 2.b | `src/services/discovery.ts:404-421` · el comentario del filtro | Nota con la **asimetría real** (SDD §1): `verified` lo **auto-reporta el registry** (`:676`) y está hardcodeado `false` para self-published (`agent.ts:141`); el ancla no-forjable es `identity`. Sin esta nota, el próximo lector vuelve a leer "una perilla más estricta que otra" |

---

## 5. Scope OUT — lo que **NO** tocás, aunque te tiente

### 5.1 Intocable por directiva de no-regresión (money-path)

- **El ranking de los agentes que YA tienen historial.** El comparador `discovery.ts:455-463` y
  `repValue` (`:437-440`) quedan **byte-idénticos**. No se agrega una clave de orden, no se reordena
  por `trial`, no se mete el badge en el sort. **CD-6.** Lo candan T-06/M6.
- **La fórmula del score** y sus knobs: `computeFromAccumulator` (`reputation.ts:138-171`),
  `REPUTATION_SCALE_FACTOR` (`F`), `REPUTATION_MAX_TASKS_PER_CALLER` (`K`). Moverlos cambia **todos**
  los scores de producción a la vez (work-item §8).
- **La posición del filtro de `minReputation`**: se queda **pre-sort y pre-slice**. `discovery.ts:347-358`
  dice **NO MOVER** y explica por qué (residual TD-189-1 quedaría encima del camino del dinero). **CD-11.**
- **`agent.reputation`** (el auto-reportado) nunca entra al filtro. **DT-1.**
- **`verified`**: no se lee, no se escribe, no se exige (§2.6).
- **`PAYOUT_MIN_REPUTATION = 2`** de `chaski-v3` (**CD-12**) — y de todos modos `chaski-v3` está
  fuera de esta fase.
- **`attachIdentities`** (`discovery.ts:516-535`) y todo el camino ERC-8004.
- El **broaden-retry** (`discovery.ts:243-254`) no se toca. Ojo con su efecto: cuando dispara, el
  pipeline corre **dos veces**, así que el batch de standing y el lector de anclas se llaman una vez
  **por corrida**. T-13 mide **una** corrida (sin `q` libre no hay retry): no "arregles" el conteo
  cacheando entre corridas.

### 5.2 Fuera de alcance (HUs aparte, ya declaradas en el SDD §6)

§1.6 / R-2 (el agente que entró y volvió a 0 por fallos tempranos — **no** entra al carril, es
deliberado, CD-14) · R-3 (`verified` como primera clave del sort) · bindear `identity` ERC-8004 a los
agentes remit · reputación importada / write-back · fianza · cualquier cambio en repos de consumidores.

### 5.3 Archivos y rutas **prohibidas** en esta HU

```
chaski-v3/**                        ← SÓLO LECTURA. Y NUNCA chaski-v3/m5-keys/
doc/sdd/212-*  doc/sdd/213-*  doc/sdd/214-*   ← hay agentes trabajando ahí AHORA
doc/sdd/_INDEX.md                   ← lo escribe nexus-docs en el cierre
.nexus/project-context.md
doc/sdd/118-wkh-sec-02b-owner-ref-rpc/
contracts/.gas-snapshot   doc/audit/   doc/jury-qa*.md
supabase/migrations/**              ← esta HU NO tiene migración: cero persistencia nueva (SDD §3.2)
```

Prohibido además: `git reset --hard`, `git clean -fd`, `git checkout --` sobre trabajo sin commitear,
`stash drop/clear`, `branch -D`, `push --force`, cambiar de rama. Cero `Co-Authored-By` (repo público).
Cero credenciales o contenido de `.env` en logs, tests o output. **Sólo lectura contra bases de datos,
jamás `caldz`.** No invoques endpoints pagados (los GET a `/discover` y `/capabilities` son gratis).

> **GOTCHA de entorno**: un hook manda los comandos al proxy `rtk`, que **resume y trunca la salida**
> (ya corrompió un fuente con exit 0). Usá `Read`/`Write` para archivos; `python3 + urllib.request`
> para HTTP. **Nunca** redirijas la salida de `cat`/`head`/`tail` a un archivo.

---

## 6. Tests por AC — la unidad de medida es **quién queda en `agents` y en qué orden**

Exemplar obligatorio: **`src/services/discovery.minreputation.test.ts`** (249 líneas, verificado).
Copiá su andamiaje tal cual: los mocks de `./registry.js`, `./agent.js`, `./reputation.js`,
`./identity.js`, `../lib/circuit-breaker.js`, `undici`; los helpers `makeRegistry()`, `rep(score)`,
`raw(slug, reputation)`, `serve(rows)`. **Agregá** un mock de `./agent.js` con
`listPublisherAnchors` (si no, el lector del ancla queda `undefined` y los tests fallan por el motivo
equivocado) y uno de `computeStandingBatch` en `./reputation.js`.

Casi toda aserción termina en `expect(result.agents.map(a => a.slug)).toEqual([...])`,
`expect(result.total)`, `expect(result.excluded)` y `expect(a.trial)`. **Nunca** *¿se llamó a tal
función interna?* — salvo T-13, que mide **costo de I/O** a propósito.

| ID | AC / CD | Archivo | Qué asserta | Mutante que **debe** matar |
|---|---|---|---|---|
| **T-01** | AC-1 | `discovery.minreputation.test.ts` (extender) | Sin `minReputation`, nadie se excluye por reputación, **con o sin** `allowTrial`; y **cero** queries nuevas | **M1**: piso por defecto (`query.minReputation ?? 1`) |
| **T-02** 💰 | AC-2 | `discovery.trial.test.ts` (**nuevo**) | El admitido viene con `trial.granted === true`, `under_min_reputation === min`, y **sin** `computedReputation` fabricada | **M2**: admitir y no marcar |
| **T-03** | AC-3 | `discover.minreputation.test.ts` + `discovery.trial.test.ts` | `minReputation=50`, 3 descartados ⟹ `excluded.reputation === 3`; `trialAvailable` cuenta los que se habrían admitido | **M3**: contar post-`slice` o fijo 0 · **M22**: contar al admitido como excluido |
| **T-04** 💰 | AC-4 | `discovery.trial.test.ts` | **Frontera exacta**: `tasksSettled = N-1` admite, `tasksSettled = N` **no** (queda sujeto a su score real) | **M4**: `<` → `<=` en el límite de N |
| **T-05** 💰 | AC-5 + CD-14 | `discovery.trial.test.ts` | `failedCount >= 1` con 0 liquidadas ⟹ **no** se admite ni con `allowTrial`. Y con 2 liquidadas + 1 fallo tampoco (**anulación**, no decremento) | **M5**: borrar el término `failedCount === 0` |
| **T-06** 💰 | **CD-6** + AC-7 | `discovery.trial.test.ts` | **Orden dorado**: `[scored 90, scored 10, trial]` ⟹ el trial **último**, y el orden de los dos scored **idéntico** al de hoy (mismo assert con y sin la feature) | **M6**: darle score sintético (`score: min`) al admitido |
| **T-07** | AC-6 / CD-13 | `chaski-v3` — **W0.3, NO EJECUTAR** | `allow_trial` viaja **sólo** si el CC elegido se cumple | **M7**: mandarlo incondicional |
| **T-08** | AC-7 | `reputation.test.ts` (extender) | Un `metadata.reputation`/`score` en el evento **no** cambia `tasksSettled` ni el `kind`: el standing no tiene ninguna entrada que el agente controle | **M8**: leer un score del `metadata` del evento |
| **T-09** 💰 | AC-8 (default OFF) | `discovery.trial.test.ts` | Sin `allowTrial`, con un `newcomer` presente y `minReputation=1`, el resultado es **idéntico** al de hoy: 0 agentes, `total 0` | **M9**: `query.allowTrial ?? true` |
| **T-10** 💰 | AC-9 (fail-closed) | `discovery.trial.test.ts` + `reputation.test.ts` | (a) `degraded` + `allowTrial=true` ⟹ **nadie** entra; (b) `degraded` viaja como `true`, **no** como Map vacío; (c) **ausencia** de un slug en el Map con `degraded=false` ⟹ **sí** es `newcomer` | **M10**: tratar `degraded` como `newcomer`, o volver al Map vacío indistinguible · **M18**: leer `standings.get(slug)` crudo sin consultar `degraded`. **Es la mutación más importante del set** |
| **T-11** 💰 | AC-10 (cupo) | `discovery.trial.test.ts` | 5 `newcomer` del mismo `owner_ref`, `M=2` ⟹ se admiten **exactamente** los 2 de `created_at` más antiguo. **El arreglo va en orden DISTINTO al de `created_at`**, para que el orden del arreglo no sea la respuesta correcta | **M11**: quitar el cupo, o resolverlo por orden del arreglo |
| **T-12** 💰 | AC-10 (techo T) | `discovery.trial.test.ts` + `trial-standing.test.ts` | `min = T+1` + `allowTrial=true` ⟹ el `newcomer` **no** entra; `min = T` exacto ⟹ **sí** | **M12**: `<=` → `<`, o borrar el techo |
| **T-13** | **CD-9** (costo de I/O) | `discovery.trial.test.ts` | Sin `allowTrial`: standing **1** llamada, ancla **0**. Con `allowTrial` y un elegible: **1 y 1**. Con `allowTrial` y `minReputation` **ausente**: ancla **0**. Aserción sobre **llamadas**, no sobre el resultado | **M13**: leer el ancla fuera del gate |
| **T-14** | DT-7 (borde HTTP) | `compose-step-shape.test.ts` + `discovery-query.test.ts` + `discover.minreputation.test.ts` | `constraints.allow_trial` booleano se acepta; no-booleano ⟹ **400**; `allowTrial` parsea **igual en GET y POST**; `'maybe'` ⟹ 400 | **M14**: no agregarlo al allowlist (`:156`) ⟹ 400 `unsupported constraint` · **M14b**: `Boolean(raw)` · **M14c**: validar sólo en GET |
| **T-15** | DT-10 (422 explicable) | `capability-resolver.test.ts` + `compose.capability.test.ts` | Conjunto vaciado **por el piso** ⟹ `reason: 'excluded_by_reputation'`, **no** `no_candidates`; y con `scope > 0` gana `excluded_by_scope` (orden preservado) | **M15**: colapsar el reason |
| **T-16** | CD-10 (redacción) | `discovery.redaction.test.ts` (extender) | Ni `owner_ref` ni la clasificación de standing aparecen en el JSON serializado (patrón `expectNoSecretMaterial`, `:96-106`) | **M16**: adjuntar el standing como campo público de `Agent` |
| **T-17** 💰 | CD-8 (una sola expresión) | `discovery.trial.test.ts` | Con `allowTrial=true`: si hay **k** admitidos, hay **k** badges y `trialAvailable === k`, en el **mismo** escenario | **M17**: cambiar el predicado del contador sin cambiar el del filtro |
| **T-18** | CD-7 (ausencia ≠ degradado) | `trial-standing.test.ts` | `standingFor` devuelve `'unknown'` con `degraded=true` y contadores en cero con `degraded=false` + slug ausente | **M18** |
| **T-19** 💰 | CD-15 (determinismo) | `trial-standing.test.ts` | Dos candidatos con **el mismo `created_at`** y `M=1`: el elegido es el de `slug` menor, y **es el mismo en 50 corridas** con el arreglo permutado | **M19**: sin desempate por `slug` ⟹ decide el orden del arreglo |
| **T-20** 💰 | R-4 (memo) | `capability-resolver.test.ts` | Dos steps de la misma capability, uno con `allow_trial` y otro sin, **NO** comparten la resolución memoizada (dos `discover`) | **M20**: dejar la clave del memo sin `allow_trial` |
| **T-21** 💰 | CD-7 (ancla) | `discovery.trial.test.ts` | El lector del ancla **falla** ⟹ **nadie** se admite (ni con `allowTrial=true` y elegibles presentes) | **M21**: error del ancla ⟹ Map vacío ⟹ admite igual |
| **T-22** | DT-8 (env conservadora) | `trial-standing.test.ts` | Env ausente / `''` / `'abc'` / `'0'` / `'-1'` ⟹ el **default**; un valor válido se respeta | **M23**: default permisivo (`Infinity` en T, `0` en M) |

💰 = **money-path** (toca selección de agente). Para cada uno se exige, sin excepción:
(i) la mutación de su fila **aplicada al código real** y el test **rojo**;
(ii) **cobertura de las líneas del guard**, no "la suite pasa";
(iii) prohibido aceptar un `describe.skip` o un archivo **no colectado** como evidencia
(`tres-formas-en-que-la-suite-miente`: un falso KILLED por archivo no colectado ya pasó en este repo).

### 6.1 Regla de mutación (idéntica a HU-307, se aplica igual acá)

- **Todo mutante debe COMPILAR** (`npx tsc --noEmit` limpio) antes de contarse. Un mutante que no
  compila lo cazó el compilador, no el test.
- La evidencia de reversión es el **`sha256sum`** de los archivos tocados, no `git status`: esta HU
  crea archivos untracked. Guardá los hashes antes de empezar y compará al final. **Nunca
  `git checkout --`**.
- **Un sobreviviente tiene dos causas, no una**: falta un test, **o** la mutación era equivalente.
  Determinalo **empíricamente** antes de escribir nada; si es equivalente, documentalo como
  equivalente en el reporte.
- **Una aserción que existe para probar que el escenario está armado se valida desarmando el
  escenario y viendo el rojo.** Sacá la siembra del `newcomer`, corré, confirmá que el test falla
  **por esa línea**. Si sigue verde, el test está midiendo aire.

---

## 7. Anti-Hallucination Checklist (marcá antes de abrir el PR)

```
[ ] Ningún path, función, símbolo, env o API que use fue inventado: todos verificados con Read/Grep
[ ] W0.3 NO se ejecutó: cero cambios en chaski-v3 (git status del otro repo limpio). NUNCA se abrió
    chaski-v3/m5-keys/
[ ] El comparador del sort (discovery.ts:455-463) y repValue (:437-440) quedaron BYTE-IDÉNTICOS (CD-6)
[ ] Ningún agente en estreno recibe score fabricado: cero asignaciones a a.computedReputation /
    a.reputation en el bloque de admisión
[ ] El predicado de admisión es `scoreReal >= min || trialAdmitted`, con la rama de mérito PRIMERO
[ ] El filtro de minReputation sigue DENTRO del bloque pre-sort (discovery.ts:404-428). NO se movió (CD-11)
[ ] `degraded` es un tercer valor explícito; ningún camino confunde Map vacío con "nadie tiene historial"
[ ] `standings.get(slug)` NO se lee crudo en ningún lado: siempre vía `standingFor` (CD-7)
[ ] El lector del ancla devuelve un resultado DISCRIMINADO y su fallo NO admite a nadie (fail-closed)
[ ] `isTrialEligible` es la ÚNICA escritura del predicado: filtro, contador, badge y cupo la usan (CD-8)
[ ] N, T y M salen SIEMPRE de lib/trial-standing.ts. Cero 3 / 10 / 2 hardcodeados en services
[ ] Las 3 envs están en .env.example con la nota de que son PROVISORIAS (pendientes del founder)
[ ] La env ausente/inválida NO apaga el control: el default es el valor conservador (DT-8)
[ ] El cupo M ordena por (created_at, slug) ascendente. Cero uso de ranking-tiebreak.ts (CD-15)
[ ] Sin `allowTrial`: CERO queries nuevas (standing 1, ancla 0), asertado por LLAMADAS (CD-9)
[ ] `allow_trial` está en el allowlist de compose-step-shape.ts:156 Y validado booleano
[ ] `allowTrial` se parsea igual en GET y en POST /discover (simetría)
[ ] La clave del memo de createCapabilityResolver incluye allow_trial
[ ] `owner_ref` NO aparece en ninguna respuesta de /discover ni /compose (CD-10)
[ ] La clasificación de standing NO es campo público de Agent (DT-6): sólo se surfacea `trial`
[ ] `verified` no se lee, no se escribe y no aparece en ningún predicado nuevo (§2.6)
[ ] PAYOUT_MIN_REPUTATION no se tocó (y no se pudo: chaski-v3 fuera de fase)
[ ] Cero migraciones nuevas. Cero escrituras a ninguna base. Jamás caldz
[ ] doc/INTEGRATION.md:256-257 ya no miente sobre el agente sin liquidadas
[ ] NO se tocaron: doc/sdd/_INDEX.md, .nexus/project-context.md, doc/sdd/212-*, 213-*, 214-*,
    doc/sdd/118-wkh-sec-02b-owner-ref-rpc/, contracts/.gas-snapshot, doc/audit/, doc/jury-qa*.md
[ ] NO se usó git destructivo ni se cambió de rama. Sin Co-Authored-By en los commits
```

---

## 8. Verificación y Done Definition

### 8.1 Gates

```bash
cd /home/ferdev/.openclaw/workspace/wt-313
npm ci                  # el worktree NO tiene node_modules
npx tsc --noEmit        # COMPLETO — `npm run build` NO alcanza: tsconfig.build.json excluye tests (WKH-196)
npm run lint            # biome check src/
npm test                # vitest run
```

### 8.2 Done

1. Las **23 mutaciones** de §6 corridas, **todas compilando**, con veredicto documentado. Un
   sobreviviente sin test que lo cace (o sin prueba empírica de equivalencia) es un **hallazgo
   abierto**, no una nota al pie.
2. **Cobertura de líneas** de los guards money-path (predicado de admisión, `degraded`, cupo, techo),
   no sólo suite verde.
3. **Delta de tests declarado**: `final = baseline + nuevos`, con el baseline de la tarea 0.0.2. Cero
   tests eliminados en esta HU (el único archivo que se **extiende** y no se reescribe es
   `discovery.minreputation.test.ts`: **T-8 de `:218-228` se conserva intacto**, es la no-regresión
   del fail-safe).
4. **Medición en vivo, antes y después** (gratis, sin auth de pago, `python3 + urllib`):
   `GET /discover?capabilities=remittance-payout&minReputation=2` (hoy: `total 0`) y
   `…&minReputation=2&allowTrial=true` (esperado post-deploy: **1**, con `trial.granted: true` y
   `computedReputation` **ausente**). **Contra prod sólo lectura**; el `allowTrial=true` recién
   responde distinto **después** del deploy, no antes.
5. `auto-blindaje.md` de esta HU (formato de las HUs 208/209).
6. **Done-report que declare, sin maquillar**:
   - que **W0.3 no se entregó** y por qué (CD-13: N/T/M/CC sin decidir) ⟹ **la demo insignia sigue
     sin destrabarse**; lo que se entrega es la mitad del gateway, que es la mitad que no depende de
     una decisión;
   - la **desviación de la firma literal de DT-4** (§2.7) para que AR la ratifique o la rechace;
   - los **residuales nuevos** de §9;
   - el cambio observable de `total` con `allowTrial=true` (R-5 del SDD).

---

## 9. Residuales que aparecieron al bajar el SDD a tareas (declarados, **no** se resuelven acá)

- **R-6 (nuevo, no está en el SDD)**: `failedCount` **no está capeado por caller**
  (`reputation.ts:128-129` incrementa con cualquier `failed`). Un competidor puede pagar **una**
  invocación de 0.03 que falle y con eso **anular el carril** de un rival por CD-14. La asimetría es
  deliberada del lado del agente (un fallo lo debe penalizar), pero el vector de un tercero
  malicioso existe y es barato. **No se mitiga en esta HU** — mitigarlo requiere decidir si el fallo
  se capea por caller, y eso mueve la semántica de `success_rate` de producción (fuera de alcance,
  work-item §8). **Documentalo en el done-report.**
- **R-1 (SDD, aceptado)**: el cupo se ancla en `owner_ref` y crear cuentas es barato. La palanca
  disponible es CC-3 (`identity` ERC-8004), que hoy **bloquearía la propia demo** (ninguno de los 3
  agentes remit la tiene).
- **R-4 (SDD)**: `prepare` y `submit` resuelven el agente **por separado**. La tarea 2.12 (memo por
  `allow_trial`) mitiga la divergencia **dentro de una request**, **no entre las dos requests**. Esa
  mitigación es de W0.3: si no se puede garantizar el mismo agente en los dos legs, **`M = 1` para
  capacidades de desembolso**.
- **`trialAvailable` con `allowTrial` ausente es una cota SUPERIOR** (pre-cupo). Motivo: CD-9 prohíbe
  la query del ancla en el camino por defecto, y sin anclas el cupo M no se puede aplicar. Con
  `allowTrial=true` el número es **exacto** y coincide con la cantidad de badges (T-17). **Escribilo
  en el JSDoc del campo y en `doc/INTEGRATION.md`**: un contador que a veces es exacto y a veces una
  cota, sin decirlo, es la clase de dato que se lee mal. **Es una concreción mía sobre una tensión
  real entre CD-8 y CD-9 del SDD: marcada para AR.**

---

*Story File — NexusAgil · F2.5 · WKH-313 · 2026-07-29*
