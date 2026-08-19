# Done Report — HU [WKH-316] El escritor del bloque `payment`

> `nexus-docs` · 2026-08-19 · rama **`feat/214-wkh-316-payment-block`** (verificada con
> `git rev-parse --abbrev-ref HEAD`, no copiada de ningún documento) · HEAD pre-commit `90cbbb6` ·
> base `main` `8242b16`. **Nada pusheado, nada mergeado, `main` intacto, `src/` intacto.**
> Este archivo existe: verificado con `ls -l` después de escribirlo (§10).

---

## 1. Resumen ejecutivo

Se entregó el **escritor** del bloque de pago de un agente: `POST /agents` y `PATCH /agents/:slug`
ahora aceptan un bloque `payment` (`method`/`chain`/`contract`/`asset`), lo validan en **7 pasos y en un
único choke-point** (`validatePaymentBlock`, `src/lib/payment-spec-writer.ts`) y lo persisten bajo
`metadata.payment` con whitelist de 4 keys. El **lector** de WKH-241 no se tocó
(`src/lib/payment-spec-reader.ts` no aparece en el diff) y lo expone en `/discover` derivando
`resolvedChain`/`network` en cada lectura. Desbloquea **WKH-317**.

**Status final: DONE (pipeline cerrado). NO MERGEADA, NO PUSHEADA.**

12/12 ACs PASS con evidencia `archivo:línea`. AR **RECHAZADO dos veces** antes de aprobar; CR APROBADO;
F4 APROBADO. **Cero DDL y cero env vars nuevas.** Archivos clave:
`src/lib/payment-spec-writer.ts` (nuevo, el único validador), `src/lib/operator-address.ts` (nuevo),
`src/services/agent.ts` (INSERT + merge del PATCH + log de auditoría), `src/routes/agents.ts` (el 422),
`src/types/index.ts` (`AgentPaymentSpecInput`), `doc/INTEGRATION.md` (el contrato público).

---

## 2. Pipeline ejecutado

| Fase | Artefacto / commit | Resultado |
|---|---|---|
| F0 | `.nexus/project-context.md` (pre-existente) | cargado |
| F1 | `work-item.md` | ⛔ **HU_APPROVED** |
| F2 | `sdd.md` | ⛔ **SPEC_APPROVED** |
| F2.5 | `story-file.md` (+ `_INDEX-row.md`) | commit `6164796` — los artefactos F2/F2.5 estaban sin versionar y se subieron acá |
| F3 | 6 commits: `6164796` (docs) · `45bbfd7` (W0 tipos) · `d44a765` (W1 `operator-address`) · `2a0a56c` (W2 el validador) · `cbdd509` (W3A route 422 + W3B service) · `91b4dd6` (W4 docs + guardián estructural) | 5 waves, **12** archivos de `src/`+`test/` tocados (20 con docs) |
| AR it-1 | `ar-report.md` (commit `d546e29`) | 🔴 **RECHAZADO** → fix-pack `e57af46` (2 citas apuntaban a otra función + el log del 422 llevaba el `payment` crudo) |
| AR it-2 | `ar-report-it2.md` (commit `90cbbb6`) | 🔴 **RECHAZADO** → fix-pack `3e61725` (el inventario declaraba una línea de un archivo que tiene siete) |
| AR final | `ar-report-it2.md` | ✅ **APROBADO**, 0 BLOQUEANTEs |
| CR | `cr-report.md` | ✅ **APROBADO**, 3 MENORes abiertos |
| F4 | `f4-report.md` | ✅ **APROBADO** — 12/12 ACs, + 2 DRIFT para la fase DONE |
| DONE | este archivo + micro-fix | 5 correcciones aplicadas (§6) |

⚠️ **Nota de instrumento**: `git log --oneline` bajo el hook de `rtk` **borra los commits de merge**.
Los 10 commits de arriba se enumeraron con `/usr/bin/git log --format='%h %s' 8242b16..90cbbb6`, y la
relación de ancestría con `main` se resolvió con `merge-base --is-ancestor`, nunca leyendo un `log`.

---

## 3. Puertas finales

Re-medidas **dos veces independientemente** (CR §0 y F4 §1) y **coincidieron al número**:

| Puerta | Valor | Instrumento |
|---|---|---|
| Suite | **295 test files · 5750 passed · 19 skipped · 0 failed**, `success: true`, exit **0** | `vitest run --reporter=json --outputFile=<fuera del repo>`, contado con `node` sobre el JSON |
| Typecheck | exit **0** | `./node_modules/.bin/tsc --noEmit` |
| Lint | `Checked 489 files`, exit **0** | `./node_modules/.bin/biome check src/` |
| README | **295 / 489** en los 4 sitios (`README.md:378` `:383`, `README.es.md:405` `:410`) | el F4 los **derivó aparte** desde `rtk proxy git ls-files` en vez de confiar en el candado `test/readme-numbers.test.ts` |

El detalle de por qué la derivación aparte importaba: el candado deriva del **índice de git**, así que un
archivo nuevo no cuenta hasta hacerle `git add`. El F4 verificó que los 5 archivos nuevos ya estaban
committeados, y que **489** coincide exacto con el universo real de Biome y **295** con lo que vitest
efectivamente corrió (293 `.test.ts` + 2 `.test.mjs`).

---

## 4. Acceptance Criteria — resultado final

**12/12 PASS. Cero FAIL. Cero NO VERIFICABLE.** Tabla completa con la evidencia `archivo:línea` de cada
uno en `f4-report.md:48-61`; acá el resumen con el testigo principal.

