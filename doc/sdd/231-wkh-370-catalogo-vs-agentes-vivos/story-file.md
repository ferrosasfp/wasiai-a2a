# Story File — [WKH-370] El vigilante del catálogo: deriva ≠ completitud

> Fase F2.5 · Rol `nexus-architect` · Fecha **2026-08-27**
> Input: `sdd.md` (SPEC_APPROVED) + `work-item.md` · Issue de origen: `wasiai-a2a#186`
> **Árbol medido para este contrato: `main` @ `a58ab2b`** (el SDD dice `a9087e4`; ése es el commit
> del F1 — el propio SDD se commiteó encima. Línea base re-medida acá abajo: **idéntica**.)
> Rama a crear: `feat/231-wkh-370-catalogo-vs-agentes-vivos` desde `main` @ `a58ab2b`.

**Este documento es lo ÚNICO que el Dev necesita leer.** Todo lo que no está acá, no se hace.
Todo lo que está acá se midió hoy contra este árbol o contra producción.

---

## 0. Cómo leer las citas de este documento

| Marca | Significado |
|---|---|
| `[M]` | **Medido en esta corrida F2.5**, abriendo el archivo con `/usr/bin/sed -n` o ejecutando el comando. |
| `[M-PROD]` | Medido hoy contra producción con un `GET` (cero credenciales, cero gasto). |
| `[SDD]` | Viene del SDD y **lo re-verifiqué**; la cita es correcta. |

⛔ `doc/sdd/` **no** está en `CORTE_A_PATHS` (`test/cited-lines-guard.citations.ts:87-102`, 14 paths)
`[M]` ⇒ **ninguna suite verifica las citas de este archivo**. Se escribieron abriendo cada archivo.
Si una no cierra, **abrí el archivo antes de creerle a este documento** y anotalo en `auto-blindaje.md`.

### Línea base del gate — corrida completa hoy, árbol limpio en `a58ab2b` `[M]`

```
/usr/bin/git status --short           → (vacío)
npx tsc -p tsconfig.json --noEmit     → "TypeScript compilation completed"            exit 0
npm run lint                          → "Checked 519 files in 256ms. No fixes applied."  exit 0
npm test                              → Test Files  312 passed | 6 skipped (318)
                                        Tests      6310 passed | 19 skipped (6329)    exit 0
```
⛔ **`npm run qa` NO EXISTE en este repo.** El gate es esa secuencia, en ese orden
(`.github/workflows/ci.yml:36-43` `[M]`).

---

## 1. ⛔ BLOQUE DE ANTI-ALUCINACIÓN — leer ANTES de escribir una línea

### 1.1 La tesis (AC-3), que es la razón de existir de la HU

> **Una fila mal nacida se ve igual que una sana desde el catálogo.**
> Deriva y completitud son dos preguntas distintas y **ninguna implica la otra**.
> El chequeo de deriva **NO** habría cazado las dos filas sin `payout_wallet`.

Si en algún momento el diseño hace que una mitad dependa de la otra (un `needs:`, un `&&`, una
escalera que corta antes), **rompiste la HU**. Las dos mitades son independientes por construcción,
y hay tests que lo afirman (T-C1, T-C2, T-Y1, T-Y3).

### 1.2 Las cinco trampas medidas

**T1 — ⛔ El `inputSchema` vive en TRES formas distintas. Medido hoy `[M-PROD]`.**

| Fuente | Dónde está `inputSchema` |
|---|---|
| `GET /discover` (mapper `mapRowToAgent`, `src/services/agent.ts:138-171`) | **`agent.metadata.inputSchema`** |
| `GET /agents` (mapper `mapRowToRecord`, `src/services/agent.ts:174-198`, iza en `:190`) | **`record.inputSchema` EN LA RAÍZ** |
| Manifiesto vivo del agente | **`manifest.inputSchema` EN LA RAÍZ** |

Medición de hoy sobre `GET /discover` (29 filas): **`inputSchema` en la raíz = 0 · en `metadata` = 5**.
Un barrido a la raíz de `/discover` devuelve *"0 de 29 publican schema"*, que es **falso**.
⇒ **CERO UNIFORME = clase CONFIG, JAMÁS DERIVA** (AC-7, fila 5 de la escalera, test T-Z1).

**T2 — ⛔ El `pathSlug` NO es el slug del catálogo en 2 de 5. Medido hoy `[M-PROD]`.**

```
remit-corridor-fx-solana      → path  remit-corridor-fx        ⚠️ distinto
remit-cashout-payout-solana   → path  remit-cashout-payout     ⚠️ distinto
remit-kyc-validator           → path  remit-kyc-validator
remit-kyc-decision            → path  remit-kyc-decision
remit-kyc-session             → path  remit-kyc-session
```
La clave sale del `invokeUrl`, y **el manifiesto se autodeclara** con el slug del catálogo
(`manifest.slug === catalogo.slug` en **5/5**, incluidos los 2 raros `[M-PROD]`).
⇒ La unión **se VERIFICA, no se confía**. Si no coincide: **`UNRESOLVED(6)`**, y ⛔ **no se comparan
los schemas** (AC-6, tests T-J1/T-J2).

**T3 — ⛔ PROHIBIDO iterar `GET /discover/:slug` sobre los 29.**
`src/routes/discover.ts:325-348` `[M]` documenta que desde WKH-369 el detalle cuesta **hasta 201
`supabase.from()` por request** (30 con las 29 filas de hoy) y **perdió `rateLimit: false`**.
Se lee la **LISTA**, **una vez por job**. Test T-S3.

**T4 — El universo se DERIVA, no se hardcodea.**
Hoy es **29 = 24 WasiAI + 5 self-published** `[M-PROD]`, y **el número se mueve** (dos filas del
índice dan 25 y 29 en fechas distintas). El discriminante **no es el host**: es el campo
`agent.registry === 'self-published'` (lo pone el mapper como literal,
`src/services/agent.ts:150` → `SELF_PUBLISHED_REGISTRY_NAME`, definido en `src/types/index.ts:306`
`[M]`). Los fixtures de la suite **sí** son literales, y llevan escrita la fecha `2026-08-27`.

**T5 — `owner_ref` es `NOT NULL`: chequear su presencia es VACUO, y se declara vacuo.**
`src/types/database.types.ts:61` lo declara `owner_ref: string` en `Row`, y `:75` lo hace
obligatorio en `Insert` `[M]`. ⇒ No existe input que ponga roja una comprobación de *presencia*.
Se implementa como **cadena no vacía tras `trim()`** (lo único que el tipo no descarta) y **el
docblock dice que es casi vacuo**. No se disfraza de protección (CD-17, test T-C4).

### 1.3 El riesgo #1 del entregable — el guardián de citas se va a poner rojo, DOS veces

`src/services/agent.ts` está en `CORTE_A_PATHS` (`test/cited-lines-guard.citations.ts:90` `[M]`).
Hay **dos** caminos independientes al rojo, y el SDD sólo anticipa el primero:

**(a) Las 3 citas que se DESPLAZAN** (CD-13 · W3.3). Medidas hoy `[M]`:

| Entrada en `citations.ts` | Token literal | `line:` | Qué ancla hoy en `agent.ts` |
|---|---|---|---|
| `:229` | `'services/agent.ts:399'` ⚠️ **sin prefijo `src/`** | `399` | `// Defense-in-depth (CD-1): re-validar la URL aunque el route ya validó.` |
| `:616` | `'src/services/agent.ts:808'` | `808` | `if (existing.owner_ref !== ownerRef) {` (dentro de `delete`) |
| `:627` | `'src/services/agent.ts:822'` | `822` | `.eq('owner_ref', ownerRef)` (dentro de `delete`) |

Las tres están **por debajo** de los dos puntos de inserción ⇒ **las tres se corren**.
⚠️ El token de `:229` está escrito **sin `src/`**: un `sed` que busque `src/services/agent.ts:` lo
**pierde**. Se corrigen **a mano, abriendo cada línea nueva**, jamás volcando la salida de un escáner.

**(b) 🔴 LAS CITAS QUE NACEN — esto el SDD NO lo dice y es más caro que (a).**
`test/cited-lines-guard.test.ts:28-30` `[M]`: *"El universo de citas **NO se declara: se DERIVA** en
cada corrida, barriendo los 14 paths con las cuatro formas sintácticas del escáner."*
Y una de esas formas es **`BARE_CITE_RE = /:(\d+)(?:-(\d+))?/g`** (`test/cited-lines-guard.scanner.ts:125`
`[M]`): **un `:N` suelto, sin path delante**.

⇒ Si el docblock nuevo que W1.B1 pide dentro de `src/services/agent.ts` contiene **cualquier**
token `:<dígito>` —`agents.ts:586`, o incluso un `` `:196` `` pelado—, el escáner lo descubre, no
encuentra su entrada declarada y **`npm test` se pone rojo**.

