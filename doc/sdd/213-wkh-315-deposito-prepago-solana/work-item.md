# Work Item — [WKH-315] La pared B: fondear la clave prepaga en Solana (deposit inbound)

**Tipo**: feature / money-path / multi-VM
**Estado**: F1 (work-item). NO hay decisión de diseño tomada, NO hay SDD.
**Repo**: `/home/ferdev/.openclaw/workspace/wasiai-a2a` (leído en SOLO LECTURA, rama `main`)
**Fecha de verificación del código**: 2026-07-29
**Directorio**: `213` — verificado libre. En el rango 2xx existen sólo 201, 202, 203, 208,
209, 210, 211, 212. **Ticket `WKH-315`**: el siguiente libre después de `WKH-314` (pared A).
**HU hermana**: `doc/sdd/212-wkh-314-x402-inbound-solana/work-item.md` (pared A, x402 inbound).
Corren **en paralelo, en worktrees separados** — ver §8 para el solapamiento y el orden de merge.

---

## 0. Corrección de las citas del encargo (verificadas antes de construir sobre ellas)

Se me pidió verificar tres citas. **El contenido de las tres es correcto; dos rutas de
archivo están mal.** Lo digo porque un sub-agente que las siga literalmente no encuentra
nada y puede concluir que el hallazgo no existe.

| Cita del encargo | Veredicto | Ruta real |
|---|---|---|
| `src/adapters/solana/deposit-verifier.ts:82-86` | ⚠️ **ruta incorrecta, contenido exacto** | `src/adapters/deposit-verifier.ts:82-86`. No existe ningún `deposit-verifier.ts` dentro de `src/adapters/solana/`. El comentario dice literalmente: `// WKH-234 — Solana rail. Deposit = Scope OUT (settle-only); código muerto` / `// para la ruta de deposit (Solana no entra al viem deposit-path).` |
| `src/routes/auth/deposit.ts:57` y `:63-65` | ✅ **exacta** | `:57` `const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;` · `:63` `!TX_HASH_RE.test(txHash) ||` · `:64-65` `typeof body.chain_id !== 'number' \|\| !Number.isFinite(body.chain_id)` |
| `SettlementPresence` en `src/adapters/solana/types.ts:170-187` | ⚠️ **ruta incorrecta, rango exacto** | `src/adapters/types.ts:170-187`. No existe `src/adapters/solana/types.ts`. Las 5 variantes están exactamente en ese rango. |
| `probeSettlementPresence` en `src/adapters/solana/payment.ts:572-644` | ✅ **exacta** (ruta y rango) | — |
| *(bonus, citado por WKH-314)* `src/lib/x402-nonce.ts:41-51` | ⚠️ **ruta incorrecta, contenido exacto** | `src/services/x402-nonce.ts:39-51`. El fail-open está en `:41-51` y su justificación escrita en el encabezado `:9-13`. |

**Conclusión de la verificación**: la pared B es real y está donde se dijo. La premisa
central del encargo —*hoy todo dólar que entra al sistema entra por EVM*— **se sostiene**,
y §1 la demuestra con las cuatro paredes concretas del camino de fondeo.

---

## Resumen