| AC | Status | Evidencia (testigo principal) |
|---|---|---|
| AC-1 · POST válido persiste y `/discover` lo expone por el lector existente | ✅ PASS | `src/routes/agents.publish.test.ts:636` · `src/services/agent.payment.test.ts:395` `:663` · whitelist en `src/lib/payment-spec-writer.ts:283-293` · `payment-spec-reader.ts` **no está en el diff** |
| AC-2 · `chain` que no resuelve → 422 `INVALID_PAYMENT_CHAIN`, cero escritura | ✅ PASS | `src/lib/payment-spec-writer.test.ts:183-204` (con gemelo anti-vacuidad) · `src/routes/agents.publish.test.ts:694-740` (`expect(mockPublish).not.toHaveBeenCalled()`) |
| AC-3 · riel no inicializado → 422 `PAYMENT_CHAIN_NOT_INITIALIZED` + lista accionable | ✅ PASS | `src/lib/payment-spec-writer.test.ts:209-229` · `src/lib/payment-spec-writer.ts:212-222` |
| AC-4 · payTo con formato de otra familia de VM → 422, y la caja NO se altera | ✅ PASS | `src/lib/payment-spec-writer.test.ts:234-264` `:267-300` · `src/lib/payment-spec-writer.ts:226-234` |
| AC-5 · zero address EVM o pubkey Solana de todos ceros → 422 `ZERO_PAYMENT_PAYTO` | ✅ PASS | `src/lib/payment-spec-writer.test.ts:303-323` (con **control de la premisa**) `:325-373` |
| AC-6 · payTo == operador → 422; operador irresoluble → ACEPTA y loguea | ✅ PASS | `src/lib/payment-spec-writer.test.ts:375-413` (5 casos) · `src/lib/operator-address.test.ts:68` `:80` `:104` `:134` `:158` |
| AC-7 · PATCH con mismos guards, 404 al no-dueño, merge no destructivo | ✅ PASS | `src/routes/agents.ownership.test.ts:355` + **gemelo** `:374` · `src/services/agent.payment.test.ts:513` `:619` · `src/services/agent.ts:665-680` |
| AC-8 · `payment: null` en PATCH borra sólo esa key | ✅ PASS | `src/services/agent.payment.test.ts:545` `:558` `:595` · `src/services/agent.ts:740-754` · el par que lo hace no-vacuo: `agents.publish.test.ts:905` + `:918` |
| AC-9 · fila no escrita por esta HU → `/discover` y `/capabilities` byte-idénticos | ✅ PASS | `src/services/agent.payment.test.ts:717` (contra un **literal escrito a mano**) `:692` · cero DDL medido · `/capabilities`: evidencia **estructural**, no test |
| AC-10 · `method` no exactamente `x402` → 422 `UNSUPPORTED_PAYMENT_METHOD` | ✅ PASS | `src/lib/payment-spec-writer.test.ts:160-178` (5 negativos + gemelo positivo) · `src/lib/payment-spec-writer.ts:193-198` |
| AC-11 · body que OMITE `payment` → byte-idéntico a hoy, nunca `null` | ✅ PASS | `src/routes/agents.publish.test.ts:681` · `src/services/agent.payment.test.ts:415` · `src/services/agent.ts:224` `:192-194` |
| AC-12 · `asset` case-insensitive contra `supportedTokens[0].symbol`, ESTRICTO | ✅ PASS | `src/lib/payment-spec-writer.test.ts:418-462` `:466` · `src/lib/payment-spec-writer.ts:242-262` |

Los **21** tests declarados (`T-316-01..21`) existen los 21, más **8** no declarados nacidos de los
fix-packs (`T-316-22..29`). **Ninguno declarado sin existir.**

---

## 5. Lo que sostiene la HU

### 5.1 El mutante testigo — `M15`

`meta.payment = paymentBlock` → `meta.payment = updates.payment` (`src/services/agent.ts:746`) pone rojo
**exactamente 1 test de 5765** (`T-316-25`, `src/services/agent.payment.test.ts:508`), y **muere por la
razón correcta**, no por un `toBe(422)` genérico: el diff del fallo es la lista de keys
(`+ "network", "resolvedChain", "sarasa"`), o sea que el testigo detecta **las keys derivadas
envenenadas**.

**No hay segundo camino, y está auditado**: sólo **dos** sitios escriben `metadata.payment` —
`src/services/agent.ts:472-478` (el INSERT de `publish`, vía `buildMetadata(input, paymentBlock)` en
`:452`, testigo `T-316-02`) y `:746` (el merge de `update`, testigo `T-316-25`)—. Y el lado de lectura
**no puede taparlo ni delatarlo**: `readStoredPaymentBlock`
(`src/lib/payment-spec-writer.ts:311-331`) hace whitelist en lectura y `readPaymentSpec` recomputa
`resolvedChain`/`network` en cada lectura, así que un JSONB envenenado no se vería en ninguna respuesta
HTTP. **Por eso el único testigo posible es un espía sobre el argumento del `update()`.**

⇒ **Un testigo único acá es la arquitectura correcta, no una debilidad.** Control cruzado del AR:
borrar `|| updates.payment !== undefined` de la condición del merge (`src/services/agent.ts:729-732`)
pone **4** tests rojos, o sea que la condición del merge y la del log de auditoría no pueden derivar en
silencio.

### 5.2 El bug que el F3 encontró y arregló solo — un log que MIENTE

El log de auditoría del PATCH leía el bloque anterior **después** del merge. `readMetadataObject` **no
copia**: devuelve `raw as Record<string, unknown>`, el MISMO objeto, y el merge hace
`meta.payment = paymentBlock` sobre él ⇒ mutaba `existing.metadata` en el lugar. Para cuando se leía
`prev`, ya era `next`: el log reportaba la billetera **nueva** como si fuera la vieja.

