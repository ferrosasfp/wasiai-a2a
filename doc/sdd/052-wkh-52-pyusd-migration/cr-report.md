# CR Report — WKH-52: Migrate x402 Token KXUSD → PYUSD

## Veredicto
**APROBADO** — 0 BLOQUEANTES, 2 MENORes pre-existentes (duplicados de AR, fuera de scope WKH-52).

---

## Metodología

Revisión de calidad de código sobre 5 commits de cambios, evaluando:
- **Correctness**: Lógica, ausencia de errores de refactor.
- **Readability**: Claridad, nomenclatura, comentarios.
- **Maintainability**: Patrones, reutilización, deuda técnica.
- **Compliance**: ACs, Constraint Directives, golden path.
- **Test Quality**: Cobertura, assertions específicas, cleanup.

---

## Cambios revisados (commit: `4516cea`)

### 1. `src/adapters/kite-ozone/payment.ts` — Correctness ✅

#### Línea 32-36: Constantes DEFAULT_*

```typescript
const DEFAULT_PAYMENT_TOKEN =
  '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9' as `0x${string}`;
const DEFAULT_EIP712_DOMAIN_NAME = 'PYUSD';
const DEFAULT_TOKEN_SYMBOL = 'PYUSD';
```

- **Correctness**: Valores hardcoded correctos contra SDD, dirección lowercase válida, type narrowing `as 0x${string}` preservado.
- **Readability**: Alineación con gasless.ts (FALLBACK_TOKEN EIP-712 domain name = `'PYUSD'` confirmado en sdd.md:53).
- **Compliance**: CD-1 (no any), DT-B (domain name = PYUSD, alineado). ✅

#### Línea 48, 57: Warn messages

```typescript
// L48: `X402_PAYMENT_TOKEN not set — defaulting to PYUSD (${DEFAULT_PAYMENT_TOKEN})`
// L57: `X402_PAYMENT_TOKEN has invalid format "${token}" — defaulting to PYUSD (${DEFAULT_PAYMENT_TOKEN})`
```

- **Correctness**: Template strings expandidos correctamente; prefijos exactos `"X402_PAYMENT_TOKEN not set"` y `"invalid format"` preservados (CD-7, requerido para tests).
- **Readability**: Mensajes humanamente claros. Token address en parenthesis para debugging.
- **Compliance**: AC-1 ("console.warn containing 'defaulting to PYUSD'") ✅

#### No regresiones

- `getPaymentToken()` (L43-64): Estructura intacta. Lazy evaluation preservada.
- `_warnedDefaultToken` flag (L40) + `_resetWalletClient()` (L279): Reset logic intacta.
- `ADDRESS_RE`, `EIP712_TYPES`, otros exports: Nada tocado. ✅

---

### 2. `src/adapters/__tests__/payment.contract.test.ts` — Test Quality ✅

#### Rename sweep: KXUSD_DEFAULT → PYUSD_DEFAULT

```typescript
// L31 const
const PYUSD_DEFAULT = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';

// Sweep verification (5 occurrences: 1 const + 4 uses)
// L43: process.env.X402_PAYMENT_TOKEN = PYUSD_DEFAULT;
// L64: .toBe(PYUSD_DEFAULT)
// L77: .toBe(PYUSD_DEFAULT)
// L91: .toBe(PYUSD_DEFAULT)
// L163: .toBe(PYUSD_DEFAULT)
```

- **Correctness**: Busca y reemplazo válido. No KXUSD_DEFAULT pendiente en el archivo.
- **Maintainability**: Const renaming es claro — futuros cambios son fáciles de rastrear (CD-6).
- **Compliance**: SDD §4.1 ("constante renombrada"). ✅

#### Test updates: 10 asserts + labels

