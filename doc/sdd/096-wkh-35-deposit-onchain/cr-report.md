# Code Review (CR) — WKH-35: Fondeo verificado on-chain de agent keys

> Revisor: nexus-adversary (rol Adversary, modo CR — calidad de código)
> Fecha: 2026-05-29
> Branch: feat/wkh-base-port-v1
> Artefactos spec: `doc/sdd/096-wkh-35-deposit-onchain/{work-item.md,sdd.md,story-WKH-35.md}`
> Alcance: `src/adapters/deposit-verifier.ts`, `src/services/budget.ts`, `src/routes/auth.ts`,
> `src/services/security/errors.ts`, `supabase/migrations/20260529000000_a2a_key_deposits.sql`
> (+ `_down`), tests (`deposit-verifier.test.ts`, `budget.test.ts`, `auth.test.ts`), `.env.example`,
> `src/__tests__/e2e/e2e.test.ts` (desviación documentada).

---

## Veredicto global: **APROBADO con MENORES**

No hay hallazgos BLOQUEANTES. Los 11 CDs se cumplen y son verificables; TS strict limpio (typecheck
`tsc -p tsconfig.build.json --noEmit` → exit 0, sin `any`/`as unknown`/`@ts-ignore` en producción); los
43 tests de las 3 suites WKH-35 + 24 e2e pasan en verde. Los hallazgos son 3 MENORES (precisión de
comparación opcional, transacción en migración, ortogonalidad token/recipient) que NO rompen ningún AC
ni exponen vulnerabilidad. Documentados abajo para decisión backlog vs. ahora.

---

## Evidencia ejecutada

```
$ npx tsc -p tsconfig.build.json --noEmit        → exit 0 (TypeScript compilation completed)
$ npx vitest run deposit-verifier/budget/auth    → PASS (43) FAIL (0)
$ npx vitest run e2e.test.ts                      → PASS (24) FAIL (0)
$ grep -nE ':\s*any|as any|as unknown|@ts-ignore' (prod files) → NONE
$ grep -rn 'ethers|web3' deposit-verifier.ts      → no ethers
$ grep -rn 'registerDeposit' src/ (sin tests)     → solo budget.ts (def) + auth.ts (caller)
```

---

## 1. Checklist de Calidad — los 11 CDs