**En producción no habría fallado nunca: sólo habría mentido en su bitácora.** El objeto mutado es una
fila recién traída de Supabase, así que no hay corrupción visible; habría envejecido en silencio hasta
la primera investigación de *"¿a qué billetera se re-apuntó, y cuándo?"* — justo la pregunta para la
que ese log existe.

Fix: capturar `previousPaymentBlock` **antes** del bloque de merge, con el porqué escrito al lado
(`src/services/agent.ts:686-694`). Verificado por mutación (`M14`): devolviendo la lectura a su lugar de
abajo, los **dos** tests de auditoría se ponen rojos. Entrada completa: `auto-blindaje.md:148-169`.

### 5.3 Cero DDL y cero env vars nuevas ⇒ **desplegar esto no requiere ninguna acción de ops**

Es un hallazgo **positivo** y lo digo explícitamente.

- **Cero DDL**: `git diff --name-only main...HEAD | grep -iE '\.sql$|migration|supabase/'` → **cero
  coincidencias**. Ni un `.sql`, ni una migración, ni un archivo bajo `supabase/`.
- **Cero env vars nuevas**: única lectura de `process.env` en los 5 archivos de `src/` del diff es
  `src/lib/operator-address.ts:53` → `OPERATOR_PRIVATE_KEY`, **ya presente** en `.env.example:352`. El
  lado Solana no lee env directo: delega en `getSolanaOperatorKeypair()` vía `await import()`
  (`operator-address.ts:78-79`), que consume `SOLANA_OPERATOR_PRIVATE_KEY`, también ya presente
  (`.env.example:1212`).
- **La ausencia de esas envs es inofensiva por construcción, no por suerte**: `resolveOperatorAddress`
  **nunca lanza** y devuelve `null`, y el paso 7 degrada a aceptar marcando `operatorCheckSkipped`
  (`payment-spec-writer.ts:266-272`) con el log `PAYTO_OPERATOR_CHECK_SKIPPED`. Un deploy sin ellas
  publica igual y pierde **sólo** el guard de AC-6, **ruidosamente**. Eso es lo que AC-6 manda.

### 5.4 El cambio de contrato — `POST /agents` con `payment: null` pasó de **201 a 422**

Antes, `payment` era una key desconocida que el endpoint ignoraba: cualquier valor daba 201. Ahora
`payment: null` en el **alta** es `422 INVALID_PAYMENT_BLOCK` (en el **PATCH** significa *borrar*, que es
otra cosa). Es una desviación de contrato **declarada**, no un descubrimiento del review
(`auto-blindaje.md:393-419`).

Está documentado **donde lo lee quien publica**:

- Sección propia con heading: `doc/INTEGRATION.md:263` `#### Deleting the block`, y en `:269-271` sin
  rodeos.
- Las **8** rejections tabuladas en `doc/INTEGRATION.md:285-294`, y el `All eight are 422` de `:282`
  cierra: son 8 filas.
- Los **dos** README linkean al ancla exacta (`README.md:287`, `README.es.md:314` →
  `doc/INTEGRATION.md#declaring-where-your-agent-gets-paid-payment`), y el heading
  `doc/INTEGRATION.md:219` produce exactamente ese slug.
- El footgun de `contract` tiene heading propio (`:248`) y la consecuencia de AC-12 estricto está
  publicada, no escondida (`:298`).

Y el **F4 midió que el ejemplo publicado funciona**: el placeholder base58 de
`doc/INTEGRATION.md:230-239` (`"YourBase58PubkeyHere11111111111111111111111"`, 43 chars) pasa el
validador real del repo, **con control positivo** (una pubkey real de 44 chars → `true`) **y negativo**
(`"abc"` → `false`), y el resto del ejemplo también cierra ⇒ **pasa los 7 pasos**. Sin eso, el primer
intento de todo integrador habría sido un 422.

---

## 6. El micro-fix pre-merge — 5 correcciones aplicadas en esta fase

| # | Qué decía | Qué es (medido por mí, hoy) | Dónde se corrigió |
|---|---|---|---|
| `MNR-1` | *"en los **11** archivos de `src/`+`test/` del Scope IN … **28 anclas en 24 líneas**"* | **12** archivos y **46 anclas en 40 líneas** | `auto-blindaje.md:663-679` |
| `MNR-2` | el reparto sumaba **19** | son **20** | `auto-blindaje.md:670-677` |
| `MNR-3` | `asset` *"stored as you sent it"* | se preserva la **caja**, se **recortan los espacios** de los extremos | `doc/INTEGRATION.md:246` |
| `DRIFT-1` | `cr-report.md` y `f4-report.md` en **0** commits | committeados por ruta explícita | este commit |
| `DRIFT-2` | `_INDEX.md:181` afirmaba que el escritor no existe, y nombraba la rama vacía; `_INDEX-row.md:18` reproducía el nombre | corregidos los dos | `doc/sdd/_INDEX.md:181` · `_INDEX-row.md:18` |

### 6.1 `MNR-1` — el conteo, derivado por mí con los TRES patrones

Los **12** archivos de `src/`+`test/` salen de
`/usr/bin/git diff --name-only 8242b16..90cbbb6 | command grep -cE '^(src|test)/'` → **12**.
El ausente del inventario era **`test/ownership-filter-guard.exceptions.ts`**, y **no es el más chico**:
tiene **41** pares estructurados `{file, line}` (`command grep -cE "^\s+line: [0-9]+"` → 41) **más 14**
anclas de prosa ⇒ **más anclas que cualquier otro fichero del Scope IN**.

