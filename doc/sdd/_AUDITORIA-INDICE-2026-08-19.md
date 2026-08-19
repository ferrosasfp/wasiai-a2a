# Auditoría del índice — `doc/sdd/_INDEX.md` (2026-08-19)

**Alcance**: las filas que el índice declaraba abiertas (`in progress`, `F1 (`, `WIP`,
`NO MERGEADO`, `pendiente merge`, `CONTROL DIFERIDO`). **No** es la validación de una HU.
**Repo**: `wasiai-a2a`, `main` = `8712863`. **Repo público, `doc/` versionado.**

## Resumen

| | |
|---|---|
| Filas de la tabla | 213 |
| Filas auditadas (declaradas abiertas o con matiz) | 15 |
| **Mal clasificadas** | **9** |
| Pendientes de verdad | 3 (`163`, `212`, `214`) |
| Correctas tal cual estaban | 3 (`190`/WKH-305, `210`, `096`+bloque PENDING-DEPLOY, no re-medido) |
| Filas editadas | 11 (9 correcciones + 1 cita re-anclada + 1 ampliación) |

**El patrón**: 6 de las 9 mal clasificadas decían «no mergeado / in progress» y **estaban
mergeadas**, algunas hace más de dos semanas. La causa es un **defecto de instrumento**, no
descuido: `git log --oneline` bajo el hook de `rtk` **borra los commits de merge** y rellena
con el siguiente no-merge, así que la lista *se ve completa* y la pregunta «¿está en `main`?»
se contesta **NO cuando la verdad es SÍ**. Reproducido en esta sesión: `10a6eb1
merge(WKH-360)` aparece con `rtk proxy "git log"` y **desaparece** con `git log`.

---

## 1. Camino del dinero y gateway en producción (primero, por prioridad)

### 1.1 — Fila `223` · WKH-360 · coordinador contratable / guard anti-bucle

| | |
|---|---|
| Declarado | `DONE` pero «⚠️ **NO mergeada ni desplegada**… `main` es produccion (Railway)» |
| **Real** | **MERGEADA Y DESPLEGADA, con el guard ARMADO en producción** |
| Commit | merge `10a6eb1` (2026-08-17), ancestro de `main` |
| Evidencia código | `src/routes/orchestrate.ts:21,145,325` (`contractingGuardHandler` cableado como preHandler) |
| Evidencia runtime | `GET https://wasiai-a2a-production.up.railway.app/health` → `contractingGuard: {"selfHostCount": 1, "depthMax": 2, "source": "env"}` (4 lecturas estables, 2026-08-19T05:06Z) |

`source: "env"` (y no `request-only`) prueba que el conjunto de identidad derivado de
configuración **no está vacío** — `readContractingGuardHealth`, `src/lib/contracting-chain.ts:864-875`.
Es exactamente la medición post-deploy que la propia fila pedía para cerrar NC-1/NC-2.

**Lo que NO cierra este merge, y queda abierto:**

1. ⚠️ **`selfHostCount` es 1, no 2.** `.env.example:598` propone dos nombres
   (`wasiai-a2a-production.up.railway.app,a2a.wasiai.io`). Si el gateway también responde por
   el alias que falta, un bucle que entre por **ese** nombre no lo ve la Capa 1. **Hay que
   verificar cuál de los dos quedó.**
2. **El paso 5 del smoke de `report.md §8` no se corrió.** Es el único que discrimina si el
   corte quedó del lado correcto del débito: en un bucle rechazado, si el saldo de la key
   **baja**, hay que revertir. El `400` sale igual bajo el mutante.
3. **R-4 confirmado midiendo, no estimando**: `GET /discover?limit=200` en prod da
   `sources: WasiAI rows=22, self-published rows=3` ⇒ 22 de 25 agentes viven en `wasiai-v2`,
   que no reenvía los headers ⇒ la Capa 2 nace con cobertura efectiva ~0 en el camino real.

### 1.2 — Fila `215` · WKH-318 · `limit` colapsa el registro federado en `/discover`

