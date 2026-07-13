# F4 QA Report — WKH-191a (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-13 · QA: nexus-qa · Estado previo: AR APROBADO con MENORs (1) · CR APROBADO con MENORs (2), 0 BLQ ambos.

## Gates (ejecutados por mí, no solo leídos)
- `npx tsc --noEmit` → exit 0.
- `npx vitest run` → **2868 passed / 0 failed** (coincide con CR/AR).
- `npm run build` → exit 0 (`tsc -p tsconfig.build.json` + copia de estáticos).
- `./node_modules/.bin/biome check` sobre los 9 archivos tocados (5 código + 4 test) → `Checked 9 files. No fixes applied.` exit 0. (Nota: `npx biome` sin el binario local resuelve mal el paquete en este entorno — usar `./node_modules/.bin/biome` directo.)

## Runtime checks
- **Migración NO aplicada a ninguna DB** (esperado, Wave 0 PENDING-DEPLOY): `GET {SUPABASE_URL}/rest/v1/a2a_payment_intent_debit_signatures?limit=1` contra la DB dev (`bdwvrwzvsldephfibmuu`) → `HTTP 404 PGRST205 "Could not find the table 'public.a2a_payment_intent_debit_signatures' in the schema cache"`. Confirma que tabla+RPC (mismo `BEGIN/COMMIT`) siguen sin desplegar.
- `ESCROW_DEBIT_CAPTURE_ENABLED` no está seteada en `.env`/`.env.local`/`.env.example` del repo → `isDebitCaptureEnabled()` (`debit-capture.ts:57-59`) evalúa `false` por default (unset !== 'true'), consistente con CD-1.
- Fix-pack de los 3 MENOR (CR/AR) verificado en código, no solo declarado:
  - uint256 `string` en `Row`/`Insert`/`Update` de `a2a_payment_intent_debit_signatures` (`database.types.ts:749,753,767,771,785,789`), no solo en `Functions.Args` (`:2749,2751`).
  - T-8 ejercita el wrapper **real** `captureDebitSignatureBestEffort` (no un stub) — `payment-intent.test.ts:1420-1503`, RPC `capture_debit_signature` throwea y se verifica `mockRpc.mock.calls.some(...)===true` + `settled` + `logSpy.warn` llamado.
  - T-3 no-tautológico: `supabase.js` NO mockea `rpc` con passthrough vacío — se espía la capa real (`payments.test.ts:44-46`) y se asserta `mockRpc.mock.calls.some(c=>c[0]==='capture_debit_signature')===false` con flag OFF (`:324-326,362-364`).

## ACs
| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (captura+persistencia en close/settle) | PASS | `debit-capture.ts:66-175` (recover+valida+persiste); wiring `payment-intent.ts:687-696` (closeSession) y `:1005-1014` (settleUpto); `debit-capture.test.ts:154-178` (T-1, firma real, 4 campos derivados exactos) |
| AC-2 (mismatch → reason, no rompe settle) | PASS | prioridad `debit-capture.ts:144-163`; `debit-capture.test.ts:183-198` (T-2 AMOUNT_MISMATCH), `:203-215` (T-2b SIGNER_MISMATCH); no-rechazo confirmado por `payment-intent.test.ts:1456-1479` (T-8, RPC de captura throwea y `status==='settled'`) |
| AC-3 (flag OFF / sin escrow → byte-idéntico) | PASS | gate primario `payments.ts:61-64` (`extractDebitCapture`); `payments.test.ts:291-367` (T-3, `debitCapture===undefined` pasado a `closeSession`/`settleUpto`, RPC nunca invocado); gate escrow `debit-capture.ts:73-76`; `debit-capture.test.ts:220-242` (T-3b, `resolveEscrowContract=null` / `getDefaultChainKey=null` → RPC nunca llamado) |
| AC-4 (firma inerte, cero on-chain) | PASS | `debit-capture.test.ts:246-260` (T-4, `settleSpy`/`signSpy` del adapter no invocados); grep repo-wide sin `writeContract`/`.debit(` en `debit-capture.ts`/`eip712.ts`/`payment-intent.ts` (solo en comentarios documentando la prohibición); `contracts/**` intacto (`git diff --name-only main -- contracts/` vacío) |
| AC-5 (anti-replay `(keyId,nonce)`) | PASS | índice único parcial `uq_debit_sig_valid_nonce ... WHERE debit_validation_status='valid'` (`20260713000000_wkh191a_debit_signatures.sql:41-44`) + pre-check + backstop `unique_violation` en el RPC (`:87-125`); `debit-capture.test.ts:264-301` (T-5, 2ª captura degrada a `NONCE_ALREADY_USED`) |
| AC-6 (`DEADLINE_EXPIRED`) | PASS | `debit-capture.ts:144-146`; `debit-capture.test.ts:305-317` (T-6); bonus `DEADLINE_TOO_FAR` T-6b `:321-333` espeja `WasiAIEscrow.sol:127` |