Hoy la clave prepaga (`a2a_agent_keys.budget`) **no se puede cargar en Solana**. El endpoint
de fondeo es viem de punta a punta y rechaza una firma base58 en la primera línea de
validación. Consecuencia: el requisito del mentor (*"los 3 agentes de Chaski se cobran en
Solana"*, *"no debe intervenir Avalanche"*) **no se cumple abriendo sólo la pared A**: si el
pagador usa clave prepaga, los agentes cobrarían en Solana con plata que entró por Avalanche.

Esta HU abre la pared B: que un owner pueda **fondear su clave con USDC de Solana devnet**,
verificado en cadena antes de acreditar, y acreditado **exactamente una vez**.

Fecha comprometida ante la incubadora (WayLearn / Solana LATAM Labs): semana del
**2026-08-03**. Restricción del founder que no se toca: **devnet, plata no real**.

---

## Sizing

- **SDD_MODE**: full (el repo es siempre QUALITY; esto es money-path de ENTRADA)
- **Estimación**: **M/L**
- **Branch sugerido**: `feat/213-wkh-315-deposito-prepago-solana`
- **Veredicto honesto contra el 2026-08-03**, corriendo en paralelo con WKH-314 en otro
  worktree: **el alcance completo no entra**. El corte mínimo sí, y está en §7 — junto con lo
  que NO se puede recortar sin dejar el camino del dinero a medias, y un corte alternativo
  que cambia código por un paso manual y que **no elijo yo** (§7.3).

---

## 1. El camino de fondeo actual, de punta a punta (relevado, archivo:línea)

`POST /auth/deposit` — `src/routes/auth/deposit.ts:46-182`.

| # | Paso | Dónde | Qué hace |
|---|---|---|---|
| 1 | Auth | `deposit.ts:48-52` | `resolveCallerKey(req)` (`parsers.ts:99-128`, hash SHA-256 del header `x-a2a-key` / Bearer `wasi_a2a_*`). De ahí sale el `ownerRef` — **nunca del body**. |
| 2 | **Validación del `tx_hash`** | `deposit.ts:57` + `:62-63` | `TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/`. Falla → **400 `INVALID_INPUT`**. |
| 3 | **Validación del `chain_id`** | `deposit.ts:64-65` | `typeof body.chain_id !== 'number' \|\| !Number.isFinite(...)`. Falla → 400 `INVALID_INPUT`. |
| 4 | Ownership pre-check | `deposit.ts:71-73` | `body.key_id !== callerKey.id` → 403. Un caller sólo fondea SU key. |
| 5 | Resolución de chain | `deposit.ts:76-87` | header `x-payment-chain` vía `resolveChainKey`, o `normalizeChainSlug(String(body.chain_id))`. Sin bundle → 400 `CHAIN_NOT_SUPPORTED`. |
| 6 | chainId autoritativo | `deposit.ts:88` | `const chainId = bundle.chainConfig.chainId; // CD-5` — **el chainId acreditado sale del bundle, jamás del caller**. |
| 7 | Match declarado vs real | `deposit.ts:91-93` | `body.chain_id !== chainId` → 400 `CHAIN_MISMATCH`. |
| 8 | **Verificación on-chain ANTES de acreditar** | `deposit.ts:98-111` | Selector escrow (`verifyEscrowDeposit`) vs treasury (`verifyDeposit`), por `escrowEnabledForChain` (`parsers.ts:93-95`). CD-4: verify-before-credit. |
| 9 | Mapeo de fallo | `deposit.ts:112-127` | `RPC_UNAVAILABLE` / `ESCROW_CONTRACT_NOT_CONFIGURED` → **503**; todo lo demás → **400**. **Sin crédito y sin consumir la prueba.** |
| 10 | **Gate de funding wallet** | `deposit.ts:129-138` | Exige `callerKey.funding_wallet` bindeada (403 `FUNDING_WALLET_NOT_BOUND`) **y** `result.from.toLowerCase() === callerKey.funding_wallet.toLowerCase()` (403 `FUNDING_WALLET_MISMATCH`). Es FIX-1 / BLQ-MED-1 — ver §4, es el corazón del problema. |
| 11 | **Crédito atómico** | `deposit.ts:142-149` → `budget.ts:720-760` | `budgetService.registerDeposit(keyId, chainId, result.amountUsd, ownerRef, txHash, tokenSymbol)`. Se acredita el **monto verificado on-chain**, nunca el declarado. |
| 12 | Recibo | `deposit.ts:153-164` | `receipt_type: 'deposit_verified'`, best-effort, `void` sin await — nunca bloquea ni propaga. |
| 13 | Respuesta | `deposit.ts:166` | `{ balance, chain_id }`. |

### 1.1 Quién verifica en cadena

`src/adapters/deposit-verifier.ts:243-378` (`verifyDeposit`), 100% viem
(`import ... from 'viem'`, `:12-19`):

1. `publicClient` per-chain, lazy (`:216-234`); sin RPC URL → `RPC_UNAVAILABLE` (`:250-252`).
2. `getTransactionReceipt` (`:257`); throw → `TX_NOT_FOUND` (`:258-259`).
3. `receipt.status !== 'success'` → `TX_REVERTED` (`:263-265`).
4. `getChainId()` vs `bundle.chainConfig.chainId` → `CHAIN_MISMATCH` (`:267-276`).
5. **Confirmaciones**: `Number(latest - receipt.blockNumber) + 1 >= resolveMinConfirmations()`
   (`:279-289`; el mínimo sale de `A2A_DEPOSIT_MIN_CONFIRMATIONS_<FAMILY>` → global → 1,
   `:94-103`).
6. **Destino + token + monto**: recorre `receipt.logs`, filtra por la dirección del token
   (`:314`), decodifica el evento `Transfer` (`:319-324`) y acepta el log cuyo
   `to == expectedTreasury` (`:331-338`), guardando `value` **y** `from` (`:335-337`).
   Sin log del token → `TOKEN_MISMATCH` (`:341-343`); sin log al treasury →
   `RECIPIENT_MISMATCH` (`:344-346`).
7. **Monto → USD**: `formatUnits(amountAtomic, token.decimals)` (`:349`); si el caller declaró
   `amount`, se compara **BigInt contra BigInt** reparseando con los mismos decimals
   (`:350-365`, FIX-3: `Number()` colapsaba precisión).

### 1.2 Dónde se acredita el saldo, y **cómo se garantiza que no se acredite dos veces**

Éste es el punto que el encargo marca como el corazón, así que va completo.

`budgetService.registerDeposit` (`src/services/budget.ts:720-760`) llama la RPC
`register_a2a_key_deposit`, definida en
`supabase/migrations/20260529000000_a2a_key_deposits.sql:34-91`. **Todo pasa en UNA
transacción de Postgres**, en este orden:

1. `SELECT ... FROM a2a_agent_keys WHERE id = p_key_id **FOR UPDATE**` (`:52-56`) — lock de
   la fila de la key. Serializa depósitos concurrentes sobre la misma key.
2. `KEY_NOT_FOUND` si no hay fila (`:58-60`).
3. **Ownership Guard a nivel DB**: `v_owner IS DISTINCT FROM p_owner_ref` →
   `OWNERSHIP_MISMATCH` (`:62-65`). Existe porque el cliente usa `SUPABASE_SERVICE_KEY` y
   bypassea RLS.
4. `KEY_INACTIVE` (`:67-69`).
5. **EL ANTI-REPLAY**: `INSERT INTO a2a_key_deposits (...)` (`:75-76`). La tabla
   (`:7-18`) tiene
   `CONSTRAINT uq_a2a_key_deposits_chain_tx **UNIQUE (chain_id, tx_hash)**` (`:17`).
   El segundo INSERT con el mismo `(chain_id, tx_hash)` levanta `unique_violation`, que se
   traduce a `RAISE EXCEPTION 'DEPOSIT_ALREADY_CREDITED'` (`:77-79`) → **la transacción entera
   aborta y NO se acredita nada**.
6. **Sólo después** se acredita: `v_new := v_current + p_amount_usd` y `jsonb_set` sobre
   `a2a_agent_keys.budget` en la clave `p_chain_id::TEXT` (`:82-87`).
7. `budget.ts:749-751` traduce el error a `DepositAlreadyCreditedError` →
   `deposit.ts:168-171` → **409 `DEPOSIT_ALREADY_CREDITED`**.

**La clave única de de-duplicación es, hoy, `(chain_id, tx_hash)`**, y el reclamo se toma
**dentro de la misma transacción que acredita y antes del UPDATE del saldo**. Es una escritura
condicional atómica real, no un check-then-act. Es fail-CLOSED por construcción: si el INSERT
no entra, no hay crédito.

> **Nota importante para la política del founder**: el diseño actual **ya honra "rechazar sin
> consumir la prueba"** en los pasos 9 y 5. Un fallo de verificación (incluido
> `RPC_UNAVAILABLE` → 503) retorna **antes** de `registerDeposit`, así que **no se inserta
> ninguna fila** y el `tx_hash` sigue siendo reclamable cuando el RPC vuelva. Esta HU debe
> **preservar** esa propiedad en la rama Solana, no inventarla.

### 1.3 Las cuatro paredes que bloquean un depósito Solana hoy (en orden de aparición)

1. **`tx_hash` (`deposit.ts:57`,`:63`)** — una firma Solana es base58 (~87-88 chars), no
   `0x…{64}`. **Primera pared: 400 `INVALID_INPUT`.** Ninguna otra se alcanza.
2. **`chain_id` numérico (`deposit.ts:64-65`)** — Solana no tiene chainId. Su
   `chainConfig.chainId` es un **sentinel sintético** (`getSolanaSyntheticChainId()`, default
   **900001**, `src/adapters/solana/chain.ts:25`,`:65-70`), declarado **no autoritativo** en
   `chain-resolver.ts:277-278` y `registry.ts:263-264`.
3. **Resolución de slug (`deposit.ts:80`)** — `normalizeChainSlug(String(body.chain_id))`
   contra `SLUG_ALIASES` (`chain-resolver.ts:20-68`). **Solana tiene sólo alias literales**:
   `'solana-devnet'` y `'solana'` (`:65-66`). **No hay alias numérico `'900001'`** (todas las
   EVM sí lo tienen: `'43113'`, `'8453'`, `'42429'`…). Así que un `chain_id: 900001` sin
   header `x-payment-chain` → **400 `CHAIN_NOT_SUPPORTED`**.
4. **El verificador (`deposit-verifier.ts`)** — es viem entero. Si se llegara al paso 8 con
   `chainKey = 'solana-devnet'`, `getVerifierClient` (`:216-234`) llama `resolveChainObject`,
   que **lanza a propósito** (`:205-208`: *"solana-devnet has no viem Chain"*). Y esa llamada
   está **fuera** del `try` del handler (el `try` abre en `deposit.ts:141`) ⇒ el throw escapa
   al handler ⇒ **500**, no un error de negocio.

Y en la superficie pública, `GET /auth/deposit-info` **excluye Solana explícitamente**:
`deposit.ts:203-207` (*"WKH-234: deposit-info is an EVM-only listing (Solana deposit = Scope
OUT …)"*) descarta todo bundle cuyo `payment.vmFamily !== 'evm'`. O sea: hoy un dev **no tiene
forma de saber a dónde mandar USDC de Solana**, porque no lo publicamos.

---

## 2. Qué hay de Solana ya construido, y por qué el deposit quedó afuera

**Por qué se dejó afuera** (leído, no inferido): fue una **decisión de alcance de WKH-234**,
no un impedimento técnico. El comentario `deposit-verifier.ts:82-86` dice *"Deposit = Scope
OUT (settle-only)"*: WKH-234 introdujo el rail Solana **sólo para el leg de SALIDA** (gateway
→ agente). Los tres `case 'solana-devnet'` del verificador (`:84-85`, `:150-151`, `:177-178`)
existen únicamente porque los `switch` sobre `ChainKey` son **exhaustivos y el compilador los
exige** (ver el inventario en `types.ts:282-312`) — son código muerto declarado, no un
intento a medias.

