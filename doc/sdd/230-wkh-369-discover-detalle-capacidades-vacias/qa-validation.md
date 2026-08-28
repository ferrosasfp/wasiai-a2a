# F4 · Validación QA — #230 · WKH-369

Rama `feat/230-wkh-369-detalle-capacidades-federadas` · HEAD `cfb1cfe` · base `18e4550`
2026-08-27 · nexus-qa.

> **Nada de acá se aceptó por lectura.** Cada AC que afirma un comportamiento se **ejecutó**.
> Las citas `archivo:línea` dicen dónde vive el código; la columna «Ejecutado» dice qué hace
> corriendo. Donde no se puede saber sin desplegar, dice **post-deploy** y no dice PASS.

## Veredicto: ✅ **APROBADO** · 8/8 ACs PASS · 0 FAIL · 4 verificaciones post-deploy pendientes

---

## 1 · El gate del repo, corrido por F4, completo y en orden

⛔ `npm run qa` NO existe en este repo. El gate es la secuencia de `.github/workflows/ci.yml`.
⚠️ Corrido con `git status --porcelain` **vacío antes y después** — el guardián
`test/readme-numbers.test.ts:83` enumera con `git ls-files`, contra el ÍNDICE y no contra el
disco: correrlo con archivos untracked es el falso verde que el CR cazó en la primera vuelta.

| Paso | Comando | Base `18e4550` | **HEAD `cfb1cfe`** | Exit |
|---|---|---|---|---|
| 1 | `npx tsc -p tsconfig.json --noEmit` | 0 errores | **0 errores** | **0** ✅ |
| 2 | `npm run lint` | 516 archivos | **519 archivos, sin fixes** | **0** ✅ |
| 3 | `npm test` | 310/316 · 6290/6309 | **312 passed \| 6 skipped (318)** · **6310 passed \| 19 skipped (6329)** | **0** ✅ |

```
=== git status --porcelain (debe estar VACIO) ===
[fin status]                     ← vacío
TSC_EXIT=0
Checked 519 files in 238ms. No fixes applied.
LINT_EXIT=0
 Test Files  312 passed | 6 skipped (318)
      Tests  6310 passed | 19 skipped (6329)
TEST_EXIT=0
=== git status POST ===
[fin]                            ← vacío
```

**Deltas contra la base, todos explicados**: +3 lint (`agent-detail.ts` + 2 archivos de test),
+2 archivos de test (318−316), +20 casos (6329−6309), +2 files passed (312−310).
Los 20 casos son los 20 tests nuevos — confirmado corriéndolos aislados: `Tests 20 passed (20)`.

**Diferencia contra el AR-2** (que reportó `6309/6328`): +1 caso, y es `T-16`, agregado por
`cfb1cfe` al cerrar el MNR-1 del AR-2. Cuadra.

---

## 2 · Medición de PRODUCCIÓN — el «antes», con la partición que exige AC-3

`GET https://wasiai-a2a-production.up.railway.app/discover?limit=100` + un
`GET /discover/<slug>` por cada uno de los 29 agentes. **Sólo lectura.** 2026-08-27.

```
LIST_KEYS=["agents","total","totalAtLeast","registries","sources","catalogStatus","excluded"]
LIST_COUNT=29
SOURCES=[{"name":"WasiAI","state":"ok","rows":24},{"name":"self-published","state":"ok","rows":5}]
```

### 2.1 La partición de TRES estados (AC-3)

| Bucket | n | Slugs |
|---|---|---|
| **`difiere`** | **10** | `agentshop-cashout-matcher`, `agentshop-corridor-discoverer`, `agentshop-kyc-validator`, `wasi-chainlink-price`, `wasi-defi-sentiment`, `wasi-wallet-profiler`, `wasi-risk-report`, `wasi-liquidity-analyzer`, `wasi-onchain-analyzer`, `wasi-contract-auditor` |
| **`coincide-con-contenido`** | **5** | `remit-corridor-fx-solana`, `remit-kyc-decision`, `remit-cashout-payout-solana`, `remit-kyc-session`, `remit-kyc-validator` — **los 5 son `self-published`** |
| **`coincide-en-vacío`** | **14** | `cobraya-*` (4), `blexsignal-*` (6), `sentiment-analyzer`, `data-miner-qa-2`, `avalanche-ecosystem-pulse`, `metrics-collector-qa` |
| detalle no legible | 0 | — |

### 2.2 La tasa, sobre la población que PUEDE exhibir el defecto

