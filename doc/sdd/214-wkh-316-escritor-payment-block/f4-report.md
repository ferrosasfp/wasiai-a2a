# F4 — Validación de ACs · WKH-316 · El escritor del bloque `payment`

> `nexus-qa` · 2026-08-19 · rama `feat/214-wkh-316-payment-block` · HEAD `90cbbb6` · base `main` `8242b16`
> Nada pusheado. Cero consultas a Supabase / Railway / prod (prohibido y no necesario para esta HU).
> **Ante conflicto entre `work-item.md` y `story-file.md`, manda el Story File** (el work-item tiene
> 3 afirmaciones medidas como falsas, listadas en `story-file.md:68-101`).

## Veredicto

**APROBADO** — 12/12 ACs en PASS con evidencia `archivo:línea`. Cero FAIL, cero NO VERIFICABLE.

Con **2 hallazgos de drift que hay que cerrar antes del merge** (ninguno rompe un AC; los dos son
trabajo de la fase DONE) y **los 3 MNR del CR confirmados** (ninguno afecta un AC).

---

## 1. Puertas — re-medidas por mí, no leídas del CR

| Puerta | Declarado | Medido por F4 | Instrumento |
|---|---|---|---|
| Suite | 295 files · 5750 passed · 19 skipped · 0 failed, exit 0 | **idéntico**: `testResults=295`, `numPassedTests=5750`, `numPendingTests=19`, `numFailedTests=0`, `success=true`, `numFailedTestSuites=0`, exit **0** | `npx vitest run --reporter=json --outputFile=<fuera del repo>`, contado con `node` sobre el JSON (2.1 MB) |
| Typecheck | exit 0 | **exit 0** | `./node_modules/.bin/tsc --noEmit` |
| Lint | `Checked 489 files`, exit 0 | **`Checked 489 files in 196ms. No fixes applied.`**, exit **0** | `./node_modules/.bin/biome check src/` |
| README | 295 / 489 | **295 / 489** en los cuatro sitios: `README.md:378` `:383`, `README.es.md:405` `:410` | ver §1.1 |

Cero rojos, así que no hubo que discriminar flake ajeno de regresión. **No repetí ninguna corrida.**

### 1.1 — Los dos números están DERIVADOS, no confiados al candado

El aviso era que `test/readme-numbers.test.ts` deriva de `git ls-files`, o sea del **índice**, y un
archivo nuevo no cuenta hasta agregarse. Lo derivé aparte, desde `rtk proxy git ls-files` (1818 rutas):

- **489** = `command grep -cE '^src/.*\.ts$'` → **489**. Coincide exacto con el `Checked 489 files` que
  imprimió Biome, o sea que el número del README y el universo real del linter son el mismo conjunto.
- **295** = `^(src|test)/.*\.test\.ts$` → **293**, más `^(src|test)/.*\.test\.mjs$` → **2** = **295**.
  Coincide con el `include` de `vitest.config.ts:5` (`src/**/*.test.ts`, `test/**/*.test.ts`,
  `test/**/*.test.mjs`) y con los **295** archivos que vitest efectivamente corrió.

Los 5 archivos nuevos de esta HU están **committeados** (`git diff --name-status --diff-filter=A`), así
que están en el índice y el candado no queda a deber. No aplica el footgun.

---

## 2. ACs — 12/12 PASS

Cada AC lleva testigo automatizado. Donde el testigo es estructural y no un test, lo digo.

