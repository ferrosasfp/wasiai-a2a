# Code Review (CR) — WKH-126b · Integración TS del Escrow No-Custodial

> Revisor: nexus-adversary (CR — foco CALIDAD/patrones/mantenibilidad/tests).
> Fecha: 2026-06-22 · Branch: `feat/117-wkh-126-escrow-noncustodial` (work-tree sin commitear; diff vs `fix/117-session-dest-cap`).
> Complementa al AR (security/integrity). Cada hallazgo cita archivo:línea.

## Gates verificados (conteo real)

| Gate | Reportado por Dev | Real | Estado |
|------|-------------------|------|--------|
| `tsc --noEmit` | 0 errores | **0 errores** (exit 0) | OK |
| Lint (`biome check src/`) | 0 errores | **0 errores** (1 `info` en `src/services/reputation.ts:116`, archivo NO tocado por la HU → pre-existente, no es finding) | OK |
| Suite vitest completa | 1615 + 34 | **1615 passed (full) ; 34 passed** en los 3 archivos escrow (`escrow-verifier.test.ts` + `escrow/eip712.test.ts` + `auth.escrow.test.ts`) | OK |

Gates confirmados tal cual los declaró el Dev.

---

## Checklist CR — resultado por punto

### 1. Adherencia al patrón exemplar — OK
- `escrow-verifier.ts` es un espejo fiel de `deposit-verifier.ts`: cache lazy propio `_clients` + `_resetEscrowVerifier()` (`escrow-verifier.ts:105-123` vs `deposit-verifier.ts:163-181`); mismo orden de checks (client→receipt→status→chainId→confirmations→logs→amount) (`escrow-verifier.ts:127-246` vs `deposit-verifier.ts:185-310`); `decodeEventLog` en try/catch dentro del loop con filtro por `log.address` (`escrow-verifier.ts:187-210`). Diferencias correctas y documentadas: filtro por contrato escrow en vez de token (`escrow-verifier.ts:188`), sin `recipient`/treasury, sin fallback a `OPERATOR_PRIVATE_KEY` (`escrow-verifier.ts:91-101`).
- `eip712.ts` sigue `signed-auth.ts:47-64`: tipos `as const` (`eip712.ts:31-38`), domain env-driven con defaults (`eip712.ts:63-73`), recover case-insensitive (`eip712.ts:146`). La inclusión de `verifyingContract` (CD-12) es la divergencia esperada vs `signed-auth.ts`/`delegation.ts`, correctamente justificada en JSDoc (`eip712.ts:9-11`).

### 2. DRY / duplicación — OK
- El Dev eligió la opción (a) del Story File §4.1.1: exportó `resolveRpcUrl`/`resolveChainObject` desde `deposit-verifier.ts` (cambio aditivo `function`→`export function`, `deposit-verifier.ts:124,145`) y los reusa (`escrow-verifier.ts:35-40`). Single source of truth real; sin duplicación de los `switch`. La decisión está documentada en el JSDoc del verifier (`escrow-verifier.ts:17-21`).
- El `_clients` Map NO se comparte (cache propio, DT-6) — correcto: cliente escrow y treasury son contratos/RPC distintos por semántica.

### 3. TypeScript strict — OK
- Sin `any` explícito en producción. Los `as unknown as` viven solo en fixtures de test (`escrow-verifier.test.ts:95-97`, `auth.escrow.test.ts:114-116`), patrón estándar del repo para `makeBundle`.
- Union `EscrowVerificationReason` exhaustiva y mapeada en el handler (`escrow-verifier.ts:45-54`; mapeo `auth.ts:685-694`).
- La desviación `src/types/receipt.ts:14` (`ReceiptType` +`'deposit_verified'`) es **additive sin cast** — la forma correcta. El Dev rechazó explícitamente `as ReceiptType` (auto-blindaje §[2026-06-22 00:13]) porque ocultaría drift. JSDoc VERIFY-AT-IMPL presente (`receipt.ts:9-13`).
- Genéricos de `decodeEventLog<readonly [typeof DEPOSITED_EVENT], 'Deposited'>` tipan el decode sin cast (`escrow-verifier.ts:189-191`).

### 4. Manejo de errores — OK
- try/catch consistente con el exemplar: cada llamada RPC envuelta, throw→`reason` mapeado (`escrow-verifier.ts:147-151,160-164,171-175`). `decodeEventLog` en try/catch ignora logs no-`Deposited` (`escrow-verifier.ts:192-202`). `parseUnits` en try/catch → `AMOUNT_MISMATCH` (`escrow-verifier.ts:227-234`). Recibo fire-and-forget con `void` sin propagar (`auth.ts:721`). Sin throws silenciados.

### 5. Naming / consistencia — OK
- `A2A_ESCROW_CONTRACT_<FAMILY>`, `ESCROW_MODE_ENABLED`, `ESCROW_EIP712_NAME/VERSION` coherentes con `A2A_DEPOSIT_TREASURY_<FAMILY>` / `REQUEST_EIP712_*` del repo. `resolveEscrowContract`/`getEscrowClient`/`_resetEscrowVerifier`/`verifyEscrowDeposit` espejan los nombres del exemplar.

