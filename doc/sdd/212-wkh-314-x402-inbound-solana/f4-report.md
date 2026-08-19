# F4 · Validación — WKH-314 · x402 inbound en Solana

**Veredicto: APROBADO** — 9/9 ACs en PASS con evidencia `archivo:línea`. Cero contaminación del árbol.
3 hallazgos de drift, **ninguno bloqueante para mergear el código apagado**; los tres son
**pre-requisitos para ENCENDER el rail**.

Rama `feat/212-wkh-314-x402-inbound-solana-f3`, HEAD `3e8ab83`. Base `main@75de7eb`. 2026-08-19.

---

## 1. Contaminación del árbol (mutantes en checkout compartido) — **DESCARTADA**

El dev declaró que M14–M18 corrieron sin worktree aislado y que no podía descartar residuo.

| Instrumento | Resultado |
|---|---|
| `/usr/bin/git status --porcelain` | 0 líneas |
| `/usr/bin/git diff HEAD --numstat` | 0 líneas |
| `git hash-object` vs `git rev-parse HEAD:<f>` en 11 archivos de mayor radio | **11/11 idénticos** |
| **Control positivo** | copia de `chain.ts` + 1 línea ⇒ `b5364627…` ≠ `1a67cb98…` ⇒ el instrumento distingue |

⚠️ **La declaración del dev era MÁS grave que la realidad.** Dijo que *"M16 tocó `src/routes/compose.ts`,
el de mayor radio"*. Inexacto: el SDD define M16 (`sdd.md:722`) como *"comparar la referencia con `===`
en vez de re-derivar"*, que vive en el camino Solana. **Ni `src/routes/compose.ts` ni
`src/services/compose.ts` fueron modificados por esta HU**, y los dos coinciden byte a byte con `main`.

---

## 2. ACs — 9/9 PASS

Suite propia de la HU: **160/160 passed, 0 failed**, 7 archivos, `testResults[].name` validado dentro
del JSON (no por exit code).

| AC | Status | Código | Test (por nombre) |
|---|---|---|---|
| **AC-1** challenge con red, mint, monto atómico, `payTo`, referencia única, expiración | ✅ | `solana-x402-challenge.ts:1-291` · emisión en `x402.ts:560` | `T-CHAL-01` `:71` · `T-CHAL-02b` `:92` · `T-CHAL-02c` `:115` (200 emisiones, 200 valores) · `T-CHALX-01` `:403` |
| **AC-2** grant + registro durable **antes** de conceder | ✅ | `x402.ts:1031` (`recordInboundObserved`) · `services/solana-inbound-proof.ts` | `T-GRANT-01` `:447` · `T-GRANT-02` `:464` · `T-GRANT-03` `:513` · `T-STORE-00` `:78` |
| **AC-3** replay con código propio, sin depender del primer intento | ✅ | `x402.ts:884-889` · `:1032` | `T-REPLAY-01/04/05` `:478/:490/:499` · `T-STORE-04/05/11` |
| **AC-4** monto corto ⇒ código distinguible, **sin consumir** | ✅ | `x402.ts:959-966` | `T-SHORT-01` `:519`/`:486` · `T-NOCONS-01` `:799` (los **ocho** motivos dejan la firma gastable) |
| **AC-5** destino/mint distinto ⇒ deniega sin consumir ni reembolsar | ✅ | `inbound-presence.ts:280-…` · `x402.ts:1007-1019` | `T-TERMS-01/02/03` · `T-TERMS-05` `:546` (MAC forjado ⇒ **cero llamadas al RPC**, contadas) · `T-BIND-09` |
| **AC-6** `unknown` nunca `absent`, canal EVM, deniega sin consumir | ✅ | `x402.ts:866-880` → `:404-475` (**el mismo** canal de EVM, DT-14) | `T-UNK-01/02/03b/05/07/07b` |
| **AC-7** EVM byte-idéntico | ✅ | `/usr/bin/git diff main...HEAD -- src/adapters/{avalanche,base,kite-ozone,tempo,inbound,escrow}/` = **0 bytes** · **control positivo** `src/adapters/solana/` = **120.728 bytes** | **231/231 passed** en 11 suites, **ninguna modificada** |
| **AC-8** `/capabilities` publica `true` sii cableado y habilitado | ✅ | **Una sola expresión**: `registry.ts:523-538`, consumida por `capabilities.ts:58` y por el guard `x402.ts:1223` | `T-CAP-01/02/03` + runtime (§4) |
| **AC-9** cero claves privadas Solana en el inbound | ✅ | grep de `Keypair\|sendRawTransaction\|PRIVATE_KEY` sobre los 5 módulos ⇒ **0**; **control positivo** `payment.ts` ⇒ **4** | `T-KEY-01` `:860` (espía, cero invocaciones) |

