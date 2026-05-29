# RE-AR (verificación de fix-pack) — WKH-35: Fondeo verificado on-chain

> Revisor: nexus-adversary (rol Adversary, modo RE-AR — verificación de cierre de BLQ)
> Fecha: 2026-05-29
> Branch: feat/wkh-base-port-v1
> Disparador: el AR previo levantó **BLQ-MED-1 (deposit-hijack: treasury compartido sin binding del depositante)**. El Dev aplicó el FIX-PACK (auto-blindaje.md §FIX-1/FIX-3). Este reporte verifica que el BLQ está CERRADO y que el fix no abrió vectores nuevos.
> Alcance fix-pack revisado: `supabase/migrations/20260529000001_a2a_key_funding_wallet.sql` (+ `_down`), `supabase/migrations/20260529000000_a2a_key_deposits.sql` (+ `_down`, FIX-2 DROP v1), `src/routes/auth.ts`, `src/services/identity.ts`, `src/adapters/deposit-verifier.ts` (FIX-3 AMOUNT_MISMATCH), `src/services/security/errors.ts`, `src/types/a2a-key.ts`, tests (`auth.test.ts`, `identity.test.ts`, `deposit-verifier.test.ts`).

---

## Veredicto: **APROBADO**

**BLQ-MED-1: CERRADO.** El fix cierra el vector de deposit-hijack mediante binding de funding wallet con prueba de control criptográfica, y el gate `Transfer.from == funding_wallet` se aplica ANTES del crédito. No introduce vectores nuevos. Sin nuevos BLOQUEANTES. 1 hallazgo MENOR cosmético (ya conocido del CR, no introducido por el fix). El verify-before-credit, anti-replay, chain-match, ownership y el path x402/debit quedan intactos.

### Evidencia ejecutada

```
$ npx tsc -p tsconfig.build.json --noEmit                          → exit 0 (compilation completed)
$ npx vitest run deposit-verifier/identity/auth/budget.test.ts     → PASS (70) FAIL (0)
$ npx vitest run e2e.test.ts                                        → PASS (24) FAIL (0)
$ grep viem mock en auth.test.ts                                    → solo deposit-verifier mockeado; recoverMessageAddress es REAL
```

---

## 1. ¿BLQ-MED-1 cerrado? — Reproducción del ataque post-fix

**Escenario**: atacante observa en el explorer el `txHash` de un depósito legítimo de la víctima (Transfer de la wallet-V → treasury compartido). Intenta `POST /auth/deposit` con SU propia key (key-A) citando ese `txHash`.

Trazo del handler `src/routes/auth.ts` (`/deposit`, líneas 212-313):

1. Auth → `callerKey` = key-A del atacante (`:214-217`).
2. Validación input + ownership pre-check `body.key_id === callerKey.id` (`:237-239`) — el atacante pone su propia key_id, pasa.
3. `verifyDeposit(...)` confirma la tx on-chain y **ahora devuelve `from`** = wallet-V de la víctima (`deposit-verifier.ts:262-270, 308`; gate `result.from === undefined → 4xx` en `auth.ts:268`).
4. **Funding-wallet gate (FIX-1), ANTES de acreditar**:
   - **(a)** Si key-A NO tiene `funding_wallet` → `403 FUNDING_WALLET_NOT_BOUND` (`auth.ts:279-281`). El atacante recién creado NO tiene wallet bindeada → frenado aquí.
   - **(b)** Si key-A SÍ tiene una `funding_wallet` (su propia wallet-A), entonces `result.from` (wallet-V de la víctima) `!=` `callerKey.funding_wallet` (wallet-A) → `403 FUNDING_WALLET_MISMATCH` (`auth.ts:282-284`). Frenado aquí.
5. `registerDeposit` (crédito) solo se alcanza si ambas condiciones pasan (`auth.ts:288`). El atacante NO controla wallet-V (no puede bindearla a su key — requiere firma de la víctima, ver §3), así que jamás llega a acreditar.