### 6. Cobertura de tests — OK
- 34 tests cubren los 11 ACs con casos reales (no triviales): AC-1 doble (18 y 6 decimales, `escrow-verifier.test.ts:148-201`), AC-2 confirmaciones (`:204-230`), AC-10 multichain + null (`:233-261`), AC-3/6/7/8/9/11 en `auth.escrow.test.ts`. AC-8 no-regresión testeado con assert de que `verifyEscrowDeposit` NO se llama (`auth.escrow.test.ts:215`). CD-8 (amount/keyId del evento, no body), CD-11 (parametrizado `'1'/'TRUE'/'True'/'yes'/''`, `:451-479`), CD-10 (503 vs 400) cubiertos.
- Mocks de viem correctos: `importOriginal` preserva `formatUnits/decodeEventLog/parseAbiItem/parseUnits/keccak256/stringToBytes/encodeAbiParameters` y solo mockea `createPublicClient` (`escrow-verifier.test.ts:25-35`). EIP-712 firma con cuenta viem real (round-trip recover real, `eip712.test.ts:43-72`).
- Aserciones sobre objeto de retorno `{ ok, reason }`, no substrings (Auto-Blindaje WKH-SEC-02 aplicado).
- Path de error y happy path ambos cubiertos en cada adapter.

### 7. Comentarios / JSDoc — OK
- Lo provisional está marcado `PROVISIONAL — VERIFY-AT-IMPL con WKH-126a` en `abi.ts:4,16`, `eip712.ts:4,27,101`, `escrow-verifier.ts:23,80`, `receipt.ts:9`. No se presenta como canónico. El desvío de `receipt.ts` está documentado en auto-blindaje para el AR.

### 8. Legibilidad / mantenibilidad — OK
- El selector del paso 5 es un ternario claro y autocontenido (`auth.ts:666-679`); los pasos 5b/6/7 NO se bifurcan (DT-5), el flag-off path queda idéntico al legacy. `escrowModeEnabled()` aislado con JSDoc CD-11 (`auth.ts:116-125`). El handler no gana complejidad estructural.

### 9. Gates declarados — OK (ver tabla arriba). Conteo real == reportado.

---

## Hallazgos

### MNR-1 — Comentario JSDoc engañoso sobre `ADDRESS_RE` en eip712.ts
- **Severidad**: MENOR (calidad de documentación; no afecta comportamiento).
- **Categoría**: Comentarios/legibilidad (CR-7/CR-8).
- **Archivo:línea**: `src/adapters/escrow/eip712.ts:20-21`.
- **Qué**: el comentario dice `/** bytes32 hex ('0x' + 64 hex) — 'keyId' derivado... */` pero la constante de la línea siguiente es `const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/` — una regex de **dirección (40 hex)**, no de bytes32 (64 hex). El comentario describe el `keyId` (bytes32) mientras la regex valida el `verifyingContract` (address). Quedó un comentario copiado/mal ubicado.
- **Reproducción**: leer `eip712.ts:20-21`; el texto del comentario contradice la regex que documenta. La validación funciona correcto (se usa solo para `verifyingContract` en `buildDebitAuthorization:110-114`), pero el comentario confunde a un futuro lector sobre qué valida.
- **Impacto**: nulo en runtime; riesgo de inducir a error a quien mantenga el archivo (podría pensar que valida keyId/bytes32).
- **Sugerencia**: ajustar el comentario a algo como `/** address hex ('0x' + 40 hex) — valida 'verifyingContract' (CD-12). */`. NO bloqueante.

### MNR-2 — `escrowBalance` en ABI declarado pero nunca consumido
- **Severidad**: MENOR (deuda menor / scope intencional).
- **Categoría**: Scope / mantenibilidad.
- **Archivo:línea**: `src/adapters/escrow/abi.ts:52-58` (`escrowBalance` view).
- **Qué**: `ESCROW_ABI` exporta `escrowBalance(bytes32) view` pero ningún código de 126b lo invoca (DT-9 decidió NO persistir saldo on-chain). Es un item de ABI sin consumidor TS — el Story File §4.0.1 lo lista como "read opcional, DT-9". Está dentro de scope declarado.
- **Reproducción**: `grep escrowBalance src/` → solo aparece en `abi.ts`; ningún call-site.
- **Impacto**: nulo; es interfaz provisional para 126a. Aceptable. Se documenta para que QA no lo confunda con dead code accidental.
- **Sugerencia**: ninguna acción requerida; está justificado por DT-9 y el Story File. Si en review final se quiere minimizar superficie, podría omitirse hasta que haya consumidor — opcional, NO bloqueante.

---

## Veredicto

**APROBADO con MENORs**

- BLOQUEANTES: **0**
- MENORES: **2** (MNR-1 comentario engañoso `eip712.ts:20`; MNR-2 `escrowBalance` sin consumidor — scope intencional DT-9).
- Gates: tsc 0 · lint 0 · 1615 + 34 tests verdes — **confirmados con conteo real**.

La implementación adhiere fielmente a los exemplars (`deposit-verifier.ts`, `signed-auth.ts`), respeta TS-strict sin `any` ni casts ocultos, reusa helpers sin duplicar (single source of truth vía export aditivo documentado), y cubre los 11 ACs + CDs con tests no-triviales contra mock viem. El desvío de `src/types/receipt.ts` (fuera de los 8 archivos del Scope IN) está justificado, es additive sin cast, y documentado en auto-blindaje — no es un finding de calidad. Los 2 MENORs no afectan comportamiento ni bloquean DONE; pueden corregirse en este fix-pack (MNR-1 es trivial) o ir a backlog.