| CD | Estado | Evidencia (archivo:línea) |
|----|--------|---------------------------|
| **CD-1 Ownership Guard** | OK | `budget.ts:74-81` firma `registerDeposit(..., ownerId: string, ...)` — `ownerId` es `string` (NO `string\|undefined`). DB-level: migración `:54-57` `IF v_owner IS DISTINCT FROM p_owner_ref THEN RAISE 'OWNERSHIP_MISMATCH'`. App-level pre-check defense-in-depth: `auth.ts:138-140` (`body.key_id !== callerKey.id → 403`). El crédito siempre pasa `ownerRef = callerKey.owner_ref` (`auth.ts:119,182`). |
| **CD-2 anti-replay atómico** | OK | Migración `:17` `CONSTRAINT uq_a2a_key_deposits_chain_tx UNIQUE (chain_id, tx_hash)`; INSERT-then-credit en UNA fn plpgsql (`:66-79`); `EXCEPTION WHEN unique_violation THEN RAISE 'DEPOSIT_ALREADY_CREDITED'` (`:69-71`). `FOR UPDATE` serializa (`:48`). Mapeo: `budget.ts:94-96` → `DepositAlreadyCreditedError`. |
| **CD-3 sin hardcodes** | OK | Treasury de env `A2A_DEPOSIT_TREASURY_<FAMILY>` con fallback operator (`deposit-verifier.ts:101-116`); RPC de env por chain (`:122-137`); confirmaciones de env (`:84-93`); topic0 de `Transfer` DERIVADO del ABI vía `parseAbiItem` (`:59-61`), NO literal. Cero addresses/URLs hardcodeadas en `src/`. |
| **CD-4 verify-before-credit** | OK | `auth.ts:163-174` (verify) precede `:177-185` (registerDeposit). Guard `if (!result.ok \|\| result.amountUsd === undefined) return 4xx` antes del crédito. El crédito usa `result.amountUsd` (on-chain), NO `body.amount` (`auth.ts:181`). Tests `auth.test.ts:230,253,306,328,378,418` afirman `registerDeposit NOT called` en todos los fail-paths. |
| **CD-5 chain-del-bundle** | OK | `auth.ts:155` `chainId = bundle.chainConfig.chainId`; rechazo si `body.chain_id !== chainId` (`:158-159` → CHAIN_MISMATCH). Verifier confirma on-chain `getChainId() === bundle.chainConfig.chainId` (`deposit-verifier.ts:214-216`). El crédito y la respuesta usan `chainId` del bundle (`:178-187`). |
| **CD-6 viem-no-ethers, TS strict** | OK | Imports solo de `viem`/`viem/accounts` (`deposit-verifier.ts:12-20`). `grep ethers/web3` → vacío. Sin `any`/`as unknown` en prod (typecheck exit 0). Tipos correctos: `bigint` para `amountAtomic`/`blockNumber`/`value`; `decodeEventLog` con `eventName:'Transfer'` para narrowear `args` (`:244-259`, documentado en auto-blindaje). |
| **CD-7 no-romper-live** | OK | `increment_a2a_key_spend` intacto (`budget.ts:48-64` sin cambios funcionales). x402/debit no tocados. Único call-site nuevo de `registerDeposit`: `auth.ts:178` (antes 501). `grep registerDeposit src/` confirma solo budget.ts+auth.ts. |
| **CD-8 mocks-completos** | OK | `auth.test.ts:39-41` `vi.mock('../adapters/deposit-verifier.js', () => ({ verifyDeposit: vi.fn() }))` exporta `verifyDeposit` completo; `:43-45` mockea `getAdaptersBundle`; `:30-36` budgetService completo. Sin mocks parciales que escondan símbolos. |
| **CD-9 typecheck autoritativo** | OK | `tsc -p tsconfig.build.json --noEmit` ejecutado → exit 0. No se usó el pelado. |
| **CD-10 decimals-NO-literal** | OK | `deposit-verifier.ts:274` `formatUnits(amountAtomic, token.decimals)` con `token = bundle.payment.supportedTokens[0]` (`:232`). Cero `/1e18` o `/1e6`. Test T8 (`deposit-verifier.test.ts:284-315`) afirma exacto: Kite 18-dec `15e17 → '1.5'`, Base 6-dec `2_500_000 → '2.5'`. |
| **CD-11 delegación-explícita** | OK | `resolveMinConfirmations` lee env explícita + valida `>=1` (`:84-93`); test T4 setea `A2A_DEPOSIT_MIN_CONFIRMATIONS='3'` y afirma `INSUFFICIENT_CONFIRMATIONS` + `confirmations:1` (`:204-223`). Decimals afirmados por test (T8). No hay defaults silenciosos sin assert. |

---

## 2. TS strict

**OK.** `tsc -p tsconfig.build.json --noEmit` → exit 0. `grep -nE ':\s*any|as any|as unknown|@ts-ignore'`
sobre los 4 archivos de producción → ninguno. Tipos del verifier correctos:
- `amountAtomic?: bigint`, `value`/`blockNumber` como `bigint` (`deposit-verifier.ts:39,225,261`).
- `receipt` tipado vía `Awaited<ReturnType<PublicClient['getTransactionReceipt']>>` (`:195`) — sin cast.
- `decodeEventLog` con `eventName:'Transfer'` + anotación de `ReturnType<typeof decodeEventLog<...>>`
  (`:244-253`) para narrowear `args` a `{from,to,value}` sin `any` (documentado en auto-blindaje §2).
- `createPublicClient(...) as PublicClient` (`:171`) es un cast a tipo concreto de viem, no un `as unknown`/`as any` — aceptable (PublicClient es el supertipo de la unión devuelta por viem).

Nota: los `as unknown as AdaptersBundle['payment']` aparecen SOLO en archivos de test
(`deposit-verifier.test.ts:79-81`, `auth.test.ts:65-67`), no en producción — patrón estándar de
fixtures parciales. No es finding.

---

## 3. Manejo de errores

**OK.** Mapa HTTP correcto y consistente con SDD §4.5 / Story File §6:

| Condición | HTTP | Evidencia |
|-----------|------|-----------|
| No auth / inactiva | 403 `{error:'Invalid or inactive API key'}` | `auth.ts:116-117` |
| Input inválido | 400 `INVALID_INPUT` | `auth.ts:125-135` |
| `key_id != callerKey.id` | 403 `OWNERSHIP_MISMATCH` | `auth.ts:138-140` |
| Chain no soportada | 400 `CHAIN_NOT_SUPPORTED` | `auth.ts:148-153` |
| `chain_id != bundle` | 400 `CHAIN_MISMATCH` | `auth.ts:158-159` |
| Verify falla (no RPC) | 400 `<reason>` | `auth.ts:169-173` |
| RPC caído | 503 `RPC_UNAVAILABLE` | `auth.ts:170` (`reason==='RPC_UNAVAILABLE' ? 503 : 400`) |
| Replay | 409 `DEPOSIT_ALREADY_CREDITED` | `auth.ts:189-192` |
| Ownership DB-level | 403 `OWNERSHIP_MISMATCH` | `auth.ts:194-195` |
| Error desconocido | 500 `DEPOSIT_FAILED` | `auth.ts:197-201` |

- El catch del endpoint NO se traga errores: re-lanza error classes tipadas a HTTP específicos y
  loguea el `errorClass` (no el mensaje crudo) en el fallback 500 (`auth.ts:197-200`) — PII-safe.
- El verifier mapea throws de RPC a reasons explícitos sin filtrar stack/mensaje
  (`deposit-verifier.ts:198-199,211-212,222-223`).
- `budget.ts:91-101`: mapea prefijos estables del `RAISE EXCEPTION` a error classes; el `else`
  preserva el contrato genérico `Failed to register deposit: <msg>` (test BLQ-4 `budget.test.ts:235-244`).
- El logger de ownership (`errors.ts:51-99`) hashea ids — no filtra owner_ref/keyId en claro.

---

## 4. Migración SQL

**OK funcional** (con 1 MENOR sobre transaction-wrap, abajo).

- v2 correcta: `FOR UPDATE` (`:48`), ownership `IS DISTINCT FROM` (`:55`), `is_active` check (`:59-60`),
  INSERT anti-replay con `EXCEPTION WHEN unique_violation → RAISE 'DEPOSIT_ALREADY_CREDITED'` (`:66-71`),
  crédito vía `jsonb_set` a `v_chain` (`:77-79`).
- Search-path hardening sobre la firma v2 `(uuid,integer,numeric,text,text,text)` (`:88-89`) —
  coincide con el patrón del exemplar `20260427160000_secure_rpc_search_path.sql:8-12`. `SECURITY DEFINER`
  + `SET search_path = public, pg_temp` cierra el schema-hijacking (categoría AR RPC SECURITY DEFINER OK).
- GRANT/REVOKE correctos: `REVOKE ... FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role`
  (`:91-95`) — la RPC NO queda expuesta a PostgREST/anon. Coincide con el exemplar.
- `_down` restaura la v1 con la firma vieja `(uuid,integer,numeric)` (`:14-35`), su search_path +
  GRANT/REVOKE (`:38-43`), y dropea la v2 `(UUID,INT,NUMERIC,TEXT,TEXT,TEXT)` + tabla (`:8-11`).
  Idempotente (`DROP ... IF EXISTS`, `CREATE OR REPLACE`).
- Naming/timestamp `20260529000000_a2a_key_deposits.sql` consistente con la convención del repo
  (`YYYYMMDDHHMMSS_nombre.sql`); el down comparte timestamp + sufijo `_down` como el exemplar
  `20260406000000_a2a_agent_keys_down.sql`.

> Observación (no finding): el `_down` recrea la v1 SIN el `is_active`/ownership de la v2 — correcto,
> porque la v1 original (`20260406000000_a2a_agent_keys.sql:126-147`) tampoco los tenía. El rollback es
> fiel al estado previo.

---

## 5. Cobertura de tests

**OK.** 19 tests del plan + extras, todos ASERTAN propiedades (no solo "no throw"):

- **Verifier (deposit-verifier.test.ts, 11 tests):** T1 afirma `ok/amountUsd/token/tokenSymbol/recipient/confirmations`
  exactos para Kite (18 dec) y Base (6 dec) (`:132-171`). T2-T9 afirman cada `reason` específico
  (no genérico). T8 afirma decimales exactos por chain (`:284-315`). +1 test CHAIN_MISMATCH (`:332-349`).
  Los mocks conservan `formatUnits`/`decodeEventLog`/`parseAbiItem`/`http` reales vía `importOriginal`
  (`:17-27`) — NO esconden la conversión de decimales ni el decode del log (CD-8 honesto).