Universo de anclas re-derivado con los **tres** patrones que el orquestador pidió:

| Patrón | Qué matchea | Anclas |
|---|---|---|
| con ruta | `src/routes/dashboard.ts:477` | **5** |
| sin directorio | `agent.ts:721`, `tsconfig.json:19` | **26** |
| sólo `:N` entre backticks | `` `:692` ``, `` `:137-149` `` | **15** |
| | **TOTAL** | **46 anclas en 40 líneas** |

Distribución (las tres formas sumadas): `test/ownership-filter-guard.exceptions.ts` **14** ·
`src/types/index.ts` **9** · `src/lib/operator-address.ts` **6** · `src/routes/agents.publish.test.ts`
**6** · `src/routes/agents.ownership.test.ts` **5** · `src/routes/agents.ts` **2** ·
`test/payment-guards-live-in-one-place.test.ts` **2** · `src/services/agent.payment.test.ts` **1** ·
`src/services/agent.ts` **1** · los otros 3 ficheros **0**.

**Reconcilia con las dos mediciones previas**, y la diferencia es el sub-universo, no el método:
**43** = lo que midió el F4 (restringido a extensión `.ts`) · **46** = sumando los anclas `.sql` y
`.json` (`src/types/index.ts:661` → `20260401000000_kite_registries.sql:44-66`;
`test/ownership-filter-guard.exceptions.ts:24` → `tsconfig.json:19` y `package.json:11`) ·
**32** = lo que contó el CR, que es correcto para su universo porque **excluía el 12º fichero**.

⚠️ **Es un PISO, no un total.** El patrón de la forma corta busca **entre backticks**; una cita escrita
en prosa suelta (*"la línea 95"*) no la devuelve **ningún** patrón. Lo que sostengo como mecánico y
cerrado es la comparación **12 ≠ 11**.

**Nada falso se oculta ahí**: el CR verificó una por una las 5 anclas de prosa de ese fichero y las 5
son correctas (`cr-report.md:65-86` para la lista con nombre y destino). Lo que fallaba era el
**inventario**, y su consecuencia concreta: la HU que cierre `TD-316-CITAS-SIN-TESTIGO` arranca de un
universo **mucho más grande** que el 28 declarado.

### 6.2 `MNR-2` — el "19" es **20** (aritmética pura, y REFUERZA la conclusión)

El diff de `src/routes/agents.ownership.test.ts` re-apunta **tres** anclas, no dos:
`services/agent.ts:701`→`:808`, `:715`→`:822`, y `:184`→`:211`. Las tres están en la tabla de W4
(`auto-blindaje.md:238-240`) marcadas ✅ *"sí (Scope IN)"*; **la tercera no estaba en la suma.**

Y `:211` es correcta — lo verifiqué abriendo el destino:
`src/routes/agents.ownership.test.ts:211` = `it('T-143B-06: owner PATCH own slug with payoutWallet → 200,
UPDATE ran under owner_ref guard, only payout_wallet touched (AC-2)', …)`, citada desde el docblock en
`:25`. Los otros dos también: `src/services/agent.ts:808` = `if (existing.owner_ref !== ownerRef) {` y
`:822` = `.eq('owner_ref', ownerRef)` del DELETE.

⇒ **20 anclas escritas o re-apuntadas por esta HU, y las 20 son ciertas.** Sumando las **5** de
`exceptions.ts`: **25, y las 25 ciertas.** Un ancla más de acierto **refuerza** la conclusión de la HU.

### 6.3 `MNR-3` — la promesa falsa en el documento PÚBLICO, corregida en la PROSA

`doc/INTEGRATION.md:246` prometía *"then **stored as you sent it**"* y
`src/lib/payment-spec-writer.ts:292` hace `block.asset = asset.trim()`.

⚠️ **El matiz que hace fácil equivocarse al arreglarlo**: la **caja SÍ se preserva y está vigilada** —
`src/lib/payment-spec-writer.test.ts:424` assertea `expect(r.block.asset).toBe('usdc')` para un `asset`
en minúsculas contra un symbol `'USDC'`. **Lo único que se toca es el whitespace.**

⇒ La corrección es de la **prosa**. `src/` NO se tocó. El nuevo texto dice lo que es cierto:

```markdown
| `asset` | no | A label. Checked against the token the rail settles. Your letter case is preserved exactly; leading and trailing whitespace is trimmed. |
```

*(nota de medición: el F4 citó ese testigo como `payment-spec-writer.test.ts:427`; medido hoy con
`command grep -n "toBe('usdc')"` está en **`:424`**. La afirmación es la misma, el número era el de la
línea de cierre del bloque.)*

### 6.4 `DRIFT-1` — dos reportes que existían y no viajaban

`git log --all -- doc/sdd/214-.../cr-report.md | wc -l` → **0**. Idem `f4-report.md`. Es el **espejo**
del patrón que apareció seis veces en esta sesión: no es un reporte declarado que no existe, es uno que
**existe y nadie va a poder leer** desde la rama — y un `git clean` lo borra sin dejar rastro. Los dos
entran en este commit por **ruta explícita**.

### 6.5 🔴 `DRIFT-2` — el índice afirmaba HOY, como hecho medido, algo falso, y el camino de verificación CONFIRMABA la mentira

`doc/sdd/_INDEX.md:181` decía, presentado como medición con control positivo:

> *"el **ESCRITOR sigue sin existir** — `PublishAgentInput` (`src/types/index.ts:282-309`) no declara
> `payment`"*

