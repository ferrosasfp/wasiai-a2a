# Story File — [WKH-314] La pata de ENTRADA de pagos en Solana (x402 inbound)

> **PRECONDICIÓN DE ARRANQUE (orden del orquestador): NO se escribe una línea de producción de esta HU
> hasta que `WKH-316` (carpeta `214-wkh-316-escritor-payment-block`) esté **mergeada en `main`**.**
> El orden lo fija el orquestador, no el código. Qué depende de verdad de 316 y qué no está **medido**
> en §0.3 de este documento: la respuesta corta es que **ningún archivo de producción de esta HU lee
> `metadata.payment`**, así que el acoplamiento real es de **orden de merge y un solo archivo de docs**,
> no de compilación ni de runtime.

**Fase**: F2.5 (Story File) · **Gate cumplido**: `SPEC_APPROVED` (2026-08-19, modo AUTO, delegado por Fernando)
**Repo**: `wasiai-a2a` · **Rama**: `feat/212-wkh-314-x402-inbound-solana`
**Base medida**: `main` @ `8242b16`
**Input**: `doc/sdd/212-wkh-314-x402-inbound-solana/sdd.md` (858 líneas) + `work-item.md` (493 líneas, 9 ACs EARS)
**SDD_MODE**: full · **Estimación**: L · **money-path INBOUND** · **devnet-only, sin excepción**

---

## 0. Lo primero que tenés que saber antes de abrir un editor

### 0.1 El SDD se escribió contra `6b391d6`. Hoy `main` es `8242b16`. Son **267 commits** de distancia.

```
git rev-list --count 6b391d6..HEAD   →  267
```

Entre medio se mergearon, como mínimo, **WKH-315** (depósito Solana), **WKH-318 / WKH-318b**
(discover federado), **WKH-319** (dedup de intents) y **WKH-360** (coordinador como agente).
Consecuencia: **la mitad de las citas `archivo:línea` del SDD apuntan a otro lado.** Están
re-medidas en §1.2 de este documento. **Usá las de acá, no las del SDD.**

### 0.2 Tres correcciones MATERIALES al SDD (no cosméticas)

| # | Lo que dice el SDD | Lo medido hoy | Qué cambia |
|---|---|---|---|
| **C-1** | §7: *"`probeSettlementPresence` … las dos HUs lo necesitan. Esta HU es la dueña de promoverlo"* y §7.2: *"WKH-315 lo importa sin tocar el archivo"* | **WKH-315 ya está mergeada y decidió NO consumirlo**, con la razón escrita en el código: `src/adapters/solana/deposit-verifier.ts:25-44` (*"POR QUE NO SE REUSA `probeSettlementPresence`"*), y cierra con *"`payment.ts` queda intacto (es de WKH-314)"* | **W0.2 se descopea**: NO se extrae nada de `payment.ts`, NO se toca `payment.ts`. Ver §5 · DT-C1 |
| **C-2** | DT-2: reusar `SettlementPresence` para decidir el grant | `SettlementPresence.landed_ok` **no implica `finalized`**. Medido y ya documentado por 315: `deposit-verifier.ts:41-43` — *"Lee a `'confirmed'` hardcodeado y su `SettlementPresence` **descarta** `confirmationStatus` (sólo mira `status.err`)"*. Y el probe de 315 (`deposit-verifier.ts:151-152`) sí lee `confirmationStatus` porque su HU es **dinero que ENTRA** | El grant de esta HU **exige finalidad**. Tipo nuevo `SolanaInboundPresence`. Ver §5 · DT-C2 y §11 · NC-1 |
| **C-3** | §6.1: *"Verificado que no hay colisión de timestamp (el máximo actual es `20260730000000`)"* | **`20260731000000` está OCUPADO** por `20260731000000_wkh315_solana_deposit.sql`. El máximo real hoy es `20260804000000` (`wkh318b_registry_max_limit`) | La migración es **`20260819000000_wkh314_solana_inbound_proofs.sql`**. Verificado libre: `ls supabase/migrations \| grep -c 20260819` → `0` |

### 0.3 Qué depende REALMENTE de WKH-316 — medido, no supuesto

El SDD de 316 afirma (`214-…/sdd.md:619`): *"Esta HU bloquea: WKH-314 (x402 inbound Solana necesita el
campo persistido)"*. **Medido contra el árbol, eso es falso a nivel de código:**

- El leg de esta HU es **caller → gateway**. El `payTo` del challenge sale de env, no de ninguna fila:
  `resolvePaymentRequirements` (`src/middleware/x402.ts:294-309`) hace
  `process.env.PAYMENT_WALLET_ADDRESS || process.env.KITE_WALLET_ADDRESS`. Esta HU agrega
  `SOLANA_X402_INBOUND_PAY_TO`, también env.
- `readPaymentSpec` —el lector de `metadata.payment` que 316 alimenta— tiene **exactamente dos
  consumidores de producción**: `src/services/discovery.ts:1380` y `src/services/agent.ts:156`.
  Ninguno de los dos está en el camino de `requirePayment`.
  *Comando que lo falsea si me equivoqué*: `command grep -rn "readPaymentSpec" src/ --include=*.ts | grep -v test`.
- **Intersección de Scope IN entre las dos HUs: UN archivo, `doc/INTEGRATION.md`.** Los 12 archivos de
  316 (`214-…/sdd.md:200-213`) y los de esta HU (§3) no comparten ningún otro path. En particular
  **esta HU no toca `src/types/index.ts`** (toca `src/adapters/types.ts`, que es otro archivo), así
  que el R-6 de 316 no aplica a 314.

**Traducción operativa:**

| Wave | ¿Puede empezar sin 316 mergeada? | Por qué |
|---|---|---|
| **W0 completa** (migración, tipos, `chain.ts`, `export` del preflight) | **SÍ** | Cero archivos compartidos, cero símbolos compartidos, cero lecturas de `metadata.payment` |
| **W1 completa** (store, presencia, challenge) | **SÍ** | ídem |
| **W2 completa** (preflight, registry, middleware, index) | **SÍ** | ídem |
| **W3** (`.env.example`, `doc/INTEGRATION.md`, `doc/MULTI-CHAIN.md`) | **NO — esperar** | `doc/INTEGRATION.md` es el único archivo que las dos escriben. 316 agrega una subsección en §3; esta HU agrega la del pagador Solana |

**Lo que sí es cierto y no hay que perder de vista**: el *entregable de producto* —"el pipeline de
Chaski cobra en Solana de punta a punta"— necesita las dos, porque el leg de SALIDA (gateway → agente)
sí lee `metadata.payment`. Pero eso es una dependencia de **narrativa**, no de este diff.

**La orden del orquestador manda igual: 316 primero.** Si el orquestador levanta esa restricción, lo
que queda bloqueado de verdad es sólo W3.

### 0.4 Corrección heredada que NO hay que repetir

El work-item de WKH-316 afirmaba que `remit-kyc-validator` tiene `payment: null`. **Es falso**: medido
contra producción el 2026-08-18 (`214-…/sdd.md:101-109`), los **3** agentes self-published ya tienen el
bloque Solana completo, sembrado a mano fuera del repo. **Esta HU no hereda esa premisa en ningún lado**
(la revisé: no aparece en `sdd.md` ni en `work-item.md` de 212), y **no debe aparecer** en ningún
docblock, commit, ni reporte de esta HU.

---

## 1. Contexto compacto

### 1.1 Qué se construye, en una frase

Que un tercero pueda **pagarle al gateway en Solana devnet** por un endpoint cobrable: el gateway emite
un challenge 402 de forma Solana, el pagador hace un SPL transfer de USDC con su propia wallet y su
propio fee, presenta la firma, y el gateway **verifica esa firma contra la cadena** y la honra
**exactamente una vez**. El gateway es **TESTIGO**, nunca tesorero: no firma, no transmite, no toca
ninguna clave privada Solana en este camino.

### 1.2 El estado de hoy, re-medido contra `8242b16`

