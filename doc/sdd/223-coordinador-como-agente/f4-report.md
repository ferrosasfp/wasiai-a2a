# F4 · QA — WKH-360 / 223 · el coordinador es un agente

> **HEAD auditado** `a7c2ce9` · rama `feat/223-wkh-360-coordinador-agente` · base `3823580`
> Worktree `/home/ferdev/.openclaw/workspace/wt-360`, árbol limpio al empezar y al terminar.
> ⛔ **Cero modificaciones de código.** Los 4 mutantes que corrí se restauraron por **sustitución
> inversa** y se verificaron con `md5sum -c` + `git status --porcelain` vacío.
> Todo número de este documento fue **medido en esta sesión** con el comando al lado. Lo que no pude
> medir dice `[NO VERIFICADO]`.

## VEREDICTO: 🟢 **APROBADO**

**12 de 12 ACs PASS con evidencia archivo:línea.** Drift: sin scope creep no justificado, sin wave
drift, sin `.sql`, sin queries nuevas. Las 6 verificaciones obligatorias dieron el resultado esperado,
y **las dos que exigían mutación mataron**. Quedan **3 MENORes de documentación**, ninguno bloqueante,
listados al final.

---

## 0 · Línea base re-derivada (no heredada del CR)

| Gate | Comando | Medido |
|---|---|---|
| Suite | `node ./node_modules/vitest/vitest.mjs run` | `Test Files 286 passed \| 6 skipped (292)` · `Tests 5624 passed \| 19 skipped (5643)` · **exit 0** |
| Typecheck | `./node_modules/.bin/tsc --noEmit` | **exit 0** |
| Lint | `npm run lint` (⛔ **no** `npx biome check`) | **exit 0** · `Checked 485 files` |
| Ownership guard | `vitest run test/ownership-filter-guard.test.ts` | **13 passed (13)** |
| SDD index guard | `vitest run test/sdd-index-matches-folders.test.ts` | 12 passed (12); filas `222` y `223` presentes |
| Árbol | `git status --porcelain` | vacío |

**Coincide exactamente con el estado declarado** (`286\|6` / `5624\|19`, tsc 0, lint 0, ownership 13/13).
La suite se re-corrió **después** de los 4 mutantes: mismo número, mismo exit 0.

Migraciones / RPC / cache — **medido, no asumido**:
```
git diff --name-only 3823580..a7c2ce9 | grep -c "\.sql$"        → 0
git diff --name-only 3823580..a7c2ce9 | grep -c "migrations"    → 0
git diff 3823580..a7c2ce9 -- 'src/*' | grep -E "^\+.*(supabase\.from\(|\.rpc\()"  → exit 1 (cero hits)
```
⇒ DT-7 respetado, CD-8 **N/A medido**, el régimen de `deriveTables()` no se activa.

---

## 1 · Los 12 ACs