**¿Sigue vigente esa razón?** **No.** Se apoyaba en que la entrada de dinero era EVM y
alcanzaba. El requisito del mentor la invalida. Lo que **sí** hay que respetar de esa decisión
es su forma: `resolveChainObject` **lanza** en vez de tener un `default` silencioso (`:202-209`
lo dice: *"Fail-loud, no `default` silencioso (CD-5)"*). La rama Solana del deposit debe
**bifurcar antes** de tocar viem, no "hacer que viem funcione con Solana".

**Piezas a REUSAR (relevadas, con archivo:línea):**

| Pieza | Dónde | Qué aporta al fondeo |
|---|---|---|
| **Presencia on-chain de 5 estados** | `src/adapters/types.ts:170-187` (`SettlementPresence`) | El tipo de tres valores **ya existe**: `landed_ok` / `landed_failed` / `landed_mismatch` / `absent` / `unknown`, exhaustividad forzada por el compilador. Su docstring (`:132-168`) es la regla del proyecto. **Se reusa, no se rediseña** (CD-3). |
| **El probe que lo produce** | `src/adapters/solana/payment.ts:572-644` (`probeSettlementPresence`) | `getSignatureStatuses([sig], { searchTransactionHistory: true })` (`:580-582`) — la **única** fuente admitida para una determinación NEGATIVA. Nunca lanza: todo fallo → `unknown` (`:583-585`). Hoy es **`private`** (`:572`) → ver §8.3. |
| **Validación de términos** | `src/adapters/solana/payment.ts` (`checkTerms`, ~`:1101-1130`) | Puro, sin red. Valida mint + monto + destino leyendo `pre/postTokenBalances`. Es el análogo exacto del `decodeEventLog(Transfer)` del EVM. |
| **Preflight de retención del RPC** | `src/adapters/solana/schema-preflight.ts:166-208` (`probeRpcHistoryRetention`) | **Verificado: es genérico y por proceso**, no específico del settle. Mide `getSlot` vs `getFirstAvailableBlock` y **corta el arranque** si la ventana retenida `<= BLOCKHASH_VALIDITY_SLOTS` (`:195-202`), o si no se puede medir y el operador no declaró `SOLANA_RPC_LEDGER_HISTORY_DECLARED_SUFFICIENT=true` (`:182-193`). Es la precondición de la que depende poder afirmar `absent`. **Esto resuelve el MI-5 de WKH-314**: ya cubre a cualquier consumidor de `absent`. Ninguna de las dos HUs tiene que construirlo; sólo NO debilitarlo. |
| **Doctrina del ledger durable** | `src/adapters/solana/settle-ledger.ts:15-39` | Escritura condicional atómica en plpgsql, fail-closed, ninguna función devuelve `boolean`. **El deposit ya cumple esa doctrina** con `register_a2a_key_deposit` (§1.2) — es el mismo molde, siete meses antes. |
| **Anti-replay durable ya existente** | `a2a_key_deposits` UNIQUE(chain_id, tx_hash) | **No hace falta tabla nueva.** Ver §5 y §8.4: `tx_hash` es `TEXT` sin CHECK de formato. |
| **Connection + commitment + mint + decimals** | `src/adapters/solana/chain.ts:39-77` | `getSolanaConnection()`, `getSolanaCommitment()` (default **`confirmed`**, `:23`,`:43-46`), `getSolanaUsdcMint()`, `getSolanaUsdcDecimals()`, `getSolanaCaip2()`. Todo env-driven, sin hardcodes. |

**Lo que NO se reusa**: `getSolanaOperatorKeypair()` (`chain.ts:84-100`). El fondeo es un acto
del **depositante**; el gateway sólo mira la cadena. Ver CD-4.

---

## 3. Las diferencias reales EVM vs Solana, derivadas del código

| Dimensión | EVM (hoy, en producción) | Solana | Consecuencia |
|---|---|---|---|
| **Identificador de la tx** | hash `0x…{64}` (`deposit.ts:57`) | firma base58 (~87-88 chars) | La validación de entrada debe bifurcar por familia. **La columna `a2a_key_deposits.tx_hash` es `TEXT` sin CHECK de formato** (migración `:12`) ⇒ **una firma base58 entra tal cual, sin migrar la columna.** |
| **Identificador de red** | `chain_id INT` (migración `:11`), real y verificado contra `getChainId()` (`deposit-verifier.ts:274`) | CAIP-2 (`caip2ChainId`, `types.ts:211`; `getSolanaCaip2()`). El `chainConfig.chainId` es un **sentinel sintético env-driven** (900001) declarado **no autoritativo** (`chain-resolver.ts:277-278`) | No hay nada que "comparar contra la cadena": la verificación de red en Solana es *"¿el RPC al que le pregunté es el cluster que creo?"*. Y el sentinel **es la clave del `budget` jsonb** (§1.2 paso 6) ⇒ decisión de producto, §6 `[DECIDE FOUNDER]` D-1. |
| **Prueba de que los fondos llegaron a NUESTRA cuenta** | evento `Transfer` del contrato ERC-20, filtrado por dirección de token y `to == treasury` (`deposit-verifier.ts:313-339`) | **no hay eventos**. Se comparan `pre/postTokenBalances` de la tx parseada (lo que hace `checkTerms`) | Código nuevo, aunque el patrón exista. **Y el destino no es una pubkey suelta: es la ATA (Associated Token Account) del operador para ESE mint.** Un transfer al owner sin ATA, o a la ATA de otro mint, no acredita nada. |
| **Resolución del destino esperado** | `resolveTreasury(chainKey)` (`deposit-verifier.ts:111-126`) | **LANDMINE VERIFICADO** | `resolveTreasury('solana-devnet')` busca `A2A_DEPOSIT_TREASURY_SOLANA`, lo testea contra `ADDRESS_RE = /^0x…{40}$/` (`:59`,`:114`) — **una pubkey base58 FALLA el test** — y cae al fallback `privateKeyToAccount(OPERATOR_PRIVATE_KEY).address` (`:117-124`), o sea **devuelve una dirección EVM como destino esperado de un depósito Solana**. Hoy es inalcanzable (pared 4), pero cualquier reuso ingenuo compara contra la cosa equivocada, en silencio. → CD-5. |
| **Mint / token correcto** | `token.address` de `supportedTokens[0]` (`EvmPaymentAdapter`), comparado lowercase (`:303`,`:314`) | `getSolanaUsdcMint()` base58, **case-SENSITIVE** | Prohibido `toLowerCase()` sobre base58. → CD-6. |
| **Finalidad** | conteo de confirmaciones: `latest - blockNumber + 1 >= min` (`:285-288`), mínimo por env (`:94-103`) | niveles de commitment. `getSolanaCommitment()` default **`confirmed`** (`chain.ts:23`,`:43-46`) | **`confirmed` NO alcanza para acreditar saldo.** `confirmed` es optimista (supermayoría de votos) y **puede descartarse**; `finalized` (rooted) no, en la práctica. Acreditar sobre `confirmed` crea saldo **gastable** sobre un estado que todavía puede revertir: el depósito se deshace y el saldo queda. El leg de salida puede vivir con `confirmed` porque ahí el riesgo es re-pagar; en la ENTRADA el riesgo es **acreditar plata que no llegó**. → AC-2 + CD-7. |
| **Idempotencia (clave única)** | `(chain_id, tx_hash)`, con `chain_id` real e inmutable | `(chain_id, signature)` con `chain_id` = **sentinel env-driven** | La firma es globalmente única en Solana, así que la clave sirve. **Pero el `chain_id` deja de ser inmutable**: cambiar `SOLANA_SYNTHETIC_CHAIN_ID` en el env **re-abre todos los depósitos pasados para re-crédito** (misma firma + otro `chain_id` = otra fila, sin colisión de UNIQUE). Es una debilidad de de-dup **introducida por el sentinel**, no heredada. → CD-8. |
| **Quién paga el fee** | el depositante (gas EVM) | el depositante (fee Solana) | Simétrico. El gateway no firma nada. → CD-4. |