---

## 3. El money-path que cambió DESPUÉS del CR — verificado, con un costo real

`inbound-presence.ts:238-250`.

**a) Tx que falló de verdad y está `finalized` ⇒ ¿sigue `landed_failed`?** ✅ **SÍ.** `:239-241`.
Gemelo positivo `T-FAIL-01` `:295` + `T-TERMS-11` `:637`. **El caso terminal no se perdió.**

**b) `err` sin finalidad ⇒ ¿deniega sin consumir, reintentable?** ✅ **SÍ.** `:242-249` ⇒ `unknown`;
`x402.ts:994-1000` deniega **sin** llamar a `recordInboundConsumed` (el consumo está en `:1031`,
después del `switch`), y `X402_SETTLE_UNKNOWN` ∈ `SOLANA_RETRYABLE_CODES` ⇒ `Retry-After: 15`.
`T-FAIL-02` `:315`, `T-FAIL-03` `:330` (el escenario exacto del CR), `T-NOCONS-01` `:799`.

**c) 🔴 El costo operativo que el dev declaró NO medido — se midió. Es real.** (no bloqueante)

`unknown` dispara `emitUnknown` (`x402.ts:995`) → `emitInboundSettleUnknownEvent` (`:404`), que hace
**dos** cosas por invocación: un `request.log.error` de nivel **ERROR, alertable** (`:425`), y una fila
durable en `a2a_events` con `status:'failed'` (`:448-465`). **Sin dedup ni rate-limit** — contraste
medido en el mismo archivo: `warnDefaultChainApplied` **sí** tiene dedup con cap (`:120-134`).

Aritmética: una tx que falló de verdad, con un cliente que obedece el `Retry-After: 15`, en 60 s ⇒
**4 logs ERROR + 4 filas `a2a_events` failed** por un pago que nunca va a prosperar. Antes del fix-pack 2
ese caso costaba **1 log `info` y 0 eventos**. Amplificación 0 → N por fallo genuino.

**Y el mensaje es EVM-específico y falso para el productor nuevo.** `x402.ts:437` emite, para el camino
Solana (`txHash: null` siempre, `:877`):

> *"the facilitator hop was cut without an answer, so the payment may have executed on-chain… the caller
> may have been charged"*

En el inbound Solana **no hay facilitator** (firma el pagador; el gateway sólo lee la cadena), y en el
caso `err`-sin-finalidad el caller **no** fue cobrado por nosotros. Compartir el canal fue correcto
(DT-14 lo argumenta bien); **no se ajustó el texto para el segundo productor**.

**Recomendación (TD, post-DONE)**: parametrizar el mensaje por productor y evaluar dedup por
`(caip2, signature)` **antes de encender el rail**.

---

## 4. Runtime

**`GET /capabilities` re-corrido hoy** (Railway, HTTP 200, 51.414 bytes):

```
kite-ozone-testnet  acceptsInboundPayment: true
avalanche-fuji      acceptsInboundPayment: true
base-sepolia        acceptsInboundPayment: true
solana-devnet       acceptsInboundPayment: false
```