| AC | Enunciado (resumen) | Estado | Evidencia (archivo:línea / medición) |
|---|---|---|---|
| **AC-1** | La carta declara precio (o cómo obtenerlo), esquema de auth/pago y endpoint por skill; sigue gratis y sin rate-limit | ✅ **PASS** | `src/services/agent-card.ts:290-330` (`endpoint:{method,path}` + `pricing` por skill; `pricing.model:'protocol-fee-on-executed-cost'` + `feeRatePercent` + `quoteEndpoint:'/orchestrate/plan'`) · `authentication.schemes: ctx.schemes` (antes `[]`) · `src/routes/well-known.ts:11` sigue con `config: { rateLimit: false }` · tests `src/routes/well-known.test.ts:116` `T-CARD-1`, `:168` `T-CARD-2` |
| **AC-2** | Una sola función (`buildSelfAgentCard`); `/capabilities` sigue derivando de ella | ✅ **PASS** | `src/routes/capabilities.ts:33` `buildSelfAgentCard(baseUrl)` — mismo call que `src/routes/well-known.ts:14` · el contexto nuevo sale de **un** helper, `agent-card.ts:224-238` `resolveSelfCardContext()`, con **un solo** call-site · test `well-known.test.ts:279` `T-CARD-4` · `T-CARD-3` (`:216`) **deriva** los prefijos de `src/index.ts` y asserta que la derivación no vino vacía (era un guard que se comparaba consigo mismo; lo arregló el propio dev) |
| **AC-3** | Dato no resoluble ⇒ **omitir** el campo, nunca `0`/`null`/placeholder | ✅ **PASS** | `agent-card.ts:230` `schemes: ['bearer', ...(inboundChains.length > 0 ? ['x402'] : [])]` — `x402` **desaparece**, no sale `x402:false` · sin `priceUsdc` por skill, y la ausencia está argumentada en el docblock (`:262-272`) · test `well-known.test.ts:343` `T-CARD-5` |
| **AC-4** | Bucle DIRECTO: rechazo **antes del débito** y **antes** del settle, con `errorCode` propio, sin emitir el fetch | ✅ **PASS** | **Sitio 1** `src/routes/compose.ts:767-783`, dentro de `resolveComposePriceHandler`, que en el array de preHandlers está en `:930` — la posición **anterior** a `...requirePaymentOrA2AKey(` (`:931`) · **Sitio 2** `src/services/orchestrate.ts:1198-1240`, contra el `budgetService.debit` de `:1295` · **Sitio 3** `src/services/compose.ts:443-458`, contra el `budgetService.debit` de `:627` y el `signAndSettleDownstream` de `:1785` · **Sitio 4** `compose.ts:1703-1725`, pre-`ssrfFetch` (`:1738`) · testigos de **orden**, no de status: `T-L1-1` (`routes/compose.contracting-loop.test.ts:203`, «400 + CERO debit + saldo intacto»), `T-L1-2` (`services/compose.contracting-loop.test.ts:156`, «debit 1 vez, NO 2»), `T-L1-2b` (`:191`), `T-L1-3` (`services/orchestrate.contracting-loop.test.ts:209`, «CERO debit»), `T-L1-7` (`services/compose.contracting-loop.test.ts:389`) |
| **AC-5** | Traza entrante que ya nos contiene ⇒ mismo `errorCode`, antes de cobrar | ✅ **PASS** | `contractingGuardHandler` es el **primer** preHandler de las 4 cadenas: `routes/compose.ts:909` (antes de `requirePaymentOrA2AKey` en `:931`) y `routes/orchestrate.ts:145`, `:325`, `:555` (antes de `markSkipMiddlewareDebitHandler` y del middleware de pago) · `middleware/contracting-guard.ts:97` · tests `contracting-guard.test.ts:80` `T-L2-1`, `:99` `T-L2-3` (membresía con punto final + mayúsculas), `:198` `T-CHAIN-5` (header repetido para esconder nuestro eslabón) · **orden con dinero**: `routes/compose.contracting-loop.test.ts:498` `T-L2-1-ORDEN` («400 y CERO llamadas a debit») |
| **AC-6** | Profundidad ≥ techo ⇒ rechazo antes de cobrar; techo ausente/ilegible ⇒ default del código, jamás «sin techo» | ✅ **PASS** | **Medido en runtime** (probe con `./node_modules/.bin/tsx` sobre el leaf, borrado después): `resolveContractingDepthMax()` sin env ⇒ `2`; con `'0'`,`'00'`,`' 0 '`,`'65'`,`'-1'`,`'abc'`,`'1O'` ⇒ **`2` en los siete** (nunca `0`, nunca `Infinity`); con `'007'` ⇒ `7` · tests `contracting-guard.test.ts:218` `T-DEPTH-1`, `:228` `T-DEPTH-1b` (gemelo positivo), `:233/:241/:249` `T-DEPTH-2/3/4` (`'1e9'`, `''`, `' 2'`/`'2abc'`/`'0x10'`/`'1000'`), `:261` `T-DEPTH-5`, `:270` `T-DEPTH-6` · orden con dinero: `routes/compose.contracting-loop.test.ts:526` `T-DEPTH-1-ORDEN` |
| **AC-7** | El invoke outbound emite la cadena y la profundidad incrementada | ✅ **PASS** | `src/services/compose.ts:1567-1589` — los dos headers van **antes** del spread de credenciales (CD-4), y sin `canonicalId` **no se emite ninguno** (CD-18) + warn en `:1596-1600` · `compose.ts:358-367` resuelve la identidad **una vez por pipeline** · tests `services/compose.contracting-loop.test.ts:442` `T-PROP-1`, `:474` `T-PROP-1b`, `:493` `T-PROP-2`, `:539` `T-PROP-5`, `:581` `T-PROP-3` (colisión de nombres real: con el orden invertido la credencial se destruye en silencio), `:635` `T-PROP-3b`, `:676` `T-PROP-4` (ida y vuelta: lo que emitimos lo caza nuestro propio lector) |
| **AC-8** | El caso legítimo, intacto: mismo status, body, cobro y cantidad de settles | ✅ **PASS** | `routes/compose.contracting-loop.test.ts:308` `T-L1+1` (200 y **sí** debita), `:331` `T-L1+2` («los DOS hosts REALES de prod pasan — el guard rechaza 0 de 25»), `:368` `T-L1+3`, `:574` `T-L2+2-ORDEN` · `services/compose.contracting-loop.test.ts:217` `T-L1+5` («5 steps ajenos → 200, **4 débitos, 5 emisiones**»), `:246` `T-L1+6`, `:846` `T-FEE-7` (200 con body escalar **no** falla un step ya cobrado) · `services/orchestrate.contracting-loop.test.ts:344` `T-L1+8`, `:373` `T-L1+9` («no hace lookups extra») · `contracting-guard.test.ts:110` `T-L2+1`, `:121` `T-L2+2` («SIN ninguno de los dos headers → PASA — el 100% del tráfico de hoy») · y las 286 suites preexistentes siguen verdes |
| **AC-9** | Capa 1 **sin** cooperación; la cooperación es necesaria **sólo** para el transitivo, y eso queda escrito en el código y en la respuesta de error | ✅ **PASS** | `routes/compose.contracting-loop.test.ts:275` `T-L1-6` («SIN ningún header de contratación, el destino propio se rechaza igual») · la limitación sale de **una sola constante**, `lib/contracting-chain.ts:187-192` `CONTRACTING_LAYER2_BEST_EFFORT_NOTE`, consumida por el **body del error**, por la Agent Card (`agent-card.ts:325`) y por el test · testigo del body: `contracting-guard.test.ts:87` `T-L2-2` (asserta el texto **desde la constante**, así que emisor y test no pueden divergir) · `T-FLAG-1` (`routes/compose.contracting-loop.test.ts:458`): **ninguna env nueva gatea el corte** (CD-1) |
| **AC-10** | El 200 de `/compose` declara el fee de protocolo de **este** gateway, de forma aditiva | ✅ **PASS** | `src/routes/compose.ts:1270-1277`: `feeRatePercent` + `protocolFeeStatus` incondicionales, `protocolFeeUsdc` **omitido** salvo cobro real · tests `routes/compose.fee.test.ts:369` `T-FEE-8` (monto sí, **hash del fee nunca**: `expect(JSON.stringify(body)).not.toContain('0xfee')`), `:411` `T-FEE-2wkh`, `:433` `T-FEE-3wkh` (`failed` ⇒ `'unknown'`, **no** `'not_charged'`) |
| **AC-11** | El fee de un sub-coordinador se expone **por separado**; si no lo declara ⇒ **no declarado**, jamás `0` | ✅ **PASS** | `lib/contracting-chain.ts:1092-1124` `rollUpCascadedFee` ⇒ `cascadedOrchestrationFeeUsdc?` + `cascadedOrchestrationFeeStatus:'complete'\|'partial'` · serializado en `routes/compose.ts:1276` y `services/orchestrate.ts:1695` · tests unitarios `lib/contracting-chain.test.ts:1310-1530`: `T-U-FEE-3` (declarado sin monto usable ⇒ `declared:false`, **nunca** `usdc:0`), `T-U-FEE-5` (body escalar ⇒ `undefined` y **no tira**), `T-U-FEE-7` (monto sobre el techo ⇒ `false`, **no se recorta**), `T-U-ROLL-3/4/5/6/7` (`partial` sin número inventado; redondeo a 0, no finita y **negativa** ⇒ se **omiten**) · integración `services/compose.contracting-loop.test.ts:741` `T-FEE-4`, `:777` `T-FEE-5` |
| **AC-12** | Estrictamente aditivo | ✅ **PASS** | `routes/compose.ts:1270-1277` — `{ kiteTxHash, ...result, ...nuevos }`: ninguna clave previa se quita ni cambia de valor · `T-FEE-8` asserta `success`/`totalCostUsdc` intactos · `T-U-ROLL-1` («ningún coordinador ⇒ `{}` ⇒ respuesta byte-idéntica») y `T-FEE-6wkh` («agente NORMAL → los dos campos de cascada AUSENTES») · **`POST /orchestrate/plan` NO ganó ningún campo de cascada** (verificado: `routes/orchestrate.ts:478-491`), que es lo que el Scope OUT pedía · ⚠️ tensión registrada y ya juzgada por el CR (MNR-4): el 200 gana **2 claves incondicionales**, así que ningún response es byte-idéntico. El propio código lo dice con el marcador `[FALSA]` sobre la frase vieja (`routes/compose.ts:1253-1258`). AC-12 pide **aditivo**, no byte-idéntico ⇒ cumple |