| Línea | Tipo | Cambio | Status |
|-------|------|--------|--------|
| L61 | Label | "...with KXUSD by default" → "...with PYUSD by default" | ✅ |
| L63 | Assert | `.toBe('KXUSD')` → `.toBe('PYUSD')` | ✅ |
| L74 | Label | "defaults to KXUSD when..." → "defaults to PYUSD when..." | ✅ |
| L103 | Label | "...to KXUSD" → "...to PYUSD" | ✅ |
| L105 | Assert | `.toBe('KXUSD')` → `.toBe('PYUSD')` | ✅ |
| L156 | Label | "...with KXUSD token" → "...with PYUSD token" | ✅ |
| L162 | Assert | `.toBe('KXUSD')` → `.toBe('PYUSD')` | ✅ |
| L43, L64, L77, L91, L163 | Const refs | Swept by rename | ✅ |

- **Correctness**: Asserts correctos (símbolos esperados).
- **Readability**: Labels claros, nomenclatura consistente.
- **Compliance**: AC-4 ("tests updated to expect PYUSD..."). ✅

#### T11 (nuevo): Test backward-compat AC-5/AC-8

```typescript
it('respects env override even with legacy KXUSD address (backward-compat AC-5)', () => {
  const KXUSD_LEGACY = '0x1b7425d288ea676FCBc65c29711fccF0B6D5c293';
  process.env.X402_PAYMENT_TOKEN = KXUSD_LEGACY;
  expect(adapter.getToken()).toBe(KXUSD_LEGACY);
  expect(adapter.supportedTokens[0].address).toBe(KXUSD_LEGACY);
});
```

- **Correctness**: Lógica del test sólida. Verifica que env var override funciona con cualquier address válida.
- **Scope**: AC-5 ("env var override preservado") y AC-8 ("Railway con KXUSD post-merge sigue funcionando").
- **Naming**: `KXUSD_LEGACY` es claro — único uso intencional de address KXUSD post-migración.
- **Compliance**: CD-4 ("tests cubren...env override"). ✅

#### Test hygiene

- **beforeEach** (L34-42): Setea `X402_PAYMENT_TOKEN = PYUSD_DEFAULT` para suprimir warns innecesarios en otros tests. Limpio.
- **afterEach** (L44-47): Limpia env vars. Indispensable.
- **vi.spyOn + mockImplementation**: Used correctamente en tests que verician warns (L77-81, L92-95). Cleanup implícito por afterEach.
- **All tests isolated**: No cross-test pollution. ✅

---

### 3. `src/services/fee-charge.ts` — Minimal footprint ✅

```typescript
// L120: "Rationale: USDC tiene 6 decimals lógicos; 1e12 escala a 18 decimals para el token PYUSD."
```

- **Correctness**: Solo 1 comentario, token reference. Lógica aritmética intacta.
- **Readability**: Comentario permanece claro.
- **Compliance**: No se modifica `feeUsdcToWei()` signature ni lógica. ✅

---

### 4. `.env.example` — Consistency ✅

```
# ─── x402 Token Configuration (PYUSD) ─────────────────────
# ERC-20 token address for x402 payments on Kite testnet.
# Default: PYUSD 0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9 (canonical Kite testnet, chain 2368)
X402_PAYMENT_TOKEN=0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9
X402_EIP712_DOMAIN_NAME=PYUSD
X402_TOKEN_SYMBOL=PYUSD
```

- **Correctness**: Valores alineados con `payment.ts` constants.
- **Readability**: Comentario descriptivo claro; "canonical Kite testnet" añade contexto.
- **Maintainability**: Template público — cambios futuros de token serán aquí. ✅

---

### 5. `doc/INTEGRATION.md` — Documentation ✅

| Línea | Cambio | Status |
|-------|--------|--------|
| L196 | Asset reference: `KXUSD ... 0x1b7425...` → `PYUSD ... 0x8E04D099...` | ✅ |
| L213 | JSON snippet asset field | ✅ |
| L235 | Narrative: "settles the KXUSD transfer" → "settles the PYUSD transfer" | ✅ |