| | |
|---|---|
| Declarado | `DONE (corte A)` — «W3 (clamp) y W4 quedan **sin empezar**… **no mergeado/pusheado**» |
| **Real** | **Cortes A y B hechos, mergeados y VERIFICADOS EN PRODUCCIÓN** |
| Commits | corte A `6eb4f8a` (2026-07-30) · **corte B `a18c592`** (2026-08-04) — los dos ancestros de `main` |
| Evidencia código | `src/services/discovery.ts:1165` — `clampToRegistryMaxLimit(unclamped, schema.maxLimit)` |
| Evidencia runtime | `GET /discover?limit=200` → **25 agentes**, `sources: [{"name":"WasiAI","state":"ok","rows":22},{"name":"self-published","state":"ok","rows":3}]`, `catalogStatus: "complete"`, `total: 25` |

El síntoma original —**3 de 23 para cualquier `N`**, con `registries` mintiendo— **ya no se
reproduce**. Ésta era la fila más equivocada del índice: negaba dos waves que están en prod.

### 1.3 — Fila `190` · WKH-306 · residuo de pagos varados

| | |
|---|---|
| Declarado | `DONE (merged d0cd3df)` · **CONTROL DIFERIDO (envs sin setear)** |
| **Real** | **La alerta está ENCENDIDA en producción.** El techo sigue sin poder verificarse |
| Evidencia runtime | `/health` publica `"strandedExposureBreached": false` (4 lecturas) |

El razonamiento, porque el valor por sí solo no alcanza: `getStrandedHealthField()`
**omite el campo entero** cuando el umbral está `unset` (`src/services/stranded-alert.ts:302-309`)
y publica el string `'unknown'` cuando está puesto pero ilegible (`:310-313`). Un **booleano**
sólo puede salir del camino activo ⇒ `STRANDED_EXPOSURE_ALERT_THRESHOLD_USD` **está seteada y
es legible**. «Envs sin setear», en plural, era **falso para la alerta**.

⚠️ Sigue **NO VERIFICABLE desde afuera** el otro env, el techo `PIPELINE_EXPOSURE_CEILING_USD`:
no se publica en `/health`, sólo se delata en el log de arranque. Para eso hace falta Railway.

*Detalle de instrumento observado*: la **primera** lectura de `/health` devolvió
`"unknown"` y las cuatro siguientes `false`. No es ruido: `stranded-alert.ts:315-332` computa
el snapshot de forma perezosa y devuelve `'unknown'` mientras esté rancio, disparando un
refresh en segundo plano. **Una sola consulta a `/health` puede decir `unknown` con el env
bien puesto.**

### 1.4 — Fila `213` · WKH-315 · depósito prepago en Solana

| | |
|---|---|
| Declarado | `DONE (código, pendiente merge/activación founder-gated)` |
| **Real** | **MERGEADA.** La *activación* sí sigue pendiente |
| Commit | merge `6946a80` (2026-07-30, «la plata ya puede ENTRAR por Solana») |
| Evidencia | `src/lib/ed25519.ts:2` (`WKH-315 · AC-7`) |
| Activación | `/health` → `solanaPayoutRoute: {"state":"rail_off"}` ⇒ bandera apagada o sin URL de facilitator (`src/adapters/solana/facilitator-settle.ts:328-329`) |

### 1.5 — Fila `216` · WKH-319 · fail-open de `checkTerms` en la salida Solana

| | |
|---|---|
| Declarado | `DONE (código, en worktree — pendiente merge/decisión del founder)` |
| **Real** | **MERGEADA** |
| Commit | merge `6a2f292` (2026-07-30) |
| Evidencia | `src/adapters/solana/payment.ts:883` (`switch (terms.verdict)`), `:1394`, `:1403`, `:1418` (`verdict: 'indeterminate'`) |

### 1.6 — Fila `212` · WKH-314 · **PENDIENTE DE VERDAD** — x402 inbound Solana

**Es la única pata del dinero que sigue sin existir**, y la rama es una **pista falsa**.

`feat/212-wkh-314-x402-inbound-solana` da «contenida en `main`», pero su tip es `6b391d6`,
que es el **merge de WKH-307c**: la rama nunca recibió un commit propio. `git rev-list --count
HEAD..rama` → 0 significa acá **«no hay nada»**, no «se mergeó». Es exactamente el falso
positivo contra el que hay que blindarse al medir pertenencia por rama.