---

## 2 · Las 6 verificaciones obligatorias

### ✅ V1 — El corte ANTES del débito, en los cuatro sitios (y CD-17 respetado)

**Tres cortan antes de un débito DISTINTO** (por eso ninguno reemplaza a otro):

| Sitio | Guard | Débito que corta | ¿Antes? |
|---|---|---|---|
| 1 · `routes/compose.ts` | `:767` | middleware `requirePaymentOrA2AKey`, preHandler `:931` (el guard vive en el preHandler `:930`) | ✅ |
| 2 · `services/orchestrate.ts` | `:1198` | `budgetService.debit` `:1295` | ✅ |
| 3 · `services/compose.ts` | `:443` | `budgetService.debit` `:627`; settle en `:1785` | ✅ |
| 4 · `services/compose.ts` (`invokeAgent`) | `:1703` | **corre DESPUÉS del débito del step** | ⛔ **declarado NO-guard de dinero** |

**CD-17 — barrido de TODA superficie que nombra el Sitio 4** (`grep -rn "SITIO 4\|Sitio 4\|sitio 4"` sobre
`src/`, `doc/sdd/223-*`, `doc/decisions/…`, `.env.example`, más los 19 mensajes de commit). **Cero textos lo
presentan como guard de dinero.** Los que lo nombran, lo **niegan**:
- `src/services/compose.ts:1681` — `⛔ ESTE NO ES EL GUARD DE DINERO (CD-17)` + `:1687-1692` («un throw acá lo agarra el catch per-step… **Si esta rama dispara, YA SE COBRÓ**, y el reembolso es best-effort»).
- `src/services/compose.contracting-loop.test.ts:9` y `:388` — el `describe` dice `⛔ NO es guard de dinero`.
- Commit `879faa7`: *«SITIO 4 · ⛔ NO ES GUARD DE DINERO, y ni el comentario ni el test ni este mensaje lo presentan como tal (CD-17)»*.