**Coincide exactamente con el `curl` publicado en `README.md:214` y `README.es.md:248`. El README NO
quedó falso.**

**Segundo control, `POST /compose` real** con el body del propio README:
- `x-payment-chain: solana-devnet` ⇒ **HTTP 400** `CHAIN_INBOUND_PAYMENT_UNSUPPORTED`
- **Control positivo** `base-sepolia` ⇒ **HTTP 402**, `"network":"eip155:84532"`, `"maxAmountRequired":"30300"`

**Gates a HEAD `3e8ab83`** (re-corridos: el CR rechazó y después aterrizaron 2 commits):

| Gate | Resultado |
|---|---|
| `npx tsc --noEmit` | exit **0** |
| `npm run lint` | exit **0**, 501 archivos |
| `npm run test:coverage` | exit **0** · 5923 passed, 19 skipped |

---

## 5. Cobertura — **nadie la corrió en toda la HU. Se corrió. Pasa.**

Piso del CI (`vitest.config.ts:26-31`): 80 / 70 / 80 / 80.

| | HEAD `3e8ab83` | Piso | Margen |
|---|---|---|---|
| Statements | **88,02 %** | 80 | +8,02 |
| Branches | **80,61 %** | 70 | +10,61 |
| Functions | **92,69 %** | 80 | +12,69 |
| Lines | **89,54 %** | 80 | +9,54 |

**Las ~550 líneas nuevas SUBIERON la cobertura global** (el 2026-08-15 era 87,49 / 79,64 / 92,48 / 89,02).

Por archivo nuevo: `inbound-presence.ts` 96,77/96,20/100/97,67 · `solana-x402-challenge.ts`
97,05/96,00/100/96,96 · `inbound-verify.ts` 89,61/91,42/100/92,75 · `inbound-preflight.ts`
90,00/73,21/**72,72**/92,10 · `solana-inbound-proof.ts` **82,35/74,32/85,71/82,50** · `x402.ts`
89,34/81,36/100/91,03.

⚠️ Observación no bloqueante: `solana-inbound-proof.ts` es el módulo **del uso único** —el fail-closed
que sostiene AC-3— y es **el de menor cobertura del lote**. Lo descubierto son ramas de error de
`probeInboundProofStore()`, que sí tiene tests directos (`T-STORE-20…23`).

Los 19 skipped son **pre-existentes**: grep de `describe.skip|it.skip|.todo(` sobre los 7 archivos de la
HU ⇒ **0** (control positivo: 7 archivos del repo sí los tienen, todos `*.real.test.ts`).

---

## 6. Drift detection

### 6.1 · Los 6 README condicionados (`MNR-2`) — ✅ **ciertos en los dos estados**

El condicional va **dentro** de la afirmación, no en nota al pie: *"in the deployment that is up right
now"*, *"while the rail envs are unset, which is today's deployment"*, y cada uno dice qué pasa con el
otro estado (*"with the envs set, that same request answers 402"*).

### 6.2 · 🔴 **Pero el mensaje de la API al que el README manda a mirar NO se condicionó** — hallazgo nuevo

`README.md:97` promete: *"That is a **configuration** statement, not a limit of the code"*.

El artefacto que el integrador recibe de verdad, `x402.ts:109-117` (`inboundPaymentUnsupportedMessage`),
**no se tocó en esta HU** y afirma **sin condicional**:

```
It is an OUTBOUND settlement rail: … callers cannot pay the gateway there —
the inbound leg needs an EVM signed authorization (EIP-3009), which this
chain's payment adapter does not implement.
```

Presentado como propiedad **del código** (*"it is"*, *"does not implement"*), que es exactamente lo que
el README dice que **no** es. Y no nombra la tercera salida que ahora existe: pedirle al operador que
encienda el rail. **Repo público, y este mensaje sale HOY en producción** (HTTP 400, medido en §4).

