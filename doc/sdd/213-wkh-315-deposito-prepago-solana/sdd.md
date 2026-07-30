# SDD #213: [WKH-315] La pared B — fondear la clave prepaga en Solana (deposit inbound)

> SPEC_APPROVED: no
> Fecha: 2026-07-29
> Tipo: feature / money-path de ENTRADA / multi-VM
> SDD_MODE: full
> Branch: `feat/213-wkh-315-deposito-prepago-solana`
> Worktree: `/home/ferdev/.openclaw/workspace/wt-315`
> Artefactos: `doc/sdd/213-wkh-315-deposito-prepago-solana/`
> Work item: `doc/sdd/213-wkh-315-deposito-prepago-solana/work-item.md` (gate `HU_APPROVED` cumplido)

---

## 0. Correcciones y resoluciones sobre el work-item (verificadas antes de diseñar)

El work-item dejó 9 Missing Inputs. **Cinco se resuelven acá con evidencia**, dos siguen
siendo decisión de negocio, uno se resolvió solo, y uno cambia de forma.

| MI | Estado tras el grounding | Evidencia |
|---|---|---|
| **MI-1** (D-1: bucket del saldo + fungibilidad) | **RESUELTO EN PARTE + ESCALADO.** Ver §4.2. El diseño usa el bucket `budget['<sentinel>']`; la "contabilidad única" del founder **no es implementable dentro de esta HU** y su razón es de código, no de opinión | `20260406000000_a2a_agent_keys.sql:102-119`, `budget.ts:113` |
| **MI-2** (D-3: cómo se prueba el control de la wallet) | **RESUELTO.** Bind ed25519 real, con el primitivo **medido**, no supuesto. Ver §5 | `node:crypto` verificado en vivo (§5.2) |
| **MI-3** (D-5: ¿la demo paga x402 o prepago?) | **NO PUDE DETERMINARLO** — requiere `chaski-v3`, fuera de este repo. NO bloquea el diseño: §7 elimina el acoplamiento con WKH-314, así que el orden de merge deja de importar | — |
| **MI-4** (flag del camino de depósito) | **RESUELTO.** `SOLANA_ADAPTER_ENABLED === 'true'`, default OFF, choke-point único; el bundle no existe sin él. Se agrega un **segundo** flag propio del depósito. Ver §4.6 | `registry.ts:62-64`, `:70-75`, `:128-134` |
| **MI-5** (alias numérico `'900001'` vs header) | **RESUELTO: header obligatorio, PROHIBIDO el alias.** Ver §4.5 | `chain-resolver.ts:20-68` (mapa PURO, no lee env), `chain.ts:65-70` (sentinel env-driven) |
| **MI-6** (ATA del operador vs cuenta dedicada) | **RESUELTO CON RECOMENDACIÓN + `[DECIDE FOUNDER]` D-6.** Ver §4.4 | `payment.ts:210-220` |
| **MI-7** (RLS de `a2a_key_deposits`) | **RESUELTO: SÍ tiene RLS.** `ENABLE ROW LEVEL SECURITY` sin policy ⇒ deny-all para `anon`/`authenticated`; `service_role` bypassa por BYPASSRLS. La columna aditiva hereda la protección; **no hace falta policy nueva** | `20260607000000_wkh_sec02_rls.sql:12` |
| **MI-8** (`.nexus/project-context.md` contradice el código) | **YA NO APLICA.** El archivo fue actualizado: dice *"Última verificación contra el código y contra el proceso vivo: **2026-07-29**"* y su línea de Stack ya nombra `@solana/web3.js 1.x`, `@solana/spl-token`, cuatro rieles y Node >= 22 | `.nexus/project-context.md:12`, `:27` |
| **MI-9** (informativo) | Sin cambios | — |

**Corrección al encargo sobre el primitivo compartido.** Se me indicó consumir
`probeSettlementPresence` (que WKH-314 promueve). **El grounding dice que ese reuso sería
incorrecto**, y por eso el diseño NO lo consume. La razón, con evidencia, está en §7.1. Es
una corrección, no una desobediencia: la consecuencia es **mejor** para la coordinación
(desaparece el único solapamiento no trivial entre las dos HUs) y **no toco `payment.ts`**.

**Corrección al encargo sobre `destination`.** Se me pidió verificar si puede expresar una
RED. **No puede, y tampoco es una dirección**: es la identidad de un **agente**. Ver §3.4.

---

## 1. Resumen