**Verify-before-credit intacto**: el orden es `verifyDeposit` (`:262`) → gate funding-wallet (`:279-284`) → `registerDeposit` (`:288`). El crédito está estrictamente DESPUÉS de ambos checks. Tests que lo prueban con `registerDeposit NOT called`:
- `auth.test.ts:569-597` — key sin `funding_wallet` → 403 NOT_BOUND + `mockRegisterDeposit` not called.
- `auth.test.ts:599-626` — `from = OTHER_WALLET != funding_wallet` → 403 MISMATCH + `mockRegisterDeposit` not called (escenario de robo explícito).
- `auth.test.ts:628-655` — `from == funding_wallet` → 200 credits (happy path).

**Conclusión §1: BLQ-MED-1 CERRADO.** El handler exige AMBAS condiciones (bound + match) antes de acreditar, y el verify-before-credit se preserva.

---

## 2. Prueba de control sólida

Endpoint `POST /auth/funding-wallet` (`auth.ts:132-203`):

- **Mensaje canónico deriva del `key_id` AUTENTICADO, NO del body**: `fundingWalletBindMessage(callerKey.id)` (`auth.ts:43-45, 161`). `callerKey` sale del header de auth vía `resolveCallerKey` (`:136`), nunca del body. El body solo aporta `wallet` y `signature` (`:142-146`).
- **No se puede bindear una wallet que NO controlás**: el handler recupera el firmante con `recoverMessageAddress` (viem real) y exige `recovered.toLowerCase() === wallet.toLowerCase()` (`auth.ts:169-173`). Si difiere → `403 FUNDING_WALLET_PROOF_INVALID`. Test real: `auth.test.ts:470-485` (firma válida del BIND_PK pero body declara OTHER_WALLET → 403, `bindFundingWallet` not called).
- **No se puede bindear la wallet de la VÍCTIMA a la key del atacante**: bindear wallet-V requiere una firma de wallet-V sobre `WASIAI_BIND_FUNDING_WALLET:<key-atacante>`. El atacante no tiene la clave privada de wallet-V → no puede producir esa firma. La firma de bind que la víctima generó (si existió) fue sobre `...:<key-víctima>`, distinta del key_id del atacante → recover devolvería wallet-V pero el mensaje canónico del atacante usa su propio key_id, por lo que la firma de la víctima NO recupera a wallet-V bajo el mensaje del atacante. Test: `auth.test.ts:487-502` (firma sobre OTRO key_id → 403 PROOF_INVALID).
- **Replay de la firma de bind no sirve**: el mensaje incluye `key_id` del caller (`auth.ts:44`). Una firma capturada de otro key_id no recupera al `wallet` declarado bajo el mensaje del caller actual → `403 PROOF_INVALID` (`auth.ts:169-173`). Confirmado por `auth.test.ts:487-502`.
- **Tests usan firmas criptográficas REALES**: `auth.test.ts:8,438-446` usa `privateKeyToAccount(BIND_PK)` + `bindAccount.signMessage(...)` y `viem` NO está mockeado en esa suite (solo `deposit-verifier` lo está). El `recoverMessageAddress` del route es el real → la prueba de control es genuina end-to-end (no un mock de recover que miente).

**Observación (no finding)**: el `key_id` no lleva nonce/expiración, así que una firma de bind válida del propio caller podría re-enviarse y re-bindear la MISMA wallet a la MISMA key (idempotente). No es un vector: el resultado es el mismo binding ya existente; no permite escalada. La canonicidad por-key_id es suficiente para cerrar el hijack del BLQ-MED-1.

**Conclusión §2: prueba de control sólida.** Mensaje ligado al key_id autenticado, recover real, no bindeable sin control de la wallet, replay cross-key neutralizado.

---

## 3. Binding hijack inverso (griefing por UNIQUE parcial)

**Escenario**: ¿puede un atacante "secuestrar" el binding de wallet-V antes que la víctima, registrando wallet-V en SU key vía el UNIQUE parcial, para que la víctima nunca pueda bindearla (DoS)?