**Es falso.** Medido hoy sobre `90cbbb6`: `src/types/index.ts:346` declara
`payment?: AgentPaymentSpecInput` dentro de `PublishAgentInput` (que abre en `:313`), y `:376` declara
`payment?: AgentPaymentSpecInput | null` en `UpdateAgentInput` (`:353`).

**Y el mecanismo es lo grave, no el número.** La medición era **correcta sobre `main` `8242b16`** — lo
verifiqué: en `main`, `PublishAgentInput` abre en `:282` y `buildMetadata` en `:186`, así que el rango
citado resolvía. Lo que estaba mal era **contra qué rama se midió**: la fila nombraba
`feat/214-wkh-316-payment-block-writer`, que **existe**, está en `6b391d6` y
`git merge-base --is-ancestor feat/214-wkh-316-payment-block-writer main` → **0**, o sea que **ya está en
`main` y no tiene commits propios**. La rama real es **sin** el sufijo `-writer` (verificado con
`git rev-parse --abbrev-ref HEAD` → `feat/214-wkh-316-payment-block`).

⇒ **Quien seguía el índice miraba la rama vacía, no encontraba nada y CONFIRMABA la afirmación falsa.**
Es **evidencia que se auto-confirma**, y es el mismo mecanismo que dejó 33 de 40 filas del índice mal
clasificadas en esta sesión.

**Y el agravante**: `_INDEX-row.md:18` —el reemplazo preparado para esta misma fase DONE— **reproducía
el nombre equivocado** y seguía en `IN PROGRESS`. Pegarlo tal cual habría propagado el error en vez de
cerrarlo. **Corregidos los dos**, con el nombre tomado de `git rev-parse`, nunca de un documento.

Al reescribir la fila aparecieron **tres citas más** ya falsas, medidas y corregidas de paso:
`src/adapters/solana/payment.ts:81` es `:82` (`const USDC_SYMBOL = 'USDC'`) · `downstream-payment.ts:284`
y `:777-785` no son el `supportedTokens[0]` del settle: son `:279` y `:805` · y `_INDEX-row.md`
apuntaba a una sección *"Deuda de numeración de este índice"* que **ya no existe** (el saneamiento del
2026-08-10 la reemplazó), con el rango `_INDEX.md:181-209` que hoy arranca en la propia fila `214`.

### 6.6 Cómo se editó, para no cometer el defecto que la HU diagnostica

Las ediciones de `auto-blindaje.md` y `doc/INTEGRATION.md` se hicieron **estrictamente line-neutral**
(17 líneas → 17, y 1 → 1), verificado con un `assert` de longitud antes de escribir y con
`git diff --stat` después (`17 insertions, 17 deletions`). Motivo: hay citas vivas a
`auto-blindaje.md:450-492`, `:609-612`, `:624-693`, `:689-693`, `:240`, `:118` desde `cr-report.md`,
`f4-report.md` y este archivo, y **agregar una línea las habría desplazado a todas en silencio** — que es
literalmente la deuda que esta HU declara. Verificado post-edición: las 6 anclas siguen apuntando a lo
mismo. Igual con `_INDEX-row.md` (39 líneas → 39), porque `f4-report.md:250` cita su `:18`.