> ### ⛔ CD-22 (NUEVO, obligatorio): el docblock de `hasPayoutWallet` se escribe con **CERO** tokens `:<dígito>`.
> Se nombran archivos y **símbolos**, nunca líneas: *"la ruta `GET /agents` de `src/routes/agents.ts`
> filtra por `keyRow.owner_ref` antes de mapear"*, no *"`agents.ts:586`"*.
> Aplica a **todo** comentario nuevo o editado dentro de `src/services/agent.ts`, incluido el que
> hay que corregir en `getSplitContextRow`. Si el Dev **necesita** citar una línea, la alternativa
> es declararla en `citations.ts` con `from`/`cite`/`target`/`line`/`mustContain`/`symbolPath`
> completos — **más trabajo, mismo resultado**. Elegí no citar.

### 1.4 El riesgo #2, que el AR va a atacar — que el Dev NO improvise acá

**No existe agent key de sólo lectura.** `GET /` (`src/routes/agents.ts:577`), `PATCH /:slug`
(`:368`) y `DELETE /:slug` (`:536`) usan **EXACTAMENTE el mismo** `requireA2AKey()` `[M]`.
⇒ El secreto `A2A_CATALOG_OWNER_KEY` tendrá **poder de borrado** sobre las filas de ese owner.

El SDD lo aceptó (DT-3, opción 3b) con **5 mitigaciones**, y las 5 son obligatorias
(§4 W1.B / W2.3 / tests T-Y5, T-Y6, T-S1, T-S2). **La alternativa —diferir la mitad de
`payout_wallet`— está especificada en el SDD y NO se toma acá.** Si el AR la exige, es una
decisión del gate humano, no del Dev.

---

## 2. Decisiones CERRADAS — el Dev no las renegocia

### D-1 · ⛔ `outputSchema` NO cuenta para completitud. Es INFORMATIVO.

**Medido hoy `[M-PROD]`, sobre el catálogo y sobre los 5 manifiestos vivos:**

| slug | `metadata.outputSchema` (catálogo) | `outputSchema` (manifiesto) |
|---|---|---|
| `remit-cashout-payout-solana` | ✅ presente | ❌ **ausente** |
| `remit-corridor-fx-solana` | ✅ presente | ❌ **ausente** |
| `remit-kyc-validator` | ✅ presente | ❌ **ausente** |
| `remit-kyc-decision` | ❌ ausente | ❌ **ausente** |
| `remit-kyc-session` | ❌ ausente | ❌ **ausente** |

Las keys de primer nivel de los 5 manifiestos son idénticas y son ocho:
`capabilities, description, inputSchema, manifestVersion, name, payment, priceUsdc, slug` `[M-PROD]`.
**`outputSchema` no está en ninguno: 0 de 5.**

**Por qué se cierra así:** exigirlo sería exigir un campo **sin fuente de verdad** — sólo puede
escribirse a mano, que es exactamente el defecto que esta HU existe para matar. Y un chequeo que
**nace rojo por un criterio inalcanzable entrena a la gente a ignorarlo**, que es el modo de falla
que `.github/workflows/smoke-downstream.yml:81-82` `[M]` documenta textualmente
(*"un issue que queda abierto para siempre es el control que la gente aprende a ignorar"*).

⇒ **Implementación**: `outputSchema` se **cuenta y se reporta** en la línea de salida como
`outputSchemaPresente=<n>/<n>`, y **NO** entra a la escalera: no puede producir `INCOMPLETA(5)`.
⇒ **TD declarada** (va en el docblock del script, no en un backlog aparte):
**`TD-370-OUTPUTSCHEMA-SIN-FUENTE`** — 3 filas del catálogo tienen un `outputSchema` escrito a mano
que ningún manifiesto respalda. O los agentes lo publican, o el catálogo lo suelta. Esta HU no lo
resuelve; lo **hace visible**.
⇒ **Consecuencia**: el chequeo **NO nace en rojo** por esta causa. Se cierra el riesgo R-1 del SDD.
⇒ **Test obligatorio T-C5**: un fixture donde falta `outputSchema` en catálogo Y en manifiesto sale
**`CONFORME(0)`** si todo lo demás está — el control positivo de que D-1 se implementó.

### D-2 · 🔴 `AgentRow` NO tiene `payout_wallet` — hay que ampliarlo, y hay un comentario que dice lo contrario

**Medido `[M]`, y el SDD no lo menciona:**

- `src/services/agent.ts:54-65` — la interfaz interna `AgentRow` lista exactamente
  `slug, name, description, capabilities, agent_url, price_usdc, metadata, enabled, owner_ref, created_at`.
  **`payout_wallet` NO está.**
- `mapRowToRecord(row: AgentRow)` (`:174`) recibe un `AgentRow` ⇒ **`row.payout_wallet` NO COMPILA**.
  W1.B2 del SDD, tal como está escrito, da error de `tsc`. Y `CLAUDE.md` prohíbe `any` explícito.
- `src/services/agent.ts:361-365` `[M]` dice **textualmente**:
  > *"seleccionando EXCLUSIVAMENTE `owner_ref, payout_wallet, referrer_ref` — esas columnas **JAMÁS
  > entran a `AgentRow`** ni a un shape público (`mapRowToAgent`/`mapRowToRecord`), preservando CD-5."*
- Y es una decisión **escrita en una HU anterior**: `doc/sdd/144-wkh-143-activate-creator-referral-splits/sdd.md:49`
  `[M]`: *"`AgentRow` interno … **NO ampliar esta interfaz** (alimenta mappers públicos → CD-5)."*

**Camino prescrito (no improvisar):**

1. Agregar a `AgentRow` **una sola línea**: `payout_wallet: string | null;`
   (⚠️ **no** `referrer_ref`: no hace falta y ampliaría el radio sin motivo).
   Runtime ya lo trae: los cuatro lectores usan `.select('*')` (`:348`, `:508`, `:581`, `:601`) y los
   dos de escritura `.select()` (`:475`, `:762`) `[M]` ⇒ **ninguna query cambia**.
2. **Corregir el comentario de `getSplitContextRow`** (`:361-365`) para que diga lo que ahora es
   cierto: *el VALOR de `payout_wallet` sigue sin entrar a ningún shape público; lo que entra a
   `PublishedAgentRecord` es un BOOLEANO derivado, y `mapRowToAgent` no lo emite.*
   ⛔ Sin tokens `:<dígito>` (CD-22). ⛔ **Dejar el comentario como está lo vuelve falso**, y ésta es
   la HU con menos derecho a dejar prosa que afirma de más.
3. ⛔ **No tocar `mapRowToAgent`.** Ahora recibe un `AgentRow` que SÍ tipa `payout_wallet`: la única
   barrera es que nadie lo agregue al objeto de retorno. El **control negativo T-B2** es esa barrera.

**Presupuesto real de `src/services/agent.ts`: ≤ 26 líneas** (el SDD decía ≤16 y no contaba ni la
línea de `AgentRow` ni la corrección del comentario). Se declara acá, no se descubre en el CR.

### D-3 · ⛔ `.env.example` NO se toca. Sale del Scope IN.

**Medido `[M]`:**
- `A2A_PROBE_KEY` —el secreto equivalente, del exemplar que esta HU sigue— **NO está en
  `.env.example`**. Lo que sí está es su metadata no-secreta: `A2A_PROBE_KEY_ID=` (`:1605`) y
  `A2A_PROBE_KEY_OWNER_REF=` (`:1610`), y el bloque de arriba explica textualmente que *"NO es un
  secreto (es un identificador, no una credencial)"*. Tampoco están `PROBE_AMOUNT_USD` ni
  `PROBE_SELF_TEST_OMIT_REQUIRED`: las envs **de script** no viven ahí.
- Y hay un costo mecánico que el SDD no vio: `test/readme-numbers.test.ts:183-185` `[M]` deriva
  `ENV_VARS` con `/^[A-Z][A-Z0-9_]*=/` sobre `.env.example` (**hoy 193** `[M]`) y `:292` lo afirma
  contra **`README.md:351`** (`documents **193 variables**`) y **`README.es.md:385`**
  (`documenta **193 variables**`). Agregar 2 entradas obliga a editar **dos números más** que el
  SDD no presupuestó.

⇒ `A2A_CATALOG_OWNER_KEY` se documenta **en el docblock del workflow** (que ya es obligatorio por
DT-3 mitigación 5) y en `auto-blindaje.md`. `CHECK_MODE` se documenta en el docblock del script.
⇒ **`.env.example` sale del Scope IN. Los números de README que cambian siguen siendo 4, no 6.**

### D-4 · Los campos que se comparan para deriva — y el `payment` que NO

Medidos hoy contra los 5 manifiestos vivos: **deriva 0/5 en los cinco campos** `[M-PROD]`.