| AC | Texto (resumido; literal en `story-file.md:119-188`) | Status | Evidencia `archivo:línea` |
|---|---|---|---|
| **AC-1** | POST válido → persiste bajo `metadata.payment`, lo devuelve en el 201, y `/discover` lo expone por el lector EXISTENTE sin tocarlo | ✅ **PASS** | `src/routes/agents.publish.test.ts:636` (T-316-01: 201 + `body.payment` con las 4 keys + el service recibe el bloque validado) · `src/services/agent.payment.test.ts:395` (T-316-02: input **sucio** con `resolvedChain`/`network`/`sarasa` → el `insert` recibe exactamente 4 keys) · `:663` (T-316-03: round-trip escritor→lector) · whitelist explícita en `src/lib/payment-spec-writer.ts:283-293` · **el lector no se tocó**: `src/lib/payment-spec-reader.ts` **no aparece** en `git diff --name-only main...HEAD` |
| **AC-2** | `chain` que no resuelve a `ChainKey` → 422 `INVALID_PAYMENT_CHAIN`, y CERO escritura | ✅ **PASS** | `src/lib/payment-spec-writer.test.ts:183-204` (T-316-04, con **gemelo anti-vacuidad**: el alias `'avalanche'` SÍ pasa el paso 2, y se persiste el alias declarado, no el `ChainKey`) · `src/lib/payment-spec-writer.ts:203-206` · route + cero escritura: `src/routes/agents.publish.test.ts:694-740` (`it.each`, assertea el `error_code` y `expect(mockPublish).not.toHaveBeenCalled()`) |
| **AC-3** | `ChainKey` conocido pero riel no inicializado → 422 `PAYMENT_CHAIN_NOT_INITIALIZED` + lista accionable | ✅ **PASS** | `src/lib/payment-spec-writer.test.ts:209-229` (T-316-05: `initializedChains` **contiene** `avalanche-fuji` y **no contiene** `kite-ozone-testnet`, + gemelo "una chain inicializada pasa") · `src/lib/payment-spec-writer.ts:212-222` (`chainKey` explícito, con la razón escrita) · route: `src/routes/agents.publish.test.ts:752` |
| **AC-4** | payTo trimeado que no pasa `isValidPayoutWallet(_, getChainVmFamily(chainKey))` → 422 `INVALID_PAYMENT_PAYTO_FORMAT`; y la caja NO se altera | ✅ **PASS** | `src/lib/payment-spec-writer.test.ts:234-264` (T-316-06: base58 en slot EVM **y** `0x…` en slot Solana, los dos; + gemelo de cada familia en su slot; + trim del payTo) · `:267-300` (T-316-07: `expect(block.contract).toBe(input)` y el test **MEDIDO** de por qué importa: `so111…112` en minúsculas **también** es pubkey válida, así que un `toLowerCase()` no fallaría ruidoso — persistiría OTRA billetera) · `src/lib/payment-spec-writer.ts:226-234` |
| **AC-5** | zero address EVM (cualquier caja) o pubkey Solana de todos ceros → 422 `ZERO_PAYMENT_PAYTO` | ✅ **PASS** | `src/lib/payment-spec-writer.test.ts:303-323` (T-316-08: assertea **`ZERO_PAYMENT_PAYTO`**, no el 422 — y trae **control de la premisa**: `expect(walletSpy.isValid).toHaveBeenCalledWith('1'.repeat(32),'solana')`, o sea que el paso 4 SÍ acepta esa cadena y por eso el paso 5 existe) · `:325-373` (T-316-09 EVM + gemelo) · `src/lib/payment-spec-writer.ts:237-240` |
| **AC-6** | payTo == operador resoluble → 422 `PAYTO_IS_OPERATOR`; irresoluble → ACEPTA y loguea `PAYTO_OPERATOR_CHECK_SKIPPED` | ✅ **PASS** | `src/lib/payment-spec-writer.test.ts:375-413` (T-316-10, 5 casos: solana igual→rechaza, distinto→acepta con `operatorCheckSkipped:false`, **EVM en otra caja también rechaza**, **Solana en otra caja NO rechaza porque es otra billetera**, e irresoluble→acepta con `operatorCheckSkipped:true`) · `src/lib/operator-address.test.ts:68` `:80` `:104` `:134` `:158` (T-316-11: env ausente y basura → `null` **sin lanzar**, el log lleva el **mensaje** del error, y **dos gemelos positivos**) · `src/lib/operator-address.ts:106-114`, `:51-74`, `:76-95` |
| **AC-7** | PATCH con `payment`: mismos guards, autorización por el guard de ownership EXISTENTE, `404` al no-dueño, y merge que no borra `inputSchema`/`outputSchema`/`discoverable` | ✅ **PASS** | `src/routes/agents.ownership.test.ts:355` (T-316-12: owner B → **404** `Agent not found` + `state.updateCalled === false`) · `:374` (**gemelo**: el mismo PATCH del dueño → 200 y el update corre — sin esto un `return 404` incondicional pasaría) · `src/services/agent.payment.test.ts:513` (T-316-13: `metadata` previo de 3 keys + PATCH sólo de `payment` → el `update` recibe las **4**) · `:619` (T-316-14: reemplazo auditado con las DOS billeteras) · `src/services/agent.ts:665-680` (defense-in-depth **después** del guard de dueño) · `:726-731` |
| **AC-8** | `payment: null` explícito → borra sólo esa key, el resto byte-idéntico | ✅ **PASS** | `src/services/agent.payment.test.ts:545` (T-316-15) · `:558` (T-316-16: borrar la única key escribe `metadata: null`, no `{}`) · `:595` (T-316-14: se audita con `op: 'delete'`, `prev` poblado, `next` null) · `src/services/agent.ts:740-754` (`delete meta.payment` + colapso R-7 a `null`) · **el par que lo hace no-vacío**: `src/routes/agents.publish.test.ts:905` + `:918` — el MISMO `null` es 422 en el ALTA y BORRADO en el PATCH |
| **AC-9** | Fila no escrita por esta HU → `/discover` y `/capabilities` byte-idénticos, el bloque sembrado NO se re-valida, nada se reescribe/migra | ✅ **PASS** | `src/services/agent.payment.test.ts:717` (T-316-17: `JSON.stringify(listAsAgents())` contra un **literal escrito a mano**, no derivado del mapper — se pone rojo ante key nueva, reordenamiento, o `payment: null` donde había ausencia; + control de armado final `not.toHaveProperty('payment')`) · `:692` (T-316-18: bloque sembrado con `chain:'polygon'` NO se re-valida ni se reescribe) · `src/services/agent.ts:214-224` · **cero DDL**: `git diff --name-only main...HEAD \| grep -iE '\.sql$\|migration\|supabase/'` → **cero coincidencias** · `/capabilities`: **evidencia estructural, no test** — `src/routes/capabilities.ts` no está en el diff y no referencia `publishedAgentService`/`listAsAgents`/`metadata` (sólo 2 comentarios de prosa en `:38` y `:55`), o sea que esa ruta no lee filas de agentes |
| **AC-10** | `method` no exactamente `x402` → 422 `UNSUPPORTED_PAYMENT_METHOD` | ✅ **PASS** | `src/lib/payment-spec-writer.test.ts:160-178` (T-316-19: `'X402'`, `' x402 '`, `'x402 '`, `'eip3009'`, `'X402 '` + **gemelo** `'x402'` exacto pasa) · `src/lib/payment-spec-writer.ts:193-198` (sin trim, sin lowercase, con la razón escrita) · route: `src/routes/agents.publish.test.ts:694-740` |
| **AC-11** | Body que **omite** `payment` → se comporta exactamente como hoy; `buildMetadata` sigue devolviendo `null`; `Agent.payment` queda `undefined` | ✅ **PASS** | `src/routes/agents.publish.test.ts:681` (T-316-20: `expect(...).not.toHaveProperty('payment')` en lo que recibe el service **y** en el 201 — `undefined`, nunca `null`) · `src/services/agent.payment.test.ts:415` (T-316-20 service: `metadata: null` y `record.payment` undefined) · `src/services/agent.ts:224` (`Object.keys(meta).length > 0 ? meta : null`, intacto) · `:192-194` (asignación condicional en `mapRowToRecord`, nunca `null`) |
| **AC-12** | `asset` presente → compara case-insensitive contra `supportedTokens[0].symbol`; mismatch → 422 `PAYMENT_ASSET_MISMATCH`. **ESTRICTO** (resuelto en F2) | ✅ **PASS** | `src/lib/payment-spec-writer.test.ts:418-462` (T-316-21: `'usdc'` vs `'USDC'` acepta **y persiste con la caja del caller**, `'PEN'` → mismatch, ausente → acepta sin escribir la key, no-string (`123`/`null`/objeto) se descarta en silencio, **y la consecuencia asumida**: con el symbol movido a `'PYUSD'`, `asset:'USDC'` da mismatch) · `:466` (T-316-26: riel sin tokens → acepta y loguea `PAYMENT_ASSET_CHECK_SKIPPED`) · `src/lib/payment-spec-writer.ts:242-262` |