**Control positivo de que el arreglo del índice no rompió nada mecánico**: corrí
`test/sdd-index-matches-folders.test.ts` con la fila nueva y **dio rojo en `G-E1`** ("todo link del
índice a `doc/sdd/` apunta a un archivo que está EN GIT") con **exactamente 3** links pendientes — los 3
que agregué (`cr-report.md`, `f4-report.md`, `done-report.md`) y que este commit trae. El guardián
funciona y el rojo era el esperado; el verde post-`git add` está en §10.

---

## 7. Hallazgos finales

- **BLOQUEANTEs: 0 pendientes.** Hubo dos rondas de AR RECHAZADO; los dos fix-packs (`e57af46`,
  `3e61725`) están verificados por el re-AR, que además confirmó que `M15`/`D`/`E`/`F` dan idéntico al
  árbol anterior (o sea: el fix no debilitó ningún testigo).
- **MENORes: los 3 del CR quedaron RESUELTOS en esta fase**, no aceptados como deuda (§6.1-6.3). El F4
  los confirmó los tres y midió que **ninguno afecta un AC**.
- **DRIFT: los 2 del F4 quedaron RESUELTOS en esta fase** (§6.4-6.5).
- **Deuda que queda ABIERTA: 2**, las dos declaradas y acotadas (§8).
- `NC-1` (`story-file.md:916`) sigue abierta y sigue sin bloquear: no se puede determinar desde el árbol
  si la pubkey de los agentes Solana vivos es la del operador del gateway. **AC-6 detecta el caso si lo
  es.**
- Pre-existentes escaladas y **NO** arregladas a propósito (fuera de Scope IN, para que el diff siga
  siendo auditable como *"lo que cambió esta HU"*): las **6 citas falsas** heredadas, ruteadas con su
  ancla real tabulada en `auto-blindaje.md:609-612`, más las que caen en `src/services/discovery.ts`
  (CD-6 prohíbe tocarlo) y en `src/services/agent.ownership.test.ts`.

---

## 8. Las DOS deudas — ejecutables por alguien que no leyó esta HU

Las dos están escritas como **acotamiento y no cierre**, cada una con su sección *"cuál es, y cuál NO
es"*. **Verificado después de mis ediciones** (`command grep -n "acota la tasa|acota la probabilidad"`):
las dos frases siguen en su lugar, `auto-blindaje.md:484-485` y `:689-691`.

### `TD-316-METADATA-LWW` — `auto-blindaje.md:450-492`

`update()` reescribe el `metadata` **completo** sin control de concurrencia (last-write-wins), y **esta
HU mete la billetera de cobro adentro de esa ventana**. El interleaving está escrito en 4 pasos
concretos con dos PATCH del mismo dueño sobre el mismo slug, y nombra lo que lo hace invisible: *"las dos
respuestas son **200**, y el log de auditoría no delata nada"* — porque el segundo no loguea, ya que su
`updates.payment` es `undefined`.

- **Honestidad de alcance**: *"La ventana no la abrí yo; lo que puse adentro, sí."* Heredar un patrón no
  es heredar su severidad: **la severidad la fija el dato que metés.**
- **Por qué se DIFIERE**: la variante con columna de versión (concurrencia optimista) **necesita DDL**, y
  esta HU es **cero-DDL** por CD-14/AC-9. Es otra HU.
- **Acotamiento, no cierre** (textual, `:485`): *"Eso **acota la probabilidad, no cierra el camino**: no
  hay ningún guard que impida el interleaving, y no hay ninguna señal —ni en la respuesta HTTP ni en el
  log— de que ocurrió."*
- **Disparador re-verificado dos veces** (CR y F4, coincidieron): `readPaymentSpec` tiene **2 call
  sites** de producción — `src/services/discovery.ts:1380` y `src/services/agent.ts:169` — y
  `grep -rn readPaymentSpec src/middleware/` da **cero** ⇒ **ninguno está en el camino de
  `requirePayment`**. La afirmación se sostiene hoy.
- Línea load-bearing: `src/services/agent.ts:686-694` captura `previousPaymentBlock` **antes** del merge,
  con la razón escrita (§5.2).

### `TD-316-CITAS-SIN-TESTIGO` — `auto-blindaje.md:624-693`

**18 citas defectuosas, 0 cazables por ningún test de este repo.**

- **Por qué 0 cazables, medido**: `codeOnly` en
  `test/payment-guards-live-in-one-place.test.ts:45-55` **borra los comentarios antes de mirar**
  (`.replace(/\/\*[\s\S]*?\*\//g,'')` + el filtro de `//` y `*`) —**y tiene que hacerlo**, es lo que
  lo vuelve un guardián de código y no de prosa—, y de los **15** archivos de `test/` con `readFileSync`
  **ninguno** verifica un `archivo.ts:N`.
- **El diseño que la cerraría YA EXISTE en el repo, aplicado a un solo destino**:
  `test/sdd-index-matches-folders.exceptions.ts:160-192` — `CitedIndexLine = { from, line, mustContain }`
  y `CITED_INDEX_LINES` (`:181-192`), con las dos propiedades que faltan y su razón escrita al lado
  (`:172-179`): el `mustContain` va **a mano** (*"es una afirmación sobre el mundo, no una lectura del
  mundo"*, porque derivarlo del contenido actual daría verde siempre) y el **universo SÍ se deriva**
  (`execFileSync('git', ['ls-files', '--', 'src'])`), con el control **G-F2: una cita nueva sin declarar
  = rojo** (`test/sdd-index-matches-folders.test.ts:420`). Hoy cubre **un** destino
  (`doc/sdd/_INDEX.md:N`) con **2** entradas.
- **Por qué se DIFIERE**: generalizarlo obliga a declarar el `mustContain` de **cada** cita existente, a
  mano, y el guardián arranca **rojo por definición** hasta que estén todas. Toca decenas de archivos.
  Es la antítesis de un fix-pack de AR.
- **Acotamiento, no cierre** (textual, `:691-694`): *"Eso **acota la tasa, no cierra el camino**: no hay
  ningún control que se ponga rojo, así que la garantía dura exactamente lo que dure la disciplina del
  que revisa, y una cita rota se descubre **cuando manda a alguien a la función equivocada**, no cuando
  se escribe."*
- **Las 6 pre-existentes falsas están ruteadas acá con su ancla real tabulada**
  (`auto-blindaje.md:609-612`).
- **Universo de arranque, actualizado por esta fase**: **46 anclas de prosa en 40 líneas + 41 pares
  estructurados**, sobre los **12** archivos del Scope IN. No 28 (§6.1). Y es un **piso**.

---

## 9. Las 4 rondas de citas — la historia con su causa raíz

La HU pasó por **cuatro rondas del mismo defecto** (W4 → fix-pack AR it-1 → fix-pack AR it-2 → este
micro-fix). **No era descuido, y la causa raíz está medida.**

**Dos puntos ciegos estructurales del barrido:**

1. Las citas **cortas** (`` `:692` ``, sin nombre de archivo) son **invisibles a cualquier grep con
   nombre de archivo** — incluido el que la propia HU declara *"el barrido correcto"*
   (`git ls-files | grep -oE '<archivo>\.ts:[0-9]+'`).
2. Las citas **sin directorio** (`agent.ts:721`) no las devuelve un patrón que lleve la ruta.

La cuarta ronda apareció **sólo** al enumerar todos los tokens `:[0-9]+` del archivo, no al grepear
`agent\.ts:[0-9]`. Y la tasa **no bajó escribiendo prosa más cuidadosa**: bajó cada vez que alguien la
midió a mano, y volvió a subir en cuanto nadie la midió.

**La distinción que ordena el juicio, verificada por el CR abriendo cada destino uno por uno**
(`cr-report.md:65-102`):

| Origen del ancla | Cantidad | Veredicto |
|---|---|---|
| Escritas o re-apuntadas **por esta HU** | **25** | **las 25 son ciertas** |
| **Pre-existentes** en los ficheros del Scope IN | 9 | **6 son falsas**, 3 exactas |

⇒ **El defecto fue desplazar sin re-verificar, no escribir mal.** Todo lo que esta HU escribió de cero es
cierto. Eso mueve el veredicto de *"HU descuidada"* a **"HU correcta en lo suyo, heredando un problema
del repo"** — y el problema lo midió hasta el fondo en vez de taparlo.

**Y el mecanismo que hace esta clase tan difícil de cazar** (pasó dos veces acá): el número equivocado
**contenía el texto buscado**, así que abrir la línea y comparar daba OK. `:761` era el `owner_ref` de
`update()` en vez del de `listMine`; `:599` era la misma línea de texto dentro de otra función.
**La evidencia se auto-confirmó las dos veces** — el mismo mecanismo que `DRIFT-2` (§6.5).

---

## 10. Archivos modificados

`/usr/bin/git diff --numstat 8242b16..90cbbb6` → **20** archivos (12 de `src/`+`test/`, 8 de docs), más
los 3 `.md` que agrega este commit.

### Código nuevo — el escritor (`src/lib/`)
| Archivo | ± | Rol |
|---|---|---|
| `src/lib/payment-spec-writer.ts` | +382 | **nuevo.** `validatePaymentBlock` — el único choke-point del write path, 7 pasos + `readStoredPaymentBlock` |
| `src/lib/payment-spec-writer.test.ts` | +798 | **nuevo.** T-316-04..11, 19, 21, 26 |
| `src/lib/operator-address.ts` | +114 | **nuevo.** `resolveOperatorAddress` — **nunca lanza**, devuelve `null` |
| `src/lib/operator-address.test.ts` | +181 | **nuevo.** T-316-11, con 2 gemelos positivos |

### Route y service (el camino de escritura)
| Archivo | ± | Rol |
|---|---|---|
| `src/routes/agents.ts` | +99 | el 422 con `error_code`/`field`, sin echo del valor del caller |
| `src/services/agent.ts` | +115 −8 | `buildMetadata(source, payment?)`, INSERT (`:452`), merge del PATCH (`:746`), log de auditoría (`:686-694`), borrado (`:740-754`) |
| `src/types/index.ts` | +47 | `AgentPaymentSpecInput` (`:280`), `PublishAgentInput.payment` (`:346`), `UpdateAgentInput.payment` (`:376`) |

### Tests de integración y guardián estructural
| Archivo | ± | Rol |
|---|---|---|
| `src/routes/agents.publish.test.ts` | +351 | T-316-01, 20, y el `it.each` de los 422 con `not.toHaveBeenCalled()` |
| `src/services/agent.payment.test.ts` | +539 −3 | T-316-02, 03, 13..18, 25 (el testigo de `M15`) |
| `src/routes/agents.ownership.test.ts` | +90 −3 | T-316-12 + su gemelo; **3** anclas re-apuntadas |
| `test/payment-guards-live-in-one-place.test.ts` | +156 | **nuevo.** T-316-24 — los 7 guards no se duplican |
| `test/ownership-filter-guard.exceptions.ts` | +9 −9 | **sólo** el `line:` corrido de 5 entradas y las citas de prosa de esas mismas entradas. Cero entradas nuevas, cero motivos reescritos |

### Documentación pública
| Archivo | ± | Rol |
|---|---|---|
| `doc/INTEGRATION.md` | +114 (+1 −1 en este commit) | el contrato del bloque `payment`, las 8 rejections, los 2 footguns · **`MNR-3`** |
| `README.md` / `README.es.md` | +3 −3 cada uno | los 2 números de puertas + el link al ancla. `README.es.md` es **desviación de scope declarada** (`auto-blindaje.md:118`), obligada por `test/readme-numbers.test.ts` |

### Artefactos de proceso
`sdd.md` (+650) · `story-file.md` (+957) · `auto-blindaje.md` (+698, +17 −17 en este commit) ·
`ar-report.md` (+747) · `ar-report-it2.md` (+452) · **`cr-report.md`** y **`f4-report.md`** (nuevos en
este commit, `DRIFT-1`) · **`done-report.md`** (este archivo) · `_INDEX-row.md` (corregido) ·
`doc/sdd/_INDEX.md:181` (corregido).

---

## 11. Smoke manual de 6 pasos — para DESPUÉS del merge

Trasladado de `f4-report.md:311-326`. **Nadie lo ejecutó**: lo tiene que correr un humano contra un
deploy, y el paso 6 es el que cierra el hueco del registry mockeado (§12, límite 3).

```
1. POST /agents con x-a2a-key válida y el body EXACTO de doc/INTEGRATION.md:230-239,
   cambiando sólo "contract" por una pubkey base58 propia.
   → esperar 201 y body.payment con EXACTAMENTE 4 keys (method, chain, contract, asset).
2. GET /discover y buscar ese slug.
   → esperar agent.payment con 6 keys: las 4 mas resolvedChain y network.
3. PATCH /agents/<slug> con {"payment": null}.
   → esperar 200, y en GET /discover el agente ya SIN la key payment (ausente, no null).
4. POST /agents con {"payment": null}.
   → esperar 422 error_code INVALID_PAYMENT_BLOCK (el cambio de contrato de esta HU).
5. POST /agents con chain "kite-ozone-testnet" y asset "USDC".
   → esperar 422 PAYMENT_ASSET_MISMATCH (o PAYMENT_CHAIN_NOT_INITIALIZED si ese riel
     esta apagado en el deploy). Es correcto y esta documentado en INTEGRATION.md:298.
6. En los logs del server, confirmar que ninguna linea del 422 contiene el valor crudo
   que mando el caller (solo { field, code }).
```

---

## 12. Límites — lo que NO se pudo medir, con esas palabras

Trasladados del CR y del F4 **sin suavizarlos**, más los míos de esta fase.

1. **La prosa no se pudo medir con un test.** Es exactamente la segunda deuda
   (`TD-316-CITAS-SIN-TESTIGO`): ningún control de este repo se pone rojo ante una cita
   `archivo.ts:N` falsa, y el guardián que más cerca está (`payment-guards-live-in-one-place`) **borra
   los comentarios antes de mirar**, por diseño. Las correcciones de §6 valen exactamente lo que valga
   la próxima persona que las re-mida a mano.
2. **No se corrió nada contra prod ni contra ninguna base** — ni Supabase, ni Railway. Consecuencia
   concreta: **AC-9 está probado a nivel de código y NO verificado contra las filas Solana sembradas.**
   La no-regresión se probó con la forma real del bloque sembrado y con un literal escrito a mano
   (`agent.payment.test.ts:717`), pero no contra las filas vivas.
3. **Todos los testigos de `validatePaymentBlock` corren contra un registry MOCKEADO.** Nunca se
   ejercitó el paso 3 (AC-3) contra un `getAdaptersBundle('solana-devnet')` **real e inicializado**, así
   que en un proceso real el resultado depende de qué rieles estén vivos en ese deploy — que es el
   diseño, no un defecto. Lo cierra el paso 6 del smoke, y lo tiene que correr un humano.
4. **El conteo de anclas es un PISO, no un total** (§6.1). Una cita en prosa suelta no la devuelve
   ninguno de los tres patrones.
5. **No re-ejecuté la suite, ni los mutantes, ni re-litigué el CR/F4 en esta fase.** Los números de §3 y
   el `M15` de §5.1 los tomo como **medidos por otros dos agentes que coincidieron al número**, no
   medidos por mí. Lo único que corrí yo es
   `test/sdd-index-matches-folders.test.ts` + `readme-numbers` + `payment-guards-live-in-one-place`
   (§6.6 y §13), y todo lo que cité con su comando en §6.
6. **El ancla de Markdown de los README se verificó por la regla de slug de GitHub, no renderizando la
   página** (heredado del F4).
7. **`git diff` bajo el hook de `rtk` TRUNCA** (3250 → 532 líneas, cortando hunks, con exit 0), así que
   todo barrido sobre el diff de este cierre se hizo con `/usr/bin/git`. Un barrido negativo hecho con
   el hook habría dado un **cero falso**.

---

## 13. Estado del árbol al cerrar

- Rama: **`feat/214-wkh-316-payment-block`** (de `git rev-parse --abbrev-ref HEAD`).
- `main` = `8242b16`, **intacto**. **Nada pusheado.** **`src/` no se tocó en esta fase.**
- Untracked declarado de otra HU: `doc/sdd/212-wkh-314-x402-inbound-solana/story-file.md`,
  md5 **`7904ef74a1c46d7880e0ca5d38e3eed4`** — **verificado al cerrar, intacto. No se tocó.**
- Commit hecho **por ruta explícita**. `git add -A` / `git add .` **no se usaron** (en esta sesión un
  `git add -A` se llevó puesto el trabajo no commiteado de otro agente:
  `auto-blindaje.md:35-56`).

---

## 14. Lecciones para próximas HUs

1. **Un inventario se ENUMERA, no se busca — y el universo se declara antes de contar.** *"Encontré 4"*
   no es una medición; *"hay 8 y son éstas"* sí. Las cuatro rondas de citas de esta HU y el `MNR-1`
   salen del mismo error de forma: contar con el patrón que ya tenías en la cabeza. Antes de publicar un
   conteo, **preguntate qué forma de la cosa que contás NO devuelve tu patrón** — y si no podés
   descartar que exista, publicá el número como **piso**, con esa palabra.
2. **Una afirmación medida tiene que decir CONTRA QUÉ se midió.** `DRIFT-2` no era una medición
   descuidada: era correcta sobre `main` y falsa sobre el mundo, porque miraba una rama homónima vacía.
   Y el camino de verificación que ofrecía **confirmaba la mentira**. Regla operativa: el nombre de una
   rama sale de `git rev-parse --abbrev-ref HEAD`, nunca de un documento; y si una fila del índice dice
   *"no existe"*, el que la lea tiene que poder distinguir *"no existe"* de *"no lo encontré donde me
   dijiste que mirara"*.
3. **Si tu diff cambia el largo de un archivo muy citado, tu trabajo no terminó.** Los barridos miran lo
   que **escribiste**; estas citas las **desplazaste**, no aparecen en tu diff y no las toca ningún
   guardián. Y antes de re-apuntar una cita, **verificá que era cierta**: un ancla desplazado se arregla
   con aritmética, uno equivocado se arregla leyendo la afirmación. La inversa también vale y es la que
   se paga cara: **editar un documento con citas entrantes obliga a ser line-neutral o a re-apuntarlas
   todas** (§6.6).
4. **Un log que repite el valor nuevo como si fuera el viejo no es un log incompleto: es un log que
   miente**, y miente justo en la pregunta para la que se escribió. En producción no habría fallado
   nada. Corolario: antes de asumir que una función de narrowing devuelve una **copia**, leele el
   `return` — acá el `as` sobre el mismo objeto estaba a la vista, y el merge mutaba el origen.
5. **Cuando declares un agujero que ningún test puede cazar, no prometas más cuidado: buscá si el patrón
   que lo cerraría YA EXISTE en el repo aplicado a otro destino.** Acá existía, con nombre
   (`CITED_INDEX_LINES`), con su control de universo (`G-F2`) y con su control anti-vacuidad
   (`mustContain` a mano) ya pensados. Eso convierte una deuda en un ticket ejecutable por alguien que
   no leyó la HU.