**Conecta con §6.3**: la frase está **clavada por un test verde**, `T-204-03` en
`x402.non-evm-inbound.test.ts:307` (`expect(body.error).toMatch(/OUTBOUND settlement rail/)`), que es el
archivo que el Scope IN mandaba reescribir. **Nadie lo va a ver ponerse rojo.**

Severidad **MENOR**: no rompe AC-7 (byte-idéntico a `main`) ni AC-8. Es **engañoso, no falso**.
**Corregir antes de encender el rail.**

### 6.3 · Scope drift — un ítem del Scope IN declarado y NO hecho

`work-item.md:284-285`, literal: *"reescritura **DELIBERADA** de
`src/middleware/x402.non-evm-inbound.test.ts` … **reescribir, no borrar**"*.

Medido: `git diff main...HEAD --stat` sobre ese archivo = **vacío**. La HU agregó
`x402.solana-inbound.test.ts` (1106 líneas, 38 tests) en vez de invertir aquél. **Cobertura neta:
mayor. Fidelidad al Scope IN: incumplida** — y es la omisión que produjo §6.2.

Otro ítem del Scope IN **obsoleto** (no es culpa del dev): `work-item.md:280-281` manda extender el
guard `inboundVmUnsupported` en `services/compose.ts:1430-1462`. **Ese guard ya no existe** — lo borró
HU-DOUBLE-PAY (`compose.ts:1625-1632`). El work-item citaba un artefacto muerto.

Wave drift: **ninguno**. 4 commits en orden F3 → fix-pack AR → fix-pack CR → docs.

### 6.4 · `auto-blindaje.md:121-149` (`MNR-7`) — ✅ **la versión corregida es cierta, reproducida**

| Comando | Salida |
|---|---|
| `/usr/bin/wc -l chain.ts` | `329` |
| `cat -n chain.ts \| tail -1` (hook) | **vacío, exit 0** |
| `cat -n chain.ts \| wc -l` (hook) | `329` |
| `/usr/bin/cat -n chain.ts \| /usr/bin/tail -1` | `   329	}` |

**Reproducido exactamente.** El pipe entrega los datos (`wc -l` los cuenta) y los pierde **según el
consumidor del otro lado**. La entrada dice la verdad y trae el control que distingue Y de no-Y.

### 6.5 · Citas ancladas — ✅ **las 5 rotas están en 0, re-verificadas DESPUÉS de la última edición**

Re-derivado sobre HEAD `3e8ab83`: `:1226` ⇒ **0** · `:1217` ⇒ **0** · `:1272` ⇒ **0** · `:1030-1033` ⇒
**0** · `:1031` ⇒ **0**. **Control positivo del cero**: `grep -c "674-730\|479-497" story-file.md` ⇒ **5**.

El fix aplicado es **el bueno, no el frágil**: se citó **el símbolo**, no la línea.

**`database.types.ts:2567` — ✅ intacto**: `/usr/bin/sed -n '2567p'` ⇒ `owner_ref: string;`, dentro de
`registries.Row` (control de vecindad: `:2565` = `invoke_endpoint`, `:2568` = `schema`).
`cited-lines-guard` **12/12** · `ownership-filter-guard` **13/13**.

### 6.6 · `a2a-key.ts:1606` — ✅ **deuda preexistente de `main`, confirmado en las dos direcciones**

`git show main:src/middleware/x402.ts` ⇒ la cita está en **`main`, línea 477**. `git grep -n` en `main`
⇒ **dos** sitios. `git diff main...HEAD -- src/middleware/a2a-key.ts` ⇒ **vacío**. Esta HU sólo
**desplazó** la línea citante (477 → 1221). **No se le imputa a WKH-314.**

---

## 7. Lo que NO se pudo medir (palabras del F4)