- **Budget (budget.test.ts, +4 tests):** T10 afirma `toHaveBeenCalledWith` los 6 params exactos
  incl. `p_owner_ref`/`p_tx_hash`/`p_token` (`:175-182`); test extra afirma `p_token:null` cuando se omite
  (`:197-204`); T11/T12 afirman `toBeInstanceOf(DepositAlreadyCreditedError/OwnershipMismatchError)`
  (`:208-233`); BLQ-4 afirma el genérico (`:235-244`). El test legacy del 501/3-args fue actualizado a
  la firma de 6 args.
- **Route (auth.test.ts, T13-T19 + extras):** happy 200 afirma body + `registerDeposit` con args exactos
  incl. `amountUsd` on-chain '10' (NO body.amount '10.00') (`:199-206`) — prueba CD-4 real. T14/T16/T18/T19
  afirman `registerDeposit`/`verifyDeposit` `not.toHaveBeenCalled()` en fail-paths. T17 cubre AMBOS niveles
  de ownership (pre-check `:310-329` + DB-level `:331-356`). +RPC_UNAVAILABLE 503 (`:233-254`).
- **3 chains con decimales (CD-10):** Kite 18-dec y Base 6-dec cubiertos (T1, T8). Avalanche NO tiene
  test de path-feliz dedicado — ver MNR-3 (no rompe AC; comparte exactamente la rama BASE/6-dec).
- Los AC-1..AC-6 tienen ≥1 test ASERTIVO cada uno.

---

## 6. Conversión decimals

**OK** con 1 MENOR de precisión (MNR-1).

- Usa `token.decimals` del adapter, NO literal: `formatUnits(amountAtomic, token.decimals)`
  (`deposit-verifier.ts:274`). El crédito final pasa el STRING `result.amountUsd` a `registerDeposit`
  (`auth.ts:181`) → NO hay pérdida de precisión en el monto acreditado (el string se pasa tal cual a
  `parseFloat` en `budget.ts:85`, que para montos human-scale es exacto).
- La comparación `AMOUNT_MISMATCH` (`deposit-verifier.ts:276`) usa `Number(amountUsd) !== Number(expectedAmountUsd)`.
  Esto resuelve correctamente el caso `'10' vs '10.00'` (ambos → 10) que un string-compare rompería.
  Riesgo de precisión: ver MNR-1.

---

## 7. Consistencia con la spec

**OK.** Firma final `registerDeposit(keyId, chainId, amountUsd, ownerId, txHash, token?)`
(`budget.ts:74-81`) calza EXACTO con Story File §6 W1.2 (`:496-504`) y SDD §4.3 (`:318-326`). El handler
(`auth.ts:113-203`) sigue el flujo de 7 pasos de Story File §6 W2.1 (`:557-640`) literalmente.

Desviaciones del Dev (documentadas en auto-blindaje.md) — **aceptables**:
- `src/__tests__/e2e/e2e.test.ts:202-217`: 1 aserción stale del 501 actualizada a 403 (sin auth). Es la
  consecuencia INTENCIONADA del re-habilitar el endpoint; cambio mínimo (4 líneas, diff verificado).
  Fuera del Scope IN del Story File, pero necesario para no romper la suite. No expande el test. OK.
- Ownership logging en `budget.ts:98` usa la forma posicional `logOwnershipMismatch('getBalance', ...)`
  — el Story File §W0.3 (`:370-372`) lo autoriza explícitamente como alternativa a agregar
  `'registerDeposit'` a `OwnershipOp`. OK (ver MNR-2 sobre el label).

---

## 8. Env vars

**OK.** Las 7 env nuevas están en `.env.example:222-237`, sin secrets, con defaults seguros:
- 3 treasury (`A2A_DEPOSIT_TREASURY_{KITE,AVALANCHE,BASE}`) vacías (placeholder) — fallback a operator
  documentado (DT-2).
