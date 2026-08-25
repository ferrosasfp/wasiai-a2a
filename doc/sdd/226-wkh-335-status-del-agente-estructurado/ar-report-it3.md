# AR — re-AR iteración 3 (WKH-335 · #226)

**Fecha**: 2026-08-25 · **Alcance**: SÓLO el fix-pack 3 (la clasificación de la población de citas).
**Árboles**: `wasiai-a2a` @ `0095af9` (base `main` `4000a8f`) · `chaski-v3` @ `d5b6e45` (base `main` `8831729`).
**No se re-barrieron** las iteraciones 1 y 2 (`ar-report.md`, `ar-report-it2.md`).
**Instrumentos propios**: escáner independiente (regex + mapa `git diff -U1000000`) en el scratchpad;
todo `git` con `/usr/bin/git` (el hook de `rtk` trunca hunks).

## VEREDICTO: **RECHAZADO** — 1 BLOQUEANTE-MEDIO + 1 BLOQUEANTE-BAJO

| ID | Nivel | Categoría | Dónde |
|---|---|---|---|
| `BLQ-MED-1` | BLOQUEANTE-MEDIO | Data Integrity (CD-12) | `chaski-v3` `src/presentation/flow-vm.test.ts:3` y `:2060` |
| `BLQ-BAJO-1` | BLOQUEANTE-BAJO | Integration / clasificación | `chaski-v3` `app/api/payout/prepare/route.test.ts:497` |
| `MNR-1` | MENOR | Prosa que afirma de más | `auto-blindaje.md:454-455` |
| `MNR-2` | MENOR | Cobertura declarada | `auto-blindaje.md:630-635` (hueco 1 sin cota) |
| `MNR-3` | MENOR | Prosa que afirma de más | `auto-blindaje.md:641` |

---

## BLQ-MED-1 — DOS citas que ESTA HU desplazó y dejó FALSAS, las dos en `src/` (CD-12)

**Categoría**: Data Integrity · **Archivo:línea**: `chaski-v3`
`src/presentation/flow-vm.test.ts:3` y `src/presentation/flow-vm.test.ts:2060`.

Las dos son tokens **sueltos** (`` `:N` `` sin nombre de archivo), o sea el hueco nº 1 que el propio
fix-pack declara. Pero el fix-pack presenta ese hueco como barrido por adyacencia
(*«4 Clase 3 REALES salieron de ahí … aparecieron sólo porque estaban al lado de una cita que el
filtro sí vio»*, `auto-blindaje.md:630-635`; *«11 de las 27 correcciones de esta ronda salieron de leer
el renglón entero»*, `:671-672`). Estas dos están **exactamente ahí** — una en la misma línea, otra en
la línea de al lado de una cita que sí entró a la población — y no se leyeron.

### (a) `src/presentation/flow-vm.test.ts:3` — el token `` `:1873` ``

Texto de HOY:
```
// WKH-352: EN ESTA LÍNEA, no en una nueva — `http-pop-signer.ts:33` (NO-TOUCH) cita
// `flow-vm.test.ts:520` por número, y `:1743`/`:1873` los citan otros dos tests sin ancla
```

**Reproducción** (los dos árboles abiertos, comparando por SÍMBOLO):

| Comando | Salida |
|---|---|
| `/usr/bin/git show 8831729:src/presentation/flow-vm.test.ts \| sed -n '1873p'` | `    const TODOS: Record<EscrowOutcome, true> = {` |
| `sed -n '1873p' src/presentation/flow-vm.test.ts` (HEAD) | `      " ya",` |
| `sed -n '1902p' src/presentation/flow-vm.test.ts` (HEAD) | `    const TODOS: Record<EscrowOutcome, true> = {` |