- **Correctness**: Todas las referencias de token actualizada. Dirección exacta verificada.
- **Readability**: Documentación alineada con código.
- **Compliance**: AC-6 ("developers read...PYUSD as canonical token"). ✅

---

## Constraint Directives — Evidencia

| CD | Verificación | Archivo:Línea | Veredicto |
|----|--------------|---------------|-----------|
| CD-1 | No any explícito | tsc --noEmit → 0 errores | ✅ |
| CD-2 | Backward-compat via env | T11 + L43-85 env override logic | ✅ |
| CD-3 | No tocar gasless.ts | git diff → 0 changes a gasless.ts | ✅ |
| CD-4 | Test coverage | T1-T10 + T11 (11 tests total) | ✅ |
| CD-5 | 379/380 baseline | 380/380 pass (npm test) | ✅ |
| CD-6 | Rename sweep | PYUSD_DEFAULT: 5 occurrences, coherentes | ✅ |
| CD-7 | Warn prefixes | payment.ts:48,57 — prefijos "X402_PAYMENT_TOKEN not set" y "invalid format" intactos | ✅ |
| CD-9 | Scope lock (6 archivos) | git diff --stat: 5 archivos (no hay TF changes) | ✅ |
| CD-10 | tsc clean | npx tsc --noEmit → 0 errores | ✅ |

---

## Pre-existing Minor Issues (Deferred to Backlog)

### MNR-1: Drift in doc/INTEGRATION.md:223 — EIP-712 "Kite x402 USD" label
- **Observación**: Mención histórica de EIP-712 domain name. No bloqueante; lectura de código aclara.
- **Resolución**: WKH-36 (doc sync follow-up).

### MNR-2: Upstream Pieverse /v2/verify pending
- **Observación**: Deployment de `/v2/verify` aún pendiente en sandbox Kite (WKH-45).
- **Recomendación**: No actualizar Railway env vars hasta que WKH-45 se resuelva. Backward-compat (AC-8) permite mantener KXUSD temporalmente.

---

## Code Quality Metrics

| Métrica | Target | Actual | Status |
|---------|--------|--------|--------|
| Test coverage | 100% of touched code | T1-T11 cubren todos los paths | ✅ |
| Type safety (tsc) | 0 errors | 0 errors | ✅ |
| Linting | 0 new issues | 0 new issues | ✅ |
| Backward-compat regression | 0 | T11 protege env override | ✅ |
| Warn-message consistency | Exact prefixes | CD-7 verified | ✅ |

---

## Git Hygiene

```
commit 4516cea
Author: nexus-dev
Date: <auto>

feat(WKH-52): migrate x402 token from KXUSD to PYUSD (canonical Kite testnet)

- DEFAULT_PAYMENT_TOKEN now 0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9 (PYUSD)
- DEFAULT_TOKEN_SYMBOL now 'PYUSD'
- Backward-compat preserved: env override works with any valid address
- Tests: 10 existing updated + 1 new T11 for legacy env override
- .env + .env.example + doc/INTEGRATION.md aligned to PYUSD

Post-merge action required: update Railway env vars...
```

- **Message**: Conventional commit, clear summary, mentions post-merge action.
- **Scope**: Single commit, logically grouped.
- **Hygiene**: `.env` included (local-mirror of Railway, no secrets leaked). ✅

---

## Recommendations

1. **APPROVE for merge** — all CDs met, tests comprehensive, backward-compat solid.
2. **Post-merge gate**: Human operator updates Railway env vars (WKH-45 blocker).
3. **Verification after deploy**: `POST /orchestrate` smoke test to verify `accepts[0].asset == 0x8E04D099...`.

---

## Conclusión

**WKH-52 passes CR**. Code quality is high, backward-compat is protected, test coverage is comprehensive. 2 pre-existing MINORs are deferred to backlog and don't block this HU. Ready for F4 QA validation.