Medición independiente, sobre el árbol:

- `src/adapters/registry.ts:523` sigue siendo literalmente `return bundle.payment.vmFamily === 'evm';`
- `src/adapters/registry.ts:428-430` sigue lanzando sobre un adapter no-EVM.

**Control positivo en la misma corrida** (un cero no es evidencia sin él): `SolanaPaymentAdapter`
existe en `src/adapters/solana/payment.ts:298` — el leg de **salida** sí está. El cero es del
código, no del grep.

**Receta para retomarla**: arrancar por `registry.ts:523` y el corte de `src/middleware/x402.ts`.
**Urgencia acotada**: `/health` da `solanaPayoutRoute: {"state":"rail_off"}`, el carril Solana
no está armado en prod.

### 1.7 — Fila `211` · WKH-313 · carril de estreno (reputación)

| | |
|---|---|
| Declarado | `DONE (código) · REVIEWED · NO MERGEADO — pendiente orden de merge coordinado (WKH-315/316/318)` |
| **Real** | **MERGEADA** |
| Commit | merge `1b322e2` (2026-07-30) |
| Evidencia | `src/services/discovery.ts:44` importa `../lib/trial-standing.js`; `:507-514` (`trialAvailable`/`trialEvaluated`); `:813` (definición de `newcomer`) |

⚠️ El estado viejo condicionaba esta HU a un «orden de merge coordinado (WKH-315/316/318)».
**Las tres se resolvieron igual**: dos por merge (`315`, `318`) y una que sigue pendiente por
otro motivo (`316`). Es el mismo daño que el índice ya documenta en su nota de 2026-07-29:
**una fila con el estado viejo hace planificar mal.**

---

## 2. Resto (no toca el dinero directamente)

### 2.1 — Fila `214` · WKH-316 · **PENDIENTE DE VERDAD** — escritor del bloque `payment`

Misma pista falsa que `212`: `feat/214-wkh-316-payment-block-writer` **también** apunta a
`6b391d6` (merge de WKH-307c), rama sin commits propios.

- `PublishAgentInput` (`src/types/index.ts:282-309`) **no declara `payment`**.
- `buildMetadata` (`src/services/agent.ts:186-198`) persiste sólo `inputSchema`,
  `outputSchema` y `discoverable`.
- **Control positivo**: `discoverable` **sí** se persiste, ahí mismo en `:195-196`.

⚠️ **Falso positivo que casi la da por hecha**: `payment?: AgentPaymentSpec` existe en
`src/types/index.ts:397` — pero pertenece a `interface Agent` (`:374`), o sea que es el
**LECTOR** de WKH-241, no el escritor. Grepear `payment` en `src/types/index.ts` y darse por
satisfecho habría cerrado mal esta fila. Sigue bloqueando WKH-317.

### 2.2 — Fila `163` · WKH-160 · **PENDIENTE DE VERDAD** — relevancia semántica

Estaba **bien clasificada** (`F1 · PARKEADA`) y se confirma:

- Barrido de `pgvector` / `embedding` sobre `src/` ⇒ **1 solo acierto**, y es el comentario
  `// embeddings vuelve con WKH-160…`
- **Control positivo**: `tokenizeForRelevance` da 4 aciertos
  (`src/services/orchestrate.ts:372,392,855,869`) ⇒ el matching léxico sigue siendo el único.
- Sin rama local ni remota.

**Cita re-anclada**: la celda citaba `src/services/orchestrate.ts:359` y el comentario está
hoy en **`:369`** — se había desplazado 10 líneas por ediciones ajenas. Corregida.

### 2.3 — Filas `220` y `221` · WKH-SEC-03 / SEC-04

Las dos decían `in progress … pendiente F4`, con un addendum de 2026-08-10 que ya había
medido «rama contenida en `main`». Lo que faltaba era el commit de merge, **invisible bajo
el hook de `rtk`**:

- `220` → merge **`b7fa4e7`** (2026-08-06)
- `221` → merge **`568cf40`** (2026-08-06)

El `in progress` queda desmentido: **falta el acta de F4, no el merge.**

### 2.4 — Filas que estaban BIEN y no se tocaron