| Campo | En el catálogo (`/discover`) | En el manifiesto | Cómo se compara |
|---|---|---|---|
| `inputSchema` | `agent.metadata.inputSchema` ⚠️ | raíz ⚠️ | huella `sha256`, 12 hex, sobre JSON canónico |
| `payment` | **`agent.metadata.payment`** ⚠️ | `payment` raíz | JSON canónico |
| `capabilities` | raíz | raíz | conjunto ordenado, canónico |
| `priceUsdc` | raíz | raíz | igualdad estricta (**es dinero**) |
| `name` | raíz | raíz | igualdad estricta |
| `description` | raíz | raíz | ⛔ **EXCLUIDO**: prosa larga, generador de falsos rojos sin valor |
| `outputSchema` | `metadata.outputSchema` | **ausente 0/5** | ⛔ **EXCLUIDO** — ver **D-1** |

> ### ⛔ CD-12 — el `payment` de la RAÍZ de `/discover` es DERIVADO. Comparar ése fabrica deriva en los 5.
> Medido hoy `[M-PROD]`: `agent.payment` (raíz) trae **6 keys**
> `asset+chain+contract+method+network+resolvedChain` en los 5, porque lo produce `readPaymentSpec`
> (`src/services/agent.ts:169`). El manifiesto **no tiene** `resolvedChain` ni `network`.
> **Se compara `agent.metadata.payment`.** Es la misma trampa que T1, un campo más allá. Test T-Z2.

### D-5 · Huellas reales de hoy — los fixtures de la suite salen de acá

Medidas con `sha256(canonicalJson(schema)).slice(0,12)`, la misma función de
`scripts/probe-money-path.mjs:201-212` `[M-PROD]`:

| slug | `metadata.inputSchema` (catálogo) | `manifest.inputSchema` | |
|---|---|---|---|
| `remit-corridor-fx-solana` | `8d8bb152ab46` | `8d8bb152ab46` | OK |
| `remit-kyc-decision` | `290928d46672` | `290928d46672` | OK |
| `remit-cashout-payout-solana` | `ff84b5afd42a` | `ff84b5afd42a` | OK |
| `remit-kyc-session` | `e65060f33f32` | `e65060f33f32` | OK |
| `remit-kyc-validator` | `7d507b7985fa` | `7d507b7985fa` | OK |

Y en la misma corrida: `name` **5/5**, `priceUsdc` **5/5**, `capabilities` **5/5**,
`metadata.payment` vs `manifest.payment` **5/5** `[M-PROD]`.

**Federados**: `GET https://wasiai-v2.vercel.app/api/v1/models/<slug>/manifest` → **404 con cuerpo
HTML** `[SDD]`. Confirma el Scope OUT: los 24 se **excluyen con motivo escrito**, nunca en silencio.

---

## 3. Qué se construye

Un chequeo con **dos mitades independientes**, corriendo como **dos jobs SIN `needs:`** de un
workflow propio programado, con **clases y códigos de salida distintos** y **dos títulos de issue
distintos**, para que el exit code **solo** ya atribuya la causa y para que el verde de una **nunca**
cierre el aviso de la otra.

- **DERIVA** — catálogo vs manifiesto vivo. Datos **públicos**, **cero credenciales**.
- **COMPLETITUD** — la fila está **incompleta**, no desincronizada. Necesita `GET /agents`
  autenticado (`x-a2a-key`, `[M]` `src/middleware/a2a-key.test.ts:344`).

**Lo que la HU NO hace**: corregir filas del catálogo · tocar el camino del dinero
(`agent-split-context.ts`, `compose.ts`, el settle) · el pin del KYC · `src/services/discovery.ts` ·
los 24 federados · ningún método que no sea `GET` · **ni `src/routes/agents.ts`** (tiene citas en el
Corte A y `GET /agents` ya devuelve lo que produce `mapRowToRecord`: el booleano viaja sin editar la ruta).

---

## 4. Scope IN — la lista exhaustiva de archivos a tocar

| # | Archivo | Acción | Presupuesto | Wave |
|---|---|---|---|---|
| 1 | `scripts/check-catalog-vs-live.mjs` | **Crear** | ≤ 380 líneas | W0.3, W1.A |
| 2 | `test/check-catalog-vs-live.test.mjs` | **Crear** | ≤ 480 líneas | W0.4, W1.A6, W2.7, W3.2 |
| 3 | `.github/workflows/check-catalog-vs-live.yml` | **Crear** | ≤ 150 líneas (2 jobs) | W2 |
| 4 | `src/services/agent.ts` | **Modificar** | **≤ 26 líneas** (ver **D-2**) | W1.B |
| 5 | `src/services/agent.completeness.test.ts` | **Crear** | ≤ 90 líneas | W1.B3 |
| 6 | `test/cited-lines-guard.citations.ts` | **Modificar** | ≤ 6 líneas (3 números) | W3.3 |
| 7 | `package.json` | **Modificar** | +2 líneas | W2.5 |
| 8 | `README.md` | **Modificar** | 2 números (`:378`, `:383`) | W3.4 |
| 9 | `README.es.md` | **Modificar** | 2 números (`:412`, `:417`) | W3.4 |
| 10 | `doc/sdd/231-…/auto-blindaje.md` | **Crear** | — (fuera de presupuesto) | W0.1, W3.1 |

⛔ **`.env.example` NO está en la lista** (ver **D-3**). ⛔ **`src/routes/agents.ts` tampoco.**
⛔ **`doc/sdd/_INDEX.md` tampoco**: la fila `231` **ya está pegada** en `_INDEX.md:223` `[M]`.

**Techo total fuera de `doc/`: 1.140 líneas.** Si el diff lo supera **2x (2.280)**, se justifica por
escrito o se recorta (regla 10 de `CLAUDE.md`). El primer candidato a recortar, si hay que recortar:
los 5 campos de D-4 bajan a 2 (`inputSchema` + `payment`), que son los que tocan dinero.

---

## 5. Las 7 clases y la escalera — el contrato del W0

Patrón: `scripts/probe-money-path.mjs:6-10` `[M]` (*el código de salida solo ya atribuye la causa*).

| Clase | exit | Qué AFIRMA | Qué **NO** afirma |
|---|---|---|---|
| `CONFORME` | **0** | Se comparó **≥1** par y todo lo elegible está conforme y completo | Nada sobre los excluidos |
| *(excepción)* | **1** | Defecto del propio chequeo (excepción no manejada) | Nada sobre el catálogo. Reservado, igual que `probe-money-path.mjs:452-463` |
| `INALCANZABLE` | **2** | Un remoto no contestó: `/discover`, `/agents` o el manifiesto de un elegible | ⛔ **NO** dice que el catálogo esté mal |
| `CONFIG` | **3** | **El chequeo no está en condiciones de afirmar nada** | ⛔ **NO implica a producción.** Acusa al instrumento |
| `DERIVA` | **4** | Catálogo ≠ manifiesto en un campo comparable, con slug, campo y **las dos huellas** | **NO** dice que la fila esté incompleta |
| `INCOMPLETA` | **5** | Una fila está **mal nacida**: sin `metadata.inputSchema`, sin `payout_wallet`, o `owner_ref` vacío | **NO** dice que difiera del manifiesto. Puede tener deriva **cero** — ésa es la tesis |
| `UNRESOLVED` | **6** | La unión catálogo↔manifiesto **no se pudo verificar** | ⛔ **NO** es deriva |

**"No pude preguntar" se parte en TRES, porque son preguntas distintas:**
`INALCANZABLE(2)` = *el otro no contestó* · `CONFIG(3)` = *yo no estoy en condiciones de preguntar* ·
`UNRESOLVED(6)` = *contestó, pero no puedo confiar en que sea el agente que creo*.

### La escalera — función **pura**, primera fila que matchea gana

```
 0. catálogo no leído (red / status ≠ 200)                    → INALCANZABLE (2)
 1. CHECK_MODE ausente o no reconocido                        → CONFIG (3)
 2. agentes.length === 0                                      → CONFIG (3)  [catálogo vacío ⇒ instrumento]
 3. elegibles.length === 0                                    → CONFIG (3)  [AC-5]
 4. modo=completitud && credencial ausente                    → CONFIG (3)  [nombra A2A_CATALOG_OWNER_KEY]
 5. modo=deriva && elegiblesConSchemaEnMetadata === 0         → CONFIG (3)  [AC-7 · el cero uniforme]
 6. modo=completitud && sinDato === elegibles.length          → CONFIG (3)  [no pude preguntar por NINGUNO]
 7. comparados === 0                                          → CONFIG (3)  [AC-4 · anti-vacuidad]
 8. inalcanzables > 0                                         → INALCANZABLE (2)
 9. unresolved > 0                                            → UNRESOLVED (6)  [AC-6]
10. incompletas > 0                                           → INCOMPLETA (5)  [AC-3 · va ANTES de deriva]
11. derivas > 0                                               → DERIVA (4)
12. sinDato > 0                                               → CONFIG (3)  [parcial: no se afirma lo no medido]
13. comparados > 0 && todo conforme                           → CONFORME (0)
14. default                                                   → INALCANZABLE (2)  ⛔ JAMÁS CONFORME
```

