# Adversarial Review — WKH-126c (routing de escrow por-cadena)

**Branch**: `fix/122-wkh-126c-escrow-per-chain-routing`
**Archivos atacados**: `src/routes/auth.ts`, `src/routes/auth.escrow.test.ts`
**Verifier soporte**: `src/adapters/escrow-verifier.ts` (no modificado, leído para verificar contratos)
**Tests**: `npx vitest run src/routes/auth.escrow.test.ts` → **PASS 19 / FAIL 0**

---

## Veredicto: APROBADO

- BLOQUEANTES: 0
- MENORES: 0

El fix resuelve el bug reportado sin regresión. La lógica del selector es correcta,
el short-circuit cumple CD-2, el funding-wallet gate quedó intacto, no hay vector de
manipulación de `chain_id`/header que fuerce el path equivocado, y `resolveEscrowContract`
valida el formato de la dirección. Categorías aplicables revisadas; resto N/A justificado.

---

## Vectores atacados

### V1 — El fix resuelve el bug (AC-1 / AC-2) → OK

`auth.ts:682` selector = `escrowEnabledForChain(chainKey)`.
`auth.ts:141-143` helper = `escrowModeEnabled() && resolveEscrowContract(chainKey) !== null`.

- Cadena CON contrato + flag on → `true` → `verifyEscrowDeposit` (escrow). Confirmado.
- Cadena SIN contrato + flag on → `resolveEscrowContract` retorna `null` → helper `false`
  → `verifyDeposit` (treasury). **Ya NO se invoca `verifyEscrowDeposit`, por lo que es
  imposible llegar al 503 `ESCROW_CONTRACT_NOT_CONFIGURED`** que producía el bug. Confirmado.

El bug original (Kite/Avalanche sin contrato + flag on → 503) queda cerrado: esas cadenas
nunca entran al verifier escrow.

### V2 — Cero regresión / CD-2 / AC-8 (flag off → treasury 100%) → OK

`auth.ts:142`: `escrowModeEnabled() && ...`. El operador `&&` de JS **short-circuita**:
si `escrowModeEnabled()` es `false`, `resolveEscrowContract(chainKey)` **nunca se evalúa**
y el helper retorna `false` sin importar si hay contrato configurado. Cumple CD-2 al pie de
la letra. `escrowModeEnabled()` (`auth.ts:129-131`) mantiene la comparación estricta
`=== 'true'`, así que `'1'`, `'TRUE'`, `''`, `undefined` → treasury. AC-3 cubierto.

Test AC-3 (`auth.escrow.test.ts:572-595`): flag borrado + contrato configurado (mock
devuelve dirección real) → asserta `verifyDeposit` llamado y `verifyEscrowDeposit` NO.
Demuestra el comportamiento aun cuando el contrato existe. Correcto.

### V3 — Funding-wallet gate (CD-1) → OK

El paso 5b (`auth.ts:713-722`) **no fue tocado** por el diff (el diff solo cambia el import
+ helper nuevo + la línea 682 del selector). El gate corre downstream del `result` unificado
de ambos verifiers: `verifyEscrowDeposit` retorna `from = Deposited.depositor`
(`escrow-verifier.ts:243`) y `verifyDeposit` retorna `from = Transfer.from`. El gate compara
`result.from` vs `callerKey.funding_wallet` idéntico para los dos paths. Sin divergencia.
Cumple CD-1 y AC-4.

### V4 — Forzar el path equivocado (manipulación de chain_id/header) → OK

- `chainKey` se resuelve una sola vez (`auth.ts:661-664`) desde el header `x-payment-chain`
  o `body.chain_id`, validado contra `bundle.chainConfig.chainId` en el paso 4
  (`auth.ts:675-677` → `CHAIN_MISMATCH`). El caller no puede inyectar una chainKey arbitraria
  sin un bundle inicializado.
- **Alineación de chainKey**: el MISMO `chainKey` (línea 682) se pasa a `escrowEnabledForChain(chainKey)`
  y a `verifyEscrowDeposit({ chainKey })` (línea 684). No hay desalineación entre la chainKey
  del selector y la del verifier. Además, `verifyEscrowDeposit` **re-resuelve** internamente
  `resolveEscrowContract(chainKey)` (`escrow-verifier.ts:133`), leyendo la MISMA env var con
  la MISMA chainKey, de modo que el contrato usado para el routing y para la verificación
  on-chain son siempre el mismo. Sin vector de path-confusion.
- Manipular `chain_id` para apuntar a una cadena con contrato solo logra que el caller use el
  path escrow de ESA cadena; sigue requiriendo un `Deposited` on-chain válido con `keyId`
  hasheado matcheando su propia key (`escrow-verifier.ts:206`) y pasar el funding-wallet gate.
  No hay escalada.