- Bindear wallet-V a CUALQUIER key requiere una firma de wallet-V sobre el mensaje canónico (`auth.ts:160-173`). El atacante no controla wallet-V → no puede producir esa firma → no puede insertarla en su key. El `bindFundingWallet` (UPDATE) jamás se alcanza para wallet-V con una key del atacante.
- Por tanto el UNIQUE parcial `uq_a2a_agent_keys_funding_wallet` (migración `20260529000001:29-31`) NO crea griefing: la única forma de ocupar el slot de wallet-V es probar control de wallet-V, lo que solo la víctima puede. El UNIQUE es defense-in-depth (una wallet ↔ a lo sumo una key), no una superficie de DoS.
- El UNIQUE es PARCIAL (`WHERE funding_wallet IS NOT NULL`), así que múltiples keys sin bindear (NULL) no colisionan entre sí (`:31`). Correcto.

**Conclusión §3: sin griefing nuevo.** El proof-of-control hace que el UNIQUE solo sea alcanzable por el dueño legítimo de la wallet.

---

## 4. Ownership Guard en el bind

`identityService.bindFundingWallet` (`identity.ts:110-138`):

- **UPDATE filtrado por `id` Y `owner_ref`**: `.eq('id', keyId)` + `.eq('owner_ref', ownerId)` (`identity.ts:120-121`). Cumple la regla obligatoria de CLAUDE.md (Ownership Guard sobre `a2a_agent_keys`). El call-site pasa `callerKey.id` + `callerKey.owner_ref` del caller autenticado (`auth.ts:177-181`), nunca del body.
- **`ownerId: string`** (no `string | undefined`) en la firma (`identity.ts:112`). Cumple la convención.
- **Unique violation (23505) → 409**: mapeada a `FundingWalletAlreadyBoundError` (`identity.ts:124-128`) → `409 FUNDING_WALLET_ALREADY_BOUND` en el route (`auth.ts:184-187`). No filtra el `error.message` crudo (solo lanza la error class tipada). PII-safe.
- **No-match (id, owner_ref) → OwnershipMismatchError**: `data.length === 0 → logOwnershipMismatch + throw` (`identity.ts:132-135`) → `403 OWNERSHIP_MISMATCH` (`auth.ts:189-190`).
- Tests: `identity.test.ts:246-270` (asserta `.eq('id',...)` + `.eq('owner_ref',...)` + lowercase), `:272-290` (23505 → ALREADY_BOUND), `:292-307` (no-match → OWNERSHIP_MISMATCH).

**Conclusión §4: Ownership Guard correcto.** UPDATE doblemente filtrado, 23505→409 sin leak.

> Nota (no finding): el `logOwnershipMismatch('deactivate', ...)` dentro de `bindFundingWallet` (`identity.ts:133`) usa la etiqueta `'deactivate'` aunque la op es bind. Idéntico patrón al MNR-2 del CR (label `'getBalance'` en `registerDeposit`). El union `OwnershipOp` no incluye `'bindFundingWallet'`; el Dev reusó un literal aceptado por la sobrecarga posicional. PII-safe (hashea ids). Cosmético — ver MNR-1 abajo.

---

## 5. No-regresión del fix

- **verify-before-credit**: intacto (ver §1). El crédito sigue estrictamente después del verify + gate.
- **anti-replay (UNIQUE chain_id, tx_hash)**: intacto. `20260529000000:17` sin cambios; la PG fn v2 mantiene `INSERT-then-credit` con `EXCEPTION WHEN unique_violation` (`:74-79`). Test `auth.test.ts:269-295` (replay → 409).
- **chain match**: intacto. `body.chain_id !== chainId → CHAIN_MISMATCH` (`auth.ts:257-259`); verifier valida `getChainId()` (`deposit-verifier.ts:216`). Tests `auth.test.ts:298-320`, `deposit-verifier.test.ts:377-394`.
- **ownership del deposit (DB-level)**: intacto. `register_a2a_key_deposit` v2 mantiene `IF v_owner IS DISTINCT FROM p_owner_ref` (`20260529000000:63-65`). Test `auth.test.ts:344-370`.
- **path x402/debit**: NO tocado. `grep` de call-sites confirma que `registerDeposit`/`verifyDeposit` solo se usan en `auth.ts`+`budget.ts`; `increment_a2a_key_spend`/debit sin cambios.
- **firma de `verifyDeposit` con `from`**: el campo `from?` es ADITIVO opcional en `DepositVerification` (`deposit-verifier.ts:45`), no rompe call-sites. El único consumidor (`auth.ts:268,282`) ya lo usa. Typecheck exit 0. Mocks de tests actualizados para incluir `from` (`auth.test.ts:189,276,351,...`). Sin call-site/test roto.