---

## 4. El guard con el mismo vicio que `x402-nonce`: SÍ existe, y es el gate de funding wallet

Se me pidió buscar, en el camino de depósito, *"alguna protección cuya justificación dependa
de una propiedad de EVM que Solana no tiene"*. **Lo hay, y es el control de seguridad más
importante de todo el endpoint.**

No es el mismo *mecanismo* que `x402-nonce.ts:41-51` (que falla abierto ante un error de DB).
Es el mismo **vicio**: un control cuya **única implementación posible es un primitivo de EVM**,
de modo que llevar el camino a Solana **lo elimina en silencio**.

### 4.1 El control

`deposit.ts:129-138`, con su justificación escrita:

> *"El treasury es compartido, así que validar solo `Transfer.to` permite que un atacante
> front-run del `txHash` reclame el depósito ajeno. Exigimos que el depositante
> (`Transfer.from`) sea la funding wallet previamente bindeada a la key."*

Es FIX-1 de BLQ-MED-1 (WKH-35). Lo corrobora `deposit-verifier.ts:333-336` y la migración
`20260529000001_a2a_key_funding_wallet.sql:3-7`.

### 4.2 Por qué no sobrevive a Solana — tres razones independientes, las tres verificadas

`POST /auth/funding-wallet` (`src/routes/auth/funding-wallet.ts:34-105`) es EVM-only en:

1. **Formato**: `ADDRESS_RE.test(wallet)` (`:51`, con `ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/` en
   `parsers.ts:28`) ⇒ **una pubkey base58 se rechaza con 400. Hoy es literalmente imposible
   bindear una funding wallet de Solana.**
2. **Prueba de control**: `recoverMessageAddress` de viem (`:62-65`) — ecrecover EIP-191 /
   secp256k1. **En Solana no existe "recuperar el firmante"**: ed25519 verifica *con la pubkey
   dada* (`nacl.sign.detached.verify`). No es un parámetro distinto, es **otro primitivo**.