- **`190` · WKH-305** — «NO SE SABE SI ESTÁ CERRADA». **Exacta**: verificado que no hay
  commit de merge para 305 (llegó por commits directos, como dice la celda) y que el módulo
  está vivo y cableado (`src/services/compose.ts:21`, `src/routes/orchestrate.ts:13`).
  Es un buen ejemplo de una fila que dice «no sé» y acierta.
- **`210` · WKH-308** — `CERRADA con matiz`. Rama contenida en `main`, coherente.
- **`136` (BACKLOG)**, **`141` (DEFERRED)**, **`153` (OBSOLETA)**, **`118` (NO ES UNA HU)** —
  estados deliberados, no desactualizados.

---

## 3. Límites de esta auditoría (declarados, no omitidos)

1. **NO se re-midió el bloque `PENDING-DEPLOY` de 2026-05/07** (`096`, `167`-`171`,
   `173`-`175`, `177`, `178`, y `209`/WKH-307b «migración a prod pendiente»). La auditoría
   de 2026-07-29 ya los parkeó como no verificables desde el árbol: la mitad que falta vive
   en Railway, Vercel y las bases (`bdwv`/`caldz`). **Quedan como estaban.** Verificarlos
   exige credenciales de esos entornos.
2. **NO se corrió la suite completa.** Se corrió sólo el guardián del índice y el test de la
   cita (`34 passed`, exit 0). No hubo cambios en `src/`.
3. **`PIPELINE_EXPOSURE_CEILING_USD` = NO VERIFICABLE** desde fuera (§1.3).
4. **El paso 5 del smoke de WKH-360 = NO EJECUTADO** (§1.1). Es el único que decide si el
   corte anti-bucle quedó del lado correcto del débito.
5. **No se consultó ninguna base de datos.** Todo el runtime salió de `GET /health` y
   `GET /discover`, los dos de sólo lectura y públicos.

## 4. Instrumentos que fallaron, y su reemplazo

| Instrumento | Falla medida | Reemplazo usado |
|---|---|---|
| `git log --oneline` (hook `rtk`) | **Borra los commits de merge** y rellena con el siguiente no-merge. Causa raíz de 6 de las 9 filas mal clasificadas | `rtk proxy "git log --merges"`, `git merge-base --is-ancestor` |
| `git merge-base` sobre una rama sola | **Da «contenida» para una rama sin commits propios** (`212` y `214` apuntan a `6b391d6`). No distingue «mergeada» de «vacía» | Segunda medición: el símbolo de la HU en el árbol, con control positivo |
| `grep` (hook `rtk`) | Devuelve un resumen con los nombres de archivo vueltos números — inservible para citar `archivo:línea` | `command grep` |
| `cat` (hook `rtk`) | Corrompe la salida | `Read`, `sed -n`, `python3` |
| `curl` (hook `rtk`) | Truncó el JSON de `/health` a ~180 chars | `rtk proxy` + `-o archivo` + `python3 -m json.tool` |
| `npx vitest --reporter=basic` | `ERR_LOAD_URL`: ese reporter no existe en esta versión | reporter por defecto |
| exit code después de un pipe | No es el del comando | `cmd > archivo; echo $?` |

## 5. Control del entregable

- **Barrido carpeta↔fila**: **14 carpetas sin fila ANTES, 14 DESPUÉS ⇒ delta = 0.** (Las 14
  son preexistentes: filas viejas que no linkean su carpeta por nombre; el guardián las tiene
  como excepciones.)
- **Ancla de money-path preservada**: `src/lib/capability-risk.ts:82` y
  `capability-risk.test.ts:56` citan `doc/sdd/_INDEX.md:144`. La línea 144 sigue siendo la
  fila `157`. Las 11 ediciones son **in-place dentro de la celda**: `11 insertions(+),
  11 deletions(-)`, **355 líneas antes y después**, cero desplazamiento.
- **Guardián verde**: `test/sdd-index-matches-folders.test.ts` → `12 passed (12)`, exit 0.
- **Y el verde se verificó**: mutando **un** `|` sin escapar en la fila `216` el guardián se
  puso **rojo** en `G-D2` (exit 1), y al restaurar volvió a exit 0. **El exit 0 significa algo.**