- 4 confirmaciones: global `A2A_DEPOSIT_MIN_CONFIRMATIONS=1` + 3 overrides por chain vacíos.
- Nombres consistentes con la resolución del verifier (`resolveChainFamilyEnvSuffix` `:65-77` →
  `KITE/AVALANCHE/BASE`; `resolveRpcUrl` `:122-137` reusa las env existentes de cada adapter). Cero
  secrets ni addresses reales.

---

## 9. Hallazgos (MENORES — no bloquean DONE)

### MNR-1 — Precisión de `Number()` en la comparación opcional `AMOUNT_MISMATCH`
- **Categoría**: Type Safety / Performance (precisión float).
- **Archivo:línea**: `src/adapters/deposit-verifier.ts:276`.
- **Descripción**: `Number(amountUsd) !== Number(expectedAmountUsd)`. `Number()` sobre un string de
  `formatUnits` con >~15-16 dígitos significativos pierde precisión (IEEE-754). Repro ejecutado:
  `formatUnits(123456789012345678901234567890n, 18)` → `'123456789012.34567890123456789'`, pero
  `Number(...)` → `123456789012.34567` (round-trip NO lossless). Para 6-dec USDC a escala realista
  (≤ ~$10^9) y 18-dec PYUSD a escala human ($10-$10k) la comparación es exacta — verificado.
- **Impacto**: BAJO. (a) El monto ACREDITADO usa el string `result.amountUsd`, no el `Number()` — no
  hay money loss. (b) Solo afecta el sanity-check opcional `expectedAmountUsd` (el caller declara un
  monto). Un atacante no gana nada: si declara un monto que colisiona en float pero difiere en string,
  igual se acredita el monto on-chain real. Solo podría producir un falso-pass/falso-AMOUNT_MISMATCH en
  depósitos de >$10^15, irreales para stablecoins.
- **Sugerencia**: la Story File §8 nota #4 (`:765-766`) delegó esta tolerancia al CR. **Decisión CR:**
  aceptable como está para el scope (stablecoins human-scale). Si se quiere blindar a futuro, comparar
  con string normalizado canónico (p.ej. normalizar trailing zeros con una util `normalizeDecimalString`)
  en lugar de `Number()`. NO bloquea. Recomiendo backlog, no fix-pack.

### MNR-2 — Label de operación incorrecto en `logOwnershipMismatch` dentro de `registerDeposit`
- **Categoría**: Test Coverage / observabilidad (calidad de logs).
- **Archivo:línea**: `src/services/budget.ts:98` → `logOwnershipMismatch('getBalance', keyId, ownerId)`.
- **Descripción**: cuando un ownership-mismatch ocurre en el path de DEPOSIT, el log de seguridad
  registra `op: 'getBalance'`, no `'registerDeposit'`. La firma posicional solo acepta
  `'getBalance' | 'deactivate'` (`errors.ts:51-55`), por eso el Dev reusó `'getBalance'` (autorizado por
  Story File §W0.3 `:371-372`).
- **Impacto**: BAJO. El log existe y hashea ids (PII-safe); solo el `op` es engañoso para forense — un
  analista vería un cross-tenant attempt etiquetado como lectura cuando fue un intento de fondeo.
- **Sugerencia**: opcional — agregar `'registerDeposit'` al union `OwnershipOp` (`errors.ts:36-40`) y a
  la sobrecarga posicional, y usarlo en `budget.ts:98`. Mejora trazabilidad de auditoría. NO bloquea
  (la spec lo permitía). Backlog.

### MNR-3 — Avalanche sin test de path-feliz dedicado en el verifier
- **Categoría**: Test Coverage.
- **Archivo:línea**: `src/adapters/deposit-verifier.test.ts` (cubre solo `kite-ozone-testnet` y
  `base-sepolia`; no `avalanche-fuji`/`avalanche-mainnet`).
- **Descripción**: el plan §12 SDD pide "las 3 chains". El verifier dispatcha Avalanche por una rama
  propia (`resolveRpcUrl:128-131`, `resolveChainObject:148-151`). Esa rama NO tiene un test que afirme
  `getAvalancheChain('fuji'/'mainnet')` + 6-dec USDC.