### V5 — resolveEscrowContract: validación de formato → OK

`escrow-verifier.ts:76` `ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/`; `escrow-verifier.ts:99`:
solo retorna la dirección si `addr && ADDRESS_RE.test(addr)`, si no `null`. Por lo tanto:
- env vacío (`''`) → `null` → helper `false` → treasury. No "escrow path con basura".
- env no-hex / longitud incorrecta → `null` → treasury.
- env con dirección válida → escrow. Y como el MISMO helper de validación corre dentro de
  `verifyEscrowDeposit`, no existe el escenario "selector dice escrow pero el verifier dice
  contrato inválido → 503": si `escrowEnabledForChain` retornó `true`, la dirección ya pasó
  `ADDRESS_RE`, así que el verifier no caerá en `ESCROW_CONTRACT_NOT_CONFIGURED`. Consistente.

### V6 — Consistencia del selector / TOCTOU → OK (sin impacto)

`escrowEnabledForChain(chainKey)` se evalúa una vez en la expresión ternaria (línea 682);
su valor decide la rama. `verifyEscrowDeposit` vuelve a leer la env (línea 133). Existe una
ventana teórica de doble lectura de `process.env` entre la línea 682 y la 133, pero:
1. Las env vars no mutan en runtime en producción (se setean al boot).
2. Si por hipótesis el contrato desapareciera entre ambas lecturas, el verifier retornaría
   `ESCROW_CONTRACT_NOT_CONFIGURED` → 503 con **cero crédito** (fail-safe verify-before-credit,
   `escrow-verifier.ts:134-136`). No hay data loss ni acreditación indebida.
No es un finding: sin mutación de env en runtime y con fallback fail-safe, no hay impacto
demostrable.

---

## Categorías del checklist

| # | Categoría | Resultado | Nota |
|---|-----------|-----------|------|
| 1 | Security | OK | Sin path-confusion; chainKey alineada; sin escalada de privilegios vía chain_id/header; ownership pre-check (auth.ts:655) y funding-wallet gate (713-722) intactos. |
| 2 | Error Handling | OK | Mapeo de status (503 para RPC/contract, 400 resto) sin cambios (auth.ts:701-710); fallback a treasury es silencioso por diseño (AC-2). |
| 3 | Data Integrity | OK | Verify-before-credit preservado; registerDeposit downstream sin cambios; idempotencia (DEPOSIT_ALREADY_CREDITED) intacta. |
| 4 | Performance | OK | Helper es synchronous, una llamada extra a `resolveEscrowContract` (lectura de env + regex). Despreciable. Sin N+1. |
| 5 | Integration | OK | Cambio aditivo: import extendido, helper nuevo, una línea de selector. Sin breaking change en el contrato del endpoint; ambas firmas de verifier intactas. |
| 6 | Type Safety | OK | `escrowEnabledForChain(chainKey: ChainKey): boolean`; `resolveEscrowContract` retorna `0x${string} \| null` con guard `!== null`. Sin `any`, sin cast peligroso. |
| 7 | Test Coverage | OK | AC-1 (escrow), AC-2 (sin contrato→treasury, no 503), AC-3 (flag off + contrato→treasury) cubiertos con asserts de path (`toHaveBeenCalledTimes`/`not.toHaveBeenCalled`). 19/19 PASS. Mocks no mienten: AC-3 asserta el comportamiento aun con contrato real configurado. |
| 8 | Scope Drift | OK | Solo `auth.ts` (import+helper+1 línea) y `auth.escrow.test.ts` (suites aditivas). Coincide con Scope IN. Casos WKH-126b existentes no modificados (CD-4). |
| 9 | Destructive Migrations | N/A | La HU no toca schema ni SQL. |
| 10 | RPC SECURITY DEFINER | N/A | No introduce funciones postgres. |
| 11 | Cache Invalidation | N/A | El `_clients` Map del escrow-verifier no fue modificado y es cache de PublicClient por chainKey (no de datos por-usuario). |

---

## Observación menor (NO es finding — informativa)

El test AC-2/AC-3 mockea `resolveEscrowContract`, por lo que el **short-circuit real** del
`&&` no se ejercita por estos tests (se confía en la semántica de JS). Esto es aceptable:
la semántica del `&&` está garantizada por el lenguaje y el comportamiento neto (treasury)
sí se asserta. No requiere acción.

---

## Acción para el orquestador

Veredicto **APROBADO**. Sin BLOQUEANTES ni MENORES. Avanzar a CR / F4.