**Loguea a `error`, y el nivel tiene testigo**: `compose.ts:1716` `log.error(...)` con el logger **del
módulo** (no el que inyecta el caller: `DownstreamLogger` sólo declara `warn`/`info`, y degradar el nivel
para entrar en ese shape habría violado CD-17). Testigo `T-L1-7`
(`services/compose.contracting-loop.test.ts:389`): asserta `mockFetch` **no llamado**, `logSpy.error`
llamado, `logSpy.warn` **no** llamado con `blocked-at-emission`, y que el mensaje contiene `'best-effort'`.

> **Mutante propio corrido** (`log.error(` → `log.warn(` en `compose.ts:1716`):
> `1 failed | 20 passed` — **muere `T-L1-7`, y sólo él**. Restaurado por sustitución inversa,
> `md5sum -c` OK, `git status` vacío. ⇒ el nivel del log **no es prosa**: está fijado.

### ✅ V2 — `T-HINT-CALLSITES`: **los DOS mutantes MATAN**

`src/lib/contracting-chain.test.ts:1140`. Escanea `src/` (sin `.test.ts`/`.d.ts`/`__tests__`), quita
comentarios, y para cada `orchestrateService.orchestrate(` / `.executeApprovedPlan(` /
`this.executeApprovedPlan(` / `composeService.compose(` mira si los argumentos incluyen `selfHostHint`.
Tres excepciones **escritas una por una** (`:1063-1075`): tool MCP, `services/inbound-task.ts`, y el
reenvío interno `this.executeApprovedPlan`. Tiene controles anti-vacuidad (`sites.length >= 3+4`, los 4
call-sites con hint nombrados uno por uno) y **no se puede pudrir hacia el otro lado** (una excepción que
sobra también rompe, `:1173`).

| Mutante | Aplicación (verificada por texto resultante) | Medido |
|---|---|---|
| **M-A · borrar el spread** | quitar `...(selfHostHint !== undefined ? { selfHostHint } : {}),` de `src/services/agent-link.ts:396` (needle `== 1`; `tsc` post-mutante = **0**, o sea el veredicto vale) | **MATA — 2 rojos**: `T-HINT-CALLSITES` en `contracting-chain.test.ts:1159` (`services/agent-link.ts :: orchestrateService.executeApprovedPlan( #1 dejó de pasar selfHostHint`) y `T-L1-2f` en `agent-link.test.ts:263` |
| **M-B · call-site nuevo sin hint** | archivo de producción nuevo con `composeService.compose({...})` sin `selfHostHint` | **MATA — 1 rojo**, con el mensaje accionable: `expected [ "services/wkh360-mutant-probe.ts :: composeService.compose( #1" ] to deeply equal []` |

Restauración: M-A por sustitución inversa (`md5sum -c` OK), M-B borrando el archivo. `git status
--porcelain` vacío tras cada uno.

### ✅ V3 — Lo que sigue ABIERTO aparece **sólo** como negación o prohibición

Tres barridos con `/usr/bin/grep -rn` (⛔ no bajo `rtk`, que trunca) sobre `src/`, `doc/`, `.env.example`,
`README*`:

| Residual | Hits en el alcance de la HU | Veredicto |
|---|---|---|
| **Transitivo contra quien borra headers** (30 hits de `transitivo/TRANSITIVO`) | `lib/contracting-chain.ts:149-153` («La capa 2 depende de que la contraparte reenvíe los headers ⇒ es BEST-EFFORT»), `:188-192` (la constante que va al **body del error**), `:889` («El del bucle **no afirma que el transitivo esté cerrado**») · `services/agent-card.ts:325` · `types/index.ts:1885` · `implementation-log.md:291`, `:447` · `doc/decisions/…:103` **R-4**, que además lista la frase prohibida (*«"bucle transitivo cerrado" a secas»*) y agrega que **no es teórico: es la topología de hoy** (22 de 25 agentes viven en `wasiai-v2`, que no reenvía) | ✅ **cero afirmaciones de cierre** |
| **IP literal (R-3 / TD-360-2)** | `lib/contracting-chain.ts:154-158` («La comparación es POR NOMBRE… Residual declarado, **NO cerrado acá**»), `:312-313` («⛔ Esto **NO cierra R-3**… Que un operador PUEDA declarar un literal no significa que el bypass esté cerrado») · `.env.example:612-615` · `contracting-chain.test.ts:194` `T-U-HOST-6` («R-3 sigue abierto por otra razón») · `doc/decisions/…:102` con su frase prohibida | ✅ **abierto y dicho** · **medido**: `isSelfDestination('https://69.46.46.64/x', ['gw.example.com'])` ⇒ `false` |
| **NO hay drenaje en curso hoy** | `implementation-log.md:341-343` («**Que hoy haya drenaje de fondos en curso.** Lo medido es que **el guard no existía**… Lo que frena hoy el caso directo es **accidental** (el bearer sólo se reenvía a registries system-trusted), **no un guard**») · `work-item.md:354-356` idéntico | ✅ **negación explícita**, sin ningún texto que reclame lo contrario |

### ✅ V4 — El conjunto vacío a pedido del caller: **declarado como abierto**, y las frases calificadas

Está escrito que lo cierra **setear `A2A_SELF_HOSTS`**, no un commit:

- `lib/contracting-chain.ts:545-570` — el bloque `⛔ Y SIN LAS DOS ENVS, ESE PÁRRAFO NO ES UNA PROPIEDAD DE
  SEGURIDAD`, con la **medición literal** (`resolveSelfHosts('a b'|'http://x'|'::1'|'')` ⇒
  `{hosts: [], canonicalId: null}` ⇒ guard **INERTE**) y la conclusión: *«Lo que el hint cubre es el bucle
  **accidental**… Lo que cierra el caso hostil es **setear `A2A_SELF_HOSTS`**, que por eso es paso del deploy»*.
- **El warn de arranque dice textualmente "contra un caller honesto"**: `contracting-chain.ts:504`
  → `'Lo que SIGUE cubierto, y SOLO CONTRA UN CALLER HONESTO: el bucle ACCIDENTAL directo por HTTP…'`,
  y sigue con *«Sin esta variable ese Host **no AGRANDA el conjunto: lo DEFINE**… lo deja en CERO y vuelve
  el guard **inerte a pedido**»*.
- **El log de arranque de prod** (`src/index.ts:239`): *«…eso cubre el bucle **ACCIDENTAL, no a un caller
  que ataca** — sin esta variable el Host no agranda el conjunto, lo DEFINE, asi que un Host ilegible lo
  deja VACIO y el guard queda inerte»*.
- Testigo ejecutable: `T-L1-2e` (`services/compose.contracting-loop.test.ts:360`), que mide las 4 entradas
  del vaciado **y** el contraste con la env puesta. Y el gemelo `T-L1-2d` (`:319`), que congela la
  monotonía **en el caso configurado** — que es donde vale.

**Ninguna superficie dice "cubierto sin configuración" a secas.** ⚠️ Ver MNR-QA-1: `.env.example` es la
única de las cuatro que no enumera el vaciado entre sus residuales.

### ✅ V5 — `MNR-6` es profiláctico: **medido, no cuenta como «cerrado con testigo»**

Mutante: quitar `resolveAgentDestination: vi.fn().mockResolvedValue(null),` de las **dos** factories
(`src/services/agent-link.test.ts:25` y `src/routes/orchestrate.test.ts:78`), needle `== 1` en cada una.

```
vitest run src/services/agent-link.test.ts src/routes/orchestrate.test.ts
  Test Files  2 passed (2)
       Tests  65 passed (65)          ← el mutante SOBREVIVE
```

⇒ **coincide byte por byte con lo que el dev declaró** en `auto-blindaje.md:445-459` («lo **medí** en vez
de suponerlo… **65 passed, 0 fail**. O sea que el mutante NO mata, por construcción»). Hoy ninguna ruta de
esos dos archivos alcanza esa export, así que **no hay comportamiento que un test pueda mirar**.
**Contabilizado como arreglo preventivo SIN testigo**, no como cierre verificado. Restaurado, `md5sum -c` OK.

### ✅ V6 — Las dos citas rotas de `facilitator-settle.wiring.test.ts` son **AJENAS y pre-existentes**

`src/adapters/solana/facilitator-settle.wiring.test.ts:14` cita `src/index.ts:246-248` para el comentario
de `await initAdapters()`, y `:93-94` cita `src/index.ts:338` / `:345` para los dos warm-ups.
Medido con `git show <sha>:src/index.ts | sed -n '<n>p'` en **tres** shas:

| sha | `:246-248` | `:338` | `:345` | Dónde vive de verdad el comentario de `initAdapters()` |
|---|---|---|---|---|
| **`3823580` (baseline, ANTES de esta HU)** | comentario del umbral de alerta | banner ASCII de `/orchestrate` | comentario del camino escrow | **`:252`** |
| `d9a8cbb` | log de self-published-auth | prosa de NC-1 | prosa del `/health` duplicado | `:322` |
| `a7c2ce9` (HEAD) | ídem | `solanaPayoutRoute` | prosa de `source:'request-only'` | `:326` |

⇒ **ya no matcheaban en el baseline** (off por ~4-6 líneas antes de que esta HU tocara nada).
El archivo es del **carril Solana** y **no está en el diff** de esta HU.
**NO se cuentan contra WKH-360.** Quedan **reportadas** para el carril Solana, junto con la aclaración de
que esta HU **ensanchó** el desfase (a ~74 y ~103 líneas) sin haberlo creado.

---

## 3 · Drift detection

### 3.1 · Scope drift — `git diff --name-only 3823580..a7c2ce9` (37 archivos)

**Dentro del Scope IN de `story-file.md §14`** (18/18 filas cubiertas): `lib/contracting-chain{,.test}.ts`,
`middleware/contracting-guard{,.test}.ts`, `routes/well-known.test.ts`, `types/index.ts`,
`services/agent-price.ts`, `routes/compose.ts`, `services/compose.ts`, `services/orchestrate.ts`,
`routes/orchestrate.ts`, `services/agent-card.ts`, `index.ts`, `__tests__/e2e/setup.ts`, los 3 mocks
tipados de CD-22, `.env.example`, `doc/decisions/…`, `doc/sdd/223-…/{implementation-log,auto-blindaje}.md`.

**Fuera de la tabla — los 11, cada uno con su origen documentado. Ninguno es scope creep:**

| Archivo | Origen | Juicio |
|---|---|---|
| `services/agent-link.ts`, `routes/agent-links.ts` (+ sus 2 tests) | **AR-it2 / BLQ-MED-1** — el TERCER caller HTTP (`POST /agents/links/:token/redeem`, público, y **el bucle lo paga quien emitió el link**) | ✅ remediación de un BLOQUEANTE, obligatoria |
| `services/agent-price.test.ts` | 5.º sitio de mock (`toEqual` exacto ⇒ rompe en runtime, no en `tsc`) | ✅ declarado, `implementation-log §6.2` |
| `services/orchestrate.quote-billing.test.ts` | fix-pack G1: `importOriginal` en un factory amputado que el guard **encendió** | ✅ declarado, `auto-blindaje:354-383`; el dev **no** bajó el guard para poner verde |
| `routes/orchestrate.test.ts` | `T-ROUTE-HINT` + MNR-6 | ✅ |
| `routes/agent-card.test.ts`, `services/agent-card.test.ts`, `routes/compose.fee.test.ts` | 3 aserciones **re-apuntadas**, las tres porque **la inversión es el objeto de un AC** (AC-1b, AC-10) | ✅ declarado, `implementation-log §5`; ninguna se borró |
| `README.md`, `README.es.md` | **CD-21** — `test/readme-numbers.test.ts` **re-deriva** los conteos y las 2 envs nuevas los volvieron falsos | ✅ obligatorio; los tres números se **derivaron**, no se incrementaron |
| `__tests__/e2e/e2e.test.ts` | **CR / BLQ-BAJO-2** — `T-HEALTH-CONTRACTING` / `T-HEALTH-BOTH` | ✅ remediación de bloqueante |

**Scope OUT respetado, verificado uno por uno**: `lib/ssrf-dispatcher.ts`, `lib/url-validator.ts`,
`lib/downstream-payment.ts`, `lib/self-published-auth.ts`, `doc/sdd/_INDEX.md`,
`.nexus/project-context.md` — **ninguno en el diff**. `POST /orchestrate/plan` **no ganó** campo de
cascada (`routes/orchestrate.ts:478-491`). Cero archivos de `chaski-v3`, `wasiai-facilitator` o cualquier
`wt-*`.

### 3.2 · Wave drift — **ninguno**

`git log --reverse 3823580..a7c2ce9`: `23a27dd` W0 → `879faa7` W1 → `6f252ad` W2 → `af9ef5a` W3 →
`1015f90` W4 → `71fdaf7` W5 → fix-pack 1 (6) → fix-pack 2 (7). **Orden estricto**, un commit por wave, sin
reordenamientos ni reescritura de historia. El commit `23a27dd` sigue declarando una cifra falsa
(`5497 passed / exit 0` sobre un árbol con 4 rojos) y **eso está corregido y no ocultado** en
`implementation-log.md:39-67`, con el riesgo de `bisect`/revert escrito.