Hoy la clave prepaga (`a2a_agent_keys.budget`) sólo se puede cargar por EVM: `POST
/auth/deposit` rechaza una firma base58 en su primera línea de validación
(`deposit.ts:57`,`:63`) y su verificador es viem de punta a punta. Consecuencia medida en el
F1: **todo dólar que entra al sistema entra por Avalanche/Base/Kite**, así que el compromiso
con la incubadora (*"los 3 agentes de Chaski se cobran en Solana"*, *"no debe intervenir
Avalanche"*) no se cumple abriendo sólo la pared A si el pagador usa clave prepaga.

Esta HU abre la pared B: un owner **prueba control de una wallet Solana con una firma
ed25519**, manda USDC de devnet a la cuenta de depósito del gateway, presenta la firma, y el
gateway **verifica en cadena a nivel `finalized` antes de acreditar** y acredita **exactamente
una vez**, con una clave de unicidad que **no depende de ninguna variable de entorno**.

Resultado esperado: los 3 agentes se cobran con plata que entró por Solana, sin Avalanche en
ningún tramo del dinero, y con el gate anti-hijack de §5 intacto — que en Solana es MÁS
necesario que en EVM, porque las firmas de una cuenta son públicas.

---

## 2. Work Item

| Campo | Valor |
|---|---|
| **#** | 213 |
| **Ticket** | WKH-315 |
| **Tipo** | feature / money-path de entrada |
| **SDD_MODE** | full |
| **Objetivo** | Que un owner pueda fondear su Agent Key con USDC de Solana devnet, verificado on-chain a `finalized`, acreditado exactamente una vez, y sólo desde una wallet Solana cuyo control probó |
| **Reglas de negocio** | devnet, plata NO real. Migraciones sólo a `bdwv`, JAMÁS a `caldz`. Sin gate de funding wallet la HU no se implementa (CD-2) |
| **Scope IN** | §6 |
| **Scope OUT** | §6 |
| **Missing Inputs** | §9 — 2 `[DECIDE FOUNDER]` no bloqueantes del arranque, 1 escalación (§4.2) |

### Acceptance Criteria (EARS)

Se heredan **los 12 ACs del work-item §5, sin cambios de redacción**. Se agregan tres que el
diseño introduce y que por lo tanto tienen que ser verificables:

- **AC-13 — la clave de unicidad no depende del entorno.** WHERE se acredita un depósito
  Solana, the system SHALL registrar su unicidad con una clave que **no incluya ningún valor
  leído de una variable de entorno**, de modo que cambiar `SOLANA_SYNTHETIC_CHAIN_ID` NO
  vuelva reclamable ninguna firma ya acreditada.
- **AC-14 — el destino esperado no puede ser de otra cadena.** WHERE se resuelve el destino
  esperado de un depósito Solana, the system SHALL derivarlo de una pubkey base58 + el mint
  configurado, y SHALL NOT poder obtener una dirección EVM: `resolveTreasury()` SHALL ser
  **inalcanzable por tipos** desde el camino Solana (falla `tsc`, no en runtime).
- **AC-15 — el depositante probado es exactamente uno.** IF una transacción mueve el mint
  configurado hacia la cuenta de depósito desde **más de un** owner de origen distinto, THEN
  the system SHALL denegar con un `error_code` propio, SHALL NOT acreditar y SHALL NOT
  consumir la prueba.

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos (todos verificados con Read; rutas confirmadas)

| Archivo | Por qué | Patrón / hallazgo extraído |
|---|---|---|
| `src/routes/auth/deposit.ts` (237 L) | Es el endpoint a extender | 13 pasos, orden auth → validación → chain → verify → gate → crédito. El `chainId` acreditado sale de `bundle.chainConfig.chainId` (`:88`), nunca del caller |
| `src/adapters/deposit-verifier.ts` (379 L) | El verificador EVM a NO tocar, y donde vive el landmine | `resolveTreasury` (`:111-126`) cae al fallback `privateKeyToAccount` cuando `ADDRESS_RE` falla ⇒ **devuelve EVM para `solana-devnet`**. `resolveChainObject` LANZA para Solana (`:205-208`) |
| `src/routes/auth/funding-wallet.ts` (171 L) | El gate de §5 | `ADDRESS_RE` (`:51`) + `recoverMessageAddress` (`:62-65`) + `toLowerCase()` (`:71`): EVM-only por tres vías independientes |
| `src/routes/auth/parsers.ts` (382 L) | Mensaje canónico + `ADDRESS_RE` | `fundingWalletBindMessage(keyId)` = `` `WASIAI_BIND_FUNDING_WALLET:${keyId}` `` (`:35-37`) |
| `src/services/identity.ts` (parcial) | Persistencia del bind | `bindFundingWallet` hace `wallet.toLowerCase()` (`:176`) y traduce 23505 → `FundingWalletAlreadyBoundError` (`:187-189`); UPDATE filtrado por `id`+`owner_ref` |
| `src/services/budget.ts` (parcial, 3 zonas) | `registerDeposit` + `debit` + `getBalance` | `getBalance` lee `budget[chainId.toString()]` (`:113`). `debit` enruta a 3 RPCs; ninguno es agnóstico de chain |
| `src/adapters/solana/chain.ts` (109 L) | Todo el env-driving de Solana | `getSolanaCommitment()` default **`confirmed`** (`:23`,`:43-46`). `getSolanaSyntheticChainId()` default 900001 (`:25`,`:65-70`). `getSolanaOperatorKeypair()` (`:84-100`) **NO se importa** (CD-4) |
| `src/adapters/solana/payment.ts` (1181 L; zonas 1-60, 540-680, 1090-1181) | El probe, `checkTerms`, la derivación de ATA | `checkTerms` (`:1101-1130`) mide el **delta de `pre/postTokenBalances` filtrando por `(owner, mint)`**, no por la dirección de la cuenta. `getAssociatedTokenAddressSync(mint, owner)` (`:214`) es el derivador. `probeSettlementPresence` es `private` (`:572`) y su `getParsedTransaction` está **hardcodeado a `'confirmed'`** (`:619`) |
| `src/adapters/types.ts` (120-320) | `SettlementPresence` y el inventario de consecuencias | 5 estados, exhaustividad forzada (`:170-187`). El docstring `:132-168` es la doctrina de la casa |
| `src/adapters/solana/schema-preflight.ts` (286 L) | La precondición de `absent` | `probeRpcHistoryRetention` (`:166-208`) es **genérica**, mide `getSlot` vs `getFirstAvailableBlock`, corta si la ventana `<= BLOCKHASH_VALIDITY_SLOTS` (150). `SOLANA_RPC_LEDGER_HISTORY_DECLARED_SUFFICIENT` (`:120`) es el **exemplar de "salida explícita declarada, sin default permisivo"** |
| `src/lib/wallet-format.ts` (82 L) | Validador base58 que **ya existe** | `isValidSolanaAddress` (`:50-71`): charset base58 + decode a **exactamente 32 bytes**, módulo leaf, **sin normalización de caja** |
| `src/adapters/solana/base58.ts` (82 L) | Codec | `base58DecodeToBytes` **LANZA con el mensaje literal `'SOLANA_OPERATOR_PRIVATE_KEY is not valid base58'`** (`:67`) ⇒ **PROHIBIDO usarlo sobre input del caller** (§4.9) |
| `src/adapters/chain-resolver.ts` (1-120, 200-310) | Alias, familias, denylist CAIP-2 | `SLUG_ALIASES` es un mapa **PURO que no lee env** (`:20-68`); Solana sólo tiene alias literales (`:65-66`). `getChainVmFamily` (`:98-100`) proyecta `CHAIN_VM_FAMILY` exhaustivo. `classifySolanaCaip2` (`:268-272`) es fail-OPEN por denylist con condición de reactivación escrita (`:260-264`) |
| `src/adapters/registry.ts` (50-170) | El gate del rail | `isSolanaEnabled()` (`:62-64`) es el **único** choke-point; `getSupportedChains()` (`:70-75`) no agrega el slug con flag OFF ⇒ `getAdaptersBundle('solana-devnet')` = `undefined` ⇒ `CHAIN_NOT_SUPPORTED` |
| `src/middleware/a2a-key.ts` (348-409, 1180-1250) | De dónde sale el chainId del DÉBITO | `resolveTargetChain` lo resuelve del header `x-payment-chain` del **caller** (`:358-362`), con fallback al default (`:372`). **NO del agente** |
| `src/lib/downstream-payment.ts` (600-730) | De dónde sale la chain del PAGO al agente | `normalizeChainSlug(agent.payment.chain)` (`:640`) — la declara el **AGENTE** |
| `src/services/compose.ts` (470-580, 1415-1490) | El débito per-step y el destino | `stepDestination = normalizeDestination(`${agent.registry}/${agent.slug}`)` (`:490-492`) |
| `src/services/spend-policy.ts` (229 L) | Semántica de `destination` | `normalizeDestination` = `trim().toLowerCase()` de `"<registry>/<slug>"` (`:51-57`) |
| `supabase/migrations/20260529000000_a2a_key_deposits.sql` (104 L) | El anti-replay y el molde de la RPC | `UNIQUE (chain_id, tx_hash)` (`:17`), `tx_hash TEXT` **sin CHECK de formato** (`:12`). `EXCEPTION WHEN unique_violation` (`:77-79`) es **agnóstico de qué índice violó**. `DROP FUNCTION` antes del `CREATE OR REPLACE` con firma nueva (`:32`, razón en `:27-31`) |
| `supabase/migrations/20260529000001_a2a_key_funding_wallet.sql` (34 L) | El índice del bind | `uq_a2a_agent_keys_funding_wallet` es UNIQUE **plano sobre la columna cruda**, parcial `WHERE ... IS NOT NULL` (`:29-31`). El lowercase es de la app, no del índice |
| `supabase/migrations/20260406000000_a2a_agent_keys.sql` (148 L) | El modelo de saldo | `budget JSONB` = `{"<chain_id>": "<amount>"}` (`:14-15`). `increment_a2a_key_spend` **debita `budget[p_chain_id::TEXT]`** (`:102-119`) |
| `supabase/migrations/20260606000000_a2a_key_spend_policies.sql` (233 L) | El mecanismo que el encargo pidió evaluar | `destination TEXT` documentado como `"<registry>/<slug>"` (`:14`), `UNIQUE (key_id, destination)` (`:20`). El `p_destination TEXT DEFAULT NULL` (`:165`) es el **exemplar de extensión back-compat de firma** |
| `supabase/migrations/20260607000000_wkh_sec02_rls.sql` (18 L) | MI-7 | `a2a_key_deposits` ENABLE RLS (`:12`) |
| `src/middleware/x402.ts` (660-740) | El canal de "resultado desconocido" (CD-11) | `error_code: 'X402_SETTLE_UNKNOWN'` + `valueDisposition: 'unknown'` + `eventService.track({eventType:'x402_settle_unknown'})` fire-and-forget con `.catch` (`:674-730`). **Existe desde HU-198/201 — WKH-314 no lo crea, lo reusa** |
| `src/lib/atomic-amount.ts` (138 L) | Conversión USD↔atómico | `usdToAtomicUnits(amountUsd: **number**, decimals)`. Toma un `number` ⇒ **NO sirve** para el compare declarado (§4.8) |
| `src/adapters/solana/index.ts` (39 L) | La factory | **NO carga el keypair**: la carga es perezosa dentro de `settle` ⇒ un proceso sin `SOLANA_OPERATOR_PRIVATE_KEY` arranca igual (§4.4) |
| `src/routes/auth.test.ts` (zonas 219-460, 592-610) | Exemplar de tests de ruta + la prueba que CD-1 no puede romper | El caso `INVALID_INPUT` usa `tx_hash: '0xbad'` (`:447`) — **falla también el charset base58 (no hay `'0'` en base58)** ⇒ el diseño de §4.5 lo deja verde |
| `doc/sdd/209-.../auto-blindaje.md`, `208-...`, `203-...` | Auto-Blindaje histórico (obligatorio) | §3.5 |

### 3.2 Exemplars verificados (existen; confirmado por Read directo)

| Para crear/modificar | Seguir patrón de | Qué se copia |
|---|---|---|
| `src/adapters/solana/deposit-verifier.ts` **(nuevo)** | `src/adapters/solana/payment.ts:572-644` (forma del probe) + `:1101-1130` (delta de token balances) | 3 valores, `getSignatureStatuses` + `searchTransactionHistory` como ÚNICA fuente de una negativa, NUNCA lanza |
| `src/adapters/solana/deposit-account.ts` **(nuevo)** | `src/adapters/solana/chain.ts:39-70` (resolución env, opts>env>default) + `payment.ts:214` (derivación de ATA) | Un getter por valor, sin hardcodes, sin `Keypair` |
| `src/lib/ed25519.ts` **(nuevo)** | `src/lib/wallet-format.ts` (módulo leaf, cero imports del proyecto) + `src/services/transform-hmac.ts` (uso de `node:crypto`) | Puro, sin dependencias nuevas |
| `isValidSolanaSignature` en `src/lib/wallet-format.ts` | `isValidSolanaAddress` (`:50-71`) del MISMO archivo | Misma técnica base-x, 64 bytes en vez de 32 |
| `bindSolanaFundingWallet` en `src/services/identity.ts` | `bindFundingWallet` (`:171-199`) del MISMO archivo | UPDATE filtrado por `id`+`owner_ref`, 23505 → `FundingWalletAlreadyBoundError`, 0 filas → `OwnershipMismatchError` |
| Migración `..._wkh315_solana_deposit.sql` | `20260529000001_...funding_wallet.sql` (columna+índice parcial aditivos) + `20260529000000_....sql:32,:93-103` (DROP antes del REPLACE + hardening) + `20260606000000_...:165` (param con DEFAULT) | Aditiva, idempotente, con `_down`, `SET search_path`, `REVOKE`/`GRANT` |
| `test/wkh315-solana-deposit.migration.test.ts` | `test/wkh307-solana-settle-intents.migration.test.ts` + `test/helpers/sql-predicate.ts` | Parseo del `.sql` con predicados en JS; helper **fuera** del glob de vitest |
| Tests de ruta | `src/routes/auth.test.ts` | `app.inject` + mocks de `identityService`/`budgetService` |
| Tests del verificador | `src/adapters/deposit-verifier.test.ts` | Doble del cliente de cadena, un caso por `reason` |

### 3.3 Estado de BD relevante (verificado en migraciones)

| Tabla / columna | Existe | Detalle |
|---|---|---|
| `a2a_key_deposits` | **Sí** | `chain_id INT`, `tx_hash TEXT` sin CHECK, `UNIQUE (chain_id, tx_hash)`, `owner_ref TEXT`, RLS ON |
| `a2a_key_deposits.vm_family` | **No — se crea (W0.3)** | `TEXT NOT NULL DEFAULT 'evm'` + `CHECK IN ('evm','solana')` |
| índice `uq_a2a_key_deposits_solana_sig` | **No — se crea (W0.3)** | `UNIQUE (tx_hash) WHERE vm_family='solana'` |
| `a2a_agent_keys.funding_wallet` | **Sí** | `TEXT` nullable + UNIQUE parcial. **NO se toca** |
| `a2a_agent_keys.funding_wallet_solana` | **No — se crea (W0.3)** | `TEXT` nullable + UNIQUE parcial propio |
| RPC `register_a2a_key_deposit/6` | **Sí** | Se **DROPea** y se recrea con 7 params (W0.3) |
| Base destino | — | **`bdwv` únicamente.** `caldz` PROHIBIDA (CD-12) |

### 3.4 El mecanismo que el encargo pidió evaluar: `destination` **no puede expresar una red**

Tres evidencias independientes:

1. **La columna se documenta como identidad de agente**, no de red:
   `20260606000000_a2a_key_spend_policies.sql:14` — `destination TEXT NOT NULL, --
   "<registry>/<slug>" normalizado (trim+lowercase)`.
2. **El call-site del débito la deriva del AGENTE resuelto**:
   `compose.ts:490-492` — `normalizeDestination(`${agent.registry}/${agent.slug}`)`; el
   step-0 idem en `routes/compose.ts:70`. **Ningún call-site produce un slug de red.**
3. **El normalizador la baja a minúsculas** (`spend-policy.ts:51-57`), así que además es
   incapaz de transportar una pubkey base58 sin destruirla (CD-6).

**Conclusión: la puerta de liquidez por red necesita una dimensión nueva.** No se puede
expresar como una `a2a_key_spend_policies` con `destination='solana-devnet'`: aunque el
operador la insertara, el `p_destination` que llega al RPC en el hot-path es siempre
`<registry>/<slug>`, así que la política **nunca haría `FOUND`** y el cap sería un control
inejercitable — exactamente el patrón que el AR de WKH-234 marcó como BLQ-MED-1.
Ver el diseño de la puerta en el **Apéndice A** (HU aparte: es camino de SALIDA).

### 3.5 Auto-Blindaje histórico — patrones recurrentes que se convierten en CD

Leídos: `209-wkh-307/auto-blindaje.md` (435 L), `208-compose-por-capacidad/` (58 L),
`203-compose-refund-broadcast-evidence/` (25 L). Cuatro patrones con **≥2 apariciones**:

| Patrón recurrente | Apariciones | Se previene con |
|---|---|---|
| **"No pude preguntar" leído como negativa demostrada** | 209 §BLQ-MEDIO-1, 209 §Wave-0 (×2: `table_missing` y `rpc_missing` para un `fetch failed`), y la HU 201 entera | **CD-14** |
| **Falso KILLED / la suite reporta algo que no habla del código** | 209 §M12 (`no tests` por un throw en el cuerpo del `describe`), 208 §M5 (mutante sobreviviente por un assert que no medía el costo) | **CD-15** |
| **Un fixture "del tipo correcto" que funciona por casualidad** | 209 §W3 (blockhash de 32 *caracteres*), 209 §Hallazgo-1 (uint64 max en una columna `BIGINT` con signo) | **CD-16** |
| **Un gate/precondición que nadie corre no es un gate** | 209 §MNR-4 (`_down` sin re-hidratación), 209 §MNR-1 (warn de arranque ⇒ pasó a cortar) | **CD-17** |

Además, dos reglas operativas de 203 y 209 que gobiernan la campaña de mutación de §8.4:
**nunca `git checkout --` sobre trabajo sin commitear** (203) y **respaldo físico + hash**
antes de mutar (203, 209).

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| # | Archivo | Acción | Qué hace | Exemplar | Wave | AC |
|---|---|---|---|---|---|---|
| 1 | `src/adapters/types.ts` | Modificar (bloque **aditivo**) | `SolanaDepositLanding` (5 estados) + `SolanaDepositVerification` (unión discriminada) | `types.ts:170-187` | W0.1 | AC-2,6 · CD-3 |
| 2 | `src/lib/wallet-format.ts` | Modificar (aditivo) | `isValidSolanaSignature` (base58 → 64 bytes) | `isValidSolanaAddress` `:50-71` | W0.2 | AC-1,8 |
| 3 | `supabase/migrations/20260731000000_wkh315_solana_deposit.sql` + `_down.sql` | **Crear** | §4.7 | §3.2 | W0.3 | AC-3,7,13 |
| 4 | `src/adapters/deposit-verifier.ts` | Modificar (**solo firmas**) | `EvmChainKey` + `isEvmChainKey` + `resolveTreasury(chainKey: EvmChainKey)`. Cuerpo byte-idéntico | — | W0.4 | AC-14 · CD-5 |
| 5 | `src/adapters/solana/deposit-account.ts` | **Crear** | Owner + ATA de depósito + flag propio. CERO `Keypair` | `solana/chain.ts:39-70`, `payment.ts:214` | W1.1 | AC-4,12,14 |
| 6 | `src/adapters/solana/deposit-verifier.ts` | **Crear** | El verificador: presencia → `finalized` → términos → union | `payment.ts:572-644`,`:1101-1130` | W1.2 | AC-1,2,4,5,6,15 |
| 7 | `src/lib/ed25519.ts` | **Crear** | `verifyEd25519Base58` con `node:crypto` | `wallet-format.ts` (leaf) | W1.3 | AC-7 |
| 8 | `src/services/identity.ts` | Modificar (aditivo) | `bindSolanaFundingWallet` — byte-exacto, sin `toLowerCase` | `identity.ts:171-199` | W1.4 | AC-7,8 |
| 9 | `src/routes/auth/parsers.ts` | Modificar (aditivo) | `solanaFundingWalletBindMessage(keyId)` | `parsers.ts:35-37` | W2.1 | AC-7 |
| 10 | `src/routes/auth/funding-wallet.ts` | Modificar | Rama `namespace:'solana'` del bind | el mismo archivo, rama EVM | W2.2 | AC-7,8 |
| 11 | `src/services/budget.ts` | Modificar | `registerDeposit(..., vmFamily)` → `p_vm_family` | `budget.ts:720-760` | W2.3 | AC-3,13 |
| 12 | `src/routes/auth/deposit.ts` | Modificar | Validación por familia, bifurcación del verify, gate Solana, mapeo de errores, `deposit-info` | el mismo archivo | W2.4 | AC-1..11 |
| 13 | `src/adapters/solana/chain.ts` | Modificar (aditivo) | Coherencia cuenta-de-depósito ↔ operador al cargar el keypair | `schema-preflight.ts:120` | W3.1 | §4.4 |
| 14 | `.env.example`, `doc/INTEGRATION.md`, `doc/MULTI-CHAIN.md` | Modificar | Envs nuevas + runbook del depositante | — | W3.2 | AC-11 |
| 15 | Tests (§8) | **Crear**/Modificar | 6 archivos | §3.2 | W1-W3 | todos |

**NO se toca, explícitamente:** `src/adapters/solana/payment.ts` (§7.1),
`src/adapters/registry.ts`, `src/middleware/x402.ts`, `src/services/compose.ts`,
`src/lib/downstream-payment.ts`, `verifyDeposit`, `bindFundingWallet`,
`increment_a2a_key_spend`, `src/adapters/solana/schema-preflight.ts`.

### 4.2 La contabilidad — MI-1 / D-1, resuelto con evidencia y con una escalación

**Hallazgo que cambia el marco de la pregunta.** El work-item pregunta si un saldo fondeado
en Solana puede pagar a un agente que cobra en Avalanche. **Ya puede, hoy, y no por esta
HU**, porque los dos extremos están desacoplados en el código:

- el bucket que se **debita** lo elige el **CALLER** con el header `x-payment-chain`
  (`a2a-key.ts:358-362`, con fallback al default en `:372`);
- la chain en la que se **paga al agente** la declara el **AGENTE**
  (`downstream-payment.ts:640`).

O sea: **cruzar de riel ya es la conducta de producción.** Un caller con saldo en Fuji que
invoca un agente que cobra en Solana debita `budget['43113']` y el operador paga con SUS
fondos de Solana. Esta HU no abre ese cruce; lo que hace es permitir que el saldo del caller
**se origine** en Solana.

**Diseño (DT-7).** El depósito Solana acredita `budget['<bundle.chainConfig.chainId>']` —
el sentinel, exactamente igual que el camino EVM acredita el suyo (`deposit.ts:88`, CD-5).
Cero cambios en `increment_a2a_key_spend`, cero cambios en `getBalance`, cero cambios en la
forma de `GET /me` ⇒ **CD-1 se cumple trivialmente**.

**Escalación honesta sobre la decisión #1 del founder ("contabilidad ÚNICA, un solo saldo,
no uno por red").** Esa decisión **no es implementable dentro de esta HU**, y el motivo es
de código:

- `budget` es un JSONB indexado por `chain_id::TEXT` (`20260406000000:14-15`);
- **el débito lee ese índice**: `increment_a2a_key_spend` hace
  `v_current_bal := COALESCE((v_row.budget ->> p_chain_id::TEXT)::NUMERIC, 0)` y
  `INSUFFICIENT_BUDGET` si no alcanza (`:102-108`);
- así que "un solo saldo" exige reescribir `increment_a2a_key_spend` (usado por **los tres**
  caminos de débito: master, delegación y sesión), `getBalance`, el helper del mensaje de
  `INSUFFICIENT_BUDGET` (`a2a-key.ts:411-428`) y la forma pública de `GET /me`.
- Eso es **camino de GASTO**, es EVM además de Solana, y **CD-1 lo prohíbe** ("el camino EVM
  queda byte-idéntico"). No es un recorte de alcance: es otra HU.

**Y hay un argumento de producto para NO hacerlo antes del 03/08**, que ofrezco porque el
founder decide con él y no contra él: **el bucket por red es lo que hace AUDITABLE el claim
de la incubadora.** Con `budget['900001']` se puede mostrar, fila por fila, que los dólares
que pagaron a los 3 agentes entraron por Solana (`a2a_key_deposits` los nombra con su firma).
Con un pool único fungible **la procedencia se borra**: no habría forma de demostrar que no
se gastó plata que entró por Avalanche. Para el compromiso *"no debe intervenir Avalanche"*,
el saldo segregado no es una limitación, es la evidencia.

→ Queda como **`[DECIDE FOUNDER]` D-7**, no bloqueante de esta HU: (i) confirmar el bucket
por red para el 03/08 (recomendado), o (ii) abrir una HU propia de contabilidad única
(estimación honesta: L, toca los tres caminos de débito).

### 4.3 Footgun 2 — cómo se cierra `finalized` (CD-7)

Tres piezas, ninguna env-override-able hacia abajo:

1. **Constante congelada, no env.** El commitment del depósito es un literal del módulo:
   `const DEPOSIT_COMMITMENT = 'finalized' as const;` en
   `src/adapters/solana/deposit-verifier.ts`. **PROHIBIDA una env que lo debilite**: una
   variable capaz de bajar una garantía de dinero es el mismo footgun que `SKIP_`, y el
   Auto-Blindaje de 209 (`SOLANA_RPC_LEDGER_HISTORY_DECLARED_SUFFICIENT`) muestra la única
   forma admitida de una salida por env — **declarar una afirmación del operador, nunca
   apagar un control**. Acá no hay nada que el operador pueda afirmar en lugar de la cadena.
2. **La finalidad se LEE, no se hereda.** `getSignatureStatuses` devuelve
   `confirmationStatus` por firma. Se exige **`=== 'finalized'`** como evidencia POSITIVA:
   - `'processed'` / `'confirmed'` ⇒ `not_finalized` (negativa **medida**, reintentable) →
     400 `DEPOSIT_NOT_FINALIZED`;
   - `confirmationStatus` **ausente/desconocido** ⇒ `unknown` (**no** "todavía no") → 503
     `DEPOSIT_VERIFICATION_UNKNOWN`. Es CD-14 aplicado a la finalidad misma.
3. **Los términos también se leen a `finalized`.** `getParsedTransaction(signature, {
   commitment: 'finalized', maxSupportedTransactionVersion: 0 })`. **NO** se usa
   `getSolanaCommitment()` (default `confirmed`, `chain.ts:43-46`) ni se hereda el commitment
   de la `Connection` compartida — el override es por llamada, así que la `Connection` cacheada
   de `getSolanaConnection()` se puede reusar sin contaminar el settle.

> Nota de honestidad, para que el AR no la levante como hallazgo nuevo: `payment.ts:619` y
> `:1141` leen a `'confirmed'` **a propósito**, con su razón escrita. Son del camino de
> SALIDA y quedan intactos (CD-1 no los cubre pero §6 Scope OUT sí).

### 4.4 Footgun 1 — el destino, y MI-6

**El landmine, re-verificado:** `resolveTreasury('solana-devnet')` busca
`A2A_DEPOSIT_TREASURY_SOLANA` (`:113`, el sufijo sale de `resolveChainFamilyEnvSuffix` →
`'SOLANA'`), lo testea contra `ADDRESS_RE = /^0x…{40}$/` (`:59`,`:114`) — **una pubkey base58
falla** — y cae al fallback `privateKeyToAccount(OPERATOR_PRIVATE_KEY).address` (`:117-124`).
Devuelve **una dirección EVM** como destino esperado de un depósito Solana, en silencio.

**Cierre en dos capas, la segunda es el compilador (AC-14):**

- **(a) Prohibición (CD-5).** El camino Solana resuelve su destino en
  `src/adapters/solana/deposit-account.ts`, nunca con `resolveTreasury`.
- **(b) Imposibilidad por tipos.** En `deposit-verifier.ts` se agrega
  `export type EvmChainKey = Exclude<ChainKey, 'solana-devnet'>` y
  `export function isEvmChainKey(k: ChainKey): k is EvmChainKey` (implementado con
  `getChainVmFamily(k) === 'evm'`, la proyección PURA y exhaustiva de `chain-resolver.ts:98`),
  y **`resolveTreasury` pasa a recibir `EvmChainKey`**. Un reuso ingenuo desde Solana
  **no compila**. El cuerpo de `resolveTreasury` y de `verifyDeposit` **no cambia una línea**.
  - Único call-site externo: `deposit.ts:218` (`deposit-info`). Ahí `chainKey` es `ChainKey`
    y el guard actual (`payment.vmFamily !== 'evm'`, `:207`) **narrowea `payment`, no
    `chainKey`**, así que no alcanza para `tsc`. Se **conserva** ese guard tal cual y se
    **agrega** `if (!isEvmChainKey(chainKey)) return null;` inmediatamente después. Dos
    guards redundantes a propósito: el primero preserva la conducta observable byte a byte
    (CD-1), el segundo es el que narrowea. `resolveTreasury(chainKey)` en `:304` ya está
    dentro de `verifyDeposit`, que sólo se invoca desde la rama EVM.

**La cuenta de depósito (MI-6).**

- Env **obligatoria y sin fallback**: `A2A_DEPOSIT_OWNER_SOLANA` (pubkey base58, validada con
  `isValidSolanaAddress`). Ausente o inválida ⇒ **el camino de depósito Solana está
  deshabilitado** (fail-loud), NUNCA un fallback. *El fallback silencioso es exactamente cómo
  `resolveTreasury` se volvió un landmine; no se repite la forma.*
- **El destino esperado es la ATA, no el owner** (CD-5):
  `getAssociatedTokenAddressSync(new PublicKey(getSolanaUsdcMint()), new
  PublicKey(A2A_DEPOSIT_OWNER_SOLANA))` — mismo derivador que `payment.ts:214`, sin red y
  **sin `Keypair`** (AC-12/CD-4).
- **Recomendación (`[DECIDE FOUNDER]` D-6): que sea la pubkey del OPERADOR.** Argumento que
  conecta con las decisiones #2 y #4 del founder: si los depósitos entran a la misma cuenta
  desde la que salen los pagos, **cada depósito re-abastece la liquidez Solana del operador**
  y la puerta de liquidez del Apéndice A dispara menos recargas manuales. Contra-argumento
  (el que da el work-item): mezclar entrada y salida complica la reconciliación. **Mitigación
  verificada:** los dos flujos ya son separables en los libros sin separar la cuenta —
  `a2a_key_deposits` nombra cada crédito con su firma y monto, y
  `a2a_solana_settle_intents` nombra cada pago con su firma.
- **Riesgo de configuración, y su gate (W3.1).** Si la env apunta a una pubkey que el
  operador no controla, el dinero del usuario aterriza en una cuenta desde la que no se puede
  pagar. No se puede chequear desde el camino de depósito sin importar el `Keypair` (CD-4), y
  no se puede chequear en `createSolanaAdapters` porque **hoy esa factory NO carga el keypair**
  (`solana/index.ts:16-39`) y hacerlo rompería el arranque de un proceso que sólo quiere
  recibir depósitos. Diseño: la aserción vive en `chain.ts:getSolanaOperatorKeypair()`
  **después** de la carga exitosa (que ya loguea la pubkey, `:95-98`) — cero dependencia de
  arranque nueva, y fail-loud. Salida explícita declarada, siguiendo el exemplar de
  `schema-preflight.ts:120`: `A2A_DEPOSIT_OWNER_IS_DEDICATED_SOLANA=true` cuando la cuenta de
  depósito es deliberadamente distinta de la del operador.
  **Trade-off declarado:** un error de config del DEPÓSITO deja de settlear la SALIDA. Es
  ruidoso, inmediato y reversible en un minuto, contra un dinero perdido que no lo es —
  la misma asimetría que resolvió 209 §MNR-1. **Cuttable** si el AR lo considera demasiado
  blast-radius; en ese caso el residuo pasa a runbook y se declara.

### 4.5 Footgun 3 y la validación de entrada — el orden importa (CD-8 / AC-13 / MI-5)

**El problema de orden.** `TX_HASH_RE` corre en el paso 2 (`deposit.ts:57`,`:63`), **antes**
de resolver la chain (paso 3, `:76-87`). Una validación por familia necesitaría saber la
familia primero, pero **mover la resolución de chain hacia arriba cambia el `error_code` de
la rama EVM** (`INVALID_INPUT` → `CHAIN_NOT_SUPPORTED` para un input doblemente malo) ⇒
**CD-1 lo prohíbe**.

**Diseño en dos tiempos (DT-5 reformulado):**

- **Paso 2 (mismo lugar, misma respuesta).** El tx_hash se acepta si es un hash EVM **o** una
  firma Solana: `TX_HASH_RE.test(t) || isValidSolanaSignature(t)`. **NO es un regex laxo**
  (CD-6b): son dos predicados estructurales estrictos y **mutuamente excluyentes** (el
  alfabeto base58 no contiene `'0'`, así que ningún `0x…` es base58; y el charset hex no
  produce 64 bytes base58). Cualquier otra cosa sigue dando **400 `INVALID_INPUT`** en el
  mismo lugar. *Verificado que la suite existente queda verde: el caso de `auth.test.ts:447`
  usa `'0xbad'`, que falla los DOS predicados.*
- **Paso 3b (nuevo, después de resolver el bundle).** Se exige coherencia
  familia↔formato: `getChainVmFamily(chainKey)` vs el predicado que matcheó. Mismatch ⇒
  **400 `INVALID_INPUT`** (mismo código que antes tenía ese input) y **cero red**.
  Delta observable único y declarado: `{tx_hash: <firma base58>, chain_id: <inexistente>}`
  pasa de `INVALID_INPUT` a `CHAIN_NOT_SUPPORTED`. Antes era **inalcanzable** (toda firma
  base58 daba `INVALID_INPUT`), así que ningún cliente EVM existente puede observarlo. Sin
  test existente afectado.

**MI-5 — resuelto: header obligatorio, PROHIBIDO el alias numérico.** `SLUG_ALIASES`
(`chain-resolver.ts:20-68`) es un mapa **PURO que no lee env** (CD-7 de WKH-234), mientras el
sentinel es env-driven (`chain.ts:65-70`). Hardcodear `'900001': 'solana-devnet'` haría que
con `SOLANA_SYNTHETIC_CHAIN_ID=900002` el alias siga ruteando a Solana mientras
`bundle.chainConfig.chainId` dice 900002 ⇒ **400 `CHAIN_MISMATCH` inexplicable**. Un caller
Solana manda `x-payment-chain: solana-devnet` (o `solana`) y `chain_id` = el valor que
`GET /auth/deposit-info` publica (AC-11). El guard de `deposit.ts:91-93` sigue vigente sin
cambios.

**El candado de CD-8 / AC-13: un índice, no una env.** El sentinel es mutable en caliente y
la clave actual es `(chain_id, tx_hash)`, así que cambiarlo re-abriría **todos** los
depósitos pasados. Se cierra **en la base**:

```
ALTER TABLE a2a_key_deposits
  ADD COLUMN IF NOT EXISTS vm_family TEXT NOT NULL DEFAULT 'evm';
ALTER TABLE a2a_key_deposits
  ADD CONSTRAINT chk_a2a_key_deposits_vm_family CHECK (vm_family IN ('evm','solana'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_a2a_key_deposits_solana_sig
  ON a2a_key_deposits (tx_hash) WHERE vm_family = 'solana';
```

Tres propiedades, las tres verificadas contra el código existente:

1. **El índice nuevo NO menciona `chain_id`** ⇒ ninguna mutación de env puede crear una
   segunda fila creditable para la misma firma. **Estructural, no confiada a un guard.**
2. **`UNIQUE (chain_id, tx_hash)` queda intacto** ⇒ la rama EVM es byte-idéntica (CD-1).
3. **La traducción del anti-replay no necesita cambios**: el bloque
   `EXCEPTION WHEN unique_violation THEN RAISE 'DEPOSIT_ALREADY_CREDITED'`
   (`20260529000000:74-79`) es **agnóstico de qué índice se violó**. El nuevo índice hereda el
   409 sin una línea de plpgsql nueva.

Y el `p_chain_id` que se escribe sigue siendo `bundle.chainConfig.chainId` (CD-5). Si alguien
cambia el sentinel, el peor caso pasa a ser **un bucket de saldo que no se puede gastar desde
el bucket viejo** (recuperable, visible, sin pérdida) en vez de **saldo duplicado**
(irreversible). Cuando los dos errores no cuestan lo mismo, el default va del lado barato.

### 4.6 El flag propio del depósito (MI-4)

- `SOLANA_ADAPTER_ENABLED === 'true'` (default OFF) ya gatea el rail entero, con
  **choke-point único** en `registry.ts:62-64` y la regla explícita de que *el resolver y el
  adapter NO leen esa env*. Sin ella, `getAdaptersBundle('solana-devnet')` es `undefined` y
  `deposit.ts:85-87` responde `CHAIN_NOT_SUPPORTED`. **Mi módulo NO la lee** (respeta CD-7 de
  WKH-234): el AND es estructural, vía la existencia del bundle.
- **Flag propio, nuevo: `A2A_DEPOSIT_ENABLED_SOLANA` (default OFF).** Justificación: encender
  el rail de SALIDA (pagarle a un agente) y abrir un camino de ENTRADA de dinero son dos
  decisiones distintas, y **CD-13 exige** poder publicar la cuenta de depósito sólo cuando la
  verificación está cableada Y habilitada. Un solo flag obligaría a elegir entre "no puedo
  settlear" y "publiqué una cuenta de depósito sin verificador".
- **Choke-point único**: `isSolanaDepositEnabled()` en `deposit-account.ts`, que exige
  `A2A_DEPOSIT_ENABLED_SOLANA === 'true'` **Y** `resolveSolanaDepositOwner() !== null`.
  Comparación estricta de string (PROHIBIDO `Boolean(process.env...)`), exemplar
  `parsers.ts:81-83`.

### 4.7 Modelo de datos — la migración (W0.3)

`supabase/migrations/20260731000000_wkh315_solana_deposit.sql` (+ `_down.sql`).
**Destino: `bdwv` ÚNICAMENTE. `caldz` PROHIBIDA (CD-12).** Aditiva e idempotente.

1. `a2a_key_deposits.vm_family TEXT NOT NULL DEFAULT 'evm'` + CHECK + índice parcial UNIQUE
   sobre `tx_hash` (§4.5). El DEFAULT es lo que mantiene byte-idénticas las filas EVM.
2. `a2a_agent_keys.funding_wallet_solana TEXT` + `CREATE UNIQUE INDEX
   uq_a2a_agent_keys_funding_wallet_solana ON a2a_agent_keys (funding_wallet_solana) WHERE
   funding_wallet_solana IS NOT NULL`. **UNIQUE plano sobre la columna cruda** — espejo exacto
   de `20260529000001:29-31`, y en Postgres la igualdad de `TEXT` es **byte-exacta**, así que
   el índice es case-sensitive sin hacer nada (CD-6/AC-8). **PROHIBIDO `lower()`** en este
   índice.
   - *Por qué una columna nueva y no reusar `funding_wallet`*: (a) `funding_wallet` se
     persiste lowercase desde la app (`identity.ts:176`) y su docstring/migración lo declaran
     contrato — cambiar eso toca el camino EVM; (b) con una sola columna, un owner **no puede
     tener las dos wallets bindeadas**, y con el cruce de rieles de §4.2 eso es un hueco
     funcional real; (c) decidir qué gate aplica **olfateando el formato** del valor
     almacenado es implícito, y esto es un control de seguridad. Con dos columnas el gate lo
     elige `bundle.payment.vmFamily`, explícito y visible al compilador.
3. `DROP FUNCTION IF EXISTS register_a2a_key_deposit(uuid,integer,numeric,text,text,text);`
   **antes** del `CREATE OR REPLACE` de 7 params. **Esto no es opcional**: es el bug BLQ-MED-1
   documentado en `20260529000000:148-155` — `CREATE OR REPLACE` con tipos de entrada
   distintos crea una **SOBRECARGA**, y un caller queda con
   `function ... is not unique`.
4. `register_a2a_key_deposit(..., p_vm_family TEXT DEFAULT 'evm')`. El cuerpo cambia en **una
   sola cosa**: el INSERT también escribe `vm_family`. El `DEFAULT` hace que la llamada de 6
   args siga válida (exemplar: `p_destination TEXT DEFAULT NULL` en `20260606000000:165`), y
   `supabase-js` pasa args nombrados, así que la rama EVM que no lo manda recibe `'evm'`.
   El orden de las operaciones (lock → ownership → active → INSERT anti-replay → crédito)
   **no se toca**: es lo que hace la escritura condicional atómica de AC-3.
5. Hardening obligatorio sobre la firma de 7 params: `SET search_path = public, pg_temp` +
   `REVOKE ... FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role` (exemplar
   `20260529000000:93-103`).
6. **RLS**: nada que hacer (MI-7 — `a2a_key_deposits` ya tiene RLS ON sin policy = deny-all
   para `anon`/`authenticated`; el service usa `service_role`, que bypassa).
7. **`_down.sql`**: DROP del índice parcial nuevo, DROP de la constraint CHECK, DROP de las
   dos columnas, DROP de la fn de 7 params y **restauración de la de 6** (exemplar
   `20260529000000:27-31`).
   ⚠️ **CD-17 aplicado (auto-blindaje 209 §MNR-4): el `_down` es la mitad de un CICLO.** Acá
   `_down` **sí destruye datos** (`DROP COLUMN vm_family`), así que un `down → up` deja todas
   las filas Solana con `vm_family='evm'` y **su unicidad pasaría a depender del sentinel otra
   vez**. Por eso el `_down` **debe** archivar antes: `CREATE TABLE
   a2a_key_deposits_solana_backup_wkh315 AS SELECT id, tx_hash FROM a2a_key_deposits WHERE
   vm_family='solana'`, y el `up` **debe** re-hidratar `vm_family='solana'` desde ese backup si
   existe, antes de crear el índice. Sin eso, un ciclo de rollback re-abre para re-crédito
   todos los depósitos Solana pasados. **Es el mismo bug que 209 documentó, en otra ropa.**

### 4.8 El verificador Solana (W1.2) — tipos y secuencia

**Tipos (W0.1, `src/adapters/types.ts`, bloque aditivo). CD-3: nada de `boolean` ni `T|null`.**

- `SolanaDepositLanding` — presencia **con finalidad**, 5 estados, exhaustividad forzada:
  `{state:'finalized_ok'}` · `{state:'landed_failed', detail}` ·
  `{state:'not_finalized', confirmationStatus}` · `{state:'absent'}` ·
  `{state:'unknown', detail}`.
- `SolanaDepositVerification` — unión discriminada del veredicto completo:
  `{ok:true, amountAtomic: bigint, amountUsd: string, depositor: string, ata: string,
  mint: string, signature: string}` |
  `{ok:false, reason: SolanaDepositReason, detail?: string}` con
  `SolanaDepositReason = 'TX_ABSENT' | 'TX_FAILED' | 'DEPOSIT_NOT_FINALIZED' |
  'MINT_MISMATCH' | 'RECIPIENT_MISMATCH' | 'AMOUNT_MISMATCH' | 'DEPOSITOR_AMBIGUOUS' |
  'DEPOSIT_ACCOUNT_NOT_CONFIGURED' | 'DEPOSIT_VERIFICATION_UNKNOWN'`.
  **PROHIBIDO copiar la forma de `DepositVerification`** (`deposit-verifier.ts:38-48`): tiene
  `ok: boolean` + `reason?` y colapsa "no pude preguntar" en `TX_NOT_FOUND` (CD-3, CD-14).

**Secuencia de `verifySolanaDeposit({ signature, expectedAmountUsd })` — NUNCA lanza:**

1. **Cuenta de depósito.** `resolveSolanaDepositOwner()` → sin ella,
   `DEPOSIT_ACCOUNT_NOT_CONFIGURED` (503). Deriva la ATA esperada.
2. **Presencia (única fuente admitida de una negativa).**
   `getSignatureStatuses([signature], { searchTransactionHistory: true })`. Todo throw,
   array ausente o vacío ⇒ `unknown` (**no** `absent`). `status === null` **después de haber
   buscado** ⇒ `absent`. `status.err` ⇒ `landed_failed`.
   *Precondición ya cubierta y no debilitada: `probeRpcHistoryRetention`
   (`schema-preflight.ts:166-208`) mide la ventana de retención del endpoint y corta el rail
   si no alcanza. Ninguna HU la re-implementa (§8.5 del work-item).*
3. **Finalidad (§4.3).** `confirmationStatus === 'finalized'` ⇒ seguir. `'processed'`/
   `'confirmed'` ⇒ `not_finalized`. Ausente/desconocido ⇒ `unknown`.
4. **Términos, a `finalized`.** `getParsedTransaction(signature, {commitment:'finalized',
   maxSupportedTransactionVersion:0})`. Throw ⇒ `unknown`. `!parsed?.meta` ⇒ `unknown`
   ("el status dice que está pero este nodo no la tiene parseada" ≠ "no coinciden" — es la
   lección literal de `payment.ts:625-633`). `parsed.meta.err` ⇒ `landed_failed`.
5. **Clasificación de términos** sobre `pre/postTokenBalances`, espejando exactamente el
   orden del EVM (`deposit-verifier.ts:341-346`) para que los códigos sean distinguibles
   (AC-4 vs AC-5):
   - ninguna entrada con `mint === getSolanaUsdcMint()` en pre **ni** post ⇒
     **`MINT_MISMATCH`** (análogo de `TOKEN_MISMATCH`; comparación **case-SENSITIVE**, CD-6);
   - hay entradas del mint pero el **delta de la ATA esperada** no es `> 0` ⇒
     **`RECIPIENT_MISMATCH`** (análogo de `RECIPIENT_MISMATCH`).
   - **El match de destino es TRIPLE** (CD-5): `mint === esperado` **Y**
     `owner === A2A_DEPOSIT_OWNER_SOLANA` **Y** la dirección de la cuenta —
     `parsed.transaction.message.accountKeys[accountIndex]` — **=== la ATA derivada**.
     *Por qué las tres y no sólo `(owner, mint)` como `checkTerms` (`payment.ts:1117-1119`):
     un `find` por `(owner,mint)` toma la PRIMERA de varias cuentas posibles del mismo owner
     para el mismo mint y puede sub-medir el delta; y CD-5 exige comparar contra la ATA, no
     contra el owner.*
   - `amountAtomic = delta`. `amountUsd = formatUnits(delta, getSolanaUsdcDecimals())`.
6. **El depositante (`from`) — AC-7 / AC-15.** El análogo de `Transfer.from` es el **owner de
   la cuenta de origen**, o sea el `owner` de las entradas del mint cuyo delta es
   **negativo** (leído de `preTokenBalances`, que es donde el owner está poblado aun si la
   cuenta se cierra en la misma tx). No es el fee-payer: en Solana el fee-payer puede ser un
   tercero (gasless) y no tiene por qué haber puesto los fondos.
   - exactamente **un** owner de origen distinto ⇒ ése es el depositante;
   - **dos o más** ⇒ **`DEPOSITOR_AMBIGUOUS`** (fail-closed, sin acreditar, sin consumir la
     prueba — AC-15). Un wallet legítimo no produce esto y adivinar cuál de dos es el
     depositante es exactamente donde se pierde el gate;
   - **cero** (imposible si el delta de destino es `> 0`, pero el compilador no lo sabe) ⇒
     `DEPOSITOR_AMBIGUOUS`, no un `undefined` que se cuele.
7. **Monto declarado (opcional), sin pérdida de precisión.** Si el caller mandó `amount`, se
   compara **BigInt contra BigInt**: `parseUnits(expectedAmountUsd, decimals)` (string→atómico)
   vs `amountAtomic`; throw de `parseUnits` ⇒ `AMOUNT_MISMATCH`. Espeja FIX-3
   (`deposit-verifier.ts:350-365`).
   **PROHIBIDO `usdToAtomicUnits`** acá: toma un `number` (`atomic-amount.ts:87`) y FIX-3
   existe precisamente para no pasar el monto declarado por un float.
8. Éxito ⇒ `{ok:true, ...}`. **El monto acreditado es SIEMPRE el de la cadena** (AC-1).

### 4.9 Flujo principal (Happy Path)

1. El owner llama `POST /auth/funding-wallet` con `{ namespace:'solana', wallet:<pubkey
   base58>, signature:<firma base58 de 64 bytes> }`. El gateway verifica ed25519 (§5) y
   persiste `funding_wallet_solana` **byte-exacto**.
2. El owner lee `GET /auth/deposit-info` y obtiene, para `solana-devnet`: `chain_id`
   (el sentinel), `cluster`, `mint`, `decimals`, `deposit_account` (**la ATA derivada**),
   `deposit_account_owner`, `required_commitment: 'finalized'`.
3. El owner transfiere USDC de devnet a esa ATA **desde la wallet bindeada** y **paga su
   propio fee** (AC-12: el gateway no firma nada).
4. `POST /auth/deposit` con `x-payment-chain: solana-devnet`, `{key_id, chain_id:<sentinel>,
   tx_hash:<firma base58>, amount?}`.
5. Paso 2 acepta el formato (§4.5) → paso 3 resuelve el bundle → paso 3b confirma
   familia↔formato → **paso 5 bifurca por `bundle.payment.vmFamily === 'solana'`** a
   `verifySolanaDeposit` (viem no se toca, `resolveChainObject` no se alcanza).
6. Gate de funding wallet, rama Solana: `callerKey.funding_wallet_solana` presente (si no,
   403 `FUNDING_WALLET_NOT_BOUND`) y `result.depositor === callerKey.funding_wallet_solana`
   con **comparación byte-exacta, sin `toLowerCase()`** (CD-6). Mismatch ⇒ 403
   `FUNDING_WALLET_MISMATCH`.
7. `budgetService.registerDeposit(keyId, chainId, result.amountUsd, ownerRef, signature,
   'USDC', 'solana')` → RPC en UNA transacción: lock → ownership → active → **INSERT
   anti-replay** → crédito. 200 `{balance, chain_id}`.
8. Recibo `deposit_verified` best-effort, `void` sin await (`deposit.ts:153-164`, sin cambios).

### 4.10 Flujo de error, y la política del founder (AC-6 / CD-9)

**La regla, verificada como preexistente en EVM:** todo fallo retorna **antes** de
`registerDeposit`, así que **no se inserta fila** y la firma sigue reclamable. Esta HU
**preserva** esa propiedad, no la inventa.

| Condición | `error_code` | Status | ¿Consume la prueba? |
|---|---|---|---|
| tx_hash con formato de otra familia | `INVALID_INPUT` | 400 | No (cero red) |
| firma ausente **habiendo buscado el histórico** | `TX_ABSENT` | 400 | No |
| aterrizó y falló on-chain | `TX_FAILED` | 400 | No |
| `processed`/`confirmed` (**medido**) | `DEPOSIT_NOT_FINALIZED` | 400 | No |
| mint distinto del configurado | `MINT_MISMATCH` | 400 | No |
| no acreditó a la ATA de depósito | `RECIPIENT_MISMATCH` | 400 | No. **Sin reembolso automático** (AC-4): runbook manual |
| monto declarado ≠ on-chain | `AMOUNT_MISMATCH` | 400 | No |
| >1 owner de origen | `DEPOSITOR_AMBIGUOUS` | 400 | No |
| cuenta de depósito sin configurar | `DEPOSIT_ACCOUNT_NOT_CONFIGURED` | **503** | No |
| **no se pudo determinar** | `DEPOSIT_VERIFICATION_UNKNOWN` | **503** | No |
| wallet Solana no bindeada / no coincide | `FUNDING_WALLET_NOT_BOUND` / `_MISMATCH` | 403 | No |
| firma ya acreditada | `DEPOSIT_ALREADY_CREDITED` | 409 | Ya estaba consumida |

- **La partición 400/503 es la que el founder pidió y ya existe en la casa**: 503 = "no puedo
  responder por la cadena/la config" (espejo de `RPC_UNAVAILABLE` /
  `ESCROW_CONTRACT_NOT_CONFIGURED`, `deposit.ts:119-123`); 400 + código propio = negativa
  **medida**, que el caller distingue por el código, igual que hoy distingue
  `INSUFFICIENT_CONFIRMATIONS`.
- **El mapeo del camino EVM NO se toca** (es una lista literal de `reason` en `:119-123`): la
  rama Solana tiene su propio mapeo sobre su propio tipo ⇒ CD-1 trivial.
- **Registro durable del `unknown` (AC-6, CD-11).** Se **reusa el canal y el vocabulario** que
  ya existe en `x402.ts:674-730` (HU-198/201, no de WKH-314): `log.error` con
  `error_code: 'DEPOSIT_VERIFICATION_UNKNOWN'` + **`valueDisposition: 'unknown'`** +
  `eventService.track({ eventType: 'solana_deposit_unknown', status: 'failed', metadata: {
  error_code, valueDisposition, signature, keyId, chainId, detail } })`, fire-and-forget con
  `.catch` (un fallo de telemetría **no puede** cambiar la respuesta de un money-path).
  - **`eventType` es `string` libre** (`src/types/index.ts:1298`) ⇒ no hay tipo que extender.
  - **NO se registra `owner_ref`**: `a2a_events` es telemetría global (CLAUDE.md) y el `keyId`
    ya alcanza para reconciliar. Es el mismo criterio que el canal x402, que anota `payTo` y
    el nonce, no el owner.
  - **Diferencia sustantiva que hay que anotar en el log**: en x402 el nonce ya estaba quemado
    cuando se emite el unknown; **acá la prueba NO se consumió** y el depositante puede
    reintentar. El mensaje debe decirlo, para que el operador no busque una reconciliación
    manual que no hace falta.
- **`base58DecodeToBytes` (`solana/base58.ts:62-81`) está PROHIBIDO sobre input del caller**:
  lanza con el literal `'SOLANA_OPERATOR_PRIVATE_KEY is not valid base58'` (`:67`). Un error de
  formato del usuario que menciona una clave privada en un log es, en el mejor de los casos,
  una falsa alarma de seguridad. Los decoders de esta HU (`isValidSolanaSignature`,
  `verifyEd25519Base58`) **devuelven, no lanzan**.

---

## 5. El corazón: la prueba de posesión ed25519 (AC-7 / MI-2 / D-3)

### 5.1 Por qué no hay alternativa a construirla

Saltear el gate para Solana **re-abre BLQ-MED-1**, y en Solana es peor que en EVM: las firmas
de una cuenta son **públicas** vía `getSignaturesForAddress` sobre la ATA de depósito, así que
un atacante no necesita front-runear nada — hace polling de la tesorería, toma la firma del
depósito ajeno y la presenta como propia. Y el **UNIQUE que existe para proteger garantiza
que el legítimo pierda**: su firma ya fue "acreditada"… a otro. **El anti-replay se vuelve el
aliado del ladrón.**

Con el gate, el mismo ataque termina en 403 `FUNDING_WALLET_MISMATCH` **sin insertar fila**,
así que el depositante legítimo sigue pudiendo reclamar. El gate no es una capa extra: es lo
que hace que el anti-replay siga siendo una defensa.

### 5.2 El primitivo — MEDIDO, no supuesto

**`node:crypto` verifica ed25519 nativamente, con cero dependencias nuevas.** Verificado en
este entorno (Node >= 22 por `package.json` → `engines`), no asumido:

```
spki der len 44   prefix 302a300506032b6570032100
sig len 64
verify ok: true
verify tampered: false
```

O sea: una pubkey ed25519 cruda de 32 bytes se vuelve verificable envolviéndola con el
**prefijo SPKI DER fijo de 12 bytes `302a300506032b6570032100`** y pasándola a
`crypto.verify(null, message, keyObject, signature)`. El `null` como algoritmo es correcto y
obligatorio para Ed25519 (la curva ya define el hash).

**Por qué `node:crypto` y no `tweetnacl`.** `tweetnacl` **no está declarada** en
`package.json`: entra sólo como transitiva de `@solana/web3.js`. `src/adapters/solana/base58.ts:8-11`
documenta la decisión ya tomada de la casa para el caso idéntico de `bs58`: *"NO se agrega
`bs58` como dependencia — depender de ella sería depender de un detalle de resolución
ajeno"*. Usar `nacl.sign.detached.verify` repetiría exactamente lo que ese comentario
prohíbe, y encima en un control de seguridad.

### 5.3 El diseño, pieza por pieza

**(a) El mensaje canónico — namespaced, nuevo, y el de EVM intacto.**
`solanaFundingWalletBindMessage(keyId)` = `` `WASIAI_BIND_FUNDING_WALLET_SOLANA:${keyId}` ``
(nuevo, en `parsers.ts`, junto al existente `:35-37`, que **no se toca**).

- **El `key_id` sale del caller autenticado, NUNCA del body** — misma propiedad que EVM
  (`funding-wallet.ts:63`): la prueba queda atada a una key concreta y no se puede replayear
  a otra.
- **Por qué un texto DISTINTO del de EVM y no el mismo.** Hoy los preimágenes ya difieren
  (EIP-191 prefija `\x19Ethereum Signed Message:\n<len>`, y `signMessage` de un wallet Solana
  firma los bytes crudos), así que compartir el texto **sería** seguro hoy. Se namespacea
  igual porque esa no-colisión depende de una convención de wallets ajena, y **una separación
  de dominios que cuesta 12 caracteres no se deja apoyada en la buena conducta de un tercero**.
- **Sin CAIP-2 ni cluster en el mensaje, a propósito**: el bind es por *key*, no por red, y
  meter un valor env-driven en el preimagen haría que un cambio de `SOLANA_CAIP2_CHAIN_ID`
  invalidara todos los binds existentes. Es el mismo error que CD-8 caza en otro lugar.

**(b) Formato — sin `ADDRESS_RE`, sin `toLowerCase()`.**
`isValidSolanaAddress(wallet)` (`wallet-format.ts:50-71`, ya existe: charset base58 + decode a
**exactamente 32 bytes**) y `isValidSolanaSignature(signature)` (nuevo, misma técnica, **64
bytes**). Ninguna normalización de caja en ningún punto (CD-6/AC-8).

**(c) Verificación.** `verifyEd25519Base58(message, pubkeyBase58, signatureBase58): boolean`
en `src/lib/ed25519.ts` — módulo **leaf** (cero imports del proyecto, como
`wallet-format.ts`), decodifica base58 sin lanzar, arma el SPKI, verifica. Cualquier fallo
(decode, longitud, verificación) ⇒ `false` ⇒ **403 `FUNDING_WALLET_PROOF_INVALID`**, el mismo
código que la rama EVM.
*Acá `boolean` **es** el tipo correcto y no viola CD-3: no hay un tercer valor. Un cómputo
criptográfico local no tiene "no pude preguntar" — no hay ningún sistema externo. CD-3 gobierna
las consultas a la cadena y a la base.*

**(d) Despacho — explícito, nunca por olfateo de formato.** El body gana un campo opcional
`namespace: 'evm' | 'solana'`, **default `'evm'`**. Un caller EVM de hoy manda `{wallet,
signature}` sin `namespace` ⇒ rama EVM byte-idéntica (CD-1). *No se despacha inspeccionando el
formato del valor: los dos predicados son mutuamente excluyentes hoy, pero elegir qué gate de
seguridad se aplica en base a una coincidencia de charset es exactamente la clase de
acoplamiento implícito que se rompe en silencio.* `namespace` con un valor no reconocido ⇒
400 `INVALID_INPUT` (fail-closed, no default a EVM).

**(e) Persistencia.** `identityService.bindSolanaFundingWallet(keyId, ownerId, pubkey)` —
copia de `bindFundingWallet` (`:171-199`) **sin la línea `wallet.toLowerCase()`**, escribiendo
`funding_wallet_solana`. Ownership Guard idéntico: `UPDATE ... .eq('id').eq('owner_ref')` +
`.select('id')`; 0 filas ⇒ `logOwnershipMismatch` + `OwnershipMismatchError` (403); `23505` ⇒
`FundingWalletAlreadyBoundError` (409).

**(f) Lo que este diseño NO arregla, dicho explícitamente.** Si un atacante consigue por
phishing que una víctima firme el mensaje con **el key_id del atacante**, puede bindear la
wallet de la víctima a su propia key y, por el UNIQUE, dejar a la víctima sin poder bindearla.
**Es paridad exacta con el camino EVM de hoy** (`funding-wallet.ts:62-75` tiene la misma
propiedad), no una regresión introducida acá. Se declara para que el AR no lo cuente como
hallazgo nuevo, y queda como deuda compartida de los dos rieles.

**(g) La opción de corte que el work-item ofrecía (pubkey registrada out-of-band) — NO se
elige, y por una razón técnica.** El bind ed25519 completo cuesta **~3 archivos chicos** (un
verificador leaf de ~30 líneas con el primitivo ya medido, una rama de ruta y un método de
service copiado del vecino). La alternativa manual ahorra menos de lo que el work-item
estimaba (que escribió el sizing antes de saber que `node:crypto` resuelve el primitivo sin
dependencia) y **cuesta más**: es un paso de operador por cada owner que quiera fondear, no
escala a la demo con más de un participante, y hay que hacerlo bien igual antes de mainnet.
**El residuo de negocio que sí queda** es la UX del depositante (cómo firma el mensaje desde
su wallet): es Scope OUT (§6) y se cubre con el runbook de W3.2.

---

## 6. Scope

**IN** — sólo `wasiai-a2a`, un escritor por repo:
- Los 15 ítems de la tabla §4.1.
- La migración a **`bdwv`**.
- Los 6 archivos de test de §8.
- Runbook del depositante + envs nuevas documentadas.

**OUT** (explícito):
1. `wasiai-facilitator` — **cero cambios**.
2. **La pared A (x402 inbound)** — es WKH-314.
3. **`src/adapters/solana/payment.ts` — cero cambios** (§7.1).
4. **mainnet**; sin slug `-mainnet`, sin RPC de mainnet, sin plata real.
5. **La contabilidad única** (§4.2) — HU propia.
6. **La puerta de liquidez por red + su alerta** (Apéndice A) — HU propia, camino de SALIDA.
7. **`TD-SOLANA-CAIP2-DENYLIST`** (§9, D-4) — HU propia; se **declara** el disparo, no se cierra.
8. Escrow Anchor, gasless/fee-payer del depositante, withdraw, reembolso automático, UX/QR/SDK.
9. Cambiar el modo de pago de los 3 agentes `remit-*`.
10. Tocar `verifyDeposit`, `bindFundingWallet`, `increment_a2a_key_spend`, `_resetVerifier`.
11. Reusar `a2a_x402_nonces` / `checkAndRecordX402Nonce` (CD-10).

---

## 7. Dependencias e interacción con WKH-314

### 7.1 El acoplamiento del probe: por qué el diseño lo ELIMINA en vez de consumirlo

Se me indicó consumir `probeSettlementPresence` (que WKH-314 promueve). **El grounding
muestra que ese reuso sería incorrecto**, con dos evidencias:

1. **Su veredicto de términos exige un monto y un destino conocidos DE ANTEMANO.** La firma es
   `probeSettlementPresence(proof: SolanaSettleProof)` (`payment.ts:572-574`) y el
   `landed_ok`/`landed_mismatch` sale de `this.checkTerms(parsed, proof)` (`:640`), que compara
   `delta < BigInt(proof.amountAtomic)` con `owner === proof.payTo`
   (`:1110-1128`). **Un depósito no conoce el monto: lo DESCUBRE.** Para invocarlo habría que
   fabricar un proof con `amountAtomic: '0'`, y entonces `landed_ok` significaría *"el balance
   no bajó"* — un guard de dinero que **siempre pasa**. Eso no es reuso, es un falso verde con
   forma de reuso; un AR lo marcaría BLOQUEANTE y tendría razón.
2. **Lee a `'confirmed'`, hardcodeado.** `payment.ts:619` fija
   `commitment: 'confirmed'`, y su `SettlementPresence` **descarta el `confirmationStatus`**
   (sólo mira `status.err`, `:601`). Así que su `landed_ok` **no implica `finalized`** y no
   puede sostener CD-7. Pedirle a 314 que lo cambie sería pedirle que modifique la semántica
   del camino de SALIDA para un requisito de la ENTRADA.

**Decisión (DT-8).** WKH-315 define su propio lector en
`src/adapters/solana/deposit-verifier.ts`. **Lo compartido es la DOCTRINA, no la función**:
tres valores mínimo, `getSignatureStatuses` + `searchTransactionHistory` como única fuente de
una negativa, `unknown` para todo lo demás, nunca lanzar. El §8.5 del work-item prohíbe
duplicar *el probe*; acá no se duplica una respuesta a la misma pregunta — son **dos preguntas
distintas**: *"¿aterrizó mi pago de monto conocido?"* (re-transmitir) vs *"¿qué movió esta
firma hacia mi cuenta, y es irreversible?"* (descubrir + acreditar).

**Consecuencias, que son buenas:**
- **WKH-315 NO toca `payment.ts`** ⇒ desaparece el único solapamiento no trivial de §8.1 del
  work-item. Todo lo demás entre las dos HUs es aditivo o disjunto.
- **El orden de merge deja de importar**, así que MI-3 (que iba a decidirlo) **deja de ser
  bloqueante**. Igual se recomienda **314 → 315** por el refactor de `registry.ts`, con
  `src/adapters/types.ts` como el único conflicto textual esperado (bloques aditivos
  distintos: `SettlementPresence` no se toca).

### 7.2 Requisitos hacia WKH-314 (ninguno bloqueante)

- **R1 — que NO cambie `SettlementPresence`** (`types.ts:170-187`). Las dos HUs lo tratan como
  congelado (CD-3 de ambas). WKH-315 no lo consume, pero agrega un bloque de tipos en el mismo
  archivo.
- **R2 — que NO debilite `probeRpcHistoryRetention`** (`schema-preflight.ts:166-208`). Es la
  precondición de la que depende poder afirmar `absent`, y WKH-315 depende de ella igual que
  el settle. Ninguna de las dos la re-implementa.
- **R3 — que sea dueña de `TD-SOLANA-CAIP2-DENYLIST` si enciende el rail primero**
  (`chain-resolver.ts:252-264`). Su condición de reactivación se dispara con cualquiera de las
  dos. WKH-315 **declara el disparo** (§9 D-4) y no lo cierra.
- **R4 — deseable, no requerido, para una convergencia posterior**: si 314 termina partiendo
  el probe en una capa de **presencia agnóstica de términos** (que devuelva también
  `confirmationStatus`), entonces vale una HU de dedup en la que el verificador de depósito
  consuma esa capa. Hoy no existe y no se diseña contra algo que no existe.

### 7.3 Precondiciones externas

- **La migración de W0.3 debe estar aplicada a `bdwv` antes del deploy** del código. Es la
  misma clase de precondición que WKH-307 volvió ejecutable con un preflight. **Acá NO se
  construye un preflight nuevo**: el flag propio (`A2A_DEPOSIT_ENABLED_SOLANA`, default OFF)
  cumple el rol y es más simple. Se declara en el runbook de W3.2 el orden migración → env.
- La fila 189 (`fix/p1-discover-reputation-402-cap`, abierta) toca `middleware/x402.ts`: **no
  afecta a esta HU** (no lo toca). Afecta a 314.

---

## 8. Plan de tests

Framework: **vitest** (`package.json` → devDeps). ≥1 test por AC. Los tests de dinero
declaran **qué mutación los mata**.

### 8.1 Cobertura por AC

| AC | Test(s) | Archivo |
|---|---|---|
| AC-1 feliz | `T-315-01` 200 + balance, monto = el de la cadena | `src/routes/auth.solana-deposit.test.ts` (nuevo) |
| AC-1 monto | `T-315-02` el caller declara 10, la cadena dice 5 ⇒ `AMOUNT_MISMATCH` y `registerDeposit` NO llamado | `src/adapters/solana/deposit-verifier.test.ts` (nuevo) |
| AC-2 finalidad | `T-315-03` `confirmationStatus:'confirmed'` ⇒ 400 `DEPOSIT_NOT_FINALIZED`, sin crédito · `T-315-03b` `getParsedTransaction` se invoca con `commitment:'finalized'` (assert sobre el arg) | ídem |
| AC-3 idempotencia | `T-315-04` segunda presentación ⇒ 409 `DEPOSIT_ALREADY_CREDITED`, balance sin cambio · `T-315-04b` la unicidad Solana la impone un índice **sin `chain_id`** | ruta + `test/wkh315-solana-deposit.migration.test.ts` |
| AC-4 destino | `T-315-05` transfer del mint correcto a **otra** ATA ⇒ `RECIPIENT_MISMATCH`, sin crédito, sin reembolso | verificador |
| AC-5 mint | `T-315-06` transfer de otro mint a nuestra ATA ⇒ `MINT_MISMATCH`, distinguible de `RECIPIENT_MISMATCH` | verificador |
| AC-6 unknown | `T-315-07` `getSignatureStatuses` tira ⇒ `unknown`, **nunca `absent`** · `T-315-07b` status presente pero `getParsedTransaction` sin `meta` ⇒ `unknown`, no `landed_mismatch` · `T-315-07c` 503 + `eventService.track` con `valueDisposition:'unknown'` y la firma · `T-315-07d` `registerDeposit` NO llamado (prueba no consumida) | verificador + ruta |
| AC-7 gate | `T-315-08` sin `funding_wallet_solana` ⇒ 403 `FUNDING_WALLET_NOT_BOUND` · `T-315-08b` depositante ≠ bindeada ⇒ 403 `FUNDING_WALLET_MISMATCH`, **sin fila insertada** (el escenario de hijack de §5.1) · `T-315-08c` bind con firma válida ⇒ 200 · `T-315-08d` firma de OTRO key_id ⇒ 403 `FUNDING_WALLET_PROOF_INVALID` | ruta + `src/lib/ed25519.test.ts` (nuevo) |
| AC-8 base58 | `T-315-09` bind de dos pubkeys que difieren **sólo en caja** ⇒ dos valores distintos, sin colisión ni normalización · `T-315-09b` `bindSolanaFundingWallet` persiste byte-exacto | `src/services/identity.solana-funding.test.ts` (nuevo) |
| AC-9 mínimo | **Diferido** (no hay mínimo hoy; `[DECIDE FOUNDER]` D-2). Se testea la ausencia: `T-315-10` un depósito de 0.000001 acredita | verificador |
| AC-10 EVM byte-idéntico | `T-315-11` **las suites existentes verdes SIN modificarse**: `src/routes/auth.test.ts`, `src/adapters/deposit-verifier.test.ts`, `src/adapters/escrow-verifier.test.ts`, `src/services/budget.test.ts` · `T-315-11b` `registerDeposit` sin `vmFamily` NO manda `p_vm_family` (la llamada EVM queda byte-idéntica) | existentes + `src/services/budget.test.ts` |
| AC-11 superficie | `T-315-12` con el flag OFF `deposit-info` **no lista** Solana · `T-315-12b` con flag ON + owner configurado lista `chain_id`/`mint`/`decimals`/`deposit_account`(ATA)/`required_commitment:'finalized'` · `T-315-12c` **nunca** una clave privada ni el owner sin ATA | ruta |
| AC-12 cero claves | `T-315-13` **estático**: ningún archivo del camino de depósito importa `getSolanaOperatorKeypair` ni `@solana/web3.js:Keypair` (grep sobre la lista de módulos, assert en el test) | `src/adapters/solana/deposit-account.test.ts` (nuevo) |
| AC-13 unicidad sin env | `T-315-14` el `.sql` crea `uq_a2a_key_deposits_solana_sig` sobre `(tx_hash)` con `WHERE vm_family='solana'` y **sin `chain_id`** · `T-315-14b` `UNIQUE (chain_id, tx_hash)` sigue existiendo · `T-315-14c` el `_down` archiva y el `up` re-hidrata `vm_family` desde el backup | migración |
| AC-14 destino por tipos | `T-315-15` **de compilación**: un fixture `.ts` que llama `resolveTreasury('solana-devnet')` **no compila** (assert con `tsc` sobre el fixture, o `@ts-expect-error` que fallaría si compilara) | `src/adapters/deposit-verifier.evm-only.test.ts` (nuevo) |
| AC-15 depositante único | `T-315-16` dos owners de origen distintos ⇒ `DEPOSITOR_AMBIGUOUS`, sin crédito · `T-315-16b` el depositante es el owner que **baja**, no el fee-payer (tx con fee-payer tercero) | verificador |

### 8.2 Archivos de test

| Archivo | Nuevo/Mod | Exemplar |
|---|---|---|
| `src/adapters/solana/deposit-verifier.test.ts` | Nuevo | `src/adapters/deposit-verifier.test.ts` |
| `src/adapters/solana/deposit-account.test.ts` | Nuevo | `src/adapters/solana/chain.test.ts` |
| `src/lib/ed25519.test.ts` | Nuevo | `src/adapters/solana/base58.test.ts` |
| `src/routes/auth.solana-deposit.test.ts` | Nuevo | `src/routes/auth.test.ts` |
| `src/services/identity.solana-funding.test.ts` | Nuevo | `src/services/identity.test.ts` |
| `test/wkh315-solana-deposit.migration.test.ts` | Nuevo | `test/wkh307-solana-settle-intents.migration.test.ts` + `test/helpers/sql-predicate.ts` |
| `src/services/budget.test.ts` | Modificar (**aditivo**) | el mismo archivo |

### 8.3 Fixtures — CD-16 obligatorio

Del Auto-Blindaje 209: *un valor de fixture que "parece del tipo correcto" y funciona por
casualidad es peor que uno que falla*.

- Firmas y pubkeys: **derivadas de la librería que las consume**
  (`Keypair.generate().publicKey.toBase58()`), **nunca** `'x'.repeat(88)`.
- Firma de 64 bytes: producida por `crypto.sign(null, msg, privateKey)` de un `generateKeyPairSync('ed25519')` real, **nunca** un buffer de ceros (209 §W3: `tx.serialize()` verifica).
- `preTokenBalances`/`postTokenBalances`: la forma **real** del RPC — `{accountIndex, mint,
  owner, uiTokenAmount:{amount, decimals, uiAmount, uiAmountString}}` — y
  `transaction.message.accountKeys` con la ATA en el `accountIndex` correcto, porque el match
  triple de §4.8-5 la lee.
- `amount_usd` en fixtures de migración: dentro del rango de `NUMERIC(18,6)` (209 §Hallazgo-1:
  un fixture "bien grande" que la columna rechaza no prueba el round-trip).

### 8.4 Campaña de mutación — los mutantes que DEBEN morir

Procedimiento obligatorio (203 + 209): **respaldo físico fuera del árbol de git → mutar →
probar que aterrizó (hash distinto) → `npx tsc --noEmit` LIMPIO → correr → restaurar por `cp`
→ verificar por hash**. **PROHIBIDO `git checkout --` / `git restore` / `git stash`** sobre
trabajo sin commitear (203: se comió 160 líneas). Un mutante que no compila **no cuenta**
(lo cazó el compilador, no el test). **`no tests` NUNCA cuenta como KILLED** (209 §M12): hay
que ver el nombre del test que falló.

| # | Mutación (guard de dinero) | Debe morir con |
|---|---|---|
| **M1** | `DEPOSIT_COMMITMENT` pasa de `'finalized'` a `getSolanaCommitment()` | `T-315-03`, `T-315-03b` |
| **M2** | `confirmationStatus` ausente se lee como `'finalized'` en vez de `unknown` | `T-315-07`, `T-315-03` |
| **M3** | un throw de `getSignatureStatuses` devuelve `absent` en vez de `unknown` | `T-315-07`, `T-315-07d` |
| **M4** | `!parsed?.meta` devuelve `RECIPIENT_MISMATCH` en vez de `unknown` | `T-315-07b` |
| **M5** | el gate de funding wallet se saltea cuando `vmFamily==='solana'` | `T-315-08`, `T-315-08b` |
| **M6** | la comparación del depositante recupera `.toLowerCase()` en los dos lados | `T-315-09` |
| **M7** | `bindSolanaFundingWallet` recupera `wallet.toLowerCase()` | `T-315-09b` |
| **M8** | el match de destino usa sólo `(owner, mint)` y no la ATA derivada | `T-315-05` |
| **M9** | el depositante pasa a ser el fee-payer (primer firmante) | `T-315-16b` |
| **M10** | con ≥2 owners de origen se toma el primero en vez de rechazar | `T-315-16` |
| **M11** | el índice parcial Solana pasa a `(chain_id, tx_hash)` | `T-315-14`, `T-315-04b` |
| **M12** | `p_vm_family` pierde el `DEFAULT 'evm'` | `T-315-11b` + la suite EVM existente |
| **M13** | el `.sql` omite el `DROP FUNCTION` de la firma de 6 params | `T-315-14` (predicado: el DROP precede al CREATE) |
| **M14** | el `_down` dropea `vm_family` sin archivar / el `up` no re-hidrata | `T-315-14c` |
| **M15** | el crédito se mueve ANTES del verify (`registerDeposit` primero) | `T-315-03`, `T-315-05`, `T-315-07d` |
| **M16** | el monto acreditado pasa a ser `body.amount` en vez del de la cadena | `T-315-01`, `T-315-02` |
| **M17** | `verifyEd25519Base58` devuelve `true` ante un error de decode | `T-315-08d` |
| **M18** | `resolveSolanaDepositOwner` cae a `resolveTreasury` cuando la env falta | `T-315-15`, `T-315-12` |
| **M19** | `A2A_DEPOSIT_ENABLED_SOLANA` se compara con `Boolean(process.env...)` | `T-315-12` (valor `'false'` debe seguir OFF) |
| **M20** | el paso 3b (coherencia familia↔formato) se elimina | nuevo `T-315-17`: firma base58 con `x-payment-chain: avalanche-fuji` ⇒ 400 `INVALID_INPUT` y **cero red** |

**CD-15 aplicado**: cada mutante exige el **nombre** del test que falló y su motivo. Un
archivo que no colecta, una suite ausente o un `describe.skip` **no son KILLED**. Y ningún
helper que pueda tirar se invoca en el cuerpo de un `describe` (209 §M12).

### 8.5 Verificación por wave

| Wave | Verificación |
|---|---|
| W0 | `npx tsc --noEmit` **completo** (no sólo `npm run build` — lección WKH-196) + los 31 predicados de la migración |
| W1 | `tsc --noEmit` + los tests de los 3 módulos nuevos |
| W2 | `tsc --noEmit` + suite completa (las 4 suites de CD-1 verdes **sin editarse**) |
| W3 | campaña de mutación 20/20 + cobertura de las líneas de los guards de dinero (no "la suite pasa") + e2e manual de devnet **opcional** |

---

## 9. Missing Inputs / `[DECIDE FOUNDER]`

| # | Pregunta | Bloqueante | Estado |
|---|---|---|---|
| **D-1 / MI-1** | Bucket del saldo + contabilidad única | **No para el arranque** | §4.2: bucket por red (recomendado y auditable); la contabilidad única es HU aparte con evidencia de por qué |
| **D-2** | ¿Mínimo de depósito en Solana? | No | Hoy no existe ninguno (verificado). AC-9 diferido; el diseño no lo impide |
| **D-3 / MI-2** | Cómo se prueba el control de la wallet | **Resuelto** | §5: bind ed25519 real, primitivo medido |
| **D-4** | ¿Quién cierra `TD-SOLANA-CAIP2-DENYLIST`? | No para 315 | Se **declara** el disparo (encender el rail dispara su condición de reactivación escrita en `chain-resolver.ts:260-264`). WKH-315 no lo cierra. **Necesita dueño** |
| **D-5 / MI-3** | ¿La demo paga x402 o prepago? | **Ya no** | **No pude determinarlo** (requiere `chaski-v3`). §7.1 eliminó la dependencia de orden |
| **D-6 / MI-6** | ¿ATA del operador o cuenta dedicada? | No | §4.4: **recomendada la del operador** (los depósitos re-abastecen la liquidez Solana); si es dedicada, declarar `A2A_DEPOSIT_OWNER_IS_DEDICATED_SOLANA=true` |
| **D-7** | Reserva y umbral de alerta de la puerta de liquidez | No para 315 | Apéndice A. Propuestos: reserva **2 USDC**, alerta **5 USDC** — **`[DECIDE FOUNDER]`, NO hardcodeados como definitivos** |

**No hay `[NEEDS CLARIFICATION]` bloqueante del arranque.** D-6 y D-7 son valores de
configuración; D-1 y D-4 son alcance de HUs futuras.

---

## 10. Constraint Directives

Se heredan **los 13 CD del work-item §9 tal cual**, con dos precisiones y cuatro CD nuevos
derivados del Auto-Blindaje histórico (§3.5).

### Precisiones sobre los heredados
- **CD-3** se cumple con `SolanaDepositLanding` (5 estados) + `SolanaDepositVerification`
  (unión discriminada), **no** reusando `SettlementPresence` (§7.1). El `boolean` de
  `verifyEd25519Base58` **no lo viola**: no hay tercer valor en un cómputo local (§5.3c).
- **CD-11** se cumple reusando el canal de `x402.ts:674-730`, que **existe desde HU-198/201**
  — WKH-314 no lo crea. Vocabulario congelado: `valueDisposition: 'unknown'` + un
  `error_code` estable + un `a2a_events` durable.

### OBLIGATORIO
- **CD-1 — el camino EVM queda byte-idéntico.** Mismos status, `error_code`, secuencia y
  campos. **Prueba exigida:** `src/routes/auth.test.ts`, `src/adapters/deposit-verifier.test.ts`,
  `src/adapters/escrow-verifier.test.ts` y `src/services/budget.test.ts` **verdes sin
  modificarse**. Un test que haya que tocar es señal de regresión, no de refactor.
- **CD-7 — acreditar SÓLO sobre `finalized`**, con un literal de módulo. Sin env que lo
  debilite.
- **CD-8 / AC-13 — la unicidad del depósito Solana no depende de ningún valor de entorno.**
  Se cierra con un índice parcial que **no menciona `chain_id`**.
- **CD-9 — rechazar sin consumir la prueba** ante cualquier indeterminación. Todo fallo
  retorna ANTES de `registerDeposit`.
- **CD-12 — devnet.** Migraciones a **`bdwv`, JAMÁS a `caldz`**.
- **CD-14 (nuevo, Auto-Blindaje ×3: WKH-307 BLQ-MEDIO-1 + Wave-0 ×2, WKH-201)** —
  **PROHIBIDO que un veredicto que afirma algo del mundo se derive de la ausencia de
  evidencia.** `if (res.error) return <veredicto definitivo>` está prohibido. Un `absent`, un
  `MINT_MISMATCH` o un `not_finalized` exigen evidencia **POSITIVA**; todo lo demás se llama
  `unknown`. Referencia: `209/auto-blindaje.md` §BLQ-MEDIO-1 y §Wave-0. Y su regla operativa:
  **cuando encuentres un sitio con esta forma, grepeá la FORMA en todo el archivo** antes de
  dar el arreglo por terminado.
- **CD-15 (nuevo, Auto-Blindaje ×2: WKH-307 M12 + HU-208 M5)** — **un mutante sólo cuenta como
  KILLED con el NOMBRE del test que falló y su motivo.** `no tests`, un archivo que no colecta,
  una suite ausente o un `describe.skip` **no cuentan**. Ningún helper que pueda tirar se
  invoca en el cuerpo de un `describe`. Y toda afirmación de "no agrega costo" **asserta el
  costo** (llamadas de I/O), no sólo el efecto.
- **CD-16 (nuevo, Auto-Blindaje ×2: WKH-307 §W3 + §Hallazgo-1)** — **los fixtures se derivan
  de la librería que los consume y respetan el TIPO de la columna.** Prohibido un base58
  fabricado a mano, una firma de ceros, o un valor "bien grande" que la base rechaza.
- **CD-17 (nuevo, Auto-Blindaje ×2: WKH-307 §MNR-4 + §MNR-1)** — **un `_down` es la mitad de un
  CICLO, y un warn de arranque no es un control.** El `_down` de W0.3 archiva y el `up`
  re-hidrata, con el gate en el `.sql`, no en el runbook.

### PROHIBIDO
- **NO** `toLowerCase()` (ni ninguna normalización de caja) sobre firmas, pubkeys y mints
  base58 — en comparación **y** en persistencia. Incluye `identity.ts` (nueva fn),
  `funding-wallet.ts` (rama Solana) y `deposit.ts` (gate Solana). **NO `lower()`** en el índice
  UNIQUE nuevo (CD-6).
- **NO** usar `resolveTreasury()` desde el camino Solana; y además **NO debe compilar**
  (AC-14).
- **NO** importar `getSolanaOperatorKeypair` ni `Keypair` desde ningún módulo del camino de
  depósito (CD-4 / AC-12).
- **NO** tocar `src/adapters/solana/payment.ts` (§7.1) — es de WKH-314.
- **NO** reusar `probeSettlementPresence` con un proof fabricado (`amountAtomic:'0'`): sería un
  guard que siempre pasa (§7.1).
- **NO** usar `base58DecodeToBytes` (`solana/base58.ts:62`) sobre input del caller: lanza con un
  mensaje que nombra `SOLANA_OPERATOR_PRIVATE_KEY` (§4.10).
- **NO** usar `usdToAtomicUnits` para el monto declarado: toma un `number` y FIX-3 existe para
  evitar ese float (§4.8-7).
- **NO** agregar el alias `'900001'` a `SLUG_ALIASES` (§4.5).
- **NO** agregar dependencias nuevas. `node:crypto` alcanza para ed25519 (§5.2), y
  `@solana/spl-token` **ya está declarada** en `package.json`.
- **NO** un regex laxo que acepte hash EVM y firma base58 en una sola expresión: dos
  predicados estrictos + coherencia por familia (§4.5).
- **NO** reusar `a2a_x402_nonces` / `checkAndRecordX402Nonce` (falla ABIERTO por diseño, con
  una justificación falsa en Solana) — CD-10.
- **NO** publicar los datos de fondeo Solana en `deposit-info` con el camino deshabilitado
  (CD-13).
- **NO** despachar el gate de funding wallet olfateando el formato del valor almacenado:
  `bundle.payment.vmFamily` decide (§4.7-2 / §5.3d).
- **NO** hacer commits, migrar `caldz`, ni ejecutar git destructivo.

---

## 11. Waves de implementación

Se respeta el corte mínimo del work-item §7.3 (AC-1..AC-8 + AC-10..AC-12, AC-11 incluida
porque sin ella nadie sabe a dónde mandar los fondos), **más** AC-13/14/15 que el diseño
introduce. **Cambio justificado respecto de §7.3:** AC-9 (mínimo) queda diferido igual, pero
se agregan los tres candados que cierran los footguns — no son alcance nuevo, son la forma
correcta de lo irrecortable.

### Wave 0 — Serial gate (nada empieza sin esto)
- **W0.1** `src/adapters/types.ts` — bloque aditivo: `SolanaDepositLanding` +
  `SolanaDepositVerification` + `SolanaDepositReason`. → Exemplar: `types.ts:170-187`.
- **W0.2** `src/lib/wallet-format.ts` — `isValidSolanaSignature` (64 bytes). → Exemplar:
  `:50-71` del mismo archivo.
- **W0.3** Migración `20260731000000_wkh315_solana_deposit.sql` + `_down.sql` (§4.7),
  **sólo escrita, NO aplicada** (aplicar a `bdwv` es W3.4, founder-gated).
- **W0.4** `src/adapters/deposit-verifier.ts` — `EvmChainKey` + `isEvmChainKey` + firma
  narrowed de `resolveTreasury`; **cuerpos byte-idénticos** + el segundo guard en
  `deposit.ts:207`.
- **Verificación W0**: `npx tsc --noEmit` completo + los predicados de la migración.

### Wave 1 — Paralelizable (4 tareas independientes)
- **W1.1** `src/adapters/solana/deposit-account.ts` — owner + ATA + `isSolanaDepositEnabled()`.
  → Exemplars: `solana/chain.ts:39-70`, `payment.ts:214`, `parsers.ts:81-83`.
- **W1.2** `src/adapters/solana/deposit-verifier.ts` — §4.8. → Exemplars:
  `payment.ts:572-644`, `:1101-1130`, `deposit-verifier.ts:243-378` (orden de clasificación).
- **W1.3** `src/lib/ed25519.ts` — §5.3c. → Exemplar: `wallet-format.ts` (leaf).
- **W1.4** `src/services/identity.ts` — `bindSolanaFundingWallet`. → Exemplar: `:171-199`.
- **Verificación W1**: `tsc --noEmit` + tests de los 3 módulos nuevos + `identity.solana-funding`.

### Wave 2 — Integración (depende de W0 + W1)
- **W2.1** `src/routes/auth/parsers.ts` — `solanaFundingWalletBindMessage`.
- **W2.2** `src/routes/auth/funding-wallet.ts` — rama `namespace:'solana'` (depende de W1.3, W1.4, W2.1).
- **W2.3** `src/services/budget.ts` — `registerDeposit(..., vmFamily)` → `p_vm_family` (depende de W0.3).
- **W2.4** `src/routes/auth/deposit.ts` — validación por familia + paso 3b + bifurcación del
  verify + gate Solana + mapeo de errores + canal `unknown` + `deposit-info` (depende de
  W0.1/W0.2/W0.4, W1.1, W1.2, W2.3).
- **Verificación W2**: `tsc --noEmit` + **suite completa**; las 4 suites de CD-1 verdes **sin
  editarse**.

### Wave 3 — Hardening, docs y evidencia
- **W3.1** `src/adapters/solana/chain.ts` — coherencia cuenta-de-depósito ↔ operador (§4.4).
  **Cuttable** si el AR juzga el blast-radius excesivo; si se corta, el residuo va al runbook
  y se declara.
- **W3.2** `.env.example` + `doc/INTEGRATION.md` + `doc/MULTI-CHAIN.md` — envs nuevas
  (`A2A_DEPOSIT_OWNER_SOLANA`, `A2A_DEPOSIT_ENABLED_SOLANA`,
  `A2A_DEPOSIT_OWNER_IS_DEDICATED_SOLANA`), runbook del depositante (cómo firmar el mensaje,
  a qué ATA transferir, orden migración → env → flag), y **el disparo declarado de
  `TD-SOLANA-CAIP2-DENYLIST`** (§9 D-4).
- **W3.3** Campaña de mutación 20/20 (§8.4) + cobertura de las líneas de los guards de dinero.
- **W3.4** **Aplicar la migración a `bdwv`** — founder-gated, `caldz` PROHIBIDA.

### Estimación
Archivos nuevos: **4 de código + 2 de migración + 6 de test** = 12.
Archivos modificados: **7**.
Líneas estimadas: ~700 de código + ~1100 de test.

---

## 12. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|
| Acreditar sobre un estado reversible | B | **Alto** (saldo gastable sin fondos) | `finalized` como literal, sin env; M1 lo prueba |
| Un depósito ajeno reclamado por un atacante | M (las firmas son **públicas**) | **Alto** | Gate ed25519 (§5); M5 lo prueba; 403 sin insertar fila deja al legítimo reclamar |
| Cambiar el sentinel duplica saldo | B | **Alto** | Índice parcial sin `chain_id` (§4.5); M11 |
| Un `down → up` re-abre los depósitos Solana | B | **Alto** | Archivo + re-hidratación en el `.sql` (CD-17); M14 |
| Dinero a una cuenta que el operador no controla | B | **Alto** | Env sin fallback + `deposit-info` la publica + gate W3.1 |
| Un blip de RPC leído como negativa | M | Medio (mala UX, sin pérdida) | CD-14 + 503 + M2/M3/M4 |
| Conflicto textual con WKH-314 en `types.ts` | **A** | **Bajo** | Bloques aditivos distintos; `SettlementPresence` no se toca; rebase trivial |
| Migración no aplicada a `bdwv` al deployar | M | Medio (fail-closed) | Flag OFF por default + orden en el runbook |
| El plazo del 2026-08-03 | M | Medio | Corte mínimo §11; W3.1 cuttable; AC-9 diferido |

---

## Apéndice A — La puerta de liquidez por red y su alerta (DISEÑO, HU aparte)

Va acá para que el diseño no se pierda, con la delimitación explícita: **es camino de SALIDA,
Scope OUT de WKH-315** (§6.6). No se implementa en esta HU.

**Qué NO es.** No es un bridge. La decisión #4 del founder es firme y el sector le da razón:
**no se construye puenteo automático**. La salida es piso de liquidez + alerta + recarga
manual.

**Por qué hace falta una dimensión nueva** (§3.4): `destination` es la identidad de un
**agente** (`<registry>/<slug>`, lowercased), no una red, y el hot-path del débito nunca
produce un slug de red, así que una política con `destination='solana-devnet'` **jamás haría
`FOUND`** — sería un control inejercitable.

**Dónde va el gate.** En `src/lib/downstream-payment.ts`, **antes** de `adapter.settle()` y en
el mismo lugar donde ya vive el pre-flight de balance del operador (el que hoy produce el
skip-code `INSUFFICIENT_BALANCE` leyendo `getOperatorSplBalance()`, `payment.ts:210-220`).

**La regla.** Se rechaza **con reserva, no en cero**:
`balance_operador(red) - monto_del_leg < RESERVA(red)` ⇒ rechazo explícito con un skip-code
propio (`LIQUIDITY_FLOOR`), **sin consumir nada**. Cortar con la billetera vacía mata los
cobros en vuelo; cortar con reserva los protege.

**Los números — `[DECIDE FOUNDER]` D-7, propuestos y NO definitivos:**
- **reserva 2 USDC** — una corrida completa en el peor caso (techo de 1,9 medido en WKH-306);
- **alerta 5 USDC** — margen para reaccionar antes de tocar el piso.
**No se hardcodean**: `A2A_LIQUIDITY_FLOOR_USD_<FAMILY>` y `A2A_LIQUIDITY_ALERT_USD_<FAMILY>`,
mismo patrón per-family que `A2A_DEPOSIT_MIN_CONFIRMATIONS_<FAMILY>`
(`deposit-verifier.ts:94-103`).

**La alerta (lo que el founder pidió diseñar).** Extiende el trípode de observabilidad que ya
alerta a `#wasiai-alerts` por gas. Tres propiedades no negociables:
1. **evidencia positiva** (CD-14): un balance que **no se pudo leer** no es "bajo". Tres
   valores: `above` / `below` / `unknown`. `getOperatorSplBalance()` **lanza** cuando no puede
   leer (`payment.ts:205-208`), y ese throw es `unknown`, no `below`;
2. **dedupe por proceso**, para que un burst no genere 200 mensajes (patrón `_warnedFlagOff`,
   `downstream-payment.ts:605`);
3. **el mensaje dice la acción**: red, balance, piso, y "recargar manualmente" — no un
   número suelto (lección 209 §MNR-1: un aviso que no pide una decisión no es un control).

**Cómo esta HU la ayuda sin implementarla.** Si D-6 se resuelve a favor de la ATA del operador
(§4.4), **cada depósito Solana re-abastece la liquidez Solana del operador**, y la frecuencia
de recarga manual baja. Es el argumento más fuerte a favor de esa opción.

---

## Readiness Check

```
[x] Cada AC tiene al menos 1 archivo asociado en la tabla 4.1 y al menos 1 test en §8.1
[x] Cada archivo de 4.1 tiene un Exemplar verificado con Read/Glob (§3.2 — todas las rutas
    confirmadas; las dos rutas mal del encargo original están corregidas en §0)
[x] No hay [NEEDS CLARIFICATION] bloqueantes del arranque (§9: 2 valores de config + 2
    alcances de HU futura; ninguno impide W0-W2)
[x] Constraint Directives: 13 heredados + 4 nuevos (CD-14..CD-17); >3 PROHIBIDO (§10)
[x] Context Map: 27 archivos leídos (§3.1), muy por encima del mínimo de 2
[x] Scope IN y OUT explícitos y no ambiguos (§6, 11 ítems OUT numerados)
[x] BD: todas las tablas verificadas en sus migraciones (§3.3); RLS de a2a_key_deposits
    confirmada (MI-7 resuelto)
[x] Happy Path completo (§4.9, 8 pasos)
[x] Flujo de error definido: 12 condiciones con status, error_code y si consume la prueba (§4.10)
[x] Auto-Blindaje histórico leído (3 HUs DONE) y convertido en CD-14..CD-17 (§3.5)
[x] Plan de mutación: 20 mutantes con su test asesino nombrado (§8.4)
[x] El CD obligatorio del encargo (EVM byte-idéntico) está como CD-1 con prueba exigida
[x] Los 3 footguns cerrados: §4.4 (destino, por tipos), §4.3 (finalized, por literal),
    §4.5 (sentinel, por índice)
[x] La prueba ed25519 diseñada con el primitivo MEDIDO, no supuesto (§5.2)
```

**No pude determinarlo** (declarado, no rellenado):
- **MI-3 / D-5** — si la demo de Chaski paga por x402 o con clave prepaga. Requiere
  `chaski-v3`, fuera de este repo. **Ya no es bloqueante** (§7.1).
- El estado de `WKH-233` (KYC por el riel a2a), reportado bloqueado en el work-item §11 y **no
  verificado acá**.
- Si `caldz` tiene la migración de WKH-307 aplicada (heredado del auto-blindaje de 209, y
  fuera de alcance por CD-12: esta HU **nunca** escribe en `caldz`).

---

*SDD generado por NexusAgil — FULL · F2 · WKH-315*