**Los 21 tests declarados (`T-316-01..21`) existen los 21**, más 8 no declarados que nacieron de los
fix-packs (`T-316-22..29`). Ninguno declarado sin existir.

---

## 3. Los 3 MNR que el CR dejó abiertos — **los tres CONFIRMADOS**, ninguno afecta un AC

### MNR-1 — "11 archivos" son **12**. CONFIRMADO.

- `auto-blindaje.md:663-664` dice *"en los **11** archivos de `src/`+`test/` del Scope IN de WKH-316 hay
  **28** anclas en 24 líneas"*.
- Medido: `git diff --name-only main...HEAD | grep -cE '^(src|test)/'` → **12**.
- El ausente es `test/ownership-filter-guard.exceptions.ts`, y no es el más chico: tiene **41** pares
  estructurados `{file, line}` (`grep -cE '^\s*line: [0-9]+,'`) — más anclas que cualquier otro archivo
  del Scope IN. Mi barrido independiente sobre los 12 dio **43** anclas de texto, contra el 28 declarado.
- **No oculta nada falso**: las 5 entradas re-apuntadas y sus **5** anclas de prosa
  (`:330-335`→`:359-364`, `:450`→`:503`, `:580`→`:633`, `:701`→`:808`, `:407`→`:447`) están las 5 en el
  diff y el CR las verificó una por una. Lo que oculta es el **tamaño del universo de arranque** de
  `TD-316-CITAS-SIN-TESTIGO`: la HU que lo cierre arranca de ~63, no de 28.