### 3.3 · Spec drift — spot-check de 3 funciones contra el SDD/Story File

| Contrato | Implementación | Veredicto |
|---|---|---|
| §3.3 `resolveSelfHosts(hint?)`: orden `BASE_URL → A2A_SELF_HOSTS → hint`, `canonicalId` = primero de ese orden o `null` | `lib/contracting-chain.ts:585-604` — mismo orden, `canonicalId: hosts.length > 0 ? hosts[0] : null` | ✅ exacto |
| §3.2 comparar `hostname` (no `host`): puerto y esquema se ignoran; punto final se strippea | **medido**: `isSelfDestination('https://GW.EXAMPLE.COM:8443/x', ['gw.example.com'])` ⇒ `true`; `('https://gw.example.com./x', …)` ⇒ `true` | ✅ |
| §3.4 dos niveles de config + `/health` aditivo | **medido**: `'.'`/`'。'`/`'%2e'`/`'a b'`/`'https://gw'`/`'gw:8443'` ⇒ `state:'invalid'` y `assertSelfHostsEnv()` **tira** · sin envs ⇒ `{"selfHostCount":0,"depthMax":2,"source":"request-only"}` · con env ⇒ `{"selfHostCount":1,…,"source":"env"}` | ✅ **y confirma el fix de AR-it2/BLQ-BAJO-1**: el `""` que se reportaba como `configured` ya no existe |

**Desviación declarada y ya ratificada por el CR §6.1** (canal de corte del Sitio 2 vía
`pipeline.errorCode` + mapeo a 400, en lugar del `__quoteStale`): verificada — **el orden respecto del
dinero no cambia** (`orchestrate.ts:1198` vs débito en `:1295`), toca 1 archivo del Scope IN en vez de 5
(3 fuera de scope), y `MUT-03` lo confirma.

### 3.4 · Test drift — ninguno

Los tests que el Story File define existen y corresponden a su AC (mapa completo en §1). Cero tests
borrados; los 3 re-apuntados están declarados con motivo. Los 3 mutantes de **testigo único** (`MUT-09`,
`MUT-14`, `MUT-15`) llevan la anotación **en el testigo**, no sólo en el `.md`, con el aviso CD-22 de que
refixturearlos los apaga igual que borrarlos — verificado en
`contracting-chain.test.ts:1242-1252`, `routes/compose.fee.test.ts:396-410`, `auto-blindaje.md:266-286`.

---

## 4 · Gates (re-ejecutados, no heredados)

Los re-corrí porque F4 es el último control antes de `main`, que **es producción (Railway)**, y porque
entre el CR y hoy entraron **13 commits** (los dos fix-packs). Resultado: **todos verdes**, y los números
coinciden con los declarados. Ver §0.

---

## 5 · MENORes (no bloquean)

- **MNR-QA-1 · `.env.example` es la única de las 4 superficies operativas que no enumera el vaciado.**
  El bloque `A2A_SELF_HOSTS` (`:576-600`) lista **tres** cosas que el `Host` no cubre (alias, callers
  no-HTTP, el eslabón que anunciamos) y **no** la cuarta: que un `Host` ilegible **vacía** el conjunto y
  deja el guard inerte. Peor: `:594-597` dice *«Con `selfHostCount` 0 el campo dice `source:
  'request-only'`, que es exactamente el estado de **los tres puntos de arriba**»* — y son cuatro. Las
  otras tres superficies (el warn de `assertSelfHostsEnv`, el log de arranque de `index.ts:239`, el
  docblock de `resolveSelfHosts`) **sí** lo dicen, así que un operador que arranca el servicio lo ve; el
  que sólo lee el `.env.example`, no. Arreglo: una línea.
- **MNR-QA-2 · La tabla de criterio de salida de `implementation-log.md` se detiene en el fix-pack 1.**
  §9.1 y §9.2 terminan en el Grupo 6 (`5613 passed`), y el HEAD es `5624` con **7 commits más**
  (fix-pack 2). Los números **sí existen y son correctos** — están en los mensajes de los 5 commits de
  código (`6d043f8` 5617 → `9bca3d6` 5618 → `9d10260` 5620 → `c1989a1` 5621 → `6a6461e` 5624, todos con
  `tsc` 0 / lint 0), y `5624` coincide con mi medición. Lo que falta es la fila en el log, o sea que el
  documento que dice ser la foto por wave **quedó viejo dentro de la propia HU**. Es exactamente la clase
  que este repo ya midió («los números que envejecen dentro de la HU», CR/MNR-5).
- **MNR-QA-3 · Dos citas rotas AJENAS en `src/adapters/solana/facilitator-settle.wiring.test.ts`**
  (`:14` → `src/index.ts:246-248`; `:93-94` → `:338`/`:345`). **Pre-existentes al baseline `3823580`**
  (V6), fuera de scope, **no se cuentan contra esta HU**. Se reportan para el carril Solana; esta HU
  ensanchó el desfase a ~74/~103 líneas sin haberlo creado.

