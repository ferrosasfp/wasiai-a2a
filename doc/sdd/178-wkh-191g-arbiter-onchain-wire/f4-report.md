# F4 QA Report — HU [WKH-191g] Wire de `arbiter.ts` al contrato `WasiAIEscrow`

**Veredicto**: APROBADO PARA DONE (code-complete, inerte en runtime hasta WKH-191h — comportamiento esperado, no un FAIL)
**Fecha**: 2026-07-13 · Epic WKH-191 Wave 1 (HU 7/8) · AR: APROBADO 0 BLQ 1 MNR · CR: APROBADO 0 BLQ 0 MNR (relayado, ver cr-report.md reconstruido)

## Gates (re-ejecutados por QA — CR no dejó cr-report.md en disco)

| Gate | Comando | Resultado |
|------|---------|-----------|
| Typecheck | `./node_modules/.bin/tsc --noEmit` | exit 0, limpio |
| Suite completa | `npx vitest run` | **2963 passed / 10 skipped / 0 failed** (166 files) — coincide exacto con lo citado por AR |
| Build | `npm run build` | exit 0 (`tsc -p tsconfig.build.json` + copy `dist/static`) |
| Lint | `./node_modules/.bin/biome check src/` | "Checked 323 files. No fixes applied." |

## Runtime / Integration checks