- **Afecta un AC**: NO. Es un número dentro de un documento de proceso.

### MNR-2 — el "19" es **20**. CONFIRMADO.

- La enumeración de `auto-blindaje.md:663-673` suma 6+6+2+2+1+2 = **19**, y para
  `src/routes/agents.ownership.test.ts` lista sólo 2 (`:808`, `:822`).
- El diff de ese archivo re-apunta **TRES**: `:701`→`:808`, `:715`→`:822`, y `:184`→`:211`.
- `:211` está en la tabla de W4 (`auto-blindaje.md:240`) **pero no en la suma**. Y es correcta:
  `src/routes/agents.ownership.test.ts:211` = `it('T-143B-06: owner PATCH own slug with payoutWallet
  → 200, …')`, citada desde el docblock en `:25`.
- **Afecta un AC**: NO.

### MNR-3 — promesa falsa en un documento público. CONFIRMADO.

- `doc/INTEGRATION.md:246` promete: *"`asset` … then **stored as you sent it**."*
- `src/lib/payment-spec-writer.ts:292`: `if (asset !== undefined) block.asset = asset.trim();`
- O sea que `asset: " USDC "` se guarda `"USDC"`, no como se mandó. Impacto funcional nulo (`asset` es
  decorativo, ningún camino de settle lo lee), pero **es una promesa falsa en el documento de
  integración de un repo público**, y la clase de frase que después alguien cita como contrato.
- Ojo con el matiz que hace fácil equivocarse al "arreglarlo": la **caja** SÍ se preserva y eso está
  vigilado (`payment-spec-writer.test.ts:427` assertea `block.asset === 'usdc'`). Lo único que se toca
  es el whitespace. La corrección es de la **prosa**, no del código.
- **Afecta un AC**: NO. AC-12 sólo manda sobre la comparación y el rechazo, no sobre el almacenamiento
  del `asset`.

---

## 4. Lo que el CR señaló como lo mejor — **verificado, es verdad**

El punto era si un integrador que lee **sólo** el README y el INTEGRATION.md se enteraría del cambio
de contrato **201 → 422** con `payment: null`. Se enteraría:

- Los **dos** README linkean al ancla exacta: `README.md:287` y `README.es.md:314` →
  `doc/INTEGRATION.md#declaring-where-your-agent-gets-paid-payment`. El ancla **resuelve**: el heading
  es `doc/INTEGRATION.md:219` `### Declaring where your agent gets paid (\`payment\`)`, cuyo slug de
  GitHub es exactamente ese. Y el link es relativo desde la raíz, donde viven los dos README.
- El cambio tiene **sección propia con heading**: `doc/INTEGRATION.md:263` `#### Deleting the block`, y
  en `:269-271` lo dice sin rodeos: *"On `POST` there is nothing to delete, so `"payment": null` is
  rejected with `INVALID_PAYMENT_BLOCK` rather than being silently read as 'no payment block'."*