---

## 6 · `[NO VERIFICADO]` — lo que no pude medir, con el motivo

- **`BASE_URL`, `A2A_SELF_HOSTS` y `TRUST_PROXY` en el Railway de prod.** No tengo acceso al panel ni
  credenciales, y no ejecuté nada contra prod (`/compose` y `/orchestrate` **mueven plata**). El diseño no
  depende de la respuesta (conjunto vacío ⇒ `warn`, no `throw`), y el instrumento post-deploy **existe y
  ahora tiene testigo**: `GET /health` → `contractingGuard.selfHostCount` / `source`
  (`T-HEALTH-CONTRACTING` y `T-HEALTH-BOTH`, que es lo que cerró CR/BLQ-BAJO-2). Ver el smoke de abajo.
- **El comportamiento en producción de todo lo de esta HU.** Nada se ejecutó contra prod desde F4.
- **Los catálogos externos de DT-2 / NC-4.** Ninguna fila verificable desde el repo.

### Smoke manual post-merge (para el operador — NO lo ejecuté)

1. Setear `A2A_SELF_HOSTS=<host de Railway>,<dominio propio>` (hostnames **pelados**: sin esquema, sin
   puerto, sin path, sin repetir). ⚠️ Un valor ilegible **no bootea** — es a propósito.
2. Desplegar y leer el log de arranque: tiene que decir `guard anti-bucle con identidad configurada`.
   Si dice `SIN identidad configurada`, la env no llegó.
3. `curl -s https://<gw>/health | jq .contractingGuard` ⇒ `{"selfHostCount": >0, "depthMax": 2,
   "source": "env"}`. Con `"source":"request-only"` el guard depende sólo del `Host` de cada petición.
4. `curl -s https://<gw>/.well-known/agent.json | jq '.authentication.schemes, .skills[].endpoint'`
   ⇒ `schemes` **no vacío**, y un `endpoint` por skill.
5. Prueba del bucle directo, con una key de saldo mínimo:
   `POST /compose` con un step cuyo destino sea el propio gateway ⇒ **400** con
   `error_code: "CONTRACTING_LOOP_DETECTED"`, y **el saldo de la key NO baja** (leer
   `x-a2a-remaining-budget` antes y después). Si el saldo bajó, el corte quedó del lado equivocado del
   débito y hay que revertir.
6. Invariante: un `/compose` normal de 2 steps ajenos ⇒ **200**, mismo cobro que antes, más las claves
   nuevas `feeRatePercent` y `protocolFeeStatus`.

---

## 7 · Categorías

Security ✅ (los 3 cortes pre-débito re-medidos por posición; el residual del vaciado **declarado**, no
tapado) · Error Handling ✅ (`T-L1-3d` congela el fail-closed con débito y fetch en cero) ·
Data Integrity ✅ (nada persiste; CD-5 con 7 testigos unitarios) · Performance ✅ (el costo real del
Sitio 2 corregido y publicado: hasta 20 SELECT para un plan de 5 steps, no 5) · Integration ✅
(estrictamente aditivo; `/plan` intacto) · Type Safety ✅ (`tsc` 0, `exactOptionalPropertyTypes` activo) ·
Test Coverage ✅ (+183 tests netos sobre el baseline; 26 mutantes declarados por el dev, 4 re-corridos por
mí, **4 de 4 con el resultado esperado**) · Scope Drift ✅ · Wave Drift ✅ ·
**Migraciones / RPC / Cache N/A medido** · **Ownership 13/13 + N/A medido** (cero `.from(` / `.rpc(` nuevos).

---

## 8 · Instrumentos: lo que evité y lo que confirmé

Trampas heredadas del expediente, **todas respetadas**: usé `npm run lint` (no `npx biome check`),
`./node_modules/.bin/tsx` (no `npx tsx` bajo `rtk`), probe **a archivo** dentro del worktree (no `-e`, no
`/tmp`), `writeFileSync` para la salida del probe, `/usr/bin/grep` con redirección a archivo (`rtk` trunca),
y **restauración por sustitución inversa + `md5sum -c`** (nunca `git checkout <archivo>`).

**Instrumento propio que confirmé antes de creerle**: los 4 mutantes se aplicaron verificando `needle == 1`
y el **texto resultante**; el de M-A pasó además por `tsc --noEmit` = 0 **antes** de emitir veredicto (un
mutante que no compila da `exit=1` con `0 rojos`, que se lee como KILL o como SOBREVIVIENTE según qué mires
— la lección que el dev pagó en `MUT-03`).

---

**Listo para DONE.** Los 3 MENORes son de documentación y pueden entrar como TD o en el commit de cierre
de `nexus-docs`; ninguno cambia comportamiento ni afecta el money-path.