El desplazamiento de este archivo es **+29** desde la línea 1049 (hunk `@@ -1048,0 +1056,22 @@` y los
tres previos). El **hermano de la misma línea** sí lo recibió — `` `:1714` `` → `` `:1743` `` (verificado:
`main@1714` y `HEAD@1743` son los dos `it("T-V8: el copy de 'chain-released' no dice 'entregado'…")`—
y el MISMO referente `TODOS` fue re-anclado a `:1902` en **otros tres** sitios de esta HU
(`history-grupos.test.tsx:405`, `flow-vm.test.ts:1941`, y el word-diff `` [-`:1873`-]{+`:1902`+} ``).
Sólo el de la línea 3 quedó sin mover.

Era **CORRECTA en `main`** y es **FALSA hoy** ⇒ **Clase 3** por el criterio del propio fix-pack
(`auto-blindaje.md:441`). Introducida por `b724068`, sobrevivió a `c6e62a1` y a `d5b6e45`.

⚠️ Agravante: esa línea 3 **es** la nota que existe para que esos números no se desincronicen
(«EN ESTA LÍNEA, no en una nueva … los citan otros dos tests sin ancla»). El aviso anti-desplazamiento
está desplazado.

### (b) `src/presentation/flow-vm.test.ts:2060` — el token `` `:1224` `` con el shift del archivo EQUIVOCADO

| Árbol | Texto |
|---|---|
| `main` (`8831729:…:2031`) | ``// Ese predicado es SIEMPRE verdadero ahí (`escrowOutcome` ya cortó en `:1195` con`` |
| `HEAD` (`…:2060`) | ``// Ese predicado es SIEMPRE verdadero ahí (`escrowOutcome` ya cortó en `:1224` con`` |

El referente es `if (k !== "unverified") return k;` **de `flow-vm.ts`**, no de este archivo:

| Comando | Salida |
|---|---|
| `/usr/bin/git show 8831729:src/presentation/flow-vm.ts \| grep -n 'k !== "unverified"'` | `1196:  if (k !== "unverified") return k;` |
| `grep -n 'k !== "unverified"' src/presentation/flow-vm.ts` (HEAD) | `1203:  if (k !== "unverified") return k;` |
| `sed -n '1224p' src/presentation/flow-vm.ts` (HEAD) | ` * ⚠️ LAS CUATRO FRASES LOCALES NO SE COPIAN ACÁ: se delegan en (…)` |

El shift de `flow-vm.ts` es **+7** (único hunk que corre líneas: `@@ -580,4 +580,11 @@`). El shift
aplicado fue **+29**, que es el de `flow-vm.test.ts` — el archivo donde vive el comentario, no el
archivo citado. En la **línea inmediatamente anterior** (`:2059`) el token hermano
`` `flow-vm.ts:1206` `` sí recibió el +7 correcto (→ `` `:1213` ``), y **ese token sí está en la población
de candidatas** (mi escáner y el del fix-pack lo traen). Leer el renglón entero, que es la regla que el
fix-pack declara haber aplicado, lo cazaba.

Por contenido: `main@flow-vm.ts:1195` = `const k = escrowFundsKnowledge(rem);` — **dentro de
`escrowOutcome`**, la función que la frase nombra, una línea arriba del `if` citado.
`HEAD@flow-vm.ts:1224` está **dentro del docblock de `escrowOutcomeDisplay`**, otra función, a 21
líneas del referente. Comparado **por función contenedora** (que es el método que este AR tenía
mandado usar): correcta en `main`, falsa hoy ⇒ **Clase 3**.

**Impacto de los dos**: violan **CD-12** (`sdd.md:441`, `story-file.md:608`/`:1216` — *«OBLIGATORIO
re-anclar las citas desplazadas en el mismo commit que las desplaza»*), viven en `src/` (no en el
estrato congelado), no las mira ningún candado (son sueltas, y `citas-ancladas.test.ts` sólo ve la
forma `` (`símbolo`, `:N`) ``), y son **deuda que creamos nosotros** — el criterio exacto que el
encargo puso como umbral de BLOQUEANTE.

**Sugerencia** (sin escribir el fix): re-anclar los dos tokens al número de HOY, y —dado que el modo
de falla fue aplicar el shift del archivo citador a un token que apunta a otro archivo— evaluar
anclarlos con símbolo (`` (`TODOS`, `:1902`) ``, `` (`escrowOutcome`, `../presentation/flow-vm.ts:1203`) ``)
para que queden bajo `src/composition/citas-ancladas.test.ts`, que es lo que el propio fix-pack hizo
con las 7 de `prepare/route.ts`.

---

## BLQ-BAJO-1 — un token HISTÓRICO **citado como cita**, clasificado como «Clase 2 · NO tocada» cuando SÍ se tocó

**Archivo:línea**: `chaski-v3` `app/api/payout/prepare/route.test.ts:497`.
**Contra**: `auto-blindaje.md:561-565` (*«Las 4 de Clase 2 de `chaski-v3`, medidas»*) + `:445-446`
(*«Clase 2 ⇒ ⛔ No se toca»*).

| Árbol | Texto de `:497` |
|---|---|
| `main` (`8831729`) | ``// `route.ts:62`, sin ancla, y esa línea es el cuerpo de `isRecord`: dice `typeof v === "object"`,`` |
| `HEAD` | ``// `route.ts:63`, sin ancla, y esa línea es el cuerpo de `isRecord`: dice `typeof v === "object"`,`` |

`/usr/bin/git log -L 495,499:app/api/payout/prepare/route.test.ts` muestra que el cambio `:62`→`:63`
lo hizo **`b724068`, el commit de Wave de esta HU**, y que el texto original (commit `8a6d85a`) era
*«validado de TIPO en route.ts:62»* — o sea que **`:62` es contenido CITADO, no un puntero**: la frase
es «Acá **decía** `route.ts:62`».

**Reproducción / impacto**: la oración de hoy afirma que el comentario *decía* `route.ts:63`. Nunca lo
dijo. La mitad **verdadera en `main`** (la afirmación sobre el pasado) quedó **falsa hoy**, y la causa
es una edición de esta HU ⇒ Clase 3, no Clase 2. La segunda mitad (*«esa línea es el cuerpo de
`isRecord`»*) sí estaba podrida en `main` (`8831729:…/route.ts:62` = `import { getKycVerdictStore }`),
y eso es lo único que el fix-pack midió.

**Por qué esto no es un empate de criterio**: el mismo fix-pack argumenta lo contrario, y bien, tres
párrafos más arriba, para `test/cited-lines-guard.test.ts:81` (`auto-blindaje.md:586-594`):
*«Cambiarla a `:589` volvería falsa una afirmación sobre el pasado»*. Y en
`test/cited-lines-guard.citations.ts:260` aplica el patrón correcto para el caso mixto: mueve el
puntero **y** conserva la historia (*«`:589` (era `:571` hasta WKH-335…)»*). En `chaski-v3` se hizo lo
contrario, en silencio, y el barrido lo archivó como deuda ajena.

**Sugerencia**: devolver el token citado a `:62` (o reescribir la oración para que el `:62` quede
declarado como histórico, al estilo de `gateways.ts:128`, que sí lo hace bien: *«la versión anterior
estaban escritos sueltos (`:116`, `:124`, `:125`, `:128`)»*), y corregir la fila correspondiente de las
«4 Clase 2» — hoy dice **NO tocada** sobre una línea que esta HU tocó.

---

## MENORes

- **`MNR-1`** — `auto-blindaje.md:454-455`: el tercero de los «tres casos que invierten la intuición»
  está **mal explicado**. Dice que `prepare/route.test.ts:809 → route.ts:482-486` *«idem»* (rota en
  `main`, correcta hoy por accidente). Medido: en `main` el token decía **`route.ts:469-473`** y era
  **CORRECTO** (`main@469-473` = el guard del `payoutId`); `b724068` lo **re-ancló** a `:482-486`
  (`HEAD@482-486` = el mismo guard). No hubo accidente: hubo una edición deliberada. El **veredicto**
  (falso positivo, no tocar) es correcto; el **mecanismo** que lo justifica es falso. Los otros dos
  casos —`compose.test.ts:106` y `compose.test.ts:17-23`— los verifiqué y **son ciertos** (ver §OK).
- **`MNR-2`** — `auto-blindaje.md:630-635`: el hueco nº 1 (tokens `` `:N` `` sueltos) es el único de los
  8 que se declara **sin cota**, y es por donde salieron `BLQ-MED-1`. La cota **es derivable**: mi
  barrido cuenta **666** tokens sueltos en `chaski-v3` y **7835** en `wasiai-a2a` (`git ls-files`,
  patrón `` `:N` ``). Los huecos 3, 4 y 5 sí llevan número; éste no.
- **`MNR-3`** — `auto-blindaje.md:641`: *«su tamaño (~22× el estrato vivo) **probaría** que la enorme
  mayoría es Clase 2 de otras HUs»*. Un tamaño no prueba una clase. La parte sustantiva de la regla de
  exclusión **sí** la verifiqué y se sostiene (ver §OK); la que sobra es esa media oración.

---

## Lo que medí y da OK

### 1. Daño colateral del fix-pack 3 — **OK, verificado**
`/usr/bin/git diff --numstat 1f86e3d 0095af9` y `… c6e62a1 d5b6e45`: **`add == del` en los 11 archivos
editados** (a2a `_INDEX.md` 4/4, `discovery-fetch-limit.ts` 1/1, `cited-lines-guard.test.ts` 7/7;
chaski los 7 archivos, 1/1 o 2/2 o 3/3). El único `N 0` es
`auto-blindaje.md` **282/0**, y es **apéndice al EOF** (412 líneas antes → 694 después; el bloque nuevo
arranca en `:413`) ⇒ no desplaza ninguna línea previa. La premisa «cero desplazamiento» **se sostiene**
y no hace falta re-barrer. Total de líneas editadas: 12 (a2a) + 12 (chaski) = **24**, que coincide con
lo declarado.

### 2. Las 12 Clase 3 de `wasiai-a2a` — **OK, 12/12 verificadas abriendo las dos líneas**
Para cada par `(main@vieja, HEAD@nueva)` el contenido es idéntico:
`compose.ts` 226→244 (`// envoltura conserva los steps completados…`), 241→259 (`throw err;`),
443→461 (`if (isSelfDestination(agent.invokeUrl, selfIdentity.hosts)) {`), 627→645
(`const debitResult = await budgetService.debit(`), 1785→1819
(`const downstream = await signAndSettleDownstream(`), 216→234 (`const composeRunId = randomUUID();`),
227→245 (`const results: StepResult[] = [];`), 230→248 (`if (!result.success) this.recordStranded…`),
372→390 (`const discoverCache = createDiscoverCache();`), 125-126→128-129 (las dos líneas del docblock
del over-fetch); `types/index.ts` 1610→1671 (`export interface AgentLinkRow {`), 1671→1732
(`export interface AgentLinkClaim {`). Todos consistentes con el mapa derivado de los hunks
(`compose.ts`: +3 desde 11, +18 desde 160, +26 desde 1159, +31 desde 1190, +34 desde 1759;
`types/index.ts`: +18 desde 689, +61 desde 1238).

### 3. La fila 226 y su «marco declarado» — **OK**
Las 5 traducciones escritas en `doc/sdd/_INDEX.md:218` son correctas contra el mapa
(`:1743`→`:1774`, `:1178-1190`→`:1204-1221` —cruza hunk—, `:1146-1159`→`:1164-1185`, `:920`→`:938`,
`field-error-parser.ts:24-31`→`:31-38`), y el `:1757` **sí** quedó sin destino:
`main@1756-1758` es `throw new Error(\`Agent ${agent.slug} returned ${response.status}…\`);`,
reemplazado en HEAD por `throw new AgentHttpError(agent.slug, response.status, detail);`
(hunk `@@ -1756,3 +1787,6 @@`).

### 4. Muestra de las 28 Clase 2 de `wasiai-a2a` — **OK (7/7 confirmadas)**
`main@compose.ts` abierto línea por línea: `:130` = `* filas de TODAS las fuentes contribuyentes…`
(la prosa cita «debita los steps 1..N»); `:278` = `if (strandedSteps.length === 0) return;` (cita
«`agent_id = agent.slug`» desde `reputation.ts:18`); `:539` = `error: ceilingBinds` (cita «el COSTO
REAL del pipeline»); `:792` = `return true;` (cita «18-dec scaling»); `:1424-1431` y `:1445-1448` = cola
de `executePipeline` + docblock/cuerpo de `resolveAgent` (las dos citas de `_INDEX.md:215` sobre header
de profundidad y bearer a registries `system`). Sumo una que el fix-pack no nombra y que también es
Clase 2 legítima: `src/lib/contracting-chain.ts:105` → `compose.ts:433`, que en `main` era `      //`
(comentario vacío). Las 7 estaban podridas **antes** de esta rama.

### 5. Las 4 Clase 2 de `chaski-v3` — **3 OK, 1 es `BLQ-BAJO-1`**
`docs/architecture.md:31` → `prepare/route.ts:297`: `main@297` = `let row: Awaited<…>`, y
`vm: "solana"` vivía en `main@512` (hoy `:525`) ⇒ Clase 2 ✓. Los dos README →
`quote/route.ts:91-96`: `main@91-96` = el `return` del 429 + `const body = await req.json()`, y el
`capability` está hoy en `:141` ⇒ Clase 2 ✓. La cuarta es `BLQ-BAJO-1`.

### 6. Muestra de los 101 falsos positivos de `chaski-v3` — **OK**
El grueso está cubierto **mecánicamente**, no por lectura: `src/composition/citas-ancladas.test.ts:73`
define `` ANCLADA = /`símbolo`,\s*`[archivo]?:línea`/ `` con el **archivo opcional**, escanea
`src|app|scripts|contracts` en `.ts/.tsx` y exige que la línea destino contenga el símbolo — o sea que
cubre también los sueltos con ancla (`` (`escrowOutcomeDisplay`, `:1260`) ``). La suite está verde ⇒
todos ésos son ciertos hoy. De los **sin ancla** abrí los dos árboles: `.env.example:285` →
`prepare/route.test.ts:1407` (hoy `it.each(["a2a-gateway","fallback",undefined])(` ✓),
`.env.example:312` → `gateway-client.ts:326` (hoy el spread de `x-payment-chain` ✓),
`quote/route.test.ts:405` → `gateway-client.ts:281-282` (hoy `case 402: return "payment_required";`,
que es lo que la frase afirma ✓), `bienvenida.tsx:112` → `flow-vm.ts:1231` (hoy los «CUATRO
DISPARADORES REALES» ✓). Y las 18 re-anclaciones `+7`/`+29`/`+18` de `flow-vm.ts`/`flow-vm.test.ts`/
`gateways.ts` las contrasté contra `main@(n−shift)`: **todas dan el mismo contenido**.

### 7. Los tres casos contraintuitivos — **2 CIERTOS, el tercero mal explicado (`MNR-1`)**
- `compose.test.ts:17-23` (citado desde `compose.discovery-pool.test.ts:32` y `discovery.limit.test.ts:23`
  como *«Patrón hoisted, exemplar»*): en `main`, `:17-23` es `vi.mock('../lib/logger.js'…)` + el
  comentario del mock de registry — **no contiene `vi.hoisted`**. En HEAD, `:17-23` es exactamente
  `const logSpy = vi.hoisted(() => ({ error, warn, info }));` + `vi.mock('../lib/logger.js', …)`, que es
  **byte por byte el bloque que `doc/sdd/218-…/story-WKH-318B.md:669-673` transcribe como el exemplar**.
  Rota en `main`, correcta hoy. ✓
- `compose.test.ts:106` (desde `compose.outbound-legs.test.ts:22`, *«mockean `downstream-payment.js`
  COMPLETO»*): `main@106` = `// producción y no un doble, para que el test se rompa…`;
  `HEAD@106` = `vi.mock('../lib/downstream-payment.js', () => ({`. Rota en `main`, correcta hoy. ✓
- El tercero: ver `MNR-1`.

### 8. El conteo del ítem 14 — **OK, 261 es el número de HOY, y reproducido con el instrumento del repo**
Corrí `scanSource` (de `test/cited-lines-guard.scanner.ts`, que el fix-pack 3 **no** tocó) vía `tsx`
desde un script en scratchpad, contra 4 árboles, con `git status --porcelain` vacío:

| Árbol | `test` | `citations` | `exceptions` | `scanner` | TOTAL |
|---|---|---|---|---|---|
| `main` `4000a8f` | 76 | **100** | 46 | 38 | **260** |
| Wave `ffeee10` | 76 | **101** | 46 | 38 | **261** |
| fix-pack 2 `1f86e3d` | 76 | 101 | 46 | 38 | **261** |
| HEAD `0095af9` | 76 | 101 | 46 | 38 | **261** |

Confirma las tres afirmaciones: (a) **261 es el de hoy** y el desglose por archivo escrito en
`cited-lines-guard.test.ts:168-169` (`76 · 101 · 46 · 38`) es exacto; (b) el `+1` lo aportó **la Wave 1**,
no el fix-pack 3 — o sea que el ítem venía viejo desde `ffeee10` y nadie lo había visto, tal como se
declara; (c) la corrección **no se movió a sí misma**: `test.ts` sigue en 76 antes y después de
escribirla. El bucle está declarado y medido contra el árbol correcto. El desglose `89·102·29·41`
**no** lo verifiqué más allá de que suma 261, y el propio fix-pack declara que su instrumento no lo
reproduce (`auto-blindaje.md:606-610`) — declarar el límite es lo correcto.

### 9. `cited-lines-guard.test.ts:81` — **OK, el argumento se sostiene, no es racionalización**
La frase describe una corrección de **la HU 224** (*«una de las correcciones de esta misma HU
(`compose.ts:130` → `src/services/compose.ts:571`) le agregó el directorio al token»*). El `:571` es
**contenido citado** —lo que aquella HU escribió—, no un puntero al guard de hoy. Moverlo a `:589`
afirmaría que la HU 224 escribió `:589`, que es falso. Y el efecto sobre el conteo es **cero**, como
declara: `cited-lines-guard.test.ts` no está en `CORTE_A_PATHS` y `571`→`589` seguiría siendo un token
P1 del mismo archivo (verificado: mi tabla de arriba da 76 para `test.ts` en los cuatro árboles).
La distinción que salva este caso —**puntero se re-ancla, contenido citado se congela**— es la misma
que `BLQ-BAJO-1` viola en el otro repo.

### 10. La regla de exclusión del estrato CONGELADO — **OK en su premisa mecánica**
`CORTE_A_PATHS` (`test/cited-lines-guard.citations.ts:87-101`) son 14 paths y **ninguno** es
`doc/sdd/**` ⇒ *«ningún candado los mira»* es literalmente cierto. Y el estrato es efectivamente
histórico: mi propio barrido lo confirma (`doc/sdd/223-…/story-file.md`, `224-…/sdd.md`,
`008-x402-compose/validation.md`, los reports de la propia 226…). `doc/sdd/_INDEX.md` queda **fuera**
del congelado y se clasificó, que es la decisión correcta (es el catálogo vivo). Único reparo: `MNR-3`.
Nota adicional, sin severidad: `doc/sdd/_AUDITORIA-INDICE-2026-08-19.md` **no** cae bajo la regla
escrita (no está en un `NNN-*/`), y su cita `src/services/compose.ts:21` la revisé — sigue apuntando
al `import` de `compose-input-mapping.js` en los dos árboles ⇒ falso positivo legítimo.

### 11. Las 4 Clase 3 de FUERA del filtro — **OK, verificadas**
`prepare/route.ts` `:344`→`:345` y `:347`→`:348` (los dos `payout_authority_unavailable`, 503 y 502)
citadas desde `flow-vm.ts:750` y `flow-vm.test.ts:2514`. `grep -n payout_authority_unavailable` da
`333/344/347` en `main` y `334/345/348` en HEAD ⇒ los tres emisores que la prosa nombra son correctos
hoy. ✓ (Lo que **no** cerró el mismo barrido son los dos de `BLQ-MED-1`.)

### 12. Las sumas — **cierran**
`12 + 28 + 14 = 54` ✓ · `10 + 4 + 101 = 115` ✓.
⚠️ Observación sin severidad: **no reproduje la población exacta**. Mi escáner, con un resolver
estricto (una cita se resuelve a un archivo real del índice antes de probar basename), da
`a2a: 538 candidatas / 19 vivas` y `chaski: 98 candidatas`, contra `1221/54` y `115`. La diferencia es
de resolver, no de método: el del fix-pack manda los `compose.ts:NNN` **a secas** a
`src/services/compose.ts` aunque `src/routes/compose.ts` también exista (ambigüedad que el propio repo
declara en `cited-lines-guard.citations.ts:257`). El sesgo va hacia **incluir de más**, o sea hacia
Clase 2 inofensiva, no hacia perder Clase 3. Las citas que mi resolver estricto sí trae están todas
clasificadas arriba.

### 13. Los gates — **CORRIDOS COMPLETOS, EN ORDEN, UNA VEZ, CON TODO EN EL ÍNDICE**
`git status --porcelain` vacío en los dos repos antes de correr.

`wasiai-a2a` (secuencia de `.github/workflows/ci.yml`; ⛔ `npm run qa` NO existe acá):

| Paso | Comando | Resultado |
|---|---|---|
| 1 | `npx tsc -p tsconfig.json --noEmit` | `TypeScript compilation completed` · exit **0** |
| 2 | `npm run lint` (`biome check src/`) | `Checked 503 files in 185ms. No fixes applied.` · exit **0** |
| 3 | `npm test` (`vitest run`) | `Test Files 298 passed \| 6 skipped (304)` · `Tests 5961 passed \| 19 skipped (5980)` · exit **0** |

`chaski-v3`:

| Paso | Comando | Resultado |
|---|---|---|
| 1 | `npm run qa` (`lint && typecheck && typecheck:scripts && test`) | exit **0** · `Checked 278 files` · `Test Files 154 passed (154)` · `Tests 3060 passed (3060)` |
| 2 | `npm run build` (`next build --webpack`) | exit **0** |

Coinciden exactamente con lo declarado en `auto-blindaje.md:676-694`.
⚠️ Y el verde **no cubre** `BLQ-MED-1`: los dos tokens son sueltos y sin ancla, así que
`citas-ancladas.test.ts` no los ve por construcción. Es un caso más de *acotar no es cerrar*.

---

## Categorías del checklist que NO aplican a este fix-pack

| Categoría | Estado |
|---|---|
| Security | **N/A** — el diff son 27 sustituciones de texto en comentarios, prosa y `.md`; cero código ejecutable, cero superficie nueva. |
| Performance | **N/A** — ídem: ninguna línea de runtime cambió. |
| Type Safety | **OK** — `tsc --noEmit` exit 0 en los dos repos; ningún tipo tocado. |
| Destructive Migrations | **N/A** — cero `.sql`, cero cambios de schema en el fix-pack 3. |
| RPC / `SECURITY DEFINER` | **N/A** — ninguna función Postgres en el diff. |
| Cache Invalidation | **N/A** — no se introdujo ni modificó ninguna capa de cache. |
| Error Handling | **N/A** — ningún `try/catch` ni camino de fallo en el diff. |
| Scope Drift | **OK** — los 11 archivos tocados están todos dentro del Scope IN del fix-pack de citas (`_INDEX.md`, `discovery-fetch-limit.ts`, `cited-lines-guard.test.ts`, los 7 de `chaski-v3`, más el `auto-blindaje.md` de la HU). Sin refactors, sin features. |
| Integration | **OK salvo** `BLQ-BAJO-1` — sin cambios de contrato; los dos gates y los dos builds verdes. |
| Data Integrity | **BLOQUEANTE** — `BLQ-MED-1`. |
| Test Coverage | **OK** — el fix-pack no agrega ni quita tests, y los conteos de las dos suites son idénticos a los de la iteración anterior (+1 en `chaski-v3` por `T-335-Q-4/CD-5`, del fix-pack 2, declarado). |

---

## Orden del fix-pack 4 (si el humano decide iterar)

1. `BLQ-MED-1` — `src/presentation/flow-vm.test.ts:3` (`` `:1873` `` → `` `:1902` ``) y `:2060`
   (`` `:1224` `` → el número de `flow-vm.ts` donde vive `if (k !== "unverified") return k`, hoy `1203`).
   Antes de escribir: **el token apunta a `flow-vm.ts`, no a este archivo** — el shift es +7, no +29.
2. `BLQ-BAJO-1` — `app/api/payout/prepare/route.test.ts:497` (`` `route.ts:63` `` → `` `route.ts:62` ``,
   o reescribir la oración declarando el token como histórico) + corregir la fila de las «4 Clase 2».
3. `MNR-1`, `MNR-2`, `MNR-3` — prosa de `auto-blindaje.md`.

⚠️ Los tres arreglos del punto 1 y 2 son **sustituciones intra-línea** ⇒ no desplazan nada y no
requieren re-barrer la población. Lo que sí conviene re-correr es el barrido de tokens **sueltos**
sobre las líneas que la HU editó: es la clase que se escapó dos veces.