- El footgun de `contract` tiene heading propio: `:248` `#### \`contract\` is the wallet that gets paid,
  not a token address`, y nombra la consecuencia ("Putting a token address there sends your earnings to
  the token contract").
- Las **8** rejections tabuladas en `:280-295`, y el `All eight are 422` de `:282` **cierra**: conté 8
  filas en la tabla. (La tabla de contrato del Story File, `:299-305`, lista 7 — le falta
  `INVALID_PAYMENT_BLOCK`, que nació en el fix-pack #2 y está declarado en `auto-blindaje.md`. El
  documento público es el que está completo, que es el orden correcto.)
- La consecuencia de AC-12 estricto sobre kite/tempo está publicada, no escondida: `:298`
  `#### \`asset\` is checked strictly, and that has a consequence worth knowing`.

### El ejemplo publicado FUNCIONA tal cual está escrito

Esto lo medí, no lo leí. El bloque JSON de `doc/INTEGRATION.md:230-239` usa el placeholder
`"contract": "YourBase58PubkeyHere11111111111111111111111"`. Un placeholder que **no** fuera una
dirección válida haría que el primer intento de todo integrador diera 422
`INVALID_PAYMENT_PAYTO_FORMAT` — el mismo patrón del `curl` publicado que devolvía otra cosa.

Corrido contra el validador real del repo (`src/lib/wallet-format.ts`, vía `tsx`):

```
example from INTEGRATION.md: "YourBase58PubkeyHere11111111111111111111111" len= 43
isValidSolanaAddress -> true
isValidPayoutWallet(solana) -> true
POSITIVE CONTROL 64KKjZFSMZRucKPqTpGydrUFeFdLHDhbHTJVGmEaXS6z len= 44 -> true
NEGATIVE CONTROL "abc" -> false
```

Control positivo y negativo incluidos, para que el `true` no sea un validador que dice `true` a todo.
El resto del ejemplo también cierra: `chain: "solana-devnet"` + `asset: "USDC"` coincide con el symbol
del adapter Solana, y el payTo no es la pubkey de todos ceros. **El ejemplo publicado pasa los 7 pasos.**

---

## 5. Las dos deudas declaradas — ¿acotamiento o cierre disfrazado?

**Las dos están escritas como ACOTAMIENTO, y las dos son ejecutables por alguien que no leyó esta HU.**
Es el mejor material del expediente.

### `TD-316-METADATA-LWW` (`auto-blindaje.md:450-492`)

- Dice el interleaving en **4 pasos concretos** con dos PATCH del mismo dueño sobre el mismo slug, y
  nombra lo que lo hace invisible: *"Las dos respuestas son **200**, y el log de auditoría no delata
  nada"* — porque el (2) no loguea, ya que su `updates.payment` es `undefined`.
- Distingue honestamente qué heredó y qué agregó: *"La ventana no la abrí yo; lo que puse adentro, sí."*
- La sección de mitigación se titula **"cuál es, y cuál NO es"** y termina en la frase que la salva de
  ser un cierre disfrazado: *"Eso **acota la probabilidad, no cierra el camino**: no hay ningún guard
  que impida el interleaving, y no hay ninguna señal —ni en la respuesta HTTP ni en el log— de que
  ocurrió."*
- **Verifiqué su disparador contra el árbol, que es la parte que envejece**: `readPaymentSpec` tiene
  exactamente **2 call sites** de producción — `src/services/discovery.ts:1380` y
  `src/services/agent.ts:169` — y `grep -rn readPaymentSpec src/middleware/` da **cero**, o sea que
  ninguno está en el camino de `requirePayment`. La afirmación se sostiene hoy.
- Verifiqué también la línea que el propio TD marca como load-bearing: `src/services/agent.ts:686-694`
  captura `previousPaymentBlock` **antes** del merge, con la razón escrita (el merge muta
  `existing.metadata` en el lugar porque `readMetadataObject` devuelve el mismo objeto).

### `TD-316-CITAS-SIN-TESTIGO` (`auto-blindaje.md:624-693`)

- Mismo formato, misma frase de honestidad: *"Eso **acota la tasa, no cierra el camino**: no hay ningún
  control que se ponga rojo, así que la garantía dura exactamente lo que dure la disciplina del que
  revisa."*
- Y — esto es lo que la hace **ejecutable por un tercero** — no promete cuidado: señala el patrón que ya
  existe en el repo aplicado a otro destino. **Los 4 punteros resuelven, uno por uno**:
  - `CITED_INDEX_LINES` → `test/sdd-index-matches-folders.exceptions.ts:181` ✅
  - el control anti-vacuidad `mustContain` → `test/sdd-index-matches-folders.exceptions.ts:166` ✅
  - el control de universo `G-F2` → `test/sdd-index-matches-folders.test.ts:420`, y **el universo se
    deriva de verdad**: `execFileSync('git', ['ls-files', '--', 'src'])` en `:421-425` ✅
  - por qué el guardián actual no puede cazarlas → `test/payment-guards-live-in-one-place.test.ts:45-55`,
    y leí el `codeOnly`: **borra los comentarios antes de mirar** (`.replace(/\/\*[\s\S]*?\*\//g,'')`
    más el filtro de `//` y `*`), o sea que por construcción no puede ver una cita ✅
- Las **6 pre-existentes falsas** están ruteadas con su ancla real tabulada (`auto-blindaje.md:609-612`).
- El TD además declara **el límite de su propio conteo** (*"el 28 es un piso, no un total"*, porque el
  barrido de la forma corta busca entre backticks y una cita en prosa suelta no la devuelve). Ese límite
  autodeclarado es correcto — y es justamente lo que MNR-1 muestra que se subestimó.

---

## 6. Drift Detection

### 6.1 Scope IN vs. el diff — **sin drift silencioso**

El diff toca **22** archivos. El Story File declara **13** en sus dos tablas
(`story-file.md:197-217`). Los 9 restantes:

- **6 son artefactos de proceso** de la propia carpeta de la HU (`sdd.md`, `story-file.md`,
  `auto-blindaje.md`, `ar-report.md`, `ar-report-it2.md`) — esperados.
- **`README.es.md`** — fuera del Scope IN, **y declarado como desviación** en `auto-blindaje.md:118`,
  obligada por `test/readme-numbers.test.ts` que verifica los DOS README. Reconocida también por el AR
  (`ar-report.md:435`). El diff son 2 números + 1 fila de tabla, nada más. **No es drift oculto.**
- **`test/payment-guards-live-in-one-place.test.ts`** — archivo nuevo, declarado como W4.3 / `T-316-24`
  (`ar-report.md:434`). No está en la tabla de "Files to Modify/Create" pero sí en las Waves.
- **`test/ownership-filter-guard.exceptions.ts`** — es la fila #13, agregada por el Dev con la corrección
  auditada en `story-file.md:219-238`. Verifiqué que el diff respetó el alcance permitido al pie de la
  letra: **5 entradas, sólo el `line:` corrido y las citas de prosa dentro de esas mismas entradas.
  Cero entradas nuevas, cero motivos reescritos, cero entradas de otros archivos.** Consistente con que
  el diff no introduce ninguna cadena `supabase.from(...)`.

Y al revés — **declarado y no tocado**: ninguno. Los 13 declarados están los 13 en el diff.

### 6.2 🔴 DRIFT-1 — `cr-report.md` existe en disco pero **en CERO commits**

```
git status --porcelain      → ?? doc/sdd/214-wkh-316-escritor-payment-block/cr-report.md
git log --all -- .../cr-report.md | wc -l   → 0
```

El reporte del CR (40.9 KB, 538 líneas) es **untracked**. Es el espejo del patrón que apareció seis
veces en esta sesión: no es un reporte declarado que no existe, es un reporte que existe y **no viaja
con la rama**. Si se pushea `feat/214-wkh-316-payment-block` hoy, el único artefacto que documenta el
CR APROBADO no llega, y un `git clean` lo borra sin dejar rastro.

**Acción**: committearlo antes del merge. No rompe ningún AC.

### 6.3 🔴 DRIFT-2 — `doc/sdd/_INDEX.md:181` afirma que esta HU **no existe**, y apunta a la rama equivocada

`doc/sdd/_INDEX.md` **no está en el diff** — y eso es correcto, el Story File lo pide explícitamente
(`story-file.md:212-213`: *"la fila `214` … ya existe (`:181`) — no la reescribas (eso es F4/DONE)"*).
Pero hay que decir en qué estado queda, porque hoy la fila **miente activamente**:

1. Declara como estado medido: *"el **ESCRITOR sigue sin existir** — `PublishAgentInput`
   (`src/types/index.ts:282-309`) no declara `payment`"*, con control positivo y todo.
   **Es falso en esta rama**: `src/types/index.ts:346` declara `payment?: AgentPaymentSpecInput` en
   `PublishAgentInput`, y `:376` declara `payment?: AgentPaymentSpecInput | null` en `UpdateAgentInput`.
   El rango citado `:282-309` también quedó viejo.
2. Nombra la rama **`feat/214-wkh-316-payment-block-writer`**. Esa rama **existe** y es la trampa:
   `git rev-parse` da `6b391d6` y `git merge-base --is-ancestor … main` confirma que **ya está en main,
   sin commits propios**. El trabajo real está en `feat/214-wkh-316-payment-block`, **sin** el sufijo
   `-writer`. Quien siga el `_INDEX.md` va a mirar la rama vacía, no encontrar nada, y confirmar la
   afirmación falsa del punto 1. **La evidencia se auto-confirma.**
3. **Y el arreglo preparado reproduce el error**: `_INDEX-row.md:18` —el reemplazo que va a usar la fase
   DONE— también dice `feat/214-wkh-316-payment-block-writer`, y sigue en `IN PROGRESS`. Si se pega tal
   cual, el nombre de rama equivocado entra al índice en silencio.

**Acción para DONE**: corregir el nombre de rama en `_INDEX-row.md:18` **antes** de pegarlo, y reemplazar
la fila `_INDEX.md:181` completa. No rompe ningún AC (ningún AC habla de `_INDEX.md`), pero es
exactamente la clase de renglón que la próxima sesión va a leer como verdad medida.

### 6.4 Wave drift

Los 8 commits respetan W0 → W1 → W2 → W3A/W3B → W4, con los dos fix-packs de AR (`e57af46`, `3e61725`)
al final. El propio Story File registra el re-cálculo de líneas de W0 y su repetición en W3B
(`story-file.md:236-238`), que es lo que corresponde cuando el mismo archivo se edita en dos waves.

### 6.5 Residuo de mutante — limpio

- `md5sum src/routes/agents.ts` → **`fdb1fd726b17aa17d4296705738f7e62`** ✅ coincide con el esperado.
- `git status --porcelain` → sólo **2** untracked, los dos `.md`: el declarado de otra HU y el DRIFT-1.
  **Cero** archivos modificados sin committear, cero residuo en `src/` ni en `test/`.
- El untracked ajeno intacto: `md5sum doc/sdd/212-wkh-314-x402-inbound-solana/story-file.md` →
  **`7904ef74a1c46d7880e0ca5d38e3eed4`** ✅ coincide. **No lo toqué.**

### 6.6 Declarado HECHO y ausente del árbol

Barrido de las afirmaciones verificables del expediente: **el único caso es DRIFT-2** (`_INDEX.md`
declara lo contrario de lo que hay), y es una fila vieja, no una promesa incumplida del Dev. Los 21
tests declarados existen. Los 5 archivos nuevos existen y están committeados. Las 5 entradas de
excepciones re-apuntadas están re-apuntadas. Los 4 números de los README están cambiados en los 4
sitios. `payment-spec-reader.ts` no se tocó, como se prometió.

---

## 7. Runtime-first — qué necesita y qué no necesita este deploy

### Cero DDL — confirmado

```
git diff --name-only main...HEAD | grep -iE '\.sql$|migration|supabase/'   → cero coincidencias
```

Ni un `.sql`, ni una migración, ni un archivo bajo `supabase/`. La HU es cero-migraciones como se
declaró (CD-14, AC-9). **No hay drift de DDL.**

### Cero env vars nuevas — hallazgo positivo, y lo digo explícitamente

**Esta HU no introduce ninguna variable de entorno nueva. Desplegar esto NO requiere acción de ops.**

Es el resultado de grepear `process.env` en los 5 archivos de `src/` del diff. Hay **una sola** lectura,
`src/lib/operator-address.ts:53` → `OPERATOR_PRIVATE_KEY`, que **ya existe** en
`.env.example:352`. El lado Solana no lee env directo: delega en
`getSolanaOperatorKeypair()` vía `await import()` (`operator-address.ts:78-79`), que consume
`SOLANA_OPERATOR_PRIVATE_KEY`, también ya presente (`.env.example:1212`).

Y el diseño hace que la ausencia de las dos sea **inofensiva por construcción, no por suerte**:
`resolveOperatorAddress` nunca lanza y devuelve `null`, y el paso 7 degrada a aceptar marcando
`operatorCheckSkipped` (`payment-spec-writer.ts:266-272`), con el log `PAYTO_OPERATOR_CHECK_SKIPPED`.
Un deploy sin esas envs publica igual y pierde **sólo** el guard de AC-6 — ruidosamente, en el log
del servidor. Eso es lo que AC-6 manda.

### Smoke manual para después del merge (no lo ejecuté yo)

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

## 8. Límites de lo que pude medir — **con esas palabras**

Estos son los **límites de lo que pude medir**. No son fallas; son el borde de mi evidencia, y
cualquiera que se apoye en este reporte tiene que saber dónde termina.

1. **No ejecuté nada contra producción, ni consulté Supabase ni Railway** (prohibido en el encargo, y
   no necesario para una HU cero-DDL). Consecuencia concreta: **no verifiqué contra la base** que las
   **3** filas Solana sembradas sigan intactas. La no-regresión de AC-9 está probada a nivel de código
   —con la forma real del bloque sembrado, `payment-spec-writer.test.ts` y `agent.payment.test.ts:717`—
   pero no contra las filas vivas.
2. **Todos los testigos de `validatePaymentBlock` corren contra un registry MOCKEADO.** Nunca ejercité
   el validador contra un `getAdaptersBundle('solana-devnet')` real e inicializado. El paso 3 (AC-3) es
   precisamente el que depende de eso, así que **en un proceso real el resultado depende de qué rieles
   estén vivos en ese deploy** — que es el diseño, no un defecto. El paso 6 del smoke de arriba es lo
   que cierra ese hueco, y lo tiene que correr un humano.
3. **No re-ejecuté los mutantes del AR ni re-litigué el CR**, por encargo explícito. O sea que
   `M15` matando 1 de 5765 sin segundo camino, la corrección de las 25 anclas, y las 5 excepciones de
   ownership los tomo como medidos por otro, no por mí. Lo único que re-medí de ese territorio es lo
   que cité arriba con su comando.
4. **Mi barrido de anclas de §3/MNR-1 es un piso, no un total.** Usé dos formas (`archivo.ts:N` y
   `` `:N` `` entre backticks) más los pares estructurados `{file, line}`. Una cita escrita en prosa
   suelta ("la línea 95") no la devuelve ningún de esos patrones. Mi **43** y el **28** declarado son
   los dos pisos; lo que sostengo con certeza es la comparación **12 archivos ≠ 11**, que es mecánica.
5. **El ancla de Markdown la verifiqué por la regla de slug de GitHub, no renderizando la página.**
   El heading (`INTEGRATION.md:219`) produce exactamente el slug que los dos README linkean, pero no
   abrí el HTML renderizado para confirmarlo visualmente.
6. **La suite corrió con otros 3 agentes usando la máquina.** No tuve que discriminar flake de
   regresión porque salió **0 failed** en la primera corrida, y no la repetí. Si hubiera salido un
   rojo, este renglón diría otra cosa.

---

## 9. Deuda que queda declarada, con su nombre

| Nombre | Dónde | Estado |
|---|---|---|
| `TD-316-METADATA-LWW` | `auto-blindaje.md:450-492` | **Abierta, correctamente acotada.** `update()` reescribe `metadata` completo sin control de concurrencia, y esta HU metió la billetera de cobro en esa ventana. Arreglo = concurrencia optimista (necesita DDL) ⇒ otra HU. Disparador medido y re-verificado por F4: `readPaymentSpec` tiene 2 call sites, ninguno en `requirePayment`. |
| `TD-316-CITAS-SIN-TESTIGO` | `auto-blindaje.md:624-693` | **Abierta, correctamente acotada.** 18 citas defectuosas, 0 cazables por ningún test. El patrón que la cerraría ya existe (`CITED_INDEX_LINES` + `G-F2` + `mustContain`), y los 4 punteros resuelven. Universo de arranque real ~63 (ver MNR-1), no 28. |
| `MNR-1` · `MNR-2` · `MNR-3` | §3 de este reporte | **Confirmados los 3, ninguno afecta un AC.** Van al micro-fix antes del merge. MNR-3 es el único con superficie pública (`doc/INTEGRATION.md:246`) y su corrección es de prosa, no de código. |
| `DRIFT-1` | §6.2 | `cr-report.md` untracked. Committear antes del merge. |
| `DRIFT-2` | §6.3 | `_INDEX.md:181` afirma que el escritor no existe y nombra la rama vacía; `_INDEX-row.md:18` reproduce el nombre equivocado. Trabajo de DONE. |
| `NC-1` | `story-file.md:916` | Sigue abierta y sigue sin bloquear: no se puede determinar desde el árbol si la pubkey de los 3 agentes Solana vivos es la del operador del gateway. AC-6 **detecta** el caso si lo es. |

---

## Cierre

**APROBADO para DONE**, con la condición de que el micro-fix pre-merge cubra los 3 MNR **y los 2 drift**.
Los 12 ACs están cumplidos y verificables, las 4 puertas las re-medí yo mismo y coinciden al número con
lo declarado, el árbol no tiene residuo, la HU no pide ni una env nueva ni una línea de DDL, y las dos
deudas están escritas como lo que son: agujeros acotados y ejecutables por un tercero, no cerrados.

Lo más valioso que encontré que nadie más había mirado: **el `_INDEX.md` de este repo afirma hoy, como
hecho medido y con control positivo, que la feature que esta rama implementa no existe — y manda a
verificarlo a una rama vacía que confirma la afirmación falsa.** Eso no rompe un AC, y es exactamente
por eso que sobrevive.