- **DB state**: N/A — HU sin migraciones (Story File §Scope IN: "Sin migraciones. Sin
  dependencias nuevas"). Confirmado `git diff --stat -- supabase/` vacío.
- **Env var parity**: NO VERIFICABLE hoy. `ARBITER_PRIVATE_KEY` y `ESCROW_ARBITER_ENABLED`
  son env vars nuevas (Scope IN) pero el código aún NO está commiteado ni deployado a ningún
  target (`git status` muestra working tree modificado sobre `main`, sin branch propia
  checked-out ni push) — no hay deployment target contra el cual verificar parity todavía.
  Grep confirma que el código las lee con los nombres correctos y sin typo:
  `src/adapters/escrow/arbiter-executor.ts:110` (`process.env.ARBITER_PRIVATE_KEY`),
  `src/services/arbiter.ts:88` (`process.env.ESCROW_ARBITER_ENABLED === 'true'`). Activación
  real (setear las vars en el target) es explícitamente Scope OUT de esta HU (WKH-191h).
- **Migration apply**: N/A — mismo motivo (sin SQL).
- **On-chain reality**: confirmado que TODA llamada `onlyArbiter` de esta HU es inerte en
  runtime hoy — no hay `setArbiter()` corrido (WKH-191h, Scope OUT) y `arbitrationConsent`
  siempre resuelve `false` (gap de producto documentado en DT-3, sin flujo de captura del lado
  del buyer). Esto es el comportamiento **diseñado y esperado**, no un hallazgo.

## ACs (work-item.md, 8/8)

| AC | Texto (resumen EARS) | Status | Evidencia |
|----|----------------------|--------|-----------|
| AC-1 | Flag OFF (default) o escrow no configurado → resuelve byte-idéntico al path actual, sin invocar ninguna función `onlyArbiter` | PASS | `src/services/arbiter.ts:111,115,117` (cascada `if (!isEscrowArbiterEnabled()) return settlePaymentIntentOnChain(base)` / sin chainKey / sin escrow → mismo fallback). Test: `src/services/arbiter.test.ts:1359` (`AC-1/AC-7: release con flag OFF → settlePaymentIntentOnChain, executeResolveDispute NO llamado`, asserts `mockExecResolve`/`mockExecLock` `not.toHaveBeenCalled()`) y `:1384` (`AC-1: flag ON pero escrow NO configurado → fallback`) |
| AC-2 | Flag ON + escrow configurado → consulta `arbitrationConsent(keyId)` (view) ANTES de actuar; `false` → cae al path operator-custodial | PASS | `src/services/arbiter.ts:120-123` (`readArbitrationConsent` antes de cualquier `executeResolveDispute`). `src/adapters/escrow-verifier.ts:132-151` (`readArbitrationConsent`, try/catch total → `false`). Test: `arbiter.test.ts:1407` (`AC-2/CD-7: flag ON + escrow + consent=false → fallback, sin executeResolveDispute ni lock`) |
| AC-3 | Transición a `'disputed'` con consent true → `lockForDispute(keyId, authorized_usd_atomic)` best-effort exactamente una vez, outcome registrado sin bloquear | PASS | `src/services/arbiter.ts:573` (`await bestEffortLockForDispute(intentId, row.key_id, row.authorized_usd)`, único call-site, dentro de `resolveDispute` servicio `:563-573`, ANTES de la clasificación → cubre auto-resolve y `arb_hold`). Helper `:172-205` (try/catch total, `log.info`/`log.warn`, nunca lanza). Test: `arbiter.test.ts:1470` (`AC-3: transición a disputed → executeLockForDispute UNA vez por deposit total`, `toHaveBeenCalledTimes(1)`, `amount = parseUnits('10', 6)` = deposit total no settleUsd) |
| AC-4 | `executeArbitration` release/split (`settleUsd>0`) con lock confirmed → `resolveDispute(keyId, seller, sellerAmount, nonce)` en namespace disjunto de `debit()`/`debitBatch()` | PASS | Swap único `src/services/arbiter.ts:728-735` (`settleArbitrationOnChain({...keyId: row.key_id})` reemplaza la única llamada `settlePaymentIntentOnChain` en esa rama). `deriveArbiterNonce` `src/adapters/escrow/arbiter-executor.ts:72-83` (bit 255 SIEMPRE seteado, disjunto). Test wire: `arbiter.test.ts:1439` (`AC-4: release/split → executeResolveDispute(seller=pay_to, sellerAmount, nonce derivado)`, asserts `seller: PAYTO`, `sellerAmount: parseUnits('10',6)`, `nonce: EXPECTED_NONCE`). Test nonce: `arbiter-executor.test.ts:488-511` (bit 255 seteado, determinista, distinto por `(keyId,intentId)`, `>= 2^255`) |
| AC-5 | `executeArbitration` refund (`settleUsd<=0`) → `releaseDispute(keyId)` en vez de dejar el lock huérfano | PASS | `src/services/arbiter.ts:700-703` (rama `arbMicro<=0` → `await bestEffortReleaseDispute(intentId, row.key_id)` ANTES del refund off-chain). Test: `arbiter.test.ts:1495` (`AC-5: refund → executeReleaseDispute, NO executeResolveDispute`, `db.refunds==[10]` refund off-chain intacto) |
| AC-6 | Cualquier leg `ambiguous` → marca para reconciliación, NO asume movimiento, NO reintenta en el mismo request | PASS | `src/services/arbiter.ts:144-160` (`not_moved`→`failureKind:'unequivocal'`; `ambiguous`→`failureKind:'ambiguous'`, NUNCA asume `settled`). Ramas consumidoras sin cambio de forma: `:767` (unequivocal→refund completo) y `:798-814` (ambiguous→`RECONCILE:` + `failed_ambiguous`, sin refund, sin retry). Tests: `arbiter.test.ts:1538` (not_moved→`db.row.status=='refunded'`) y `:1563` (ambiguous→`db.row.status=='failed'`, `db.refunds==[]`) |
| AC-7 | Wire no operante (flag OFF/sin escrow/sin consent/`NotArbiter`) → WKH-139 v2 y WKH-189 siguen funcionando exactamente como hoy, sin cambio observable | PASS | `resolveHold` (`arbiter.ts:1087-1195`) delega en `executeArbitration` (`:1194`) SIN código nuevo — hereda el seam automáticamente (confirmado: cero diff en `resolveHold`). `rules.ts`/`llm-classifier.ts`/`evidence.ts` sin diff (`git status --porcelain -- src/services/arbiter/` vacío). Test: `arbiter.test.ts:879-925` (describe `AC-7 flag OFF byte-idéntico`) + `:1359` |
| AC-8 | Toda llamada `onlyArbiter` firmada EXCLUSIVAMENTE con `ARBITER_PRIVATE_KEY`, NUNCA `OPERATOR_PRIVATE_KEY` | PASS | `src/adapters/escrow/arbiter-executor.ts:110` (`process.env.ARBITER_PRIVATE_KEY`, cache propio `_arbiterWalletClients`/`_arbiterPublicClients`, Maps nuevos `:97-98`). `debit-executor.ts:77` intacto (`OPERATOR_PRIVATE_KEY`, sin diff — confirmado `git diff --stat -- src/adapters/escrow/debit-executor.ts` vacío). Test: `arbiter-executor.test.ts:313` (`ARBITER_PRIVATE_KEY ausente → not_moved`) y `:325` (`CD-5: con solo OPERATOR seteado → not_moved`) |

## Fallback byte-idéntico (confirmación específica)

`base = { intentId, ownerRef, payTo, finalAmountUsd, chainId }` en `settleArbitrationOnChain`
(`arbiter.ts:108`) son EXACTAMENTE los 5 campos que la llamada original pasaba a
`settlePaymentIntentOnChain` en el swap (`:728-735`, con `keyId` extra solo consumido por el
seam, nunca por `settlePaymentIntentOnChain`). El único call-site de `settlePaymentIntentOnChain`
dentro de `executeArbitration` fue reemplazado por el seam (línea 728); las ramas
`settled`/`unequivocal`/`ambiguous` que consumen el resultado (`:737-814`) no cambiaron de forma
(mismo `SettleOutcome`, verificado por diff — sólo cambia la línea de la llamada + el campo
`keyId`). `openDispute`/`resolveHold` no llaman `settlePaymentIntentOnChain` directamente, sólo
vía este mismo seam.

## Drift

- **Scope**: `git status --porcelain -- src/` = exactamente los 6 archivos del Scope IN del
  Story File (`abi.ts`, `arbiter-executor.ts` nuevo, `escrow-verifier.ts`, `arbiter.ts`,
  `arbiter-executor.test.ts` nuevo, `arbiter.test.ts`). `contracts/**` sin diff.
  `debit-executor.ts`/`payment-intent.ts`/`rules.ts`/`llm-classifier.ts`/`evidence.ts`/
  `dashboard.html`/`resolveHold` — todos sin diff (importados tal cual, no modificados).
- **Wave order**: no verificable por commits (el trabajo está en el working tree sobre `main`,
  sin commits por wave todavía) — verificado en su lugar el código final contra la secuencia
  W0→W3 del Story File; consistente (ABI extendido primero, executor puro con
  `deriveArbiterNonce` luego clients/executors, wire al final, tests cubren todo).
- **Spec drift**: 0. `deriveArbiterNonce` coincide byte-a-byte con la fórmula §7 del Story File
  (bit flag `1n<<255n`, `encodePacked(['string','bytes32','string'], [...])`). `ESCROW_ABI`
  converge con `IWasiAIEscrow.sol` (5 funciones + 3 eventos, nombres/args verificados).
- **Nombre del flag**: `ESCROW_ARBITER_ENABLED` (Story File confirmó este nombre sobre el
  `ARBITER_ONCHAIN_ENABLED` propuesto en el work-item — decisión F2 correctamente reflejada en
  código, sin contradicción).
- **Proceso (observación, no bloqueante)**: el work-item/AR citan branch
  `feat/191g-arbiter-onchain-wire`; el working tree real está sobre `main` con los cambios sin
  commitear. No afecta corrección del código; queda a criterio de `nexus-docs` cómo commitear en
  el cierre DONE.

## AR follow-up

- MNR-1 (nonce pre-consumible por el buyer una vez 191h+consent activos, refina impacto de R-3):
  no bloquea. Aceptado como TD explícito para la HU de contra-medida post-191h
  (`ar-report.md:70-76`). Consistente con CD-6/CD-7 del work-item (exactly-once > anti-griefing,
  tradeoff documentado).
- CR (relayado): APROBADO 0 BLQ 0 MNR — sin `cr-report.md` en disco; reconstruido por QA en
  `doc/sdd/178-wkh-191g-arbiter-onchain-wire/cr-report.md` con los 4 gates re-verificados
  independientemente arriba.

## Estado funcional

Code-complete y testeado con mocks (patrón `debit-executor.test.ts`). Inerte en runtime hoy por
diseño: sin `ARBITER_PRIVATE_KEY` + `setArbiter()` (WKH-191h, Scope OUT) toda llamada
`onlyArbiter` revertiría `NotArbiter` → `not_moved`; sin flujo de captura de
`setArbitrationConsent` (gap de producto, DT-3) `arbitrationConsent(keyId)` es `false` para el
100% de los keyIds → fallback SIEMPRE activo. Ambas condiciones son el comportamiento diseñado
(CD-1/CD-7/AC-2), no un defecto. `resolveHold` (WKH-189) hereda el wire sin código nuevo,
confirmado por ausencia de diff en esa función.

**Listo para DONE.**

*F4 QA generado por NexusAgil.*