- **Impacto**: BAJO. Avalanche comparte EXACTAMENTE la semántica de Base (USDC 6 dec, `viem/chains`,
  formatUnits 6) ya cubierta por T1/T8. El dispatcher Avalanche es estructuralmente idéntico a Base. El
  riesgo de regresión es marginal (un typo en `resolveRpcUrl`/`resolveChainObject` para la rama Avax no
  lo atrapa ningún test). Typecheck cubre la exhaustividad del switch (sin `default`, union completa).
- **Sugerencia**: agregar 1 caso T1-equivalente para `avalanche-fuji` (env `FUJI_RPC_URL`, chainId 43113,
  USDC 6-dec). Cierra el gap "las 3 chains". NO bloquea (cobertura semánticamente equivalente existe).
  Recomiendo backlog o, si entra fácil, fix-pack.

---

## 10. Categorías sin hallazgos (revisadas y descartadas)

- **Security (injection/secrets/auth/RBAC)**: OK. Sin secrets en código; treasury/RPC de env; RPC SQL
  con `SECURITY DEFINER` + `search_path` fijo + GRANT a `service_role` únicamente; ownership doble
  (app + DB); validación de input (`TX_HASH_RE`, `key_id` no vacío, `chain_id` finito) en
  `auth.ts:124-135`. Sin SQL dinámico (`EXECUTE format`) en la migración.
- **Data Integrity (race/idempotencia/tx)**: OK. `UNIQUE(chain_id,tx_hash)` + `FOR UPDATE` +
  INSERT-then-credit atómico cierran doble-crédito bajo concurrencia (migración `:48,66-79`).
- **Integration / backwards-compat**: OK. Firma de `registerDeposit` cambió pero el único call-site era
  el endpoint 501; `increment_a2a_key_spend`/x402/debit intactos; `DepositInput`/`DepositResponse`
  reusados (re-export confirmado en `types/index.ts:695 export * from './a2a-key.js'`).
- **Cache Invalidation**: N/A — esta HU no introduce capa de cache (el `Map<ChainKey,PublicClient>` es
  un pool de clientes RPC stateless, no un cache de datos por-usuario; no hay cross-tenant via cache key).
- **Destructive Migrations**: revisada. La v2 hace `CREATE OR REPLACE FUNCTION` con firma NUEVA (6 args)
  → NO dropea la v1 de 3 args (coexisten); la tabla es nueva (`CREATE IF NOT EXISTS`), sin `DROP COLUMN`/
  `ALTER TYPE`/`UPDATE` masivo. No destructiva. (Wrap transaccional → MNR informativo abajo.)

> **Nota informativa (no finding) — transaction wrap de la migración**: `20260529000000_a2a_key_deposits.sql`
> NO envuelve su DDL en `BEGIN;...COMMIT;`, a diferencia del exemplar `20260427160000_secure_rpc_search_path.sql`.
> Verifiqué la convención del repo: es MIXTA (7 migraciones sin wrap incl. el exemplar más cercano
> `20260406000000_a2a_agent_keys.sql`; 4 con wrap). Como la migración es no-destructiva e idempotente
> (`CREATE IF NOT EXISTS`, `CREATE OR REPLACE`), un fallo parcial es recuperable re-corriéndola. Por estar
> dentro de la convención existente del repo y ser idempotente, NO lo marco como finding. Si el equipo
> quiere estandarizar wrap en migraciones con `CREATE FUNCTION`, es una mejora de proceso (backlog).

---

## 11. Resumen para el orquestador

- **Veredicto**: **APROBADO con MENORES**. Gate CR: PASA (cero bloqueantes).
- **CDs**: los 11 cumplidos y verificables (tabla §1).
- **TS strict**: limpio (typecheck exit 0, sin `any`/`as unknown`/`@ts-ignore` en prod).
- **Tests**: 43 WKH-35 + 24 e2e en verde; asertan propiedades de seguridad reales (no "no-throw").
- **Hallazgos**: 3 MENORES — MNR-1 (precisión `Number()` en comparación opcional AMOUNT_MISMATCH, sin
  money-loss, delegado por la spec), MNR-2 (label `'getBalance'` en log de deposit ownership, autorizado
  por spec), MNR-3 (Avalanche sin test de path-feliz dedicado, cobertura equivalente vía Base). Ninguno
  bloquea DONE; recomiendo backlog (MNR-3 opcionalmente al fix-pack si entra trivial).
- **Path del reporte**: `doc/sdd/096-wkh-35-deposit-onchain/cr-report.md`.