⛔ El número agregado «10 de 29 = 34%» **no satisface AC-3** y es engañoso en las dos
direcciones: mete en el denominador a 14 agentes cuya lista está vacía (no pueden exhibirlo)
y a 5 self-published (que hacen early-return y tampoco pueden).

| Denominador | Fórmula | Tasa |
|---|---|---|
| Total del catálogo ⛔ *no vale para AC-3* | 10 / 29 | 34,5 % |
| Lista no vacía (incluye self-published) | 10 / 15 | 66,7 % |
| ✅ **Población que puede exhibirlo: FEDERADOS con lista no vacía** | **10 / 10** | **100,0 %** |

**Y el número complementario que el work-item predijo**: `federados TOTAL=24` ·
`federados con detalle [] = 24` → **24 de 24**. Los 14 restantes están en
`coincide-en-vacío` porque su lista TAMBIÉN es `[]`: su `[]` de detalle es indistinguible
de una afirmación verdadera. Ése es exactamente el colapso que AC-2 existe para romper.
`self-published = 5`, `self con detalle [] = 0`.

### 2.3 Los otros campos de AC-6, medidos en prod HOY

```
priceUsdc  divergentes = 0/29   []
reputation divergentes = 2/29   [["wasi-chainlink-price",0,null],["wasi-defi-sentiment",1,null]]
capabilitiesState presente en el detalle = 0/29   (esperado: la HU no está desplegada)
```
Cuadra **exacto** con lo que midió el SDD §3.3: `priceUsdc` **0/29** (tapado por el fallback),
`reputation` **2/29**.

### 2.4 El «antes» del Agent Card (AC-5)

```
agentshop-kyc-validator | 200 | card.skills=[]  | lista.caps=["remittance","remit","kyc","compliance"] | wasiai
wasi-contract-auditor   | 200 | card.skills=[]  | lista.caps=["audit","security","smart-contract","vulnerability"] | wasiai
remit-kyc-validator     | 200 | card.skills=[6] | lista.caps=[los mismos 6] | self-published
```
El defecto está vivo en la **segunda** ruta de detalle, y el self-published es el control que
muestra que no es un problema del endpoint del card.

---

## 3 · AC por AC

| AC | Status | Evidencia `archivo:línea` | Ejecutado (salida real) |
|---|---|---|---|
| **AC-1** — detalle == lista para federados | ✅ **PASS** (test) · prod **post-deploy** | `agent-detail.ts:100-113`; T-01 `agent-detail.test.ts:387`; T-08 `discover.detail-capabilities.test.ts:258` | `✓ T-01 … 64ms` · `✓ T-08 … 85ms`. Con el defecto re-introducido: `× T-01 → expected [] to deeply equal ['remittance','remit','kyc',…]`, `× T-08 → expected [] to have a length of 4` |
| **AC-2** — no resuelto ≠ `[]` | ✅ **PASS** | `types/index.ts:458-465` (`capabilitiesState?: 'unresolved'`); `agent-detail.ts:58-62` `markUnresolvedIfEmpty`; T-02a `:398`, T-02b `:405`, T-02c `:412`, T-11 `:513` | 4/4 verdes. **No es tautológico**: T-02b fija que resuelto-y-vacío deja la clave **AUSENTE** (`'capabilitiesState' in agent === false`), y T-11 mata el marcado incondicional (capacidades que SÍ trajo el detalle salen sin marcador) |
| **AC-3** — partición de 3 + tasa sobre la población que puede exhibirlo | ✅ **PASS** | T-03 `agent-detail.test.ts:426`, T-04 `:441`; clasificador `:295-311` | **En prod** (§2.1/§2.2): `difiere=10 / coincide-con-contenido=5 / coincide-en-vacío=14`, tasa **10/10 = 100 %** sobre federados con lista no vacía. **En el arnés**: `✓ T-04` mide el camino CON el defecto a propósito (`getAgent` pelado) para que la elección del denominador sea **observable** — `difiere=1, coincideConContenido=1, coincideEnVacio=2, tasa=50 %`. Con el camino arreglado `0/2 === 0/4` y el denominador sería inobservable |
| **AC-4** — con el defecto, el test de paridad falla | ✅ **PASS** | T-03 `:426` (`expect(conteo.difiere).toBe(0)`) | **Mutación ejecutada** en worktree aislado (`agent-detail.ts:103` `agent.capabilities = entrada.capabilities;` → comentada): `× T-03 → expected 1 to be +0` · y arrastra `× T-01`, `× T-05`, `× T-08`, `× T-13`. `Tests 5 failed \| 15 passed (20)`. Control: sin mutar, `20 passed (20)` |
| **AC-5** — `skills` del card sale de la misma lista | ✅ **PASS** (test) · prod **post-deploy** | `routes/agent-card.ts:41-43` (`resolveAgentForDetailView`); T-05 `discover.detail-capabilities.test.ts:281` | `✓ T-05 … 52ms`. Con el defecto puesto: `× T-05 → expected [] to have a length of 4`. `services/agent-card.ts` **no se tocó** (`:124` ya deriva de `agent.capabilities`) — confirmado: 0 líneas en el diff |
| **AC-6** — paridad de los 3 campos de `agentMapping` con path ≠ nombre | ⚠️ **PASS con residual** (ver F4-MNR-1) | `capabilities` → `agent-detail.ts:103`; `reputation` → `:108-112`; `price` → no se toca (`discovery.ts:1500`, `:1512-1544`). T-06a `:464`, T-06b `:470` | `✓ T-06a` (`reputation === 7`, no `NaN`) · `✓ T-06b`. **En prod**: `priceUsdc 0/29` divergentes, `reputation 2/29`. Las 2 de reputación las cierra `:108-112` — **post-deploy** |
| **AC-7** — lista y `/compose` byte-idénticos | ✅ **PASS** | T-07a `discover.detail-capabilities.test.ts:305`, T-07b `:338`; `services/discovery.ts` y `services/compose.ts` → **0 líneas** en el diff | **Demostrado ejecutando, no leyendo el diff** — ver §4 |
| **AC-8** — el gate en el orden del CI | ✅ **PASS** | `.github/workflows/ci.yml` | §1: `0` · `519` · `312/318` · `6310/6329` · **exit 0**, con el índice limpio |