**Conclusión §5: cero regresiones.** 70 tests WKH-35 + 24 e2e en verde.

---

## 6. FIX-2 (DROP v1) y FIX-3 (AMOUNT_MISMATCH BigInt)

**FIX-2 — DROP explícito de la v1 (3 args)**:
- `DROP FUNCTION IF EXISTS register_a2a_key_deposit(uuid, integer, numeric)` ANTES de crear la v2 (`20260529000000:32`). Correcto: la v1 insegura (sin owner_ref/anti-replay) queda eliminada, no accesible a `service_role`.
- **Reversible**: el `_down` (`20260529000000_a2a_key_deposits_down.sql:13-43`) recrea la v1 con su firma vieja + search_path + GRANT/REVOKE. Idempotente (`CREATE OR REPLACE`, `DROP IF EXISTS`). El rollback restaura el estado previo fielmente. OK.

**FIX-3 — comparación de monto exacta (BigInt)**:
- `deposit-verifier.ts:282-297`: `parseUnits(expectedAmountUsd, token.decimals)` → `bigint`, comparado `expectedAtomic !== amountAtomic` (BigInt vs BigInt). NO usa `Number()`. `parseUnits` lanza si el string es inválido o excede decimals → `AMOUNT_MISMATCH` (`:289-296`). Cierra el MNR-1 del CR (pérdida de precisión float64).
- **El crédito sigue usando el monto on-chain**: `amountUsd = formatUnits(amountAtomic, token.decimals)` (`:281`) se devuelve y se pasa a `registerDeposit` (`auth.ts:291`). La comparación `expectedAmountUsd` es solo un sanity-check opcional; el monto acreditado es siempre el on-chain. Confirmado por `auth.test.ts:657-693` (sin body.amount → acredita el on-chain 7.5).
- Tests: `deposit-verifier.test.ts:286-306` (1 wei de diferencia → AMOUNT_MISMATCH, prueba la no-pérdida de precisión), `:308-326` (match exacto → ok).

**Conclusión §6: FIX-2 reversible y correcto; FIX-3 exacto en unidades atómicas, crédito on-chain preservado.**

---

## 7. Tests reales

- **Bind usa firmas criptográficas REALES**: `auth.test.ts:438-446` — `privateKeyToAccount` + `signMessage`. `viem` NO mockeado en esa suite → `recoverMessageAddress` del route es real (verificado por grep: solo `deposit-verifier` se mockea). No hay mock de recover que mienta.
- **Test del escenario de robo (from != funding_wallet → 403)**: `auth.test.ts:599-626` (`from = OTHER_WALLET` → `403 FUNDING_WALLET_MISMATCH` + `registerDeposit NOT called`). Presente y asertivo.
- **Test NOT_BOUND**: `auth.test.ts:569-597`. **Test happy (from == funding_wallet → 200)**: `:628-655`.
- **Tests negativos de proof**: wallet declarada distinta (`:470-485`), key_id distinto / replay cross-key (`:487-502`), sin auth (`:504-516`), already-bound 409 (`:518-534`), ownership DB-level (`:536-550`), input inválido (`:552-565`).

**Conclusión §7: tests genuinos.** Firmas ECDSA reales, escenario de robo cubierto, asserts específicos (no "no-throw").

---

## Hallazgos del fix-pack