3. **Comparación y almacenamiento**: `recovered.toLowerCase() !== wallet.toLowerCase()`
   (`:71`) y `const normalized = wallet.toLowerCase()` en `identity.ts:176` (documentado en
   `funding-wallet.ts:31` y en la migración `:14`: *"Se guarda SIEMPRE lowercase desde la
   app"*). **La insensibilidad a mayúsculas es verdadera del hex y FALSA del base58.**
   Bajar a minúsculas una pubkey base58 la destruye; y como `funding_wallet` tiene
   **UNIQUE INDEX** (migración `:29-31`), dos pubkeys distintas que difieran sólo en caja
   **colisionan**, y la comparación de `deposit.ts:136` daría match con un depositante que
   **no es** el bindeado.

### 4.3 El bug de dinero que esto produce, que es el punto

Como una funding wallet Solana **no se puede bindear**, la implementación tentadora es
**saltear el gate para Solana** (`if (vmFamily === 'solana') skip`). Eso **re-abre exactamente
BLQ-MED-1**: el treasury es **compartido**, así que validando sólo el destino, **cualquier
caller autenticado puede reclamar el depósito de otro** y acreditárselo a su propia key.

**Y en Solana es más fácil que en EVM.** En EVM había que front-runear o pescar el `txHash`.
En Solana no hace falta front-runear nada: las firmas de una cuenta son **públicas y
consultables** con `getSignaturesForAddress` sobre la ATA del treasury. Un atacante **hace
polling**, toma cualquier firma de depósito ajeno y la presenta como propia. El único costo es
llegar primero, y el UNIQUE de `(chain_id, tx_hash)` **garantiza que el legítimo pierda**: su
depósito ya fue "acreditado"… a otro.

**Por eso esto es AC-7 + CD-2 de esta HU, no un follow-up.**

### 4.4 Un segundo fail-open, adyacente, que hay que nombrar antes de cruzarlo

`classifySolanaCaip2` (`chain-resolver.ts:266-272`) clasifica un CAIP-2 desconocido como
**`testnet`** ⇒ el gate de opt-in de mainnet del leg lo deja pasar. Es **fail-OPEN por
denylist**, y está declarado como deuda (`TD-SOLANA-CAIP2-DENYLIST`) en `:252-264`, con su
licencia apoyada en **tres condiciones simultáneas**, una de las cuales es *"(b) el rail Solana
está flag-gated OFF"*. El mismo comentario escribe su **condición de reactivación**:

> *"CONDICIÓN DE REACTIVACIÓN (pasa a ALLOWLIST fail-CLOSED, obligatorio): en cuanto exista un
> ChainKey `solana-mainnet` **o** el rail Solana salga de flag OFF."*

Si esta HU (o WKH-314) enciende el rail, **esa condición se dispara**. No decido si cerrarlo es
tarea de esta HU, de la 314 o de una propia (§6, D-4) — pero **no se puede cruzar en silencio**.

### 4.5 Y un no-hallazgo honesto, que digo explícitamente para que nadie lo persiga como rojo

`deposit-verifier.ts:254-260` **colapsa "no pude preguntar" con "no existe"**: el
`getTransactionReceipt` de viem lanza tanto cuando la tx no está como cuando el RPC está caído
o contesta ilegible, y **ambos** salen como `TX_NOT_FOUND`. Como `deposit.ts:119-123` sólo mapea
`RPC_UNAVAILABLE` y `ESCROW_CONTRACT_NOT_CONFIGURED` a 503, **un blip de RPC devuelve 400
`TX_NOT_FOUND`**, que el cliente lee como negativa demostrada. Y `DepositVerification`
(`:38-48`) **no tiene** campo `indeterminate`, a diferencia de `VerifyResult`
(`types.ts:28-43`), que lo agregó justamente por esto (`:31-42`).

**No es un fail-open y no pierde plata**: es fail-CLOSED y **no consume la prueba** (§1.2), así
que el pagador reintenta. Es un **error de etiquetado**, no de dinero. Lo nombro por dos
razones: (a) que la rama Solana **no copie esa forma** (CD-3), y (b) que el AR no lo levante
como bloqueante nuevo — es preexistente y CD-1 lo congela.

*(Nota adicional, fuera de alcance por CD-1: `budget.ts:736` hace
`p_amount_usd: parseFloat(amountUsd)` — convierte a float64 el monto verificado antes de
mandarlo a un `NUMERIC(18,6)`. Para USDC de 6 decimales no hay pérdida en rangos reales, y
`AMOUNT_MISMATCH` sí compara BigInt (`:350-365`). Lo dejo anotado, no lo toco.)*

---

## 5. Acceptance Criteria (EARS)

- **AC-1 — camino feliz.** WHEN un owner autenticado presenta una firma base58 de una tx de
  Solana devnet que transfirió el mint configurado (`getSolanaUsdcMint()`) a la ATA de
  depósito del gateway para ese mint, con la red declarada como `solana-devnet` y la firma no
  reclamada antes, the system SHALL acreditar **el monto verificado on-chain** (nunca el
  declarado por el caller) al `budget` de la key y SHALL responder el nuevo balance.
- **AC-2 — finalidad.** WHILE la transferencia no esté `finalized`, the system SHALL NOT
  acreditar saldo, SHALL responder un `error_code` estable distinguible de un rechazo
  definitivo, y SHALL NOT consumir la prueba. *(Un `confirmed` puede descartarse; un saldo
  acreditado ya es gastable — §3, fila "Finalidad".)*
- **AC-3 — re-envío del mismo depósito (idempotencia).** WHEN la misma firma se presenta por
  segunda vez, the system SHALL denegar con un `error_code` estable de depósito ya acreditado,
  SHALL NOT incrementar el saldo, y SHALL detectarlo mediante una **escritura condicional
  atómica a nivel DB** — nunca con un `SELECT` previo seguido de un `INSERT`.
- **AC-4 — destino equivocado.** IF la transferencia acredita a una cuenta distinta de la ATA
  de depósito configurada del gateway, THEN the system SHALL denegar con un `error_code`
  distinguible de replay y de indeterminado, SHALL NOT acreditar, SHALL NOT consumir la
  prueba, y SHALL NOT intentar ningún reembolso automático.
- **AC-5 — mint equivocado.** IF la transferencia mueve un mint distinto del configurado, THEN
  the system SHALL denegar con un `error_code` propio, distinguible del de destino equivocado,
  y SHALL NOT acreditar. *(Un mint arbitrario es acuñable a voluntad por cualquiera: aceptar el
  mint equivocado es acreditar dólares contra un token sin valor.)*
- **AC-6 — "no pude determinar", con la política del founder.** WHILE la cadena o el registro
  de unicidad no puedan responder, the system SHALL clasificar el resultado como `unknown`
  (nunca como `absent` ni como negativa demostrada), SHALL **denegar sin consumir la prueba**
  de modo que el depositante legítimo pueda reintentar cuando el sistema vuelva a poder
  preguntar, SHALL responder un status distinguible de un rechazo definitivo, y SHALL dejar un
  registro durable que nombre la firma para reconciliación.
- **AC-7 — el depositante debe estar probado (el control de §4).** WHEN se acredita un depósito
  Solana, the system SHALL exigir que el **origen de los fondos** sea una wallet Solana
  previamente **bindeada a esa key con prueba de control ed25519**, y IF no hay wallet Solana
  bindeada, THEN the system SHALL denegar el depósito. The system SHALL NOT acreditar ningún
  depósito Solana con el gate de funding wallet ausente o salteado.
- **AC-8 — base58 nunca se normaliza.** WHERE un valor sea una pubkey, una firma o un mint de
  Solana, the system SHALL compararlo y almacenarlo **byte-exacto**, y SHALL NOT aplicarle
  `toLowerCase()` ni ninguna otra normalización de caja.
- **AC-9 — monto mínimo.** WHERE exista un mínimo de depósito configurado para Solana, IF el
  monto verificado on-chain es menor a ese mínimo, THEN the system SHALL denegar con un
  `error_code` propio y SHALL NOT acreditar. *(Verificado: **hoy no existe ningún mínimo de
  depósito** en el camino EVM — `verifyDeposit` sólo compara contra el `amount` declarado por el
  caller (`deposit-verifier.ts:350-365`); el único `A2A_DEPOSIT_MIN_*` es
  `A2A_DEPOSIT_MIN_CONFIRMATIONS` (`:94-103`). Si el mínimo debe existir y con qué valor es
  `[DECIDE FOUNDER]` D-2 — no lo invento.)*
- **AC-10 — EVM byte-idéntico.** WHERE la chain resuelta es EVM, the system SHALL comportarse
  de forma byte-idéntica a hoy: mismos status, mismos `error_code`, misma secuencia
  auth → validación → resolución de chain → verify-before-credit → gate de funding wallet →
  crédito atómico.
- **AC-11 — honestidad de la superficie pública.** WHEN se lee `GET /auth/deposit-info`, the
  system SHALL publicar los datos de fondeo de `solana-devnet` (cluster, mint, decimals,
  cuenta de depósito, commitment exigido) **si y sólo si** el camino de verificación de
  depósitos Solana está cableado y habilitado en ese proceso.
- **AC-12 — cero claves privadas.** WHILE el camino de depósito Solana esté activo, the system
  SHALL NOT cargar, derivar ni usar ninguna clave privada Solana. El único acto irreversible
  del fondeo es del depositante.

---

## 6. Decisiones técnicas (DT-N) y `[DECIDE FOUNDER]`

### Decisiones técnicas propuestas

- **DT-1** — La verificación vive en **`wasiai-a2a`**, no en `wasiai-facilitator`. Un escritor
  por repo, y a2a ya tiene `Connection`, el probe de 5 estados y `checkTerms`.
- **DT-2** — Se **reusa `SettlementPresence`** (`types.ts:170-187`) para el veredicto de
  presencia. La pregunta es la misma; lo que cambia es quién pagó.
- **DT-3** — Se **reusa la tabla `a2a_key_deposits`** y la RPC `register_a2a_key_deposit` como
  registro de unicidad. Justificación: ya es una escritura condicional atómica fail-CLOSED
  (§1.2), `tx_hash` es `TEXT` sin CHECK de formato (migración `:12`) y el `chain_id` es `INT`
  (900001 entra sin problema). **NO se crea una tabla paralela**: dos registros de unicidad
  para el mismo concepto es la forma más común de perder la unicidad.
- **DT-4** — La rama Solana **bifurca antes** de `deposit-verifier.ts` / viem, sobre
  `bundle.payment.vmFamily`. **No** se intenta "hacer que `resolveChainObject` devuelva algo"
  (`:205-208` lanza a propósito).
- **DT-5** — La validación de formato del `tx_hash` pasa a ser **por familia** (hex `0x…{64}`
  para EVM, base58 para Solana), sin relajar la EVM. Prohibido un regex laxo que acepte las dos.
- **DT-6** — El destino esperado se resuelve con un helper **propio de Solana** (env base58 →
  ATA derivada del mint), **no** con `resolveTreasury` (§3, fila "Resolución del destino").

### `[DECIDE FOUNDER]` — preguntas de negocio, sin elegir por él

- **D-1 `[bloqueante]` — ¿Bajo qué "red" vive el saldo de Solana, y es fungible con el de
  EVM?** El `budget` es un jsonb indexado por `chain_id::TEXT` (migración `:47`,`:82-86`;
  `getBalance` lee `budget[chainId.toString()]`, `budget.ts:113`). Si Solana usa el sentinel
  **900001**, un owner que fondea en Solana ve `budget['900001']`. Las dos preguntas de negocio
  son: (a) ¿es ése el identificador que queremos exponer públicamente en `GET /me`, sabiendo
  que es un número inventado por nosotros y **cambiable por env**?; (b) **¿un saldo fondeado en
  Solana puede pagar a un agente que cobra en Avalanche, y al revés?** Si son fungibles, el
  gateway está haciendo de facto un cross-chain interno con fondos del operador. Si no lo son,
  hay que decir qué pasa cuando un pipeline mezcla agentes de dos redes. **Esto decide si el
  compromiso "no interviene Avalanche" se cumple de verdad o sólo en la etiqueta.**
- **D-2 — ¿Hay mínimo de depósito en Solana, y cuánto?** Hoy **no existe ninguno** (verificado,
  AC-9). Es la misma clase de decisión que el mínimo de 5 dólares: de negocio, no técnica.
- **D-3 — ¿Cómo se prueba el control de la wallet depositante?** Dos formas, con costo distinto
  (§7.3): (i) ruta completa de bind con **firma ed25519** verificada server-side — es el
  espejo honesto del camino EVM y escala; (ii) **pubkey del depositante registrada
  out-of-band** por el operador para la demo — mucho menos código, pero es un paso manual y no
  escala. **Lo que NO es una opción es no tener gate** (§4.3).
- **D-4 — ¿Quién cierra `TD-SOLANA-CAIP2-DENYLIST`?** Su propia condición de reactivación se
  dispara al encender el rail Solana (§4.4). Puede ser esta HU, WKH-314, o una HU propia — pero
  las dos HUs pueden encender el rail, así que alguien tiene que ser dueño.
- **D-5 — ¿Vale la pena la HU si la demo paga por x402?** Es el espejo del **MI-1 de WKH-314**:
  si el pagador de la demo usa x402, la pared A alcanza y ésta puede diferirse; si usa clave
  prepaga (que es el **modo ratificado de los 3 agentes `remit-*`**, según WKH-314 §10 MI-1),
  **ésta es la HU del camino crítico y la 314 no**. *No lo pude determinar desde este repo:
  requiere mirar `chaski-v3`.*

*(Nota: la política ante un pago indeterminado **NO se re-pregunta**. Ya está decidida —
rechazar sin consumir la prueba — y está codificada en AC-6 y CD-9.)*

---

## 7. Scope IN / OUT y el corte mínimo

### 7.1 Scope IN — un solo repo, un solo escritor

**Sólo `wasiai-a2a`.** Archivos/módulos previstos:

- `src/routes/auth/deposit.ts` — validación por familia (`:57`,`:62-65`), bifurcación del
  verify (`:98-111`), gate de funding wallet por familia (`:129-138`), y `deposit-info`
  (`:203-207`) para AC-11.
- `src/adapters/solana/deposit-verifier.ts` **(nuevo)** — verificador de depósito Solana:
  presencia de 5 estados + términos (mint / ATA destino / monto) + commitment `finalized`.
  *Ojo: hoy este archivo **no existe** (el encargo lo citaba; ver §0).*
- `src/adapters/deposit-verifier.ts` — sólo el helper de destino esperado para Solana (DT-6).
  **Sin tocar `verifyDeposit`** (AC-10).
- `src/routes/auth/funding-wallet.ts` + `src/routes/auth/parsers.ts` + `src/services/identity.ts`
  — bind de wallet Solana con prueba ed25519, **sin `toLowerCase()`** (AC-7 / AC-8), según D-3.
- `src/adapters/types.ts` — tipos del proof de depósito. Reusa `SettlementPresence`.
- `src/adapters/solana/payment.ts` — **sólo** exponer `probeSettlementPresence` si WKH-314 no
  lo hizo (§8.3). Cero cambios de lógica.
- `supabase/migrations/…_wkh315_solana_deposit.sql` — **sólo si** D-1/CD-8 exigen columna o
  índice nuevos. **Todas las migraciones van a `bdwv`, NUNCA a `caldz`.** Con `_down`.
- Tests nuevos + `doc/INTEGRATION.md`.

### 7.2 Scope OUT (explícito)

1. **`wasiai-facilitator` — CERO cambios** (DT-1, un escritor por repo).
2. **La pared A** (x402 inbound): es WKH-314.
3. **mainnet.** devnet-only, sin slug `-mainnet` (espeja CD-4 de WKH-234).
4. **Escrow Anchor para Solana.** El depósito es un SPL transfer directo.
5. **Gasless / fee-payer del depositante.** Paga su propio fee (AC-12).
6. **Reembolso automático** de un depósito mal enviado: runbook manual (AC-4).
7. **Retirar saldo** (withdraw) en Solana. Sólo entrada.
8. **UX / QR / SDK** del lado del depositante.
9. **Cambiar el modo de pago de los 3 agentes `remit-*`.**
10. **Tocar `verifyDeposit` / el camino EVM** más allá de la bifurcación (CD-1).
11. **Reusar `a2a_x402_nonces` / `checkAndRecordX402Nonce`** — prohibido (CD-10).

### 7.3 El corte mínimo, y el que NO elijo yo

**No entra completo** en la semana del 03/08 bajo el pipeline QUALITY (F2 → SPEC_APPROVED →
F2.5 → F3 → AR → CR → F4 con fix-packs y mutación), en paralelo con WKH-314.

**Lo que NO se puede recortar sin dejar el camino del dinero a medias** — los tres:

1. **El gate de funding wallet** (AC-7). Sin él el depósito es reclamable por cualquiera (§4.3).
   Recortar esto no es un corte de alcance, es introducir una vulnerabilidad.
2. **La de-duplicación** (AC-3). Sin ella un depósito se acredita N veces = plata regalada.
3. **`finalized` para acreditar** (AC-2). Sin ello se acredita saldo gastable sobre un estado
   reversible.

**Corte mínimo propuesto**: AC-1 a AC-8 + AC-10 + AC-12, con AC-11 (`deposit-info`) incluida
porque son ~20 líneas y sin ella **nadie sabe a dónde mandar los fondos**. Se difiere: AC-9 (no
hay mínimo hoy), escrow, withdraw, UX.

**El corte que cambia código por un paso manual, y que `[DECIDE FOUNDER]` D-3 debe resolver**:
implementar AC-7 con la **pubkey del depositante registrada out-of-band por el operador** en
vez de la ruta completa de bind ed25519. Ahorra la parte más grande del trabajo y **conserva
el control de seguridad intacto** (el gate sigue existiendo y sigue comparando contra una
wallet declarada de antemano). Costo: es manual, no escala, y hay que volver a hacerlo bien
antes de mainnet. **Es defendible para una demo de devnet y no lo elijo yo.**

**Qué ve la incubadora con el corte mínimo**: un owner manda USDC de devnet a la cuenta del
gateway desde su propia wallet Solana, pega la firma, el gateway la verifica contra la cadena
y le acredita saldo — y los 3 agentes se cobran con **plata que entró por Solana**, sin
Avalanche en ningún tramo del dinero.

---

## 8. Interacción con WKH-314 (pared A) — solapamiento y orden de merge

### 8.1 Archivos que toca cada una

| Archivo | WKH-314 (pared A) | WKH-315 (esta) | Riesgo |
|---|---|---|---|
| `src/adapters/types.ts` | sí (tipos del proof inbound) | sí (tipos del proof de depósito) | **SOLAPA** — bajo: son bloques aditivos distintos del mismo archivo. Conflicto textual probable pero trivial. |
| `src/adapters/registry.ts` | **sí** (`acceptsInboundPayment` deja de ser `vmFamily==='evm'`) | no | disjunto |
| `src/adapters/solana/payment.ts` | sí (expone verificación inbound) | sí (necesita el probe) | **SOLAPA** — ver §8.3. |
| `src/adapters/solana/schema-preflight.ts` | sí (MI-5, "por verificar") | **no hace falta** | **resuelto**: §2 verifica que `probeRpcHistoryRetention` (`:166-208`) ya es genérico. **Ninguna de las dos lo toca.** |
| `src/middleware/x402.ts` | **sí** (rama Solana del challenge) | no | disjunto |
| `src/services/compose.ts` | **sí** (`:1430-1462`) | no | disjunto |
| `src/adapters/solana/inbound-claim.ts` (nuevo) | **sí** | no | disjunto |
| `src/routes/auth/deposit.ts` | no | **sí** | disjunto |
| `src/routes/auth/funding-wallet.ts` · `parsers.ts` · `services/identity.ts` | no | **sí** | disjunto |
| `src/adapters/deposit-verifier.ts` · `src/adapters/solana/deposit-verifier.ts` (nuevo) | no | **sí** | disjunto |
| `supabase/migrations/` | sí (tabla de single-use inbound) | quizás (§7.1) | disjunto (archivos distintos) |
| `doc/INTEGRATION.md` · `doc/MULTI-CHAIN.md` | sí | sí | **SOLAPA** — trivial. |

**Veredicto**: el solapamiento **real** es un solo archivo de código con riesgo no trivial —
`src/adapters/solana/payment.ts` — y se resuelve con §8.3. El resto es aditivo o disjunto.
**Las dos pueden correr en worktrees separados.**

### 8.2 Primitivos compartidos

- **`SettlementPresence`** (`types.ts:170-187`) — **ya mergeado** (WKH-307). Las dos
  **consumen**, ninguna construye. Cero conflicto. Ninguna lo rediseña (CD-3 de ambas).
- **`probeRpcHistoryRetention`** (`schema-preflight.ts:166-208`) — **ya existe y es genérico**.
  Ninguna lo construye; las dos dependen de él y **ninguna debe debilitarlo**.
- **El canal de "resultado desconocido"** — WKH-314 lo ancla en `x402.ts:674-730` (log con
  `error_code` estable + evento durable en `a2a_events`). Esta HU debe usar **el mismo
  vocabulario y el mismo canal**, no inventar otro (CD-11).
- **El registro durable de uso único** — **NO es compartido, y es importante que no lo sea.**
  WKH-314 construye `solana/inbound-claim.ts` + tabla nueva para las pruebas x402. Esta HU
  **no necesita nada de eso**: el depósito **ya tiene** su registro de unicidad durable y
  fail-CLOSED (`a2a_key_deposits` UNIQUE(chain_id, tx_hash), §1.2). Son dos objetos distintos
  (una prueba de pago x402 vs un depósito acreditado) y unificarlos sería un rediseño, no un
  ahorro.

### 8.3 El único acoplamiento que exige coordinación

`probeSettlementPresence` es **`private`** hoy (`payment.ts:572`). Las dos HUs lo necesitan
desde afuera. **Exactamente una debe promoverlo** a superficie reusable; la otra lo consume.

**Propuesta**: **WKH-314 lo promueve** (mergea primero) y **WKH-315 lo consume**. Si el orden
se invierte (ver §8.4), se invierte también la propiedad.

### 8.4 Orden de merge propuesto

**WKH-314 → WKH-315**, por dos razones concretas: (a) 314 es dueña de la promoción del probe
(§8.3) y del refactor de `acceptsInboundPayment` en `registry.ts`; (b) 315 rebasea sobre un
`payment.ts` ya quieto.

**Con una condición explícita que puede invertirlo**: si la respuesta al **MI-1 de WKH-314** /
**D-5** es *"la demo paga con clave prepaga"*, entonces **315 es el camino crítico y 314 no**,
y conviene invertir el orden (315 promueve el probe, 314 lo consume). **Esa decisión no es
mía.**

**Riesgo externo, heredado del relevamiento de WKH-314 (§11.2) y no re-verificado acá**: la
fila 189 (`fix/p1-discover-reputation-402-cap`) está **abierta** y tocó la superficie del
challenge 402 en los 5 adapters. Afecta a **314** (que escribe `middleware/x402.ts`), **no a
315** (que no lo toca). Buena noticia para el paralelismo.

### 8.5 Qué NO debe duplicarse entre las dos

1. El tipo de presencia (`SettlementPresence`) — se consume.
2. El probe (`probeSettlementPresence`) — se promueve **una** vez (§8.3).
3. El preflight de retención del RPC — **ya existe**, no se re-implementa.
4. El canal / vocabulario de "no pude determinar" — uno solo (CD-11).
5. La resolución de mint / decimals / commitment / CAIP-2 — `solana/chain.ts:39-77`, ya existe.
6. La validación de términos de una tx SPL — `checkTerms`, se reusa el patrón.
7. **El registro de uso único NO se unifica** (§8.2) — son objetos distintos.

---

## 9. Constraint Directives (CD-N)

- **CD-1 — OBLIGATORIO: el camino EVM queda byte-idéntico.** Mismos status, mismos
  `error_code`, misma secuencia, mismos campos de respuesta. Prueba exigida: las suites
  existentes del deposit (`src/adapters/deposit-verifier.test.ts`,
  `src/adapters/escrow-verifier.test.ts`, `src/services/budget.test.ts` y las de rutas auth)
  quedan **verdes sin modificarse**. Cualquier test que haya que tocar es señal de regresión,
  no de refactor.
- **CD-2 — PROHIBIDO acreditar un depósito Solana sin gate de funding wallet.** Saltear,
  desactivar por flag o dejar "para después" el gate de §4 re-abre BLQ-MED-1 y es **BLOQUEANTE
  automático en AR**. Si D-3 no está resuelto, la HU **no se implementa**.
- **CD-3 — PROHIBIDO un `boolean` o un `T | null`** en cualquier eslabón de la verificación del
  depósito Solana. Se reusa `SettlementPresence`; un tipo nuevo se admite sólo si tiene ≥3
  estados y el compilador fuerza la exhaustividad. **Y PROHIBIDO copiar la forma de
  `DepositVerification`** (`deposit-verifier.ts:38-48`), que no tiene el tercer valor y colapsa
  "no pude preguntar" en `TX_NOT_FOUND` (§4.5).
- **CD-4 — PROHIBIDO que el camino de depósito firme, transmita o alcance una clave privada
  Solana.** `getSolanaOperatorKeypair()` (`chain.ts:84-100`) **no se importa**. El único acto
  irreversible del fondeo es del depositante.
- **CD-5 — PROHIBIDO usar `resolveTreasury()`** (`deposit-verifier.ts:111-126`) para resolver
  el destino esperado de un depósito Solana. Devuelve una **dirección EVM** para
  `solana-devnet` (§3). El destino Solana se resuelve con su propio helper y **OBLIGATORIAMENTE
  se compara contra la ATA del mint**, no contra el owner.
- **CD-6 — PROHIBIDO `toLowerCase()` (o cualquier normalización de caja) sobre firmas, pubkeys
  y mints base58**, en comparación y en persistencia. Incluye explícitamente
  `identity.ts:176`, `funding-wallet.ts:71` y `deposit.ts:136` en su rama Solana. El base58 es
  case-sensitive y `funding_wallet` tiene UNIQUE index (§4.2).
- **CD-7 — OBLIGATORIO acreditar sólo sobre `finalized`.** El commitment exigido para acreditar
  saldo se declara explícitamente y **no hereda** `getSolanaCommitment()` (default `confirmed`,
  `chain.ts:23`,`:43-46`). Prohibido acreditar sobre `processed` o `confirmed`.
- **CD-8 — OBLIGATORIO que la clave de unicidad del depósito Solana no dependa de un valor
  mutable por env.** El sentinel `SOLANA_SYNTHETIC_CHAIN_ID` es cambiable en caliente, y con la
  clave actual `(chain_id, tx_hash)` cambiarlo **re-abre todos los depósitos pasados para
  re-crédito** (§3, fila "Idempotencia"). El diseño debe cerrar eso — por columna dedicada,
  por índice adicional, o por congelar el sentinel con un guard de arranque. Cómo, lo decide F2.
- **CD-9 — OBLIGATORIO: rechazar sin consumir la prueba** ante cualquier indeterminación (de la
  cadena o del registro de unicidad). Decisión del founder, ya tomada. Y **OBLIGATORIO
  preservar** la propiedad que el camino EVM ya tiene: todo fallo de verificación retorna
  **antes** de `registerDeposit`, así que no se inserta fila y la firma sigue reclamable (§1.2).
  Aplica **aunque sea devnet**: lo que se fija es la forma del código que mainnet hereda.
- **CD-10 — PROHIBIDO reusar `a2a_x402_nonces` / `checkAndRecordX402Nonce`**
  (`src/services/x402-nonce.ts:31-53`) para nada de este camino. **Falla ABIERTO por diseño
  explícito** (`:41-51`) con una justificación —*el nonce EIP-3009 ya es single-use on-chain*—
  **falsa en Solana**.
- **CD-11 — OBLIGATORIO reusar el canal de "resultado desconocido"** que WKH-314 ancla en
  `x402.ts:674-730` (log con `error_code` estable + evento durable en `a2a_events`).
  **PROHIBIDO inventar vocabulario nuevo para lo mismo.**
- **CD-12 — OBLIGATORIO devnet.** Sin slug `-mainnet`, sin RPC de mainnet, sin plata real.
  **Todas las migraciones van a `bdwv`, JAMÁS a `caldz`** (archivo de mainnet).
- **CD-13 — PROHIBIDO publicar los datos de fondeo Solana en `GET /auth/deposit-info`** mientras
  la verificación no esté cableada y habilitada. Es un contrato público: si publicamos una
  cuenta de depósito, alguien manda fondos reales ahí (AC-11).

---

## 10. Missing Inputs

- **MI-1 `[bloqueante]`** — **D-1**: bajo qué `chain_id` vive el saldo Solana y si es fungible
  con el EVM. Bloquea el diseño de la clave de unicidad y del `budget`.
- **MI-2 `[bloqueante]`** — **D-3**: cómo se prueba el control de la wallet depositante (bind
  ed25519 completo vs pubkey registrada out-of-band). Bloquea el sizing real (§7.3) y CD-2.
- **MI-3 `[bloqueante]` `[NEEDS CLARIFICATION]`** — **D-5** / espejo del MI-1 de WKH-314: ¿la
  demo paga por x402 o con clave prepaga? Decide **cuál de las dos HUs es el camino crítico** y
  el orden de merge (§8.4). *No pude determinarlo desde este repo: requiere `chaski-v3`.*
- **MI-4 `[resolver en F2]`** — Flag del camino de depósito Solana: nombre, default (OFF), y si
  se ANDea con `SOLANA_ADAPTER_ENABLED`. **No verifiqué** el default de
  `SOLANA_ADAPTER_ENABLED` ni cómo `buildBundle` gatea el bundle de `solana-devnet`; WKH-314
  lo reporta como default `false` (su MI-4) y **lo tomo como dato heredado, no verificado acá**.
- **MI-5 `[resolver en F2]`** — ¿Se agrega el alias numérico `'900001'` a `SLUG_ALIASES`
  (`chain-resolver.ts:20-68`) para que `chain_id: 900001` resuelva sin header, o se exige el
  header `x-payment-chain: solana-devnet`? La primera opción hace ruteable por env un slug; la
  segunda cambia el contrato del endpoint para un caller Solana. Ninguna es obvia.
- **MI-6 `[resolver en F2]`** — La cuenta de depósito Solana: ¿ATA del operador (misma pubkey
  que firma los settles de salida) o una cuenta de depósito dedicada? Mezclar entrada y salida
  en la misma cuenta complica la reconciliación; separarlas es una env más y una operación de
  fondeo más. Hay una restricción dura: **CD-4 prohíbe que el camino de depósito toque la clave
  privada**, así que la cuenta de depósito sólo necesita ser *observable*, no firmable, por este
  camino.
- **MI-7 `[resolver en F2]` — no pude determinarlo** — Si `a2a_key_deposits` tiene RLS
  habilitada y con qué política. Leí su migración de creación
  (`20260529000000_a2a_key_deposits.sql`) y **no habilita RLS**; hay migraciones posteriores de
  RLS (`20260607000000_wkh_sec02_rls.sql`, `20260610000000_wkh_sec02c_rls_registries.sql`) que
  **no abrí**. Relevante porque la tabla guarda `owner_ref` + montos.
- **MI-8 `[escalar al humano]`** — **`.nexus/project-context.md` contradice el código.** Dice
  `Última actualización: 2026-03-31`, describe un stack Kite-only, no menciona Solana, Base,
  Tempo, el facilitator ni `@solana/web3.js`, y afirma *"viem v2 — PROHIBIDO ethers.js"* como si
  toda la cadena fuera EVM. **No lo modifiqué** (fuera de mi alcance de escritura). Un
  sub-agente que lo tome como fuente de verdad decide mal en esta HU. *(Ya escalado por
  WKH-314 MI-6; lo repito porque sigue sin resolverse.)*
- **MI-9 `[informativo]`** — *"No debe intervenir Avalanche"*: WKH-314 MI-7 pregunta si aplica
  también a la identidad (ERC-8004 de `remit-kyc-validator` anclada a Avalanche). **Para el
  dinero, esta HU + la 314 son las dos que hacen falta.** No re-pregunto: es la misma duda.

---

## 11. Análisis de paralelismo

- **¿Bloquea otras?** Sí: cualquier demo que exija que la **entrada de plata** sea Solana-only
  **por el camino prepago**. Y, junto con WKH-314, el cierre honesto del claim *"el pipeline de
  Chaski se cobra en Solana sin Avalanche"*.
- **¿Puede ir en paralelo con WKH-314?** **Sí**, en worktrees separados. Un único punto de
  coordinación: `payment.ts` / promoción del probe (§8.3). Orden propuesto en §8.4.
- **¿Con WKH-313** (fila 211, discovery/reputación)? Sí — archivos disjuntos.
- **¿Con la fila 189** (`fix/p1-discover-reputation-402-cap`, abierta)? **Sí, sin conflicto**:
  toca `middleware/x402.ts` y la superficie del challenge 402; esta HU no los toca. (A 314 sí
  la afecta.)
- **¿Con `WKH-307b`** (ops: aplicar migración a caldz)? Sí, es ops puro. **Recordatorio: esta HU
  nunca escribe en `caldz`** (CD-12).
- **NO puede ir en paralelo con**: cualquier HU que escriba `wasiai-facilitator` **si** en algún
  momento se decide mover la verificación allá (hoy Scope OUT, DT-1). Un escritor por repo.
- **Necesaria pero no suficiente**: igual que la 314. El entregable *"los 3 agentes se cobran en
  Solana"* necesita además que el KYC pase por el riel a2a (`WKH-233`, reportada bloqueada;
  **no verificada acá**).