**Por qué 10 antes que 11**: AC-3 dice que una fila incompleta **no** se reporta como conforme; si
coexisten manda la que cuesta dinero. **Y el orden no esconde nada**: la línea de salida lleva
**siempre** los seis contadores, así que el exit atribuye y la línea enumera.

**De dónde sale `sinDato`** (el SDD lo cuenta pero nunca dice su origen): en modo `completitud` se
cruzan los elegibles de `GET /discover` contra lo que devuelve `GET /agents`. **Un elegible que el
`GET /agents` no devuelve —porque la key es de otro owner— es `sinDato`, NUNCA "completo".**
"No lo pude medir" **no es** "está bien" (CD-10).

### Formato de salida — UNA línea de clase, como `probe-money-path.mjs:443-450` `[M]`

```
<CLASE>: <mensaje que atribuye> | modo=<deriva|completitud> catalogo=<n> elegibles=<n>
  comparados=<n> derivas=<n> incompletas=<n> unresolved=<n> inalcanzables=<n>
  sindato=<n> excluidos=<n> outputSchemaPresente=<n>/<n> durationMs=<n>
```
Más una segunda línea `EXCLUIDOS: <slug>=<motivo>; …` (AC-5 · CD-10) y, cuando hay hallazgos, una
línea `HALLAZGO:` por agente con slug, campo y **las dos huellas** (AC-1).
⛔ **Nunca el valor de una wallet ni de una credencial. El repo es PÚBLICO** (CD-5).

---

## 6. Waves de implementación

### W0 — Serial gate. Nada empieza sin esto.

| # | Tarea | Archivos | Terminado cuando |
|---|---|---|---|
| **W0.1** | Rama `feat/231-…` desde `main` @ `a58ab2b`. Correr el gate **completo y en orden** y anotar la línea base en `auto-blindaje.md` | — | Coincide con §0. **Si no coincide, PARAR** y avisar |
| **W0.2** | Crear un **subdirectorio propio** del scratchpad para los backups de mutación (CD-20) | — | El directorio existe y es exclusivo de esta HU |
| **W0.3** | **El contrato puro**: constantes (`BASE_URL`, `SELF_PUBLISHED`, `MANIFEST_SUFFIX`), las 7 clases con sus exit codes, `verdict()`, `canonicalJson`/`schemaFingerprint`, `deriveManifestUrl()`, `readCredential()`, `classify()` con la escalera de §5. **Cero red** | `scripts/check-catalog-vs-live.mjs` | Ninguna función de W0.3 llama a `fetch` |
| **W0.4** | La suite de la escalera: **fila por fila**, mensajes distinguibles, default ≠ `CONFORME` | `test/check-catalog-vs-live.test.mjs` | Los 15 casos pasan; T-E1..T-E3 verdes |

**Exemplar de W0.3** — `scripts/probe-money-path.mjs` `[M], 463 líneas`:
- encabezado que **declara las clases**: `:6-10`
- `schemaFingerprint` + `canonicalJson`: `:201-212` — **se copian tal cual**
- escalera pura con default que **no** es la clase buena: `:343-345`
  (*"la única clase que jamás debe alcanzarse por omisión no puede ser la que dice que todo anda"*)
- `⛔ Nunca imprime la credencial, ni entera ni truncada: el repo es PÚBLICO`: `:19`

⛔ **`CHECK_MODE` ausente o no reconocido ⇒ `CONFIG(3)`**, nunca un default que corra "algo"
(fila 1, test T-E2).

**Exemplar de W0.4** — `test/probe-money-path.test.mjs` `[M], 581 líneas`:
- `sinComentarios(yaml)` (`:42-47`) y `sinComentariosJs(src)` (`:55-59`) — para que el guardián mire
  **CÓDIGO y no PROSA**. ⚠️ Existen por un **falso positivo real**: un guardián que escanea la
  explicación del archivo se denuncia a sí mismo. **Se copian.**
- `SCRIPT_CODE = sinComentariosJs(SCRIPT_SRC)` (`:62`) — es sobre esto que corren los tests de fuente
- fixture literal del schema real: `:65`

---

### W1 — Paralelizable: dos carriles independientes

#### Carril A — la red y el comparador (depende de W0.3)

| # | Tarea | Terminado cuando |
|---|---|---|
| **W1.A1** | `request()` con timeout + retry **sólo** en errores de conexión. Exemplar: `probe-money-path.mjs:350-375` (`isRetryable` en `:351`, `request` en `:357`) `[M]` | Un timeout no se reintenta salvo donde es idempotente |
| **W1.A2** | `derivarUniverso(agents)` → `{elegibles, excluidos:[{slug,motivo}]}` por **`registry === 'self-published'`** | Los 24 federados salen en `excluidos` **con motivo no vacío** (T-U1) |
| **W1.A3** | `compararAgente(fila, manifiesto)` → los 5 campos de **D-4**, con **T1** y **CD-12** | Los 5 campos producen deriva **cada uno por separado** (T-D2) |
| **W1.A4** | `evaluarCompletitud(fila, record?)` → `metadata.inputSchema`, `payout_wallet` (vía `hasPayoutWallet`), `owner_ref` no vacío. **`outputSchema` sólo se CUENTA** (D-1) | T-C1..T-C5 verdes |
| **W1.A5** | `main(env)` **exportada** que **DEVUELVE** el exit code; `emit()` de una línea; auto-run **sólo si se invoca directo**. Exemplar: `probe-money-path.mjs:379`, `:443-450`, `:452-463` `[M]` | Importar el script desde el test **no** dispara la corrida |
| **W1.A6** | Tests de W1.A con `fetch` doblado (**cero red**) + fixtures literales **fechados 2026-08-27**. Exemplar: `test/probe-money-path.test.mjs:326` `[M]` | Ningún test abre un socket |

**W1.A3 · la unión se VERIFICA — el orden es normativo (AC-6):**
1. Si el `invokeUrl` **no termina en `/invoke`** ⇒ **`UNRESOLVED(6)`** con motivo.
   ⛔ **No se adivina otra forma de URL.**
2. La URL del manifiesto = ese `invokeUrl` con el sufijo `/invoke` reemplazado por `/manifest`.
3. Si el manifiesto **no contesta 200** o no es JSON ⇒ **`INALCANZABLE(2)`** para ese agente.
4. Si `manifest.slug !== catalogo.slug` ⇒ **`UNRESOLVED(6)`** y ⛔ **NO se comparan los schemas**.

Medido: los 5 pasan los 4 pasos, **incluidos los 2 con `pathSlug ≠ slug`** `[M-PROD]`.

#### Carril B — el booleano `hasPayoutWallet` (independiente de A)

| # | Tarea | Archivo | Terminado cuando |
|---|---|---|---|
| **W1.B0** | Agregar `payout_wallet: string \| null;` a `AgentRow` (`:54-65`) — **una línea** (ver **D-2**) | `src/services/agent.ts` | `tsc` exit 0 |
| **W1.B1** | `hasPayoutWallet: boolean` en `PublishedAgentRecord` (`:71-90`, va cerca de `:88`), con docblock que declara **quién lo lee** y **por qué no viola CD-5**. ⛔ **CERO tokens `:<dígito>`** (CD-22) | idem | El docblock no contiene ningún `:` seguido de dígito |
| **W1.B2** | Asignarlo en `mapRowToRecord` (`:174-198`, junto a las asignaciones condicionales de `:190-196`): `row.payout_wallet !== null && row.payout_wallet.trim() !== ''`. ⛔ **NO tocar `mapRowToAgent`** | idem | El campo es siempre `boolean`, nunca `undefined` |
| **W1.B3** | **Corregir el comentario de `getSplitContextRow`** (`:361-365`), hoy falso tras W1.B0 (ver **D-2** paso 2). ⛔ Sin tokens `:<dígito>` | idem | El comentario describe el estado real |
| **W1.B4** | Tests **T-B1** y **T-B2** | `src/services/agent.completeness.test.ts` | Los dos verdes |
| **W1.B5** | `npm run lint` **inmediatamente** después de W1.B | — | `Checked 520 files … No fixes applied.` exit 0 |

**Exemplar de W1.B2** — la asignación condicional que ya existe tres veces en `mapRowToRecord`
(`:190`, `:191`, `:196` `[M]`), obligatoria por `exactOptionalPropertyTypes`.
⚠️ `hasPayoutWallet` es **distinto**: es **siempre presente** (`boolean`, no opcional), así que va
**dentro** del objeto literal `record`, no en un `if`.