### MNR-1 — Label de operación incorrecto en `logOwnershipMismatch` dentro de `bindFundingWallet`
- **Categoría**: observabilidad (calidad de logs). **Severidad**: MENOR (no bloquea).
- **Archivo:línea**: `src/services/identity.ts:133` → `logOwnershipMismatch('deactivate', keyId, ownerId)`.
- **Descripción**: cuando un ownership-mismatch ocurre en el path de BIND, el log de seguridad registra `op:'deactivate'`, no `'bindFundingWallet'`. El union `OwnershipOp` (`errors.ts:81-85`) no incluye `'bindFundingWallet'`, así que el Dev reusó `'deactivate'` (aceptado por la sobrecarga posicional). Es el mismo patrón del MNR-2 del CR (label en `registerDeposit`), NO introducido por este fix-pack — heredado del estilo existente.
- **Impacto**: BAJO. El log existe y hashea ids (PII-safe); solo el `op` es engañoso para forense.
- **Sugerencia**: agregar `'bindFundingWallet'` (y `'registerDeposit'`) al union `OwnershipOp` + a la sobrecarga posicional, y usarlos. Mejora trazabilidad. Backlog (no bloquea DONE).

### Categorías revisadas sin hallazgos nuevos
- **Security/auth/RBAC**: OK. Proof-of-control criptográfica, mensaje ligado al key_id autenticado, sin secrets, RPC SQL nuevo NO introducido (la migración FIX-1 es DDL aditiva pura). Ownership Guard doble.
- **Data Integrity**: OK. UNIQUE parcial idempotente; anti-replay intacto; bind es UPDATE atómico por (id,owner_ref).
- **Destructive Migrations**: OK. `20260529000001` es aditiva (`ADD COLUMN IF NOT EXISTS` NULLABLE, sin DEFAULT sobre tabla con filas → sin reescritura/lock pesado), envuelta en `BEGIN/COMMIT`, con `_down` reversible. FIX-2 `DROP FUNCTION` de la v1 es reversible vía `_down`. Sin `DROP COLUMN`/`ALTER TYPE`/`UPDATE` masivo/`TRUNCATE`.
- **RPC SECURITY DEFINER**: N/A para el fix-pack — la migración FIX-1 no crea RPC; la v2 de `register_a2a_key_deposit` (ya revisada en CR) mantiene `SET search_path = public, pg_temp` + GRANT a `service_role` (`20260529000000:96-103`). Sin regresión.
- **Type Safety**: OK. `from?: 0x${string}` aditivo; `funding_wallet: string | null` en el row type (`a2a-key.ts:27`); guard `result.from === undefined` (`auth.ts:268`); typecheck exit 0, sin `any` nuevo en prod.
- **Cache Invalidation**: N/A — el fix no introduce cache.
- **Scope Drift**: OK. Los archivos del fix-pack corresponden al cierre del BLQ-MED-1 (FIX-1) y al MNR de precisión delegado (FIX-3). Sin features no pedidas.

---

## Resumen para el orquestador

- **Veredicto**: **APROBADO**. Gate RE-AR: PASA (cero bloqueantes).
- **BLQ-MED-1**: **CERRADO**. Evidencia: gate `funding_wallet` bound + `Transfer.from == funding_wallet` ANTES del crédito (`auth.ts:279-284` precede `:288`); prueba de control criptográfica ligada al key_id autenticado (`auth.ts:43-45,160-173`); UNIQUE parcial sin griefing (proof-of-control requerido). Tests del escenario de robo en verde (`auth.test.ts:599-626`).
- **Regresiones**: ninguna. verify-before-credit, anti-replay, chain-match, ownership DB-level, x402/debit intactos. FIX-2 (DROP v1) reversible; FIX-3 (BigInt) exacto con crédito on-chain preservado.
- **Hallazgos**: 1 MENOR (MNR-1, label de log cosmético, heredado del estilo existente, PII-safe) — no bloquea DONE, recomiendo backlog.
- **Evidencia ejecutable**: typecheck exit 0; 70 tests WKH-35 + 24 e2e PASS.
- **Path del reporte**: `doc/sdd/096-wkh-35-deposit-onchain/ar-report-2.md`.