1. **Que la migración esté aplicada en cualquier base.** Prohibido aplicarla; no se consultó ninguna. Los
   11 tests `T-MIG-01…11` leen **el texto del `.sql`**, no el esquema de un servidor. *"El archivo dice
   X" ≠ "el servidor tiene X"*. Sin la tabla, `probeInboundProofStore()` da `table_missing` y el
   preflight cierra el camino (`T-PRE-02`) — **falla cerrado**, pero nadie verificó el otro extremo.
2. **El comportamiento del rail ENCENDIDO contra devnet real.** Todo AC-1…AC-6 está probado con dobles.
   **No se presentó una firma real** de una transferencia USDC-SPL de devnet contra un gateway con las 4
   envs puestas, ni se observó un `{err, confirmationStatus:'processed'}` real de un fork descartado.
3. **El volumen real de la alerta de §3.c.** Se calculó la aritmética leyendo el `Retry-After: 15` y la
   ausencia de dedup. **No se observó bajo carga** ni se conoce el umbral de alertas del destino de logs.
4. **La paridad de env vars contra Railway.** No se listaron las variables (los tokens son de alcance
   limitado). Se midió **la consecuencia observable** (`/capabilities` publica `false`, que por
   `registry.ts:537` sólo sale de `isSolanaX402InboundConfigured()` en falso), **no las envs del servidor**.
5. **Si otro agente leyó un archivo mutado durante las ventanas de ~30 s.** El árbol de HOY está limpio
   (§1) y eso descarta residuo; **no descarta** que un tercero haya medido contra un estado transitorio
   y publicado una conclusión falsa en OTRO artefacto. **Inobservable desde acá.**

---

## 8. Smoke manual — para el operador, ANTES de encender el rail

```
0. Aplicar 20260819000000_wkh314_solana_inbound_proofs.sql en bdwv (NUNCA caldz).
1. Verificar SOLANA_X402_INBOUND_PAY_TO != A2A_DEPOSIT_OWNER_SOLANA y != su ATA.
   El preflight falla cerrado (T-COL-01/01b), pero confirmalo: un choque cobra la misma
   transferencia dos veces.
2. Setear SOLANA_RPC_URL_FALLBACK con un nodo DISTINTO del primario. Sin el, un `absent`
   es UNA opinion, no una ausencia corroborada (x402.ts:990). El preflight solo AVISA.
3. Setear las 4 envs y redeployar. curl "$GW/capabilities" => solana-devnet debe pasar a true.
4. POST /compose con x-payment-chain: solana-devnet => 402 con network "solana:<genesis>",
   mint base58, payTo base58, reference, nonce y expiresAt.
5. Transferir USDC-SPL con esa reference, esperar `finalized`, presentar la firma => 200.
   Re-presentarla => 402 X402_SOLANA_PROOF_REPLAY.
6. En la base: SELECT status, amount_atomic FROM solana_inbound_proofs WHERE signature='<sig>'
   => una fila, status='consumed'.
7. Mirar el conteo de a2a_events con eventType='x402_settle_unknown' antes y despues (§3.c).
8. Corregir inboundPaymentUnsupportedMessage (x402.ts:109-117) y T-204-03
   (x402.non-evm-inbound.test.ts:307) ANTES de encender: hoy la API dice lo contrario del README.
```

---

## 9. Cierre

- **9/9 ACs PASS** con `archivo:línea` y test por nombre. Ninguno FAIL, ninguno NO VERIFICABLE.
- **Árbol no contaminado**, descartado con hashes y control positivo.
- **Gates verdes a HEAD**: `tsc` 0, lint 0, suite 5923 passed, coverage 88,02/80,61/92,69/89,54 sobre
  piso 80/70/80/80.
- **3 hallazgos, ninguno bloqueante para mergear el código apagado**, los tres **pre-requisitos para
  encender el rail**: §6.2 (el mensaje público que contradice al README), §6.3 (el test del Scope IN sin
  reescribir, que clava esa frase) y §3.c (el costo de alertas del `unknown`, con mensaje falso para el
  productor Solana).

**APROBADO para DONE.**