| Hecho | Evidencia (re-verificada hoy) | Lo que decía el SDD |
|---|---|---|
| La pared A sigue en pie | `src/adapters/registry.ts:523` es literalmente `return bundle.payment.vmFamily === 'evm';` | `:510-512` ❌ |
| El corte del middleware | `src/middleware/x402.ts:479-497` (guard) · `:490` header · `:512` eco de chain | `:479-497`, `:512` ✅ |
| `getPaymentAdapter` lanza sobre non-EVM | `src/adapters/registry.ts:426` (firma `(chainKey?): EvmPaymentAdapter`) | `:414-422` ❌ |
| El canal `unknown` | `src/middleware/x402.ts:674-730` (closure `emitInboundSettleUnknown`, `error_code` `X402_SETTLE_UNKNOWN` en `:680`) | `:674-730` ✅ |
| El probe de presencia OUTBOUND | `src/adapters/solana/payment.ts:792` (`probeSettlementPresence`, **`private`**) + `:805` (`…Inner`) + `:814` (`searchTransactionHistory: true`) | `:572-644` ❌ |
| `checkTerms` OUTBOUND | `src/adapters/solana/payment.ts:1382` (**`private`**), lee `preTokenBalances`/`postTokenBalances` en `:1414-1415` | `:1101-1130` ❌ |
| `SettlementPresence` | `src/adapters/types.ts:194-211` (5 estados) | `:170-187` ❌ |
| `SolanaSettleProof` | `src/adapters/types.ts:124` | `:124-128` ✅ |
| `SolanaPaymentAdapter` | `src/adapters/types.ts:336` | `:209-243` ❌ |
| El anti-replay que NO se usa | `src/services/x402-nonce.ts:31-54`; fail-open en `:47-50`; justificación EVM-only en `:9-13` | `:31-53`, `:41-51`, `:10-13` ≈ |
| `probeRpcHistoryRetention` | `src/adapters/solana/schema-preflight.ts:166` — **sigue `private`**, alcanzable sólo desde `probeSolanaSchema` (`:210-226`) **después** de que `probeSettleLedger()` diga `ok` (`:212-216`) | `:166-208`, `:211-226` ✅ |
| Cache single-flight del preflight | `src/adapters/solana/schema-preflight.ts:240-275`; warm-up en `src/index.ts:448` | ✅ |
| `SOLANA_RPC_URL_FALLBACK` existe y **no la lee nadie** | `.env.example:1208`; único hit en `src/` es `src/adapters/deposit-verifier.ts:228`, que **devuelve el nombre como string** en el resolver del deposit-path viem | `.env.example:969` ❌ |
| `getSolanaConnection` lee sólo `SOLANA_RPC_URL` | `src/adapters/solana/chain.ts:39-41` (`getSolanaRpcUrl`) + `:73` (singleton) | ✅ |
| El único punto que toca la clave privada | `src/adapters/solana/chain.ts:84` (`getSolanaOperatorKeypair`) | `:84-100` ✅ |
| `getSolanaFallbackConnection` | **NO existe.** `chain.ts` exporta 11 símbolos; ninguno es ése | (a crear) ✅ |
| Clasificadores de error de Postgres | `src/adapters/solana/settle-ledger.ts:99` (`isRelationMissingError`) y `:122` (`isTransportFailure`) — **NO están exportados**, son `function` de módulo | `:99-128`, *"importados, no re-escritos"* ⚠️ ver §5 · DT-C4 |
| El molde de la migración | `supabase/migrations/20260730000000_wkh307_solana_settle_intents.sql` ✅ existe |  ✅ |
| El uso único garantizado por el motor | `supabase/migrations/20260529000000_a2a_key_deposits.sql` ✅ existe | ✅ |
| Las 8 suites x402 | Las 8 existen: `binding`, `chain-aware`, `challenge-amount`, `dual-header`, `non-evm-inbound`, `passport-shape`, `settle-reverify`, `settle-unknown` | ✅ |
| Guardián de AC-8 | `src/routes/capabilities.inbound-chains.test.ts:140` (`SOLANA_ADAPTER_ENABLED='true'`) + `:154` (`acceptsInboundPayment` → `false`) | `:118` ❌ |
| Guardián de CD-1 | `src/middleware/x402.non-evm-inbound.test.ts:233` (`WASIAI_A2A_CHAINS`) + `:254` (`getPaymentAdapter('solana-devnet')` lanza) | ✅ |
| El rail Solana en producción | `GET /health` publica `solanaPayoutRoute: {"state":"rail_off"}` (dato del orquestador, 2026-08-19; el productor es `src/index.ts:338` → `readPayoutRouteHealth()`) | — |

### 1.3 Los cinco archivos que tenés que leer antes de escribir