---

## 4 · AC-7 — la byte-identidad, ejecutada

**Método**: dos worktrees detached (`18e4550` y `cfb1cfe`), la **misma** sonda copiada byte
a byte en los dos (`sha256 6bf60f6c…` idéntico en ambos), el mismo doble de `fetch` /
`registryService` / `supabase` / `reputation`. La sonda no hace assertions: **serializa y
vuelca**; la comparación la hace `sha256sum` afuera. Se volcó el **body crudo** de:

`GET /discover?limit=10` · `GET /discover?capabilities=kyc` · `POST /discover {capabilities,limit}` ·
`POST /discover {}` · `discover({limit:50})` y `discover({capabilities:['kyc']})` (el pool que
consume `compose.ts:171`) · `getAgent(fed-con-caps)` y `getAgent(fed-sin-caps)` (el resolver de
step, `compose.ts:1713-1714`).

```
BASE 18e4550 → 1ddd7cd1a4a6bfce20dcff99f07923c1ba0a580fb5e0931ec8b4f4cd65ea55d9  10362 bytes
HEAD cfb1cfe → 1ddd7cd1a4a6bfce20dcff99f07923c1ba0a580fb5e0931ec8b4f4cd65ea55d9  10362 bytes
/usr/bin/diff → sin salida   ⇒  AC7_BYTE_IDENTICO
```

### 4.1 ⚠️ La primera corrida fue VACUA y se descartó

La primera versión de la sonda devolvía el listado como `{agents: [...]}`; `discover()` lo
clasificó `state:"failed", failure:"bad_payload"` y las **dos** vistas salieron con
`agents: []`. Los sha256 coincidían — comparando dos listas **vacías**. Eso es evidencia que
se auto-confirma, no byte-identidad. La forma correcta es un **array pelado**
(`discover.detail-capabilities.test.ts:225`). Con la sonda arreglada:
`agents=2`, `sources=[{"name":"WasiAI","state":"unverified","rows":2}]`,
`caps[0]=["remittance","remit","kyc","compliance"]` — **no vacua**.

### 4.2 Control positivo — el instrumento SÍ discrimina

Se inyectó en el worktree de HEAD la fuga que AC-7 prohíbe (`capabilitiesState: 'unresolved'`
dentro de `mapAgent`, `discovery.ts:1360-1362`, o sea el marcador viajando por la LISTA):

```
HEAD MUTADO → a73a380bb62496eee50978b8fd348b5b7b53dc6a0d84ed70fa7c40867d22d237   ← sha DISTINTO
/usr/bin/diff → 22 líneas de diferencia
× T-07a → expected '{"id":"a-fed-1",…}' to be '{"id":"a-fed-1",…}'
× T-07b → expected ['id','name','slug',…(13)] to not include 'capabilitiesState'
```