## Convergencia con el contrato (`contracts/src/WasiAIEscrow.sol`)
- Domain: `__EIP712_init("WasiAIEscrow","1")` (`.sol:80`) ↔ `buildDebitDomain` defaults `'WasiAIEscrow'`/`'1'` (`eip712.ts:68-69`). Match.
- Struct/orden: `DebitAuthorization(bytes32 keyId,uint256 amount,uint256 deadline,uint256 nonce)` (`.sol:38-39`) ↔ `DEBIT_AUTHORIZATION_TYPES` (`eip712.ts:31-38`). Match byte-a-byte.
- `keyId = keccak256(stringToBytes(key_id))` (`debit-capture.ts:88`) — el contrato recibe `keyId` como `bytes32` opaco (no deriva el hash on-chain), consistente con el patrón `_depositor[keyId]` existente (WKH-126a).
- Amount en unidades atómicas del token real (`bundle.payment.supportedTokens[0].decimals`, `debit-capture.ts:85,89`), NUNCA literal 18 — `debit-capture.test.ts:362-377` (T-9, decimals=6 → `"1500000"` != `"1500000000000000000"`).
- `recoverDebitAuthorization` verificado contra `signer.address` independiente (no tautológico) en `eip712.test.ts:154-193` (T-10).
- `recoverDebitAuthorization` compara `recovered==buyer_wallet`; el contrato compara `recovered==_depositor[keyId]`. El binding `buyer_wallet==depositor` queda para 191b (observación informativa de AR, no bloqueante para 191a por ser firma inerte).

## Drift detection
- Scope: los 8 archivos modificados + 2 nuevos (`debit-capture.ts`, `debit-capture.test.ts`) + 2 migraciones están 100% dentro de Scope IN del work-item. `contracts/**` intacto (CD-4). Sin refactor adyacente fuera de scope.
- Nada staged (`git diff --cached --name-only` vacío) — working tree limpio de commits prematuros.
- `doc/sdd/170-wkh-172-remit-cashout-payout/` y `doc/sdd/172-wkh-191-escrow-noncustodial-settlement/` untracked en el status son artefactos de proceso de OTRAS HUs (170 ya DONE sin commitear aún; 172 es el work-item del epic padre) — no forman parte del diff de código de 191a, no son drift de esta HU.
- Wave order: sin violación — el único wave relevante (W0, Story File) tiene todos sus archivos consistentes con lo declarado.

## AR/CR follow-up
- AR: 0 BLQ, 1 MNR (fidelidad tipo NUMERIC→number, dormido en 191a) → **resuelto** en fix-pack (verificado arriba).
- CR: 0 BLQ, 2 MNR (T-8 mock del wrapper; T-3 no asserta spy del RPC) → **ambos resueltos** en fix-pack (verificado arriba).
- Sin hallazgos nuevos de QA.

**Listo para DONE.**