**Exemplar de W1.B4** — `src/services/agent.payment.test.ts` `[M], 815 líneas`. La convención de
nombres está medida: `agent.enabled.test.ts`, `agent.ownership.test.ts`, `agent.payment.test.ts`,
`agent.pricing.test.ts`, `agent.trial-anchors.test.ts` `[M]` ⇒ **`agent.completeness.test.ts` encaja.**

⚠️ **CD-18**: `npm run lint` es `biome check src/` y `biome.json:9` es `["src/**/*.ts"]` `[M]` ⇒
los **únicos** archivos de esta HU que biome mira son `src/services/agent.ts` y
`src/services/agent.completeness.test.ts`. **`scripts/` y `test/` NO se lintean.** El lint es el
**segundo** eslabón del gate y es el que sorprende.
⛔ **CD-14**: `npx biome` **NO corre acá**. Es `./node_modules/.bin/biome` o `npm run lint`.

---

### W2 — El workflow (depende de W1.A5)

| # | Tarea | Archivo | Terminado cuando |
|---|---|---|---|
| **W2.1** | Los **2 jobs SIN `needs:`**, `permissions: {contents: read, issues: write}`, `cron: '23 6 * * *'`, `workflow_dispatch`, `pull_request` acotado con `paths:` a los **3 archivos del chequeo** | `.github/workflows/check-catalog-vs-live.yml` | T-Y1 verde |
| **W2.2** | Job `deriva`: **cero secretos**; `continue-on-error: ${{ github.event_name == 'pull_request' }}` | idem | El job no menciona ningún `secrets.` salvo `GITHUB_TOKEN` |
| **W2.3** | Job `completitud`: `if: github.event_name != 'pull_request'`; `A2A_CATALOG_OWNER_KEY` **exactamente una vez** | idem | T-Y5 y T-Y6 verdes |
| **W2.4** | Abrir/comentar/cerrar por **título exacto**, **dos títulos distintos entre sí**, pegando la línea de clase vía **`env:`** | idem | T-Y2 y T-Y4 verdes |
| **W2.5** | Los 2 npm scripts, **al final** del bloque (después de `probe:money-path`) | `package.json` | T-S4 verde |
| **W2.6** | Docblock del workflow: qué mide cada job, por qué no hay `needs:`, y **`TD-370-KEY-SOLO-LECTURA`** | idem | La TD está escrita en el YAML, no en un backlog aparte |
| **W2.7** | Afirmaciones sobre el **YAML real** (T-Y1..T-Y6) | `test/check-catalog-vs-live.test.mjs` | Los 6 verdes |