1. **`src/adapters/solana/deposit-verifier.ts:1-60`** — el docblock más importante para vos. Es la HU
   hermana (dinero que ENTRA) ya mergeada, con su CD-14 (*"`if (res.error) return <veredicto
   definitivo>` está PROHIBIDO"*) y con la explicación medida de por qué el probe del leg de salida no
   sirve acá.
2. **`src/adapters/solana/deposit-verifier.ts:117-166`** (`probeDepositLanding`) — **tu exemplar
   literal** para el probe inbound: nunca lanza, `searchTransactionHistory: true`, `null` tras búsqueda
   ⇒ `absent`, `confirmationStatus` leído explícitamente, valor no reconocido ⇒ `unknown`.
3. **`src/adapters/solana/settle-ledger.ts:15-45`** — las 3 reglas del store durable + el boundary
   *"este es el ÚNICO archivo de `src/adapters/solana/**` que importa `lib/supabase.js`"*.
4. **`supabase/migrations/20260730000000_wkh307_solana_settle_intents.sql`** — el molde de la migración
   (PK que hace atómico el reclamo, `amount_atomic TEXT`, `REVOKE`/`GRANT`, `p_probe` con
   `RAISE EXCEPTION` como primera sentencia).
5. **`src/middleware/x402.ts:455-530`** — el tramo exacto donde entra tu bifurcación.

---

## 2. Los Constraint Directives que van ADELANTE (auto-blindaje reciente)

Estos cinco salen de las **3 últimas HUs cerradas** (223 · WKH-360, 222 · WKH-345, 221 · WKH-SEC-04),
destilados en `214-…/sdd.md:446-485`. **Dos de ellos son 3/3: se repitieron en las tres.** Van primero
porque son los que más veces rompieron trabajo ya hecho en este repo.

- **CD-A1 (3/3) — PROHIBIDO citar `archivo:línea` sin re-verificarla DESPUÉS de la última edición del
  diff.** Las tres HUs rompieron **sus propias** citas al editar: WKH-360 (*"Mi propia aritmética de
  desplazamiento ubicó mal una cita"*), WKH-345 (*"Mi propio find/replace me rompió la prosa y las
  citas"*), WKH-SEC-04 (*"Mis propias ediciones corrieron las líneas que yo citaba"*).
  **Obligatorio al cerrar CADA wave**: re-abrir cada cita escrita en esa wave y confirmarla con
  `command sed -n 'Np' <archivo>`. No `grep`: `grep` bajo el hook de este entorno devuelve números en
  vez de rutas.
  ⚠️ Esta HU ya arranca pagando el precio ajeno: §1.2 lista **9 citas del SDD que están corridas**
  porque el árbol se movió 267 commits. No agregues las tuyas.

- **CD-A2 (3/3) — PROHIBIDO escribir en un docblock, README, `.env.example` o reporte una afirmación
  que no se midió en esa misma sesión.** WKH-345 (*"Copié a un docblock una afirmación del Story File
  que no medí, y era falsa"*), WKH-360 (*"dejé en falso un número publicado en los DOS README"*),
  WKH-SEC-04 (*"Escribí tres afirmaciones que mi propio archivo no podía refutar"*).
  **Regla operativa**: cada frase que escribas tiene que poder completarse con *"esto sería falso si
  \_\_\_"*, y ese \_\_\_ tiene que ser **un input concreto**, no una intención.

- **CD-A3 (2/3) — PROHIBIDO declarar verde corriendo sólo los archivos tocados, y PROHIBIDO leer un
  exit code después de un pipe.** WKH-345 (*"Corrí sólo los archivos que toqué y canté verde con 2
  rojos en el árbol"*), WKH-SEC-04 (*"Medí biome con un pipe y me dio el resultado tranquilizador"*).
  **Cierre de wave = las tres puertas de §9, completas, sin pipe, con el exit code leído directo.**

- **CD-A4 (2/3) — Todo test negativo necesita su gemelo positivo, y hay que verificar POR QUÉ se puso
  rojo.** WKH-345 (*"T-5 no puede matar al mutante que dice matar"*), WKH-360 (*"Mi testigo moría por
  la razón BARATA"*, *"un mutante que MATA por el motivo equivocado: 178 rojos en vez de 2"*).
  **Concreto acá**: el test de "monto insuficiente" debe fallar con `X402_SOLANA_AMOUNT_SHORT` y **no**
  con `X402_SOLANA_REFERENCE_MISMATCH`. **Se assertea el `error_code`, nunca sólo el status.**

- **CD-A5 (2/3) — PROHIBIDO citar un commit o un documento que todavía no está en el índice de git.**
  WKH-345, WKH-SEC-04. Si escribís *"ver `doc/…/story-file.md`"*, `git add` primero.

**Y los cinco del SDD, que también son de auto-blindaje** (`sdd.md:608-643`) y siguen vigentes:
CD-10 (*"no tests" NUNCA cuenta como KILLED; ningún helper que pueda tirar se invoca en el cuerpo de un
`describe`*), CD-11 (*una sola expresión por valor y por canal*), CD-12 (*fixtures derivados de la misma
librería que los consume: una firma Solana es base58 de 64 bytes ≈87-88 chars, una referencia es base58
de 32 bytes; `'x'.repeat(88)` no es base58 y explota lejos del origen*), CD-13 (*nada de `git checkout --`
/ `git restore` / `git stash` durante la campaña de mutación: copia física fuera del árbol +
`sha256sum`*), CD-14 (*el `_down` que preserva datos trae un gate de re-hidratación EJECUTABLE en el `up`*).

---

## 3. Scope IN — lista exhaustiva de archivos a tocar

### 3.1 Producción

| # | Archivo | Acción | Wave |
|---|---|---|---|
| 1 | `supabase/migrations/20260819000000_wkh314_solana_inbound_proofs.sql` | **crear** | W0.1 |
| 2 | `supabase/migrations/20260819000000_wkh314_solana_inbound_proofs_down.sql` | **crear** | W0.1 |
| 3 | `src/adapters/types.ts` | modificar (**bloque aditivo al final**, molde `:271-282` de WKH-315) | W0.2 |
| 4 | `src/adapters/solana/schema-preflight.ts` | modificar (**una palabra**: `export` en `:166`) | W0.3 |
| 5 | `src/adapters/solana/chain.ts` | modificar (4 accesores nuevos + `_resetSolanaChain` extendido) | W0.4 |
| 6 | `src/services/solana-inbound-proof.ts` | **crear** | W1a |
| 7 | `src/adapters/solana/inbound-presence.ts` | **crear** | W1b |
| 8 | `src/adapters/solana/inbound-verify.ts` | **crear** | W1b |
| 9 | `src/lib/solana-x402-challenge.ts` | **crear** | W1c |
| 10 | `src/adapters/solana/inbound-preflight.ts` | **crear** | W2.1 |
| 11 | `src/adapters/registry.ts` | modificar (`acceptsInboundPayment`, `:522-524`) | W2.2 |
| 12 | `src/middleware/x402.ts` | modificar (extracción del canal + bifurcación + handler) | W2.3 |
| 13 | `src/index.ts` | modificar (warm-up, 1 línea, junto a `:448`) | W2.4 |

### 3.2 Tests

| # | Archivo | Acción |
|---|---|---|
| 14 | `src/lib/solana-x402-challenge.test.ts` | crear |
| 15 | `src/services/solana-inbound-proof.test.ts` | crear |
| 16 | `src/adapters/solana/inbound-presence.test.ts` | crear |
| 17 | `src/adapters/solana/inbound-verify.test.ts` | crear |
| 18 | `src/adapters/solana/inbound-preflight.test.ts` | crear |
| 19 | `src/middleware/x402.solana-inbound.test.ts` | crear |
| 20 | `test/wkh314-inbound-proofs.migration.test.ts` | crear (usa `test/helpers/sql-predicate.ts`, que **existe**) |
| 21 | `test/helpers/solana-inbound-fixtures.ts` | crear (CD-12: fixtures derivados de `@solana/web3.js` / `base58.ts`) |

### 3.3 Docs y config (W3 — **la única wave que espera a WKH-316**)

| # | Archivo | Acción |
|---|---|---|
| 22 | `.env.example` | bloque nuevo con las 3 variables + la advertencia devnet del fallback |
| 23 | `doc/INTEGRATION.md` | sección del pagador Solana ⚠️ **archivo compartido con WKH-316** |
| 24 | `doc/MULTI-CHAIN.md` | la asimetría deja de ser total + `TD-INBOUND-MULTI-ATA` |
| 25 | `doc/sdd/_INDEX.md` | **editar la CELDA DE ESTADO de la fila `212` (`:179`). NO agregar fila.** Ver §3.5 |

### 3.4 Archivos que están en el Scope IN del SDD y **SALEN**

| Archivo | Por qué sale |
|---|---|
| `src/adapters/solana/payment.ts` | **C-1**: WKH-315 ya decidió no consumir su probe (`deposit-verifier.ts:25-44`) y cierra con *"`payment.ts` queda intacto"*. Tocarlo pondría en riesgo el leg de salida recién shipeado, sin ganar un solo consumidor |
| `src/adapters/solana/presence.ts` (nombre del SDD) | Renombrado a `inbound-presence.ts` (#7) para que nadie lo lea como "el probe compartido": **no es compartido, es del inbound**. Ver DT-C1 |
| `src/services/compose.ts` | Ya lo sacaba el SDD §3 con evidencia (`compose.ts` gobierna el leg gateway→agente, no caller→gateway). Se mantiene fuera |
| `src/middleware/x402.non-evm-inbound.test.ts` | **NO se reescribe** (CD-1 del SDD). Queda verde intacto; las expectativas invertidas van a `x402.solana-inbound.test.ts` |
| `src/types/index.ts` | Esta HU no lo toca. Es de WKH-316 |

### 3.5 El guardián del índice — lo que NO tenés que hacer

`test/sdd-index-matches-folders.test.ts` exige **exactamente una** fila por carpeta y se pone **rojo con
una fila duplicada**. La fila `212` **ya existe** (`doc/sdd/_INDEX.md:179`) desde el saneamiento del
2026-08-10, y el propio `_INDEX-row.md` de esta carpeta abre con
*"⚠️ **YA INSERTADA — NO VOLVER A COPIARLA**"*. **Editá la celda de estado de la fila existente. No pegues
la fila del `_INDEX-row.md`.**

### 3.6 Scope OUT (se mantiene el del SDD §12, más lo de §3.4)

`wasiai-facilitator` cero bytes · `chaski-v3` cero bytes · `wasiai-v2` cero bytes · la pared B (es
WKH-315, **ya mergeada**) · Solana Pay QR / SDK / UX del pagador · gasless o fee-payer para la tx del
pagador · escrow Anchor · reembolso automático · **mainnet** · reusar `a2a_x402_nonces` · cambiar el modo
de pago de los 3 agentes `remit-*` · arreglar el `.find()` de `checkTerms` (`TD-INBOUND-MULTI-ATA`) ·
mover el testigo al facilitator.

---

## 4. Anti-Hallucination Checklist — específico de esta HU

Antes de escribir cada archivo, confirmá con `Read` (no de memoria, no del SDD):

- [ ] **`src/adapters/registry.ts:522-524`** — que `acceptsInboundPayment` sigue siendo la línea que
      creés. *Sería falso si el cuerpo ya tuviera un `if`.*
- [ ] **`src/middleware/x402.ts:479-497`** — que el guard sigue ahí y que `:512` sigue siendo el
      `reply.header(X_A2A_PAYMENT_CHAIN_HEADER, chainKey)`. **Tu bifurcación va entre `:512` y `:514`,
      con `return` inmediato.**
- [ ] **`src/adapters/solana/schema-preflight.ts:166`** — que `probeRpcHistoryRetention` sigue **sin**
      `export`. *Si ya lo tiene, alguien te ganó de mano: no lo agregues dos veces.*
- [ ] **`src/adapters/solana/chain.ts`** — que **no** existe `getSolanaFallbackConnection`.
- [ ] **`supabase/migrations/`** — que `20260819000000` sigue libre (`ls | grep -c 20260819` → `0`).
      Si otra HU lo tomó, subí el timestamp; **no** reuses uno ocupado.
- [ ] **`src/adapters/solana/settle-ledger.ts:99` y `:122`** — que `isRelationMissingError` /
      `isTransportFailure` siguen **sin** `export` (ver DT-C4 para qué hacer).
- [ ] **`src/adapters/types.ts:194`** — que `SettlementPresence` sigue teniendo 5 estados y que el
      comentario de `:271-282` sigue diciendo que **queda congelado para el camino de salida**.
      **PROHIBIDO agregarle un estado.**
- [ ] **`test/ownership-filter-guard.scanner.ts:243`** (`deriveTables`) — el universo de tablas se
      **deriva** de los bloques `Row` de `src/types/database.types.ts` que declaran `owner_ref`
      (`:277`). La tabla nueva de esta HU **no lleva `owner_ref`** (decisión explícita, §7.1), así que
      **no entra al conjunto** y ni el guardián ni `test/ownership-filter-guard.exceptions.ts` cambian.
      *Sería falso si le agregaras `owner_ref` a la tabla: ahí sí el guardián te va a exigir el filtro.*
- [ ] **NO inventes un `error_code`** que no esté en la tabla de §8.3.
- [ ] **NO uses `getPaymentAdapter()` en la rama Solana.** Lanza a propósito (`registry.ts:426`).
- [ ] **NO toques `src/adapters/solana/payment.ts`.** Ni una línea. Ni un comentario.

---

## 5. Decisiones que este Story File FIJA (delta sobre el SDD)

- **DT-C1 — No se extrae nada de `payment.ts`. `src/adapters/solana/inbound-presence.ts` se escribe
  nuevo, siguiendo la DOCTRINA, no la función.**
  Es exactamente lo que hizo WKH-315 y lo dejó escrito: *"Lo compartido es la DOCTRINA, no la función:
  tres valores mínimo, `getSignatureStatuses` + `searchTransactionHistory` como ÚNICA fuente de una
  negativa, `unknown` para todo lo demás, nunca lanzar"* (`deposit-verifier.ts:39-43`).
  Beneficios medibles: (a) `payment.ts` (1647 líneas, money-path de salida recién shipeado) no se toca;
  (b) desaparece el riesgo sobre `src/adapters/solana/intent-dedup.test.ts:1843-1850`, que espía el
  método privado `probeSettlementPresence` por nombre; (c) el SDD justificaba la extracción con
  *"315 lo consume"*, y **315 no lo consume**.

- **DT-C2 — El grant exige FINALIDAD. Tipo nuevo `SolanaInboundPresence`, bloque aditivo en
  `src/adapters/types.ts`.**
  `SettlementPresence.landed_ok` sólo mira `status.err`; un `confirmed` no-finalizado pasaría como
  grant. Para dinero que ENTRA eso es el mismo agujero que 315 midió y cerró. Estados:

  ```ts
  export type SolanaInboundPresence =
    /** Aterrizó, sin error, `finalized`, y CUMPLE los términos del challenge. Único grant. */
    | { state: 'finalized_ok'; creditedAtomic: string }
    /** Aterrizó y falló on-chain: nada se movió. Terminal, NO se consume la prueba. */
    | { state: 'landed_failed'; detail: string }
    /** Aterrizó, `processed`/`confirmed`, todavía no `finalized`. Negativa MEDIDA y REINTENTABLE. */
    | { state: 'not_finalized'; confirmationStatus: string }
    /** Aterrizó y finalizó, pero los términos NO cumplen (monto/mint/destino). Fail-closed. */
    | { state: 'terms_mismatch'; detail: string }
    /** El nodo RESPONDIÓ, buscando en el histórico, y no la conoce. Prueba de ausencia. */
    | { state: 'absent' }
    /** No se pudo preguntar. NUNCA autoriza conceder. */
    | { state: 'unknown'; detail: string };
  ```

  Seis estados, exhaustividad forzada por el compilador (CD-3 del work-item: *"un tipo nuevo se admite
  sólo si tiene ≥3 estados y el compilador fuerza la exhaustividad"* — se admite).
  **Coste declarado**: el pagador espera la finalidad (~13 s en devnet, no medido acá) antes de que su
  prueba sirva. Encaja con la política §2 del SDD: `not_finalized` es un **aplazamiento** —se rechaza
  con `Retry-After` y **sin consumir**—, no una pérdida. Ver §11 · NC-1.

- **DT-C3 — El monto acreditado se calcula SUMANDO, no con `.find()`.**
  El `.find()` de `checkTerms` (`payment.ts:1382`, leg de salida) es una fuente conocida de
  `landed_mismatch` falso si la wallet receptora tiene dos cuentas de token del mismo mint (DT-8 del
  SDD). En el inbound la pregunta correcta es *"¿cuánto recibió `payTo` de este mint en esta tx?"*, y la
  respuesta correcta es la **suma** de `Σ(post − pre)` sobre **todas** las entradas con
  `owner === payTo && mint === configurado`. Es correcto por construcción y **no toca `checkTerms`**.
  El chequeo del preflight (`getTokenAccountsByOwner(payTo,{mint}) === 1`) **se mantiene**, pero baja a
  lo que de verdad es: una **señal de configuración al operador al arrancar**, no el guard del dinero.
  `TD-INBOUND-MULTI-ATA` queda registrado igual, para el leg de salida.

- **DT-C4 — Los clasificadores de error de Postgres se EXPORTAN, no se re-escriben.**
  `isRelationMissingError` (`settle-ledger.ts:99`) e `isTransportFailure` (`:122`) son `function` de
  módulo, **sin `export`**. CD-11 (*una sola expresión por valor*) exige compartirlas.
  **Esta HU es la dueña de agregarles `export`, con el cuerpo byte-idéntico** — igual que el `export`
  de `probeRpcHistoryRetention`. Cero líneas de lógica tocadas.
  *Sería falso si `settle-ledger.test.ts` fallara tras el cambio: agregar `export` no altera
  comportamiento, y esa suite verde sin modificarse es la prueba.*

- **DT-C5 — `SOLANA_X402_INBOUND_PAY_TO` DEBE ser distinta de la cuenta de depósito de WKH-315.**
  **Hallazgo nuevo, no está en el SDD.** WKH-315 acredita saldo prepago cuando una firma Solana
  transfiere USDC a la ATA de depósito (`resolveSolanaDepositAta()`,
  `src/adapters/solana/deposit-account.ts:79`, derivada de `A2A_DEPOSIT_OWNER_SOLANA`, `:57`), y lleva
  su propio uso único en `a2a_key_deposits` (`UNIQUE (chain_id, tx_hash)`, escritor
  `src/services/budget.ts`). Esta HU lleva el suyo en una tabla distinta.
  **Si las dos direcciones fueran la misma, UNA sola transferencia se podría cobrar DOS veces**: una por
  `POST /auth/deposit` (crédito de saldo) y otra como prueba x402 (servicio). Ningún store mira al otro.
  **Obligatorio**: el preflight inbound compara `SOLANA_X402_INBOUND_PAY_TO` (y su ATA derivada) contra
  `resolveSolanaDepositAta()` y **falla cerrado** si coinciden, con motivo propio
  `SOLANA_INBOUND_PAYTO_COLLIDES_WITH_DEPOSIT`. Con su test (T-COL-01).
  *Sería falso si `resolveSolanaDepositAta()` devolviera siempre `null`: devuelve `null` sólo cuando
  `A2A_DEPOSIT_OWNER_SOLANA` está ausente — y en ese caso no hay colisión posible, que es justamente el
  caso que el guard debe dejar pasar.*

- **DT-C6 — Migración `20260819000000`** (C-3).

- **Todo lo demás del SDD se mantiene sin cambios**: DT-1 (destino compartido + referencia, con sus
  números medidos), DT-3 (uso único en la FIRMA, referencia en columna aparte), DT-4 (bifurcación antes
  de `getPaymentAdapter`), DT-5 (capacidad real con UNA definición), DT-6 (referencia como cuenta extra
  read-only, con el borde de las tx v0), DT-7 (el store vive en `src/services/`, no en
  `adapters/solana/`, por el boundary de `settle-ledger.ts:40-45`), DT-10 (doble proveedor con su tabla
  de escalada), DT-11 (flag propio ANDeado, default `false`), DT-12 (`observed` → `consumed`),
  DT-13 (challenge sin estado, referencia = HMAC), DT-14 (el canal `unknown` se extrae, no se duplica),
  DT-15 (`decodeXPayment` no se toca), DT-16 (`payTo` como pubkey en variable propia, **nunca** derivada
  de la clave privada), DT-17 (el testigo vive acá, no en el facilitator).

---

## 6. El orden de las verificaciones, y qué pasa en cada corte

**Esto es lo más importante del documento.** Es money-path **inbound**: aceptar un pago mal verificado
es peor que rechazarlo, porque el rechazo es reintentable y la aceptación indebida no se deshace.

### 6.1 La secuencia — normativa, el orden no es decorativo

| Paso | Qué se comprueba | ¿Toca red? | ¿Toca DB? | Si falla |
|---|---|---|---|---|
| **P0** | Flag + config completa (`isSolanaX402InboundConfigured()`) | no | no | el camino ni siquiera existe: sigue el 400 de hoy (`CHAIN_INBOUND_PAYMENT_UNSUPPORTED`) |
| **P1** | El sobre trae `authorization` objeto + `signature` string, y la firma **decodifica como base58 de 64 bytes** | no | no | `402` `X402_SOLANA_PROOF_MALFORMED`, **sin consumir** |
| **P2** | La **referencia se RE-DERIVA** con el HMAC del servidor y se compara **en tiempo constante**; y el challenge **no está expirado** según `expiresAt` **del MAC** (no del campo suelto del cliente) | no | no | `402` `X402_SOLANA_REFERENCE_MISMATCH` / `X402_SOLANA_CHALLENGE_EXPIRED`, **sin consumir** |
| **P3** | **Peek del store**: ¿esta firma ya está `consumed`? | no | sí | `402` `X402_SOLANA_PROOF_REPLAY`. Si el store no contesta ⇒ **P8** |
| **P4** | Presencia + finalidad + términos, primario **y** fallback (DT-10), combinados por la función pura | sí | no | ver §6.2 |
| **P5** | **Binding**: la `reference` está en `transaction.message.accountKeys` ∪ `meta.loadedAddresses`, y el `blockTime` cae dentro de `[issuedAt, expiresAt]` | sí (misma lectura de P4) | no | `402` `X402_SOLANA_REFERENCE_MISMATCH`, **sin consumir** |
| **P6** | `record_solana_inbound_observed(...)` — persiste el veredicto de la cadena | no | sí | si no contesta ⇒ **P8** |
| **P7** | `consume_solana_inbound_proof(...)` — **escritura condicional atómica**, exactamente un ganador | no | sí | perdedor ⇒ `X402_SOLANA_PROOF_REPLAY`; si no contesta ⇒ **P8** |
| **P8** | *(no es un paso: es el destino de todo lo indeterminado)* | — | — | `402` `X402_SETTLE_UNKNOWN` + evento durable, **sin consumir**, con `Retry-After` |
| **P9** | Concesión del acceso | — | — | — |

**Por qué P2 va antes que P4**: una prueba con la referencia forjada se rechaza **sin gastar una sola
llamada al RPC**. Es la defensa barata contra el pagador que copia una firma del explorer, y contra el
que quiere que le pagues el rate-limit del nodo. Hay un test que lo mide contando llamadas (T-TERMS-05).

**Por qué P3 (peek) va antes que P4**: un reintento cuya fila ya está `observed` **salta P4 y P5**
(DT-12): la incertidumbre de la cadena se paga **una sola vez en la vida del pago**. Test con conteo de
llamadas: T-CACHE-01.

**Por qué P7 va lo más tarde posible**: residuo declarado y aceptado (SDD DT-12) — si la respuesta HTTP
se pierde después del consumo, el pagador queda cobrado sin servicio. Es la misma postura que el camino
EVM de hoy y no se resuelve en esta HU; se mitiga poniendo el consumo inmediatamente antes de conceder.

### 6.2 La tabla de veredictos de P4 — qué concede y qué no

Combinador **puro y sin red** sobre dos `SolanaInboundPresence` (primario, fallback). Precedencia, en
este orden exacto:

| Situación | Veredicto | HTTP / `error_code` | ¿Consume? | ¿`Retry-After`? |
|---|---|---|---|---|
| Alguno dice `terms_mismatch` | **`terms_mismatch`** (pegajoso) | `402` `X402_SOLANA_TERMS_MISMATCH` | **NO** | no |
| Si no, alguno dice `finalized_ok` **y ninguno contradice los términos** | `finalized_ok` | **grant** | sí (P7) | — |
| Si no, alguno dice `landed_failed` | `landed_failed` | `402` `X402_SOLANA_TX_FAILED` | **NO** | no |
| Si no, alguno dice `not_finalized` | `not_finalized` | `402` `X402_SOLANA_NOT_FINALIZED` | **NO** | **sí** |
| Si no, **los dos** dicen `absent` | `absent` | `402` `X402_SOLANA_PROOF_ABSENT` | **NO** | **sí** |
| Cualquier otro caso (incluye "uno `absent`, otro `unknown`") | **`unknown`** | `402` `X402_SETTLE_UNKNOWN` | **NO** | **sí** |

Reglas que el combinador **no puede** romper, cada una con su mutante en §8.2:

1. **`terms_mismatch` es pegajoso y gana a `finalized_ok`.** Dos parseos de la misma firma no pueden
   discrepar legítimamente sobre los números: si discrepan, es una anomalía y **deniega**.
2. **Un `absent` solo, contradicho por un `unknown`, NO es una negativa.** Hacen falta **dos nodos** que
   hayan buscado y no la conozcan.
3. **La ausencia de fallback nunca convierte un `unknown` en un grant.** Sin `SOLANA_RPC_URL_FALLBACK`
   configurada, el veredicto del primario se usa tal cual.
4. **El monto se compara en unidades ATÓMICAS y con `>=`.** Acreditar **más** que lo requerido concede;
   acreditar **menos** es `terms_mismatch` con detalle `AMOUNT_SHORT` ⇒ `X402_SOLANA_AMOUNT_SHORT`.
   **PROHIBIDO** comparar en decimal, y **PROHIBIDO** `!==`.

### 6.3 El criterio fail-closed, en una frase que se puede testear

> **Ningún estado que no sea `finalized_ok` con términos cumplidos concede acceso, y ningún camino que
> no conceda acceso escribe `consumed`.**

Las dos mitades tienen su test paramétrico: T-NOCONS-01 recorre **los 8 motivos de rechazo** y afirma
que la firma sigue gastable; T-GRANT-01 afirma que la fila queda `consumed` **antes** de que el handler
responda.

---

## 7. Idempotencia — dónde se marca usada una prueba, y qué pasa con un replay

### 7.1 La tabla

`public.a2a_solana_inbound_proofs`, en `20260819000000_wkh314_solana_inbound_proofs.sql`.

```
caip2          TEXT NOT NULL
signature      TEXT NOT NULL          -- firma base58 de la tx del PAGADOR
PRIMARY KEY (caip2, signature)        -- ← ESTO es el uso único.
                                      --   No es defensa en profundidad: es LA defensa.
reference      TEXT NOT NULL
resource       TEXT NOT NULL
pay_to         TEXT NOT NULL
amount_atomic  TEXT NOT NULL          -- TEXT, NUNCA NUMERIC (WKH-196)
mint           TEXT NOT NULL
status         TEXT NOT NULL DEFAULT 'observed'
                    CHECK (status IN ('observed','consumed'))
observed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
consumed_at    TIMESTAMPTZ NULL
attempts       INTEGER NOT NULL DEFAULT 1
created_at / updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
```

**Sin `owner_ref` y sin RLS — decisión explícita, no olvido.** En el camino x402 puro no hay identidad
de caller: el pagador se identifica con su firma de pago (lo dice el propio código,
`src/middleware/x402.ts:449-451`: *"`null` = path x402 puro: acá NO hay agent-key (el caller se
identifica con la firma de pago)"*). Es dedup **global** del gateway, mismo criterio que
`a2a_solana_settle_intents`. Consecuencia mecánica, ya verificada en §4: la tabla **no entra** al
universo de `test/ownership-filter-guard.test.ts`, porque ese universo se **deriva** de las tablas con
`owner_ref` en `src/types/database.types.ts` (`test/ownership-filter-guard.scanner.ts:243,277`).
`REVOKE ALL … FROM PUBLIC, anon, authenticated` + `GRANT` sólo a `service_role`; la tabla se toca
**exclusivamente** desde las funciones `SECURITY DEFINER` con `search_path` fijo.

### 7.2 Las tres funciones — ninguna devuelve `boolean`

Todas `RETURNS TABLE(applied BOOLEAN, outcome TEXT, …)`, regla 3 de `settle-ledger.ts:15-39`.

1. **`record_solana_inbound_observed(...)`** — `INSERT … ON CONFLICT (caip2, signature) DO UPDATE SET
   attempts = attempts + 1 … WHERE status = 'observed' AND los términos coinciden … RETURNING`.
   **Una sola sentencia.** Outcomes: `observed` / `consumed` (⇒ replay) / `terms_conflict` (la misma
   firma presentada contra otro destino, monto, mint o referencia **no es este pago**).
2. **`consume_solana_inbound_proof(...)`** — `UPDATE … SET status='consumed', consumed_at=now()
   WHERE caip2=… AND signature=… AND status='observed' AND los términos coinciden RETURNING`.
   **Exactamente un ganador, decidido por Postgres.** Outcomes: `consumed` / `already_consumed` (⇒
   replay) / `not_observed` (estado imposible ⇒ fail-closed) / `terms_conflict`.
3. **`probe_solana_inbound_store(p_probe BOOLEAN)`** — `RAISE EXCEPTION 'WKH314_PROBE_OK'` como
   **primera sentencia**, antes de tocar una fila. Prueba **POSITIVA** de costo cero para el preflight.
   Leer un catálogo no probaría lo mismo: una función homónima con el cuerpo viejo figuraría igual.

### 7.3 Qué pasa con un replay, exactamente

| Escenario | Resultado | Test |
|---|---|---|
| Misma firma, segunda presentación, primer intento **exitoso** | `402` `X402_SOLANA_PROOF_REPLAY`, sin servicio | T-REPLAY-01 |
| Misma firma, segunda presentación, primer intento **falló después del consumo** (fila `consumed`, servicio nunca entregado) | **sigue siendo replay.** La detección mira **LA FILA**, nunca el resultado de nadie | T-REPLAY-02 |
| Dos presentaciones **concurrentes** de la misma firma | exactamente una gana; la otra recibe replay | T-REPLAY-04 |
| Misma firma contra **otro** challenge (otra referencia / otro monto / otro destino) | `terms_conflict` ⇒ `X402_SOLANA_TERMS_MISMATCH`, **no** replay | T-REPLAY-05 |
| El store **no contesta** al preguntar si ya se usó | `unknown` ⇒ deniega **sin consumir**; el reintento vuelve a competir por la misma PK | T-UNK-02 |

**El borde que el work-item §3.3 identificó bien, y cómo se cierra**: cuando lo indeterminado es el
*store*, "reintentá después" arriesgaría servir dos veces. **Se cierra por construcción, no por
política**: el consumo es una escritura condicional atómica contra una PK de Postgres, así que un store
mudo produce un `unknown` del store ⇒ se rechaza sin consumir, y el reintento **vuelve a competir por la
misma PK**. Nunca hay un camino en que dos requests ganen el mismo consumo.

### 7.4 Lo que está PROHIBIDO acá

- **PROHIBIDO** reusar `a2a_x402_nonces` / `checkAndRecordX402Nonce` (`src/services/x402-nonce.ts:31-54`).
  Falla **abierto** por diseño (`:47-50`) y su justificación escrita (`:9-13` — *"el `authorization.nonce`
  EIP-3009 ya es single-use a nivel token on-chain"*) **es falsa en Solana**: una prueba Solana es una
  firma ya aterrizada, se presenta N veces y la cadena no objeta nada porque no hay nada que gastar de
  nuevo.
- **PROHIBIDO "arreglar" `x402-nonce.ts` volviéndolo fail-closed**: eso cambia el camino EVM y viola CD-1.
- **PROHIBIDO** un fallback en memoria del store. Cliente caído, error de Postgres, `data` vacío,
  `applied: undefined`, forma inesperada ⇒ **todo eso es "no sé", y "no sé" nunca concede acceso**
  (regla 2 de `settle-ledger.ts`).

---

## 8. Contratos concretos

### 8.1 Variables de entorno (las tres nuevas + una que ya existe)

| Variable | Default | Qué hace |
|---|---|---|
| `SOLANA_X402_INBOUND_ENABLED` | `false` | Gate del camino de entrada x402. Comparación **literal** contra `'true'`; cualquier otro valor deja el camino apagado. Flag **propio**, ANDeado con `SOLANA_ADAPTER_ENABLED`. **Exemplar de redacción y de doctrina**: `A2A_DEPOSIT_ENABLED_SOLANA` en `.env.example:1283-1292` (WKH-315), que ya explica por qué el rail de salida y un camino de entrada de dinero son dos decisiones distintas |
| `SOLANA_X402_INBOUND_PAY_TO` | *(vacío)* | **Pubkey base58** de la wallet receptora. **NUNCA** una clave privada, **NUNCA** derivada de `SOLANA_OPERATOR_PRIVATE_KEY` (AC-9 / CD-2 / DT-16). **DEBE ser distinta de la ATA de depósito** (DT-C5) |
| `SOLANA_X402_INBOUND_CHALLENGE_SECRET` | *(vacío)* | Secreto del HMAC de la referencia. Longitud mínima exigida. Nunca en logs, nunca en el repo |
| `SOLANA_RPC_URL_FALLBACK` | *(vacío)* | **Ya existe en `.env.example:1208` y hoy no la lee nadie.** Esta HU la enciende. **PROHIBIDO** que apunte a mainnet (CD-5): un host de mainnet ⇒ fail-closed al arrancar, no un warn |

`isSolanaX402InboundConfigured()` (en `chain.ts`, **pura y síncrona**) exige las **cuatro** cosas juntas:
`SOLANA_ADAPTER_ENABLED === 'true'` **Y** `SOLANA_X402_INBOUND_ENABLED === 'true'` **Y**
`SOLANA_X402_INBOUND_PAY_TO` presente y base58 de **32 bytes exactos** **Y**
`SOLANA_X402_INBOUND_CHALLENGE_SECRET` presente con la longitud mínima.
**Limitación declarada, no escondida**: `/capabilities` es síncrono, así que publica *"configurado"*, no
*"la DB y el RPC están sanos"*. Eso se enforcea perezoso en la verificación. CD-6 se cumple en el sentido
que importa: **con la config incompleta el valor publicado es `false` y el camino está cerrado**.

### 8.2 El sobre y el challenge

**402 (respuesta):** `network` = CAIP-2 (`solana:<genesis>`), `mint` base58, `maxAmountRequired` en
unidades atómicas del mint, `payTo` base58, `reference` base58 (32 bytes), `expiresAt` **absoluto**,
`extra.nonce` base58 (entropía por emisión).
**El monto sale de UNA sola resolución** reusada por el challenge y por el binding (CD-11), igual que
`resolvePaymentRequirements` hace en EVM.
⚠️ **Esa frase fue FALSA hasta el fix-pack del AR** (BLQ-ALTO-1) y conviene que se lea con lo que la
sostiene: había DOS expresiones del monto —`requiredAmount`, que sólo alimentaba el challenge, y
`presented.amountAtomic`, que salía del sobre del cliente y era el que viajaba hasta la cadena—, y
divergían. Hoy el sobre se compara contra `requiredAmount` (monto, `payTo` y `mint`) en P2b, antes del
peek, con el mismo `>=` en unidades atómicas que usa la rama EVM en `x402.ts:1226`.

**X-PAYMENT (request):** el decoder **no se toca**. `decodeXPayment` (`src/middleware/x402.ts:359-382`)
sólo exige `authorization` objeto y `signature` string:

```
{ authorization: { reference, payTo, amountAtomic, mint, issuedAt, expiresAt, nonce },
  signature: '<txid base58>',
  network: 'solana:<genesis>' }
```

**La referencia es un MAC, no una fila** (DT-13):
`HMAC-SHA256(secreto, resource|payTo|amountAtomic|mint|caip2|issuedAt|expiresAt)` truncado a 32 bytes y
codificado en base58 — o sea, **una clave pública válida**, usable como cuenta.
Persistir cada challenge sería **una escritura por cada 402 en una ruta pública sin autenticar** =
amplificación de denegación de servicio gratis. El MAC da infalsificabilidad y expiración con cero
almacenamiento.
**El servidor RE-DERIVA y compara en tiempo constante. PROHIBIDO comparar con `===` contra el valor que
mandó el cliente, y PROHIBIDO leer la expiración de un campo sin MAC.**

### 8.3 Los `error_code` — tabla cerrada

| `error_code` | HTTP | ¿Consume? | `Retry-After` | Cuándo |
|---|---|---|---|---|
| `X402_SOLANA_PROOF_MALFORMED` | 402 | no | no | la firma no decodifica como base58 de 64 bytes, o falta un campo del sobre |
| `X402_SOLANA_REFERENCE_MISMATCH` | 402 | no | no | la referencia no re-deriva, o no aparece en la tx |
| `X402_SOLANA_CHALLENGE_EXPIRED` | 402 | no | no | `expiresAt` (del MAC) ya pasó, o el `blockTime` cae fuera de la ventana |
| `X402_SOLANA_AMOUNT_SHORT` | 402 | no | no | acreditó **menos** que el atómico requerido |
| `X402_SOLANA_TERMS_MISMATCH` | 402 | no | no | destino ≠ `payTo`, o mint ≠ el configurado, o `terms_conflict` del store |
| `X402_SOLANA_TX_FAILED` | 402 | no | no | la tx aterrizó y falló on-chain |
| `X402_SOLANA_NOT_FINALIZED` | 402 | no | **sí** | aterrizó pero todavía no `finalized` |
| `X402_SOLANA_PROOF_ABSENT` | 402 | no | **sí** | **dos** nodos buscaron en su histórico y no la conocen |
| `X402_SOLANA_PROOF_REPLAY` | 402 | *(ya estaba)* | no | la fila está `consumed` |
| `X402_SETTLE_UNKNOWN` | 402 | no | **sí** | **REUSADO, no inventado** (CD-8). La cadena o el store no pudieron responder |

**`Retry-After` sólo en los reintentables.** Un rechazo por monto insuficiente no se arregla esperando:
mandarle `Retry-After` es mentirle al pagador. Test: T-RETRY-01.

**El canal de `unknown` es UNO SOLO** (DT-14 / CD-8 / CD-11): `emitInboundSettleUnknown`
(`src/middleware/x402.ts:674-730`) es hoy una **closure sobre variables del handler EVM**. Se **extrae**
a función de módulo con parámetros explícitos; el sitio EVM la invoca reenviando exactamente lo mismo.
Se conservan `error_code` `X402_SETTLE_UNKNOWN` y `eventType` `x402_settle_unknown`; la rama Solana
agrega `signature` y `reference` al `metadata` y **no manda** `authorizationNonce`.
**La prueba de que la extracción no cambió nada es `x402.settle-unknown.test.ts` verde SIN MODIFICAR.**
El `track()` va siempre con `.catch()`: `eventService.track` **tira** si el insert falla
(`src/services/event.ts:88`), y un evento perdido no puede cambiar la respuesta HTTP.

---

## 9. Waves

### Puertas de cierre — idénticas para TODAS las waves (CD-A3)

```
npm test          # completo. NO sólo los archivos tocados. NO redirigido a un archivo.
npx tsc --noEmit  # completo, no `npm run build` (lección WKH-196)
npm run lint      # biome check src/  — OJO: NO cubre test/
```

**Línea base a superar, no a igualar**: `286 archivos / 5624 passed | 19 skipped`, `tsc` exit 0
(medida por el orquestador sobre `8242b16`; **re-medila vos antes de la primera línea de código** — es
tu control positivo, y si no da eso, el problema es el árbol, no tu diff).
⚠️ **No existe script `qa` en este repo.** Son `test`, `lint` y `build`.
⚠️ **`npx vitest run > archivo` bajo el hook de `rtk` trunca a 500 chars y devuelve exit 0.** Correr sin
redirección. **Nunca leas un exit code después de un pipe.**
⚠️ Al cerrar cada wave: **barrido CD-A1** de todas las citas escritas en esa wave, con
`command sed -n 'Np' <archivo>`.

---

### W0 — SERIAL. Contratos, tipos, esquema. Cero red, cero wiring, cero cambio observable.

| # | Archivo | Qué |
|---|---|---|
| **W0.1** | `supabase/migrations/20260819000000_wkh314_solana_inbound_proofs.sql` + `_down.sql` | Tabla + PK `(caip2, signature)` + las 3 funciones `plpgsql` + `p_probe` + **gate de re-hidratación ejecutable en el `up`** (CD-14). El `_down` **renombra en vez de borrar**: la evidencia de a quién se le sirvió no se destruye. El gate aborta si el backup conserva filas `status='consumed'` — re-aplicar el `up` sobre una tabla vacía **borra el uso único de toda prueba ya gastada** ⇒ servicio gratis para cada firma histórica. **Aplicar a `bdwv`, NUNCA a `caldz`** |
| **W0.2** | `src/adapters/types.ts` | `SolanaInboundPresence` (DT-C2), `InboundObserveResult`, `InboundConsumeResult`, `SolanaInboundBinding`, `SolanaInboundChallenge`. **Bloque ADITIVO al final**, molde `:271-282`. **PROHIBIDO tocar `SettlementPresence`** |
| **W0.3** | `src/adapters/solana/schema-preflight.ts` | **Sólo** añadir `export` a `probeRpcHistoryRetention` (`:166`). Cuerpo byte-idéntico |
| **W0.4** | `src/adapters/solana/settle-ledger.ts` | **Sólo** añadir `export` a `isRelationMissingError` (`:99`) e `isTransportFailure` (`:122`) (DT-C4). Cuerpos byte-idénticos |
| **W0.5** | `src/adapters/solana/chain.ts` | `getSolanaFallbackConnection(): Connection \| null` (cacheada por proceso, con la validación anti-mainnet de CD-5), `getSolanaInboundPayTo()`, `getSolanaInboundChallengeSecret()`, `isSolanaX402InboundConfigured()`, y `_resetSolanaChain()` (`:162`) extendido para limpiar la conexión de fallback |

**Salida de W0**: las tres puertas verdes y **cero cambio de comportamiento observable** — `npm test`
debe dar **exactamente** la línea base. Si sube o baja el número de tests, algo se rompió o algo se
duplicó.
**Puede empezar sin WKH-316 mergeada** (§0.3).

---

### 🔬 Tarea bloqueante entre W0 y W1b — la medición en devnet

**Declarada en el SDD (DT-6 / R-1) y sigue sin resolverse: F2 no podía firmar una transacción.**

> Probar en **devnet** que una transferencia SPL con una clave de 32 bytes **inexistente** como cuenta
> **read-only no-firmante** aterriza, y que esa clave aparece en `transaction.message.accountKeys` de
> `getParsedTransaction`.

Es el supuesto sobre el que se apoya toda la convención Solana Pay y **todo DT-6**. **Si no aterriza,
DT-6 cae y hay que volver al memo** — y es infinitamente más barato descubrirlo antes de construir W1b
encima. Dejá la firma de devnet en el log de la wave: es evidencia citable para F4.

---

### W1 — PARALELIZABLE. Tres frentes, archivos disjuntos.

| # | Archivo | Qué | Depende de |
|---|---|---|---|
| **W1a** | `src/services/solana-inbound-proof.ts` (nuevo) | Seam **fail-CLOSED** del single-use. Importa los clasificadores exportados en W0.4. Tipos de retorno: uniones con ≥3 estados, **nunca `boolean`, nunca `T \| null`**. Vive en `src/services/` y **no** en `adapters/solana/`, porque `settle-ledger.ts:40-45` declara ser el **único** archivo de `adapters/solana/**` con acceso a datos (CD-7 de WKH-307), y porque es el reemplazo directo de `services/x402-nonce.ts` | W0.1, W0.2, W0.4 |
| **W1b** | `src/adapters/solana/inbound-presence.ts` + `src/adapters/solana/inbound-verify.ts` (nuevos) | `inbound-presence.ts`: el probe (exemplar literal `deposit-verifier.ts:117-166`) + los términos por **SUMA** (DT-C3). `inbound-verify.ts`: el combinador de doble proveedor (**función pura** sobre dos `SolanaInboundPresence`, §6.2) + la lectura del binding (`accountKeys` ∪ `meta.loadedAddresses`; **si la tx es v0 y no se pueden resolver las direcciones cargadas, el veredicto es `unknown`, JAMÁS "la referencia no está"**) | W0.2, W0.5, **la medición en devnet** |
| **W1c** | `src/lib/solana-x402-challenge.ts` (nuevo) | `buildSolanaChallenge()` / `verifySolanaChallengeReference()`. HMAC, puro, comparación en **tiempo constante**, expiración absoluta. **Cero red, cero DB.** Base58 vía `src/adapters/solana/base58.ts` (`base58Encode` `:27` / `base58DecodeToBytes` `:62`) — **PROHIBIDO** escribir un codificador base58 nuevo (CD-11) | W0.5 |

---

### W2 — SERIAL. Preflight y wiring.

| # | Archivo | Qué |
|---|---|---|
| **W2.1** | `src/adapters/solana/inbound-preflight.ts` (nuevo) | Cache single-flight (molde `schema-preflight.ts:240-275`: positivo para siempre, negativo con TTL). Verifica **cuatro** cosas, fail-closed con motivos distinguibles: (1) la tabla + los RPC del store resuelven (`p_probe`, prueba **positiva**); (2) la retención de historia del RPC (reusa el símbolo exportado en W0.3, **sin duplicarlo**); (3) `getTokenAccountsByOwner(payTo,{mint})` devuelve exactamente 1 (señal al operador, DT-C3); (4) **`SOLANA_X402_INBOUND_PAY_TO` ≠ la ATA de depósito de WKH-315** (DT-C5, motivo `SOLANA_INBOUND_PAYTO_COLLIDES_WITH_DEPOSIT`) |
| **W2.2** | `src/adapters/registry.ts` | `acceptsInboundPayment` (`:522-524`) pasa a capacidad real: `evm` ⇒ `true` (**idéntico a hoy**); `solana` ⇒ `isSolanaX402InboundConfigured()`. **UNA sola definición**, la que ya consumen el guard del middleware (`x402.ts:479`) y `/capabilities` (`capabilities.ts:57-58`), para que no puedan divergir |
| **W2.3** | `src/middleware/x402.ts` | (a) extraer `emitInboundSettleUnknown` (`:674-730`) a función de módulo (DT-14); (b) insertar la bifurcación Solana **entre `:512` y `:514`**, sobre `bundle.payment.vmFamily`, con **`return` inmediato**; (c) `buildSolanaX402Response` + el handler inbound Solana con la secuencia de §6.1. **Ni una línea del camino EVM aguas abajo (`:514-891`) se modifica** |
| **W2.4** | `src/index.ts` | Warm-up del preflight inbound, fire-and-forget, **sólo con el flag ON**. Una línea, junto a `:448` (`if (process.env.SOLANA_ADAPTER_ENABLED === 'true') warmSolanaSchemaPreflight();`) |

---

### W3 — Docs y config. Sin código de runtime. ⏸ **ESPERA A QUE WKH-316 ESTÉ MERGEADA.**

`.env.example` (bloque nuevo con las 3 variables + la advertencia devnet del fallback) ·
`doc/INTEGRATION.md` (cómo paga un tercero en Solana: la tupla del 402, el sobre X-PAYMENT, la tabla
completa de `error_code` de §8.3 y **cuáles son reintentables**) ⚠️ **archivo compartido con WKH-316** ·
`doc/MULTI-CHAIN.md` (la asimetría deja de ser total; `TD-INBOUND-MULTI-ATA` registrado) ·
`doc/sdd/_INDEX.md:179` (**editar la celda de estado, NO agregar fila** — §3.5).

---

## 10. Tests requeridos

Archivos: los 8 de §3.2. Helpers compartidos en `test/helpers/` — **nunca importar un `.test.ts` desde
otro** (duplica sus suites; medido en WKH-307).
**CD-12 es obligatorio en los fixtures**: firmas y pubkeys derivadas de `@solana/web3.js` /
`src/adapters/solana/base58.ts`, nunca `'x'.repeat(88)`.

### 10.1 Cobertura por AC

| AC | Tests | Qué se afirma |
|---|---|---|
| **AC-1** (challenge) | `T-CHAL-01/02/03` | 402 con `x-payment-chain: solana-devnet` y flag ON trae `network` CAIP-2, `mint` base58, `maxAmountRequired` atómico, `payTo` base58, `reference` y `expiresAt` absoluto · la `reference` **cambia** entre dos 402 del mismo endpoint · `maxAmountRequired` sale de **una sola** resolución |
| **AC-2** 💰 (grant) | `T-GRANT-01/02/03` | firma `finalized` + referencia correcta + monto ≥ + no reclamada ⇒ acceso, y la fila queda `consumed` **antes** de que el handler responda · el consumo se `await`ea · monto **estrictamente mayor** ⇒ concede |
| **AC-3** 💰 (replay) | `T-REPLAY-01…05` | los 5 escenarios de §7.3, incluido el concurrente y el `terms_conflict` |
| **AC-4** 💰 (monto corto) | `T-SHORT-01/02` | `X402_SOLANA_AMOUNT_SHORT`, distinguible de replay y de unknown · **no consume**: una segunda presentación con el monto correcto **no** da replay |
| **AC-5** 💰 (destino/mint/referencia) | `T-TERMS-01…05` | destino ≠ `payTo` ⇒ deniega, **cero** intentos de reembolso · mint ≠ configurado ⇒ deniega · firma válida **salvo** la referencia (la "robada del explorer") ⇒ deniega · `blockTime` anterior a `issuedAt` ⇒ deniega · **MAC forjado ⇒ deniega ANTES de tocar la red (cero llamadas al RPC, se cuentan)** |
| **AC-6** 💰 (`unknown`) | `T-UNK-01…07` | RPC que tira en los **dos** ⇒ `unknown`, **nunca** `absent` · store mudo ⇒ `unknown` y el reintento sigue siendo posible · el `unknown` emite `X402_SETTLE_UNKNOWN` **y** el `a2a_events` con `signature` + `reference` · un `track()` que tira **no** cambia la respuesta HTTP · primario `absent` + fallback `finalized_ok` ⇒ **grant**; primario `absent` + fallback `unknown` ⇒ **`unknown`** · primario `finalized_ok` + fallback `terms_mismatch` ⇒ **`terms_mismatch`** · **sin fallback configurado, un `unknown` sigue siendo `unknown`** |
| **AC-7** 💰 (EVM byte-idéntico) | `T-EVM-01…10` | **las 8 suites x402 verdes SIN MODIFICARSE**, con el flag Solana ON y OFF · con el flag OFF, `x-payment-chain: solana-devnet` sigue dando **400** `CHAIN_INBOUND_PAYMENT_UNSUPPORTED` con el mismo mensaje y la misma lista · `src/adapters/solana/payment.test.ts` y `src/adapters/solana/intent-dedup.test.ts` verdes **sin modificarse** (prueba de que `payment.ts` no se tocó) |
| **AC-8** (capacidad pública) | `T-CAP-01/02/03` | flag OFF ⇒ `/capabilities` publica `false` (suite existente `capabilities.inbound-chains.test.ts` **intacta**) · flag ON **y config completa** ⇒ `true`, y el guard del middleware **concuerda** con lo publicado en el mismo proceso · flag ON pero **falta** `SOLANA_X402_INBOUND_PAY_TO` o el secreto ⇒ `false` y camino cerrado |
| **AC-9** 💰 (cero claves privadas) | `T-KEY-01/02` | espía sobre `getSolanaOperatorKeypair` (`chain.ts:84`): **cero** invocaciones en **todos** los caminos inbound, grant y los 8 rechazos · espía sobre `sendRawTransaction` / `sendTransaction`: **cero** invocaciones en todo el camino inbound |

### 10.2 Tests de los CD y de las decisiones nuevas

| ID | Qué afirma |
|---|---|
| `T-NOCONS-01` 💰 | **Paramétrico sobre los 8 motivos de rechazo**: en los ocho la firma sigue gastable (una presentación posterior válida concede) |
| `T-RETRY-01` | Sólo `X402_SOLANA_NOT_FINALIZED`, `X402_SOLANA_PROOF_ABSENT` y `X402_SETTLE_UNKNOWN` llevan `Retry-After`. Los otros cinco, no |
| `T-FINAL-01` 💰 | **DT-C2**: una tx `confirmed` pero **no** `finalized` ⇒ `X402_SOLANA_NOT_FINALIZED`, **no** grant, **no** consume, **con** `Retry-After` |
| `T-FINAL-02` | `confirmationStatus` ausente o con un valor no reconocido ⇒ **`unknown`**, nunca `not_finalized` ("no sé" no es "todavía no") |
| `T-SUM-01` 💰 | **DT-C3**: `payTo` con **dos** cuentas de token del mismo mint, el crédito en la segunda ⇒ **concede igual** (la suma lo ve). Con `.find()` daría un `terms_mismatch` falso sobre un pago real |
| `T-COL-01` | **DT-C5**: `SOLANA_X402_INBOUND_PAY_TO` == la ATA de depósito de WKH-315 ⇒ el preflight **falla cerrado** con `SOLANA_INBOUND_PAYTO_COLLIDES_WITH_DEPOSIT`. **Gemelo positivo**: direcciones distintas ⇒ el preflight pasa. **Segundo gemelo**: `A2A_DEPOSIT_OWNER_SOLANA` ausente ⇒ el preflight pasa (no hay colisión posible) |
| `T-CACHE-01` 💰 | **DT-12**: segunda petición con la fila en `observed` ⇒ **cero** llamadas al RPC. **Se asertan las llamadas, no sólo el resultado** (CD-10c) |
| `T-MIG-01…05` | El `.sql` tiene la PK `(caip2, signature)` **y es PRIMARY KEY**, `amount_atomic TEXT` (**no** NUMERIC), `REVOKE ALL` + `GRANT` sólo a `service_role`, `search_path` fijo en las 3 funciones, y el **gate de re-hidratación** en el `up`. Sin T-MIG-01 la HU podría shipear con el uso único ausente y **todo lo demás verde** |
| `T-EXP-01` | **DT-C4 / W0.3**: `settle-ledger.test.ts` y las suites del preflight verdes **sin modificarse** tras agregar los `export` |

### 10.3 La campaña de mutación

**Los ACs de dinero (💰) no se consideran cubiertos por "la suite pasa": se consideran cubiertos por
COBERTURA de sus líneas de guard + el mutante correspondiente MUERTO.**

Los 34 mutantes del SDD §10 (M1…M34 + M-P1) siguen vigentes **salvo M-P1** (era sobre la extracción de
`payment.ts`, que se descopeó — C-1). Se agregan cinco:

| # | Mutante | Debe matarlo |
|---|---|---|
| **M35** | Aceptar `confirmed` como grant (o sea, ignorar `confirmationStatus`) | `T-FINAL-01` |
| **M36** | Mapear un `confirmationStatus` ausente a `not_finalized` en vez de a `unknown` | `T-FINAL-02` |
| **M37** | Cambiar la suma de DT-C3 por un `.find()` | `T-SUM-01` |
| **M38** | Quitar el chequeo de colisión con la cuenta de depósito | `T-COL-01` |
| **M39** | Poner `finalized_ok` antes de `terms_mismatch` en la precedencia de §6.2 | `T-UNK-06` |

**La mutación de la HU sigue siendo M6**: hacer que el seam del store falle **abierto** ante un error de
DB (o sea, copiar `x402-nonce.ts:47-50`). Si M6 sobrevive, la HU no está.

**Reglas de la campaña** (CD-10 / CD-13 / CD-A4): cada mutante se reporta con **el nombre del test que
falló y el motivo**; **`no tests` NUNCA cuenta como KILLED**; antes de mutar, **copia física fuera del
árbol de git + `sha256sum`**, y verificación del hash al restaurar. `git checkout --`, `git restore` y
`git stash` **no son mecanismos de undo**.

---

## 11. Lo que esta HU NO entrega — con todas las letras

Esta sección existe para que **nadie** lea el reporte final de esta HU y concluya "el dinero ya entra por
Solana, listo". **No es así.** Cada línea de acá es falsable con un comando.

1. **El rail queda ENCENDIDO SÓLO PARA DEVNET, y por defecto APAGADO.**
   `SOLANA_X402_INBOUND_ENABLED` nace en `false` y se ANDea con `SOLANA_ADAPTER_ENABLED` (que también
   está en `false` en `.env.example:1205`). Sin las dos en `'true'` **más** las dos variables de
   config, `acceptsInboundPayment` sigue devolviendo `false` para Solana y el 400 de hoy sigue saliendo
   igual. **Mergear esta HU no enciende nada.**
   *Falsable con*: `curl .../capabilities | jq '.chains[]|select(.key=="solana-devnet")'` tras el deploy
   ⇒ debe seguir diciendo `acceptsInboundPayment: false` hasta que el operador haga los 5 pasos de §12.

2. **En producción el carril Solana está apagado hoy.** `GET /health` publica
   `solanaPayoutRoute: {"state":"rail_off"}` (2026-08-19). Esta HU **no lo enciende** y no toca esa
   bandera: es del leg de **salida** (`src/adapters/solana/facilitator-settle.ts`).

3. **NO hay mainnet, y ahora hay mecanismo para las DOS variables de RPC.** CD-5, sin slug `-mainnet`.
   La validación anti-mainnet existía **sólo para el fallback**, que es opcional, mientras `SOLANA_RPC_URL`
   —obligatoria, y la que construye la `Connection` primaria— no se validaba en ningún lado: con ella
   apuntando a mainnet el preflight pasaba y todos los cobros se verificaban contra otro ledger (AR,
   BLQ-MED-3). El preflight inbound ahora falla cerrado con `primary_rpc_is_mainnet`.
   *Falsable con*: `SOLANA_RPC_URL=https://api.mainnet-beta.solana.com` + las 4 envs del inbound ⇒ el
   preflight devuelve `{ok:false, failure:'primary_rpc_is_mainnet'}` (T-PRE-04c) y el rail queda apagado.
   ⚠️ **Y ACOTA, NO CIERRA**: el guard mira si la URL se DECLARA de mainnet. Un endpoint de mainnet con
   hostname opaco (la red dentro del api-key) pasa los dos guards, y ninguna de estas frases afirma lo
   contrario.

4. **El camino PREPAGO (a2a-key) sigue sin pasar por acá.** Con `x-a2a-key` presente,
   `requirePaymentOrA2AKey` **nunca** delega en este handler (está escrito en `x402.ts:476-478`), y
   resuelve la chain con su propio `resolveTargetChain`. El fondeo de esa clave en Solana lo entregó
   **WKH-315**, no esta HU.

5. **Sigue habiendo un camino EVM-only, y es grande**: `getPaymentAdapter()` (`registry.ts:426`) sigue
   siendo `EvmPaymentAdapter` y sigue lanzando sobre non-EVM. Todo el pipeline
   `buildX402Response → resolvePaymentRequirements → verify → settle → re-verify` **sigue siendo
   EVM-only**. Esta HU **bifurca antes** de tocarlo (DT-4) y **no lo generaliza**. Un adapter Solana
   ahí sigue sin existir.

6. **El leg gateway → agente NO cambia.** `src/services/compose.ts` sale del Scope IN con evidencia
   (SDD §3): `compose.ts` gobierna el pago **al agente**, no el pago **al gateway**. Que un caller pueda
   pagarnos en Solana **no** hace que le paguemos al agente en Solana.

7. **El testigo NO se movió al facilitator.** `wasiai-facilitator` recibe **cero bytes**. Su
   `verifyPayoutSignature` sigue sin usarse desde acá. Es una HU aparte, en ese repo (DT-17).

8. **Nada de Solana Pay QR, SDK del pagador, gasless, escrow Anchor ni reembolso automático.** El 402
   publica la tupla; **construir el QR y firmar la transferencia es del pagador**, con su wallet y su
   fee.

9. **Un pago capturado y no servido se resuelve A MANO.** Residuo declarado (SDD DT-12 / R-5): si la
   respuesta HTTP se pierde después del consumo, el pagador queda cobrado sin servicio y su reintento da
   `replay`. **Es la misma postura que el camino EVM tiene hoy.** No se resuelve acá: se registra, y el
   destrabe es un runbook manual.

10. **Esta HU es NECESARIA pero NO SUFICIENTE** para el entregable *"los 3 agentes del pipeline de
    Chaski se cobran en Solana"*: eso además exige que Chaski efectivamente pague por x402 Solana
    (repo `chaski-v3`, fuera de alcance) y que el leg de salida esté encendido.

### 11.1 `[NEEDS CLARIFICATION]` abiertos

| # | Pregunta | Default que este Story File aplica | ¿Bloquea F3? |
|---|---|---|---|
| **NC-1** | **¿El grant exige `finalized`, o alcanza `confirmed`?** Es una decisión de política de dinero, no técnica: `finalized` cuesta latencia al pagador (~13 s en devnet, **no medido acá**); `confirmed` acepta una tx que la cadena todavía podría descartar. WKH-315 ya eligió `finalized` para dinero que entra (`deposit-verifier.ts:41-43`) | **Exigir `finalized`** (DT-C2). Es el fail-closed y es coherente con la HU hermana ya mergeada. `not_finalized` es un aplazamiento con `Retry-After`, no una pérdida | **NO.** El diseño es aditivo: aflojar a `confirmed` sería borrar una rama del `switch`, no rediseñar |
| **NC-2** | **¿La referencia aterriza de verdad como cuenta read-only no-firmante?** (DT-6 / R-1 del SDD) | Se **mide en devnet** antes de W1b. Si no aterriza, DT-6 cae y se vuelve al memo | **SÍ bloquea W1b** (no W0, no W1a, no W1c) |
| **NC-3** | **¿Cuál es el límite de tasa real del endpoint RPC de la demo?** (R-3 del SDD) | No determinable sin generar carga contra un tercero. Mitigado por diseño: DT-10 (doble proveedor) + DT-12 (la cadena se pregunta **una vez por pago**, nunca en los reintentos) | **NO.** Se mide en W2 con una batería controlada contra el endpoint que se vaya a usar |
| **NC-4** | **¿La wallet receptora del inbound tiene que ser una tercera cuenta, distinta del operador Y de la ATA de depósito?** DT-C5 sólo exige distinta de la de **depósito** | Distinta de la de depósito: **obligatorio y con guard**. Distinta del operador: **recomendado**, no forzado (forzarlo rompería un despliegue existente sin ganar una garantía nueva — AC-9 ya prohíbe **derivarla** de la clave privada, que es lo que importa) | **NO** |

---

## 12. Precondiciones de despliegue (para el runbook de F4)

**El orden es normativo.** Cualquier permutación deja una ventana en que la capacidad se publica sin
estar cableada (rompe CD-6) o el camino verifica contra una tabla que no existe.

1. **Aplicar `20260819000000_wkh314_solana_inbound_proofs.sql` a `bdwv` ANTES de deployar el código.**
   **NUNCA a `caldz`** (regla del founder: `caldz` es mainnet y está PROHIBIDA). Sin la migración, el
   preflight falla cerrado y el inbound Solana no verifica: degradación **ruidosa y recuperable**, no
   servicio gratis.
2. **Setear `SOLANA_X402_INBOUND_PAY_TO`** con la **pubkey** base58 de la wallet receptora, y verificar
   que (a) tenga **exactamente una** cuenta de token para el mint configurado y (b) **no sea** la ATA de
   depósito de WKH-315 (DT-C5). **Nunca una clave privada en esta variable.**
3. **Setear `SOLANA_X402_INBOUND_CHALLENGE_SECRET`** con un secreto de alta entropía. Nunca en logs,
   nunca en el repo.
4. **Setear `SOLANA_RPC_URL_FALLBACK`** con un **segundo proveedor de devnet, distinto del primario**.
   Que sean el mismo endpoint **anula DT-10 entero**: un `unknown` tiene que ser caro de provocar, y dos
   llamadas al mismo nodo caído no lo son.
5. **Recién entonces `SOLANA_X402_INBOUND_ENABLED=true`.** Antes de eso todo el cambio es **inerte por
   construcción** (DT-11).

---

## 13. Done Definition — la HU termina cuando TODAS estas son ciertas

| # | Criterio | Cómo se verifica |
|---|---|---|
| 1 | Los 25 archivos de §3 tocados, y **ninguno más** | `git diff --stat` contra `main` |
| 2 | **`src/adapters/solana/payment.ts` con CERO cambios** | `git diff main -- src/adapters/solana/payment.ts` ⇒ vacío |
| 3 | **`src/services/compose.ts` y `src/types/index.ts` con CERO cambios** | ídem |
| 4 | Las **8 suites x402** verdes **SIN MODIFICARSE** | `git diff main -- 'src/middleware/x402.*.test.ts'` ⇒ vacío (salvo el archivo **nuevo**) |
| 5 | `capabilities.inbound-chains.test.ts`, `payment.test.ts`, `intent-dedup.test.ts`, `settle-ledger.test.ts` verdes sin modificarse | ídem |
| 6 | Las 3 puertas verdes, **sin pipe**, exit code leído directo | `npm test` (**> 5624 passed**) · `npx tsc --noEmit` (0) · `npm run lint` (0) |
| 7 | ≥1 test por AC, con el `error_code` asserteado (no sólo el status) — CD-A4 | §10 |
| 8 | Los 39 mutantes reportados con **el test que falló y el motivo**; `no tests` **nunca** como KILLED | `mutation-log.md` en la carpeta de la HU |
| 9 | La medición en devnet de NC-2 hecha, con la firma citada | log de la wave |
| 10 | **Barrido CD-A1**: cada cita `archivo:línea` escrita en el diff re-verificada con `command sed -n` **después** de la última edición | reporte de cierre |
| 11 | **Barrido CD-A2**: cada afirmación nueva en docblocks / `.env.example` / docs se puede completar con *"esto sería falso si \_\_\_"* con un input concreto | reporte de cierre |
| 12 | Fila `212` del `_INDEX.md` con la celda de estado actualizada, **sin duplicar la fila** | `npm test` (el guardián `sdd-index-matches-folders` se pone rojo si hay dos) |
| 13 | `auto-blindaje.md` escrito en la carpeta de la HU | archivo en disco, en el índice de git |
| 14 | **Cero `[NEEDS CLARIFICATION]` bloqueantes sin resolver**: NC-2 resuelto por medición; NC-1/3/4 declarados con su default aplicado | §11.1 |

---

*Story File generado por NexusAgil — FULL · nexus-architect · F2.5 · base medida `main@8242b16`*