⇒ La igualdad de §4 **no** es el resultado de una sonda que no puede fallar. Mutación
restaurada desde backup verificado con `/usr/bin/diff -q`; worktrees eliminados; repo
principal `git status --porcelain` **vacío**.

---

## 5 · Drift detection

| Chequeo | Resultado |
|---|---|
| **Scope IN vs archivos tocados** | ✅ Los 6 archivos de `src/` son **exactamente** los ítems 1-6 de `sdd.md §4.7`: `types/index.ts`, `services/agent-detail.ts`, `routes/discover.ts`, `routes/agent-card.ts` + los 2 de test. Ni uno de más |
| **Scope OUT — camino del dinero** | ✅ **0 archivos**. `downstream-payment`, `adapters/**`, `middleware/x402`, `fee-*`, settle, escrow, `compose.ts`, `orchestrate`, `agent-price.ts` → cero líneas en el diff |
| **Scope OUT — el pin del KYC** | ✅ `kyc-session-create` / `kyc-decision-read` sin tocar |
| **Scope OUT — republicar filas del catálogo** | ✅ Cero migraciones, cero SQL en el diff. La medición de §2 fue **sólo GET** |
| **CD-11 — `services/discovery.ts` no se toca** | ✅ 0 líneas. Es lo que hace automáticas a CD-3/CD-4 y a AC-7 |
| **`services/agent-card.ts` (declarado «no se toca»)** | ✅ No aparece en el diff. AC-5 se satisface desde la ruta |
| **Orden de waves** | ✅ `6d1cb63` (feat) → `29d55e3` (fix-pack AR+CR) → `cfb1cfe` (2 MENOR del AR-2). Los 3 en la rama, `git merge-base --is-ancestor` OK |
| **Tests del Story File ↔ ACs** | ✅ T-01..T-16 presentes y corriendo; los 20 casos nombran su AC en el título |
| **Deuda arreglada de contrabando** | ✅ Ninguna. `TD-369-1` (el `NaN` de `reputation`) sigue sin arreglar — arreglarlo habría roto AC-7; `TD-369-2` (`computedReputation`) idem |
| **Deuda sin declarar** | ⚠️ **una** — ver F4-MNR-1 |
| **Escala vs presupuesto (`sdd.md §4.7`)** | ⚠️ `agent-detail.ts`: **62 líneas de código** vs 45 presupuestadas (**1,38×**, dentro del 2×); prosa 117 vs ~35 (**3,3×**); tests **1066** vs ~400 (**2,7×**). El exceso es atribuible y está escrito: son los 6 bloqueantes del AR+CR (T-11..T-16) que no existían al presupuestar |

**TDs declaradas y verificadas presentes en `sdd.md §11`**: `TD-369-6`, `-7`, `-8`, `-9`, `-10` — las 5. `TD-369-6` está además **pineada ejecutando** por T-14 (`:353`), que se pone rojo el día que se cierre.

---

## 🔵 F4-MNR-1 — El residual de precio de AC-6 no tiene TD propia

`agent-detail.test.ts:470-482` (T-06b) **afirma con un assert** que existe una clase de payload
para la que AC-6 no se cumple:

```ts
// (b) el detalle NO trae `price_per_call` ⇒ 0, y DIVERGE de la lista.
const sinCaps = await resolveAgentForDetailView('fed-sin-caps');
expect(sinCaps?.priceUsdc).toBe(0);          // el detalle publica 0
expect(enLista?.priceUsdc).toBe(0.002);      // la lista publica 0.002
```

AC-6 pide, para `price`, **o** el mismo valor que la lista **o** declararlo no resuelto según
AC-2. Acá no pasa ninguna de las dos: sale `0` —un precio perfectamente plausible— sin ningún
marcador. `capabilitiesState` sólo habla de `capabilities`.

**Por qué es MENOR y no un FAIL de AC-6**: la población que hoy lo exhibe es **0 de 29**
(§2.3, medido contra prod). Los 24 federados salen del mismo endpoint y todos traen
`price_per_call`. El agujero es **latente**, no vivo.

**Por qué igual se anota**: `TD-369-4` declara el acoplamiento *«borrar `resolvePriceWithFallback`
mandaría el precio a 0 en silencio»*. Eso es una causa distinta. La que T-06b fija —**el
upstream deja de mandar `price_per_call` en el detalle**— no depende de que nadie toque este
repo, y es la clase de cosa que envejece sola. Un `0` sin marcador es la misma ambigüedad que
esta HU existe para matar, movida del campo `capabilities` al campo `price`.