---

## 12. Definition of Ready — estado

| Requisito | Estado |
|---|---|
| Citas del encargo verificadas antes de construir | ✅ §0 — 2 rutas corregidas, contenido confirmado |
| ACs en EARS, ≥6, sin lenguaje vago | ✅ **12 ACs** (feliz · finalidad · idempotencia · destino · mint · indeterminado · funding wallet · base58 · mínimo · EVM byte-idéntico · superficie pública · cero claves) |
| Scope IN / OUT explícito | ✅ §7.1 / §7.2 |
| Constraint Directives ≥3, incluida "EVM byte-idéntico" | ✅ **13 CDs**, CD-1 = EVM byte-idéntico |
| Sizing honesto contra el 2026-08-03 | ✅ M/L, no entra completo; corte mínimo §7.3 + los 3 irrecortables |
| Tipo de 3+ valores definido desde el diseño | ✅ DT-2 / CD-3 (reusa `SettlementPresence`) |
| Política de indeterminación | ✅ Decidida por el founder: AC-6 / CD-9 (rechazar sin consumir) |
| Guard con vicio EVM-dependiente buscado | ✅ **Encontrado**: §4 (gate de funding wallet) + §4.4 (denylist CAIP-2 fail-open) + §4.5 (un no-hallazgo declarado) |
| Solapamiento con WKH-314 y orden de merge | ✅ §8 — un solo archivo con riesgo real, orden propuesto con su condición de inversión |
| Decisiones de negocio aisladas y NO tomadas | ✅ §6 D-1..D-5 |
| Bloqueantes abiertos | ⚠️ **MI-1, MI-2, MI-3.** MI-3 puede cambiar cuál HU es el camino crítico. |