**Exemplar del aviso** — `.github/workflows/probe-money-path.yml` `[M], 178 líneas`, verificado línea a línea:
- `permissions` con el motivo escrito: `:53-56` (*"Declarar el bloque RESTRINGE al listado, así que
  `contents: read` tiene que estar o el checkout se queda sin permiso"*)
- captura de la corrida + `grep` de la línea de clase a `$GITHUB_OUTPUT`: `:87-97`
- `continue-on-error: ${{ github.event_name == 'pull_request' }}`: `:98`
- ⚠️ **la advertencia que importa**, `:75-79`: *"GitHub le niega el secret a los PRs **desde un fork**
  y se lo entrega **ENTERO** a un PR de una rama de este mismo repo"* ⇒ **por eso** el job
  `completitud` lleva `if: github.event_name != 'pull_request'`
- el título viaja por `env:`: `TITULO` en **`:116`** (abrir) y en **`:165`** (cerrar), **idénticos**
- la línea de clase viaja por `env:`, **nunca interpolada dentro del `run:`**: `LINEA` en `:117`
- el fallo de `gh issue list` **no se traga el aviso**: `:148-151`
- ⛔ Sin `--label`: `gh issue create --label` **falla si la etiqueta no existe** y eso convierte el
  aviso en un segundo fallo silencioso (`:141-142`)

**Exemplar estructural secret-free** — `.github/workflows/smoke-downstream.yml` `[M], 94 líneas`:
`permissions` en `:17-19`; abrir por título exacto en `:52-79`; **cerrar en verde** en `:81-94`,
con el motivo escrito en `:81-82`.

> ### ⛔ CD-6 (extendido) — CUATRO títulos, los CUATRO distintos
> Los dos existentes, leídos hoy `[M]`:
> - `probe-money-path.yml:116` y `:165` → `'probe-money-path: la corrida por reloj esta fallando'`
> - `smoke-downstream.yml:56` y `:87` → `'smoke-downstream: la corrida por reloj esta fallando'`
>
> Los dos nuevos deben ser distintos de esos **y entre sí**, o **el verde de la deriva cierra el
> aviso de la completitud** — la misma trampa, un nivel adentro. T-Y4 los lee de los archivos reales.

**Cadencia `'23 6 * * *'`** — diaria, **minuto no redondo** (el planificador de GitHub encola
masivamente en el minuto 0; razón escrita en `probe-money-path.yml:31-33` `[M]`), y **distinta** de
las dos existentes (`'0 7 * * *'` y `'7 * * * *'`) para no competir por runner.
**Costo: 0 USDC** — sólo `GET`, y el inventario **congelado** de rutas que cobran no tiene **ningún**
`GET` ni `HEAD` (`src/routes/charged-routes.meta.test.ts:280-291`, y el `toEqual([])` que lo fija
está en **`:296-300`** `[M]` — el SDD decía `:299`, que es el `),`).

> ### ⛔ CD-14 — los npm scripts: al FINAL, y que NO empiecen por `test`
> 1. `package.json` **línea 11** es `"lint": "biome check src/",` `[M]`, y hay un test que la clava:
>    `test/probe-money-path.test.mjs:511` `[M]` hace `expect(pkgSrc.split('\n')[10]).toContain('biome check src/')`.
>    ⇒ **PROHIBIDO insertar por encima de la línea 11.** Los 2 scripts van al final del bloque.
> 2. ⛔ **Ningún nombre puede empezar por `test`.** `test/test-files-are-run-in-ci.test.ts:28-39` `[M]`
>    descubre runners quedándose con los steps que corren `npm test` / `npm run test…`
>    **SIN `if:` ni `continue-on-error:`** — y con cualquiera de los dos el step se vuelve
>    `untranslatable` y **el guardián se pone ROJO**. Los steps nuevos llevan los dos.
>    Con nombres tipo `check:catalog:deriva` / `check:catalog:completitud`, el descubridor los ignora.
>    El exemplar ya lo afirma: `test/probe-money-path.test.mjs:510` `[M]`:
>    `expect('probe:money-path').not.toMatch(/^test/)`.

---

### W3 — Falsabilidad y arrastre (depende de W0..W2)

| # | Tarea | Archivo | Terminado cuando |
|---|---|---|---|
| **W3.1** | **AC-10**: romper a propósito la mitad de **deriva** y la de **completitud**, **una mutación por vez**, y anotar el rojo **literal, con su MOTIVO** y con el commit del árbol en que se midió | `doc/sdd/231-…/auto-blindaje.md` | Las 2 mutaciones documentadas con su salida textual |
| **W3.2** | **Controles positivos** de cada rojo: que el chequeo **efectivamente ejecutó** (`comparados > 0` en la línea emitida) | `test/check-catalog-vs-live.test.mjs` | T-V2 verde |
| **W3.3** | **CD-13**: corregir a mano los **3** números de `citations.ts` (`:229` `399`, `:616` `808`, `:627` `822`), **abriendo cada línea nueva**. ⚠️ El de `:229` está escrito **sin prefijo `src/`** | `test/cited-lines-guard.citations.ts` | `npm test` verde en `cited-lines-guard` |
| **W3.4** | `git add -A` **ANTES** del gate, y recién ahí actualizar los **4** números de los README (§7) | `README.md`, `README.es.md` | `readme-numbers` verde |

> ### ⛔ CD-20 — cómo se restaura una mutación
> Copia previa con `cp` a un **subdirectorio propio** del scratchpad (que es **compartido**), y
> restaurar con `cp`. ⛔ **NUNCA `git checkout --`**: la HU 230 perdió con eso justamente lo que
> medía. Y ⛔ **`diff` bajo el hook contestó "✅ Files are identical" sobre archivos que difieren**:
> usá **`/usr/bin/diff`**. Los demás mienten por omisión; ése **afirma una equivalencia falsa**.

> ### ⛔ CD-19 — herramientas, con ruta absoluta al binario
> `/usr/bin/grep -rn` (el `Grep` del agente respeta `.gitignore` y da **CERO falso**) ·
> `/usr/bin/diff` · `/usr/bin/git diff` (bajo el hook **TRUNCA cortando hunks**) ·
> `/usr/bin/sed -n` · ⛔ **nunca `cat`** (devolvió 69 líneas de un archivo de 79).

> ### ⚠️ Citas colaterales que esta HU DESPLAZA y que ningún guardián mira — **medido `[M]`, NO se arreglan**
> `CORTE_A_PATHS` son 14 paths; fuera de ellos las citas se pudren en silencio. La inserción de
> W1.B corre estas dos, y **arreglarlas violaría CD-9** (`discovery.ts` está en Scope OUT):
> - `src/services/discovery.ts:255` cita `services/agent.ts:429-440`
> - `src/services/orchestrate.ts:1160` cita `services/agent.ts:526`
>
> Y una que **ya estaba podrida antes de esta HU** (no la causa el Dev, se declara para que el CR no
> la impute): `src/services/agent.ownership.test.ts:6` cita `src/services/agent.ts:549` como
> `listMine`, y `listMine` hoy vive en **`:598`** `[M]`. Ese archivo **no** está en `CORTE_A_PATHS`.
>
> ⇒ **Se anotan en `auto-blindaje.md` como `TD-370-CITAS-FUERA-DEL-CORTE`. NO se tocan.**

---

### W4 — Cierre (serial)

| # | Tarea |
|---|---|
| **W4.1** | `git add -A` — ⛔ **ANTES** del gate |
| **W4.2** | `npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test`, **los tres, en ese orden, una vez** |
| **W4.3** | Contrastar contra §0 y contra §7 |

> ### ⛔ `git add -A` ANTES del gate — y el motivo, medido
> `test/readme-numbers.test.ts:82-90` `[M]` enumera con **`git ls-files -z`**, o sea **contra el
> ÍNDICE, no contra el disco**. El docblock lo dice: *"Contra git y no contra el disco por dos
> razones medidas: es lo que un `checkout` trae … y Biome tiene `vcs.useIgnoreFile: true`"*.
> Con los archivos nuevos **untracked, el guardián no los ve y DA VERDE EN FALSO**. Pasó exactamente
> así en WKH-369.
> Lo mismo `test/scripts-imported-by-tests-are-tracked.test.ts:48` `[M]`
> (`/['"](?:\.\.\/)+(scripts\/[^'"]+\.mjs)['"]/g`): **descubre el literal `'../scripts/…​.mjs'` del
> import y exige que ese archivo esté trackeado.** ⇒ el test **debe** importar el script con un path
> que empiece por `../`, y el `.mjs` **debe** estar en el índice.

---

## 7. Los números que cambian — derivados corriendo el guardián, NUNCA a mano

| Número | Sitio | Base `[M]` | Esperado | De dónde sale |
|---|---|---|---|---|
| Archivos de test | `README.md:378` (`**318 test files**`) | **318** | **320** | `include` de `vitest.config.ts:5` (`src/**/*.test.ts`, `test/**/*.test.ts`, `test/**/*.test.mjs`) sobre el índice de git. Suman `test/check-catalog-vs-live.test.mjs` **+1** y `src/services/agent.completeness.test.ts` **+1** |
| ídem, español | `README.es.md:412` (`**318 archivos de test**`) | **318** | **320** | idem |
| Archivos que linta Biome | `README.md:383` (`over **519 files**`) | **519** | **520** | `files.includes` de `biome.json:9` = `["src/**/*.ts"]`. Suma **sólo** `src/services/agent.completeness.test.ts` |
| ídem, español | `README.es.md:417` (`sobre **519 archivos**`) | **519** | **520** | idem |

⚠️ **`scripts/check-catalog-vs-live.mjs` no suma a ninguno de los dos**: `scripts/` no está en los
globs de vitest ni en los de biome `[M]`.
⚠️ **El número de variables de `.env.example` NO cambia** (sigue en **193**, `README.md:351` y
`README.es.md:385`) **porque D-3 dice que no se toca `.env.example`**. Si el Dev lo toca igual,
**tiene que actualizar esos dos números también** o `npm test` se pone rojo.
⛔ **Los 4 números se DERIVAN corriendo el guardián** (`npm test -- readme-numbers`), no se escriben
de memoria. Y se escriben **después** del `git add -A`.

**Cobertura (fuera del gate, pero mirala):** el job `coverage` de `.github/workflows/ci.yml:85-105`
`[M]` corre `npm run test:coverage` con pisos `statements 80 / branches 70 / functions 80 / lines 80`
(`vitest.config.ts:26-31`). `scripts/check-catalog-vs-live.mjs` **entra a la medición** porque el
test lo importa. Con la suite de §8 debería sobrar (la medición del 2026-08-15 estaba 7,5-12,5 puntos
por encima), pero **si W1.A deja ramas sin ejercitar, ese job se pone rojo aunque el gate esté verde**.

---

## 8. Tests requeridos — cada uno con su MUTANTE y el rojo esperado

⚠️ **Ningún test de esta HU abre un socket ni gasta un centavo.** Funciones puras importadas;
`main()` con `fetch` doblado; afirmaciones sobre los archivos reales del repo.
Patrón: `test/probe-money-path.test.mjs:1-15` `[M]`.

| ID | AC / CD | Qué cubre | Archivo | **Mutante** → rojo esperado |
|---|---|---|---|---|
| **T-D1** | AC-1 | Huellas distintas en `inputSchema` → **`DERIVA(4)`** nombrando slug, campo y **las dos** huellas | `test/check-catalog-vs-live.test.mjs` | Devolver la huella del catálogo en las dos ⇒ **`CONFORME(0)`** falso |
| **T-D2** | AC-1 · D-4 | Los **5** campos comparables producen deriva **cada uno por separado** (5 casos) | idem | Sacar un campo del comparador ⇒ ese caso pasa a `CONFORME` |
| **T-D3** | AC-1 · **CD-21** | El fixture positivo tiene `inputSchema` **con contenido real** (el de `remit-corridor-fx-solana`, huella `8d8bb152ab46`): un comparador que **no compara nada** no lo satisface | idem | Vaciar el fixture ⇒ el test **pasa con el bug puesto** |
| **T-C1** | AC-2 | Completitud y deriva son **independientes**: el mismo agente conforme en deriva puede salir `INCOMPLETA` | `idem` | Encadenar las dos mitades ⇒ la incompleta se reporta conforme |
| **T-C2** | **AC-3 (LA TESIS)** | Fila con `hasPayoutWallet: false` y deriva **CERO** → **`INCOMPLETA(5)`**, ⛔ jamás `CONFORME(0)` | idem | Poner la fila 10 **después** de la 13 en la escalera ⇒ sale `CONFORME` |
| **T-C3** | AC-3 | Fila con `metadata` vacío (sin `inputSchema`) → `INCOMPLETA` **aunque no haya nada que comparar** | idem | idem |
| **T-C4** | **CD-17** | `owner_ref: '   '` → `INCOMPLETA`; y el docblock **declara** que `owner_ref: null` es imposible por tipo | idem | — (el test documenta un límite; **no lo esconde**) |
| **T-C5** | **D-1** | Fixture sin `outputSchema` en catálogo **y** en manifiesto, con todo lo demás bien → **`CONFORME(0)`**, y `outputSchemaPresente` lo **cuenta** | idem | Meter `outputSchema` en la escalera ⇒ el chequeo **nace rojo** por un criterio sin fuente |
| **T-V1** | **AC-4** | `comparados === 0` con todo lo demás conforme → **`CONFIG(3)`**, ⛔ nunca 0 | idem | Sacar la fila 7 ⇒ un chequeo **que no ejecutó nada sale verde** |
| **T-V2** | AC-4 · CD-7 | **Control positivo**: en el caso feliz la línea emitida lleva `comparados > 0` | idem | — (sin este control, un rojo no prueba que el chequeo corrió) |
| **T-U1** | **AC-5** | Los 24 federados salen en `EXCLUIDOS:` **con motivo no vacío, uno por uno** | idem | Filtrar sin registrar ⇒ **exclusión silenciosa** |
| **T-U2** | AC-5 · CD-3 | `elegibles === 0` → **`CONFIG(3)`**, ⛔ nunca `CONFORME` | idem | Sacar la fila 3 |
| **T-J1** | **AC-6** | `manifest.slug !== catalogo.slug` → **`UNRESOLVED(6)`** y ⛔ **no se comparan los schemas** | idem | Ignorar la autodeclaración ⇒ **compara el agente equivocado** |
| **T-J2** | AC-6 · **T2** | Los 2 casos reales `pathSlug ≠ slug` resuelven bien; un `invokeUrl` que no termina en `/invoke` → `UNRESOLVED`, **no** una URL adivinada | idem | Asumir `slug == pathSlug` ⇒ **404 leído como deriva** |
| **T-Z1** | **AC-7 · T1** | Fixture con los 5 publicando `inputSchema` **en la raíz** y **nada** en `metadata` → **`CONFIG(3)`**, ⛔ **NO** "5 derivas" | idem | Mirar la raíz de `/discover` ⇒ *"0 de 29 publican schema"*, **falso** |
| **T-Z2** | **CD-12** | Fixture con `payment` de raíz que trae `resolvedChain`+`network`, y `metadata.payment` igual al manifiesto → **`CONFORME`** | idem | Comparar `agent.payment` en vez de `agent.metadata.payment` ⇒ **deriva fabricada en los 5** |
| **T-E1** | **AC-8** | Las 7 clases tienen exit codes **distintos** y **ningún mensaje usa la palabra clave de otra clase**. Patrón: `test/probe-money-path.test.mjs:283` `[M]` | idem | Reusar un código ⇒ **el exit deja de atribuir** |
| **T-E2** | AC-8 | `CHECK_MODE` ausente / basura → **`CONFIG(3)`**. El default **nunca** corre "algo" | idem | Poner un default ⇒ **un typo mide otra cosa en silencio** |
| **T-E3** | AC-8 | El **default de la escalera** (fila 14) **no** es `CONFORME` | idem | Cambiar la fila 14 a `CONFORME` |
| **T-E4** | AC-8 · CD-15 | Modo completitud sin credencial → `CONFIG(3)` **nombrando `A2A_CATALOG_OWNER_KEY`**; y `sinDato > 0` parcial → `CONFIG(3)`, ⛔ nunca 0 | idem | Sacar la fila 12 ⇒ **se afirma conforme lo que no se midió** |
| **T-Y1** | **AC-9** | El YAML tiene **2 jobs** y **ningún `needs:`** entre ellos (sobre el YAML **sin comentarios**) | idem | Agregar `needs:` ⇒ **un fallo de completitud apaga la deriva** |
| **T-Y2** | AC-9 | Cada job tiene su par abrir/cerrar con el **mismo** título dentro del par | idem | Cambiar uno ⇒ **el aviso nunca se cierra** |
| **T-Y3** | AC-9 | Ningún `if:` de un job depende del otro job | idem | — |
| **T-Y4** | **CD-6** | Los **4** títulos del repo (2 nuevos + `probe-money-path.yml:116` + `smoke-downstream.yml:56`) son **los 4 distintos**, leídos de los archivos reales | idem | Reusar un título ⇒ **un chequeo cierra el aviso del otro** |
| **T-Y5** | DT-3 mit.1 | `A2A_CATALOG_OWNER_KEY` aparece **exactamente UNA vez** en el YAML, y en el step del job `completitud` | idem | Filtrarlo al job `deriva` ⇒ **la credencial viaja de más** |
| **T-Y6** | DT-3 mit.2 | El job `completitud` lleva `if: github.event_name != 'pull_request'` | idem | Sacarlo ⇒ **la credencial llega a corridas de PR de este mismo repo** |
| **T-S1** | **CD-11** | El fuente **sin comentarios** no contiene `POST`/`PATCH`/`DELETE`/`/compose`, y todo `method:` es `GET` | idem | Un método que muta ⇒ **el vigilante deja de observar** |
| **T-S2** | **CD-5** | La función que emite **no menciona** ninguna variable de credencial ni de wallet. Patrón: `test/probe-money-path.test.mjs:514-529` `[M]` | idem | Loguear el row entero ⇒ **el valor llega a un issue público** |
| **T-S3** | **T3** | El fuente no construye **ninguna** URL `/discover/<slug>`: sólo la lista | idem | Iterar el detalle ⇒ **429 y hasta 201 queries por request** |
| **T-S4** | **CD-14** | Los nombres de los npm scripts **no empiezan por `test`**, y `package.json` línea 11 **sigue siendo** `"lint": "biome check src/"` | idem | Insertar arriba ⇒ **rompe el test del exemplar** |
| **T-S5** | **CD-22** | El fuente de `src/services/agent.ts`, **en las líneas que esta HU agrega o edita**, no contiene ningún token `:<dígito>` | `src/services/agent.completeness.test.ts` | Citar una línea en el docblock ⇒ **`cited-lines-guard` rojo por una cita no declarada** |
| **T-B1** | AC-2 · W1.B | `hasPayoutWallet` es `false` con `null` **y** con `'   '`; `true` con valor | idem | Usar `!!row.payout_wallet` ⇒ **`'   '` cuenta como completa** |
| **T-B2** | **CD-9 / CD-5** | **Control negativo**: el objeto que produce `mapRowToAgent` (el de `/discover`) **NO** contiene `hasPayoutWallet` ni `payout_wallet`. La HU **no** agrega superficie pública anónima | idem | Ponerlo en el mapper equivocado ⇒ **se publica a todo el mundo** |

**Total: 33 tests.** Cobertura por AC:
AC-1 → T-D1..T-D3 · AC-2 → T-C1, T-C4, T-B1 · **AC-3 → T-C2, T-C3** · AC-4 → T-V1, T-V2 ·
AC-5 → T-U1, T-U2 · AC-6 → T-J1, T-J2 · AC-7 → T-Z1 · AC-8 → T-E1..T-E4 · AC-9 → T-Y1..T-Y3 ·
**AC-10 → la columna "Mutante" entera + W3.1/W3.2**.

> ### ⛔ CD-21 — PROHIBIDO un fixture que pase con el bug puesto
> CD-1 de WKH-369 fue exactamente eso: un fixture con capacidades vacías que daba verde **con el
> defecto presente**. Acá el equivalente exacto es **un fixture de manifiesto sin `inputSchema`**:
> haría pasar tanto al comparador correcto **como a uno que no compara nada**.
> **Todo fixture positivo lleva contenido que SÓLO un comparador que funciona puede satisfacer** (T-D3).

---

## 9. Constraint Directives — la lista completa y vigente

**Heredados del work-item y del SDD (no se negocian):**

- **CD-1** ⛔ PROHIBIDO buscar `inputSchema` en la raíz de `/discover`. Vive en `metadata.inputSchema`.
  Re-medido hoy: **5 en `metadata`, 0 en la raíz** `[M-PROD]`. Cero uniforme ⇒ **`CONFIG`, nunca deriva**.
- **CD-2** ⛔ PROHIBIDO asumir `slug == pathSlug`. **Falso en 2 de 5, medido.** La unión se **verifica**.
- **CD-3** ⛔ PROHIBIDO tratar a los 29 por igual. El universo es `registry === 'self-published'`.
- **CD-4** ⛔ PROHIBIDO meter esto en `npm test` / `ci.yml` (`ci.yml:4-6`: *"Runs WITHOUT secrets or a
  live database"* `[M]`).
- **CD-5** ⛔ PROHIBIDO imprimir el valor de `payout_wallet`, `owner_ref` o cualquier credencial.
  **El repo es PÚBLICO.** Presencia/ausencia, nunca el valor.
- **CD-6** ⛔ Cuatro títulos de issue, los cuatro distintos (ver W2).
- **CD-7** ⛔ PROHIBIDO que el guard se lea a sí mismo, y prohibido un chequeo que sólo verifique una
  AUSENCIA sin control positivo. **Todo rojo se confirma por su MOTIVO.**
- **CD-8** ⛔ PROHIBIDO iterar `GET /discover/<slug>`. Se lee la **lista**, una vez por job.
- **CD-9** ⛔ PROHIBIDO tocar `src/services/discovery.ts`, el camino del dinero y el pin del KYC.
  **El único `src/` de esta HU es `src/services/agent.ts` + su test nuevo.**
- **CD-10** ⛔ PROHIBIDO excluir un agente en silencio. *"No lo pude medir"* **no es** *"está bien"*.
- **CD-11** ⛔ Este chequeo **OBSERVA**. Sólo `GET`. Ningún `POST`/`PATCH`/`DELETE`, ningún `/compose`.
- **CD-12** ⛔ PROHIBIDO comparar el `payment` de **raíz** de `/discover` (ver D-4).
- **CD-13** ⛔ PROHIBIDO cerrar la HU sin corregir a mano las **3** citas de `citations.ts` (W3.3).
- **CD-14** ⛔ npm scripts al final, y ninguno empieza por `test` (ver W2). Biome se invoca con
  `./node_modules/.bin/biome`; **`npx biome` NO corre acá**.
- **CD-15** ⛔ PROHIBIDO afirmar que la completitud está verificada cuando el secreto falta.
  **Un "sin dato" NUNCA sale por exit 0.**
- **CD-16** ⛔ PROHIBIDO hardcodear 29 / 24 / 5. Se **derivan** en cada corrida.
- **CD-17** ⛔ PROHIBIDO tratar la comprobación de `owner_ref` como protección real sin declarar que
  es **casi vacua** (ver T5).
- **CD-18** ⛔ `lint` es el **SEGUNDO** eslabón del gate y es el que sorprende (ver W1.B5).
- **CD-19** ⛔ Herramientas con ruta absoluta al binario (ver W3).
- **CD-20** ⛔ Las mutaciones se restauran con `cp` desde un backup previo, en subdirectorio propio.
  **NUNCA `git checkout --`.**
- **CD-21** ⛔ Ningún fixture que pase con el bug puesto (ver §8).

**Nuevos de esta F2.5, del árbol real:**

- **CD-22** ⛔ **Cero tokens `:<dígito>` en todo comentario nuevo o editado de `src/services/agent.ts`**
  (ver §1.3(b)). Test T-S5.
- **CD-23** ⛔ **PROHIBIDO dejar el comentario de `getSplitContextRow` como está** después de ampliar
  `AgentRow`: hoy afirma que `payout_wallet` *"JAMÁS entra a `AgentRow`"*, y tras W1.B0 eso es
  **falso**. Corregirlo es parte de la wave, no un apéndice (ver D-2).
- **CD-24** ⛔ **PROHIBIDO tocar `.env.example`** (ver D-3). Si se toca igual, hay **dos números más**
  de README que actualizar (`README.md:351`, `README.es.md:385`).

---

## 10. Anti-Hallucination Checklist — marcar ANTES de abrir el PR

```
[ ] Todo path que escribí en código existe. Verificado con /usr/bin/ls o /usr/bin/sed -n
[ ] NO usé `cat` ni el Grep del agente para ninguna medición
[ ] `inputSchema` se lee de `metadata.inputSchema` en /discover, de la RAÍZ en el manifiesto
    y de la RAÍZ en /agents. Las tres formas están en el código, no una sola
[ ] `payment` se compara desde `metadata.payment`, NUNCA desde la raíz de /discover
[ ] La unión slug↔manifiesto se VERIFICA con `manifest.slug`; no asumí `slug == pathSlug`
[ ] El script NO construye ninguna URL `/discover/<slug>`
[ ] El universo se deriva de `registry === 'self-published'`; no hardcodeé 29/24/5
[ ] `outputSchema` NO está en la escalera; sólo se cuenta (D-1)
[ ] `owner_ref` se chequea por cadena no vacía, y el docblock dice que es casi vacuo
[ ] Ningún método distinto de GET aparece en el fuente sin comentarios
[ ] `A2A_CATALOG_OWNER_KEY` aparece EXACTAMENTE una vez en el YAML, en el job `completitud`
[ ] El job `completitud` lleva `if: github.event_name != 'pull_request'`
[ ] Los 2 jobs NO tienen `needs:` entre ellos
[ ] Los 4 títulos de issue del repo son los 4 distintos
[ ] Agregué `payout_wallet` a `AgentRow` Y corregí el comentario de `getSplitContextRow` (CD-23)
[ ] NO toqué `mapRowToAgent`, y T-B2 lo prueba
[ ] Ningún comentario nuevo de `src/services/agent.ts` contiene un `:` seguido de dígito (CD-22)
[ ] Corregí los 3 números de `citations.ts` ABRIENDO cada línea — incluido el de `:229`,
    que está escrito SIN el prefijo `src/`
[ ] NO toqué `.env.example`, NO toqué `src/routes/agents.ts`, NO toqué `doc/sdd/_INDEX.md`
[ ] `git add -A` corrió ANTES del gate
[ ] Los 4 números de README los DERIVÉ corriendo el guardián, no de memoria
[ ] El gate completo corrió UNA vez, en orden: tsc → lint → test
[ ] `auto-blindaje.md` tiene las 2 mutaciones de AC-10 con su rojo LITERAL y su motivo
[ ] Anoté `TD-370-OUTPUTSCHEMA-SIN-FUENTE`, `TD-370-KEY-SOLO-LECTURA` y
    `TD-370-CITAS-FUERA-DEL-CORTE`
```

---

## 11. Done Definition

La HU está lista para AR cuando **todo** esto es cierto:

1. Los **10 archivos** del Scope IN existen con su cambio, y **ninguno fuera de esa lista** fue tocado.
2. **`npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test`**, los tres, **en ese orden**,
   **después de `git add -A`**, con:
   - `tsc` exit 0
   - `lint`: **`Checked 520 files … No fixes applied.`** exit 0
   - `test`: **320** archivos de test (312+2 pasados que suben a 314 · 6 skipped), **≥ 6.343** casos,
     **0 failed**
3. Los **33 tests** de §8 existen y pasan.
4. `auto-blindaje.md` documenta las **2** mutaciones de AC-10 con la **salida literal del rojo**, su
   **motivo**, su **control positivo** (`comparados > 0`) y el **commit** del árbol en que se midieron.
5. Los **4** números de README están actualizados y **derivados** corriendo `readme-numbers`.
6. Las **3** citas de `citations.ts` apuntan a la línea correcta, verificadas **abriendo cada línea**.
7. Las 3 TD están escritas **en el código/workflow**, no en un backlog aparte.
8. `MI-8` sigue abierto y **no bloquea el merge**: sin el secreto, el job `completitud` sale
   **`CONFIG(3)` nombrándolo** y `deriva` corre igual.

⛔ **El entregable NO es que el chequeo dé verde hoy: es que se ponga ROJO cuando corresponda, y por
el motivo correcto.**

---

## 12. Inconsistencias SDD ↔ árbol real detectadas en esta F2.5

Para el AR, el CR y la QA. Las **siete** se midieron hoy; las resoluciones ya están arriba.

| # | Dónde | Qué dice el SDD | Qué mide el árbol `[M]` | Resuelto en |
|---|---|---|---|---|
| **I-1** | §0 / §7 W0.1 | Rama desde `main` @ `a9087e4` | HEAD es **`a58ab2b`** (el propio SDD se commiteó encima). Línea base **idéntica**, re-medida | Encabezado + W0.1 |
| **I-2** 🔴 | W1.B2 | `row.payout_wallet` en `mapRowToRecord` | **`AgentRow` (`:54-65`) NO tipa `payout_wallet` ⇒ NO COMPILA.** Y `agent.ts:361-365` + `doc/sdd/144-…/sdd.md:49` dicen **"NO ampliar esta interfaz"** | **D-2** + W1.B0 + **CD-23** |
| **I-3** 🔴 | DT-4 / CD-13 | El único costo del guardián son las 3 citas desplazadas | El guardián **DERIVA** el universo (`cited-lines-guard.test.ts:28-30`) con `BARE_CITE_RE = /:(\d+)…/g` (`scanner.ts:125`) ⇒ **un `:N` en el docblock nuevo lo pone rojo igual** | **§1.3(b)** + **CD-22** + T-S5 |
| **I-4** | W2.6 / Scope IN | Documentar `A2A_CATALOG_OWNER_KEY` y `CHECK_MODE` en `.env.example` | `A2A_PROBE_KEY` **no está** ahí (sólo `_ID`/`_OWNER_REF`, `:1605`/`:1610`), y `readme-numbers.test.ts:183-185,292` clava **`documents **193 variables**`** en 2 sitios más | **D-3** + **CD-24** |
| **I-5** | §11 R-1 | El chequeo **nace rojo** por 2 filas sin `outputSchema` | `outputSchema` está **ausente en 5/5 manifiestos** ⇒ es un criterio **sin fuente de verdad** | **D-1** — R-1 **cerrado**, el chequeo **no** nace rojo |
| **I-6** | §3.1 | `charged-routes.meta.test.ts:299` fija "ningún GET cobra" | El `.toEqual([])` está en **`:300`**; `:299` es el `),`. Corrimiento de 1 | Citado como `:296-300` en W2 |
| **I-7** | §3.1 | `probe-money-path.mjs:357-374` = `request()` | `request()` va de `:357` a **`:375`**. Corrimiento de 1 (el inicio es exacto) | Citado como `:350-375` en W1.A1 |

**Lo que del SDD se verificó y está EXACTO** (para que el CR no lo vuelva a medir): las 3 citas de
`citations.ts` (`399`/`808`/`822`, entradas `:229`/`:616`/`:627`) · `CORTE_A_PATHS` = 14 paths en
`:87-102` · `package.json` línea 11 · `biome.json:9` · `vitest.config.ts:5,16` ·
`agent.ts:54-65, 71-90, 138-171, 150, 152, 165, 169, 174-198, 176-177, 190-191, 373, 467-468, 712-713, 735-736` ·
`agents.ts:368, 536, 577, 586` · `database.types.ts:53-66, 75` · `types/index.ts:305-306` ·
`discover.ts:325-348` · `verify-rls-enabled.mjs:23-34` (y `a2a_agents` **no** está en `RLS_TABLES`) ·
`ci.yml:4-6, 36-43` · `smoke-downstream.yml:17-19, 22, 56, 81-82, 87` ·
`probe-money-path.yml:31-33, 34-38, 77-79, 100, 116, 117, 148-151, 165` ·
`probe-money-path.mjs:6-10, 19, 201-212, 343-345, 443-450, 452-463` ·
`probe-money-path.test.mjs:283, 326, 510-511, 514-529` · `_INDEX.md:223` ·
y **todas** las mediciones de producción de §3.3/§3.4, incluidas las **5 huellas** `sha256-12`,
reproducidas independientemente hoy.

---

*Story File generado por NexusAgil — F2.5 · `nexus-architect` · 2026-08-27 · árbol `a58ab2b`*