**Salida sugerida**: TD nueva, o extender `TD-369-4` con esta segunda causa. No bloquea.

## 🔵 F4-MNR-2 — Dos archivos tocados que la tabla §4.7 no lista

`README.md:378` y `README.es.md:412` (los números `316→318` y `516→519`). No están en
`sdd.md §4.7`, pero **son mecánicamente obligatorios**: `test/readme-numbers.test.ts` los pone
rojos si no se actualizan. No es scope creep; es una entrada que faltó en el presupuesto.

## 🔵 F4-MNR-3 — `doc/sdd/_INDEX.md` sin la fila (ítem 8 de §4.7)

`_INDEX-row.md` existe en la carpeta de la HU pero `doc/sdd/_INDEX.md` **no aparece en el
diff**. El propio §4.7 dice «al cerrar», así que es trabajo de la fase DONE (`nexus-docs`),
no drift. Se anota para que no se pierda.

---

## 6 · Lo que NO se puede saber sin desplegar

Los cuatro ítems de abajo están **PASS en el arnés** y **medidos como defectuosos en prod**
(§2). Lo que falta es el «después». **No cuentan como verificados en producción.**

| # | Qué verificar post-deploy | Comando | Esperado |
|---|---|---|---|
| 1 | **AC-1** en prod | `GET /discover/<slug>` para los 10 de `difiere` (§2.1) | `capabilities` == el de `GET /discover`; bucket `difiere` pasa de **10 → 0**, `coincide-con-contenido` de 5 → 15 |
| 2 | **AC-2** en prod | idem, sobre los 14 de `coincide-en-vacío` | los que el catálogo confirma vacíos salen **sin** `capabilitiesState`; los que no se puedan confirmar salen **con** `'unresolved'` |
| 3 | **AC-5** en prod | `GET /agents/agentshop-kyc-validator/agent-card` | `skills` con 4 entradas (hoy `[]`) |
| 4 | **AC-6/`reputation`** en prod | comparar `reputation` lista↔detalle | `wasi-chainlink-price` (0 vs `null`) y `wasi-defi-sentiment` (1 vs `null`) dejan de divergir ⇒ **2/29 → 0/29** |

### Smoke manual post-deploy (para el operador)

```bash
B=https://wasiai-a2a-production.up.railway.app
# 1) el caso testigo: hoy da [] y debe dar 4
curl -s $B/discover/agentshop-kyc-validator | jq '.capabilities, .capabilitiesState'
# 2) el card, la segunda ruta que AC-5 inscribe
curl -s $B/agents/agentshop-kyc-validator/agent-card | jq '[.skills[].id]'
# 3) AC-7: la lista NO debe cambiar ni publicar el marcador
curl -s "$B/discover?limit=100" | jq '[.agents[] | select(has("capabilitiesState"))] | length'   # debe dar 0
# 4) el rate limit ya NO está exento en el detalle (AR BLQ-BAJO-3)
for i in $(seq 1 70); do curl -s -o /dev/null -w "%{http_code} " $B/discover/agentshop-kyc-validator; done   # debe aparecer 429
```

⚠️ El paso 4 **cambia el comportamiento observable de una ruta pública**: `GET /discover/:slug`
perdió `config: { rateLimit: false }` (`routes/discover.ts:321-360`). Es intencional y está
justificado con números en el docblock, pero un consumidor que hoy la martillea va a empezar a
ver `429`. Vale avisarlo en el release note.

---

## 7 · Higiene de esta validación

- Repo principal **nunca modificado**: `git status --porcelain` vacío al empezar, antes del
  gate, después del gate y al terminar. HEAD `cfb1cfe` sin mover.
- Las dos mutaciones (AC-4 y el control positivo de AC-7) se hicieron en **worktrees detached
  en scratchpad**, con backup verificado por `/usr/bin/diff -q` antes de mutar y restauración
  por `cp`. **Nunca `git checkout --`** sobre el árbol de trabajo real. Worktrees eliminados.
- Herramientas: `/usr/bin/grep`, `/usr/bin/diff`, `/usr/bin/git`, `sed`/`awk`. **Sin `cat`**,
  sin la herramienta `Grep`. La salida de `vitest` se leyó vía `rtk proxy` porque el filtro del
  proxy la colapsa a `PASS (n) FAIL (n)` y se pierden los nombres de test.
- Contra producción: **sólo `GET`**. Cero escrituras, cero SQL, cero deploys.
