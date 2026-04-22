# Story File — WKH-52: Migrate x402 payment token KXUSD → PYUSD

> **HU**: WKH-52
> **Branch**: `feat/052-wkh-52-pyusd-migration` (base: `main` @ `b6e503d`)
> **Pipeline**: QUALITY / Sizing: **S**
> **Fecha**: 2026-04-20
> **SDD de referencia**: `doc/sdd/052-wkh-52-pyusd-migration/sdd.md`
> **Work item**: `doc/sdd/052-wkh-52-pyusd-migration/work-item.md`

---

## 1. Objetivo

Reemplazar el default hardcoded del adaptador x402 (`KiteOzonePaymentAdapter`) de **KXUSD** (community workaround, `0x1b7425...`) a **PYUSD** (token canónico oficial de Kite testnet, `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9`). El env override vía `X402_PAYMENT_TOKEN` queda intacto — Railway mantiene KXUSD hasta que el humano decida el cutover post-merge. Alcance puramente config + tests + docs: **NO** se tocan sign/verify/settle ni la interfaz pública de `PaymentAdapter`.

Resultado esperado: default de código = PYUSD; 380/380 tests pass (379 base + T11 nuevo); backward-compat de env override preservada (AC-5, AC-8).

---

## 2. Pre-requisitos

- Node **≥ 20** disponible en el shell.
- `npm install` ejecutado (dependencias al día).
- Working tree limpio (`git status` sin cambios pendientes).
- Branch base `main` actualizada al commit `b6e503d` (o HEAD más reciente de `main`).
- Baseline verde (`vitest run` → **379/379** pass).

---

## 3. Scope IN (exhaustivo — 6 archivos)

| # | Archivo | Tipo de cambio |
|---|---------|----------------|
| 1 | `src/adapters/kite-ozone/payment.ts` | 3 constantes `DEFAULT_*` + 2 warn messages |
| 2 | `src/adapters/__tests__/payment.contract.test.ts` | Rename const + 10 asserts + 1 test nuevo (T11) |
| 3 | `src/services/fee-charge.ts` | 1 comentario (L120) |
| 4 | `.env` | Header + 3 valores (L10-14) |
| 5 | `.env.example` | Header + comentario descriptivo + 3 valores (L62-74) |
| 6 | `doc/INTEGRATION.md` | 3 líneas textuales (L196, L213, L235) |

## Scope OUT (prohibido tocar)

- `src/adapters/kite-ozone/gasless.ts` (CD-3 — ya usa PYUSD correctamente).
- `src/adapters/kite-ozone/chain.ts`.
- Lógica de `sign()` / `verify()` / `settle()` / `quote()` shape (CD-3).
- E2E tests (`feat/029-e2e-tests`, bloqueado por WKH-45).
- Railway env vars (gate humano post-merge).
- `scripts/demo-x402.ts` (demo no-producción).
- `README.md`, `doc/sdd/037-*/`, `doc/sdd/WKH-KXUSD/*`.
- Firma pública de `PaymentAdapter` (DT-C).

---

## 4. Wave 1 — Pasos atómicos

> Esta HU es una sola Wave. Los 6 archivos son cambios textuales/config pequeños. El orden de 1.2 → 1.7 es serial por convención, pero no hay dependencias cruzadas entre 1.2 y 1.3/1.4/1.5/1.6 — podés tocarlos en cualquier orden. La **Validación 1.8** sí es estrictamente serial y debe ser la última.

### Paso 1.1 — Setup de branch

```bash
git checkout main
git pull origin main
git status   # tree limpio
git checkout -b feat/052-wkh-52-pyusd-migration
vitest run   # baseline: 379/379 pass antes de tocar nada
```

Si el baseline falla → **STOP**. Escalá al orquestador.

### Paso 1.2 — `src/adapters/kite-ozone/payment.ts`

Modificar **solo** las líneas 32-36 (3 constantes) y las líneas 48 y 57 (2 warns). **NO** tocar:

- `KITE_NETWORK`, `KITE_FACILITATOR_ADDRESS`, `KITE_FACILITATOR_DEFAULT_URL`
- La función `getPaymentToken()`, `getEip712Domain()`, `getTokenSymbol()` en estructura — solo cambian los literales dentro de los warns.
- El flag `_warnedDefaultToken` ni su reset en `_resetWalletClient()`.
- `ADDRESS_RE`, `EIP712_TYPES`, cualquier otra constante/función.

Cambios exactos:

1. **L32-33**: address literal `0x1b7425...` → `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9`.
2. **L34**: `'Kite X402 USD'` → `'PYUSD'`.
3. **L36**: `'KXUSD'` → `'PYUSD'`.
4. **L48**: `"...— defaulting to KXUSD (${DEFAULT_PAYMENT_TOKEN})"` → `"...— defaulting to PYUSD (${DEFAULT_PAYMENT_TOKEN})"`. **Mantener el prefijo exacto** `"X402_PAYMENT_TOKEN not set"` (CD-7 — los asserts filtran por ese substring).
5. **L57**: Análogo a L48 — mantener `"X402_PAYMENT_TOKEN has invalid format"` intacto; cambiar solo `"KXUSD"` → `"PYUSD"` y la address entre paréntesis.

Criterio de hecho del paso: `grep -n KXUSD src/adapters/kite-ozone/payment.ts` → **0 matches**.

### Paso 1.3 — `src/adapters/__tests__/payment.contract.test.ts`

Tres tipos de cambio en este archivo:

**A. Rename + const value (L31)**

- `const KXUSD_DEFAULT = '0x1b7425...'` → `const PYUSD_DEFAULT = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9'`.
- Usar **Find & Replace en todo el archivo** para `KXUSD_DEFAULT` → `PYUSD_DEFAULT` (cubre L43, L64, L77, L91, L163 automáticamente). Después **releer el archivo completo** para confirmar sweep (CD-6).

**B. Actualizar los 10 asserts / describe labels**

| # | Línea | Cambio |
|---|-------|--------|
| 1 | L31 | const rename + valor (ya cubierto en A) |
| 2 | L43 | `process.env.X402_PAYMENT_TOKEN = PYUSD_DEFAULT;` (rename automático) |
| 3 | L61 | describe label: `'...with KXUSD by default'` → `'...with PYUSD by default'` |
| 4 | L63 | `.toBe('KXUSD')` → `.toBe('PYUSD')` |
| 5 | L64 | `.toBe(KXUSD_DEFAULT)` → `.toBe(PYUSD_DEFAULT)` (rename automático) |
| 6 | L74 | describe label: `'defaults to KXUSD when...'` → `'defaults to PYUSD when...'` |
| 7 | L77 | assert ya cubierto por rename |
| 8 | L91 | assert ya cubierto por rename |
| 9 | L103 + L105 | describe label `'defaults token symbol to KXUSD'` → `'...to PYUSD'`; assert `.toBe('KXUSD')` → `.toBe('PYUSD')` |
| 10 | L156 + L162 + L163 | describe label `'quote() ... with KXUSD token'` → `'...with PYUSD token'`; L162 `.toBe('KXUSD')` → `.toBe('PYUSD')`; L163 cubierto por rename |

**IMPORTANTE**: **NO tocar** los asserts de warn message filters — las L80 y L92 usan `stringContaining('X402_PAYMENT_TOKEN not set')` / `stringContaining('invalid format')`. Esos prefijos se mantienen en Paso 1.2 (CD-7).

**C. Agregar T11 — test nuevo para AC-5 / AC-8**

Insertar este bloque **justo después** del test existente `'reads token address from X402_PAYMENT_TOKEN env var'` (antes del `it('defaults to KXUSD when...')` — que pasará a llamarse `'defaults to PYUSD when...'`).

Shape de referencia (adaptar literals y prefijos al estilo existente del archivo):

```ts
it('respects env override even with legacy KXUSD address (backward-compat AC-5)', () => {
  const KXUSD_LEGACY = '0x1b7425d288ea676FCBc65c29711fccF0B6D5c293';
  process.env.X402_PAYMENT_TOKEN = KXUSD_LEGACY;
  expect(adapter.getToken()).toBe(KXUSD_LEGACY);
  expect(adapter.supportedTokens[0].address).toBe(KXUSD_LEGACY);
});
```

> Rationale: AC-8 exige que Railway pueda seguir con KXUSD post-merge. T11 blinda el env override contra regresión futura. Este es el único uso intencional de la address KXUSD literal en el test file post-migración.

Criterio de hecho del paso: `grep -c KXUSD src/adapters/__tests__/payment.contract.test.ts` → exactamente **1** match (el KXUSD_LEGACY dentro del T11, o 2 si contamos el label del test — ambos son intencionales).

### Paso 1.4 — `src/services/fee-charge.ts`

**Solo L120**: `token KXUSD` → `token PYUSD`. Es un comentario de 1 línea. **NO tocar** la función `feeUsdcToWei()` ni ninguna otra parte del archivo.

### Paso 1.5 — `.env`

**L10-14 exclusivamente**. NO tocar L1-9 ni L16+. Cambios:

- **L10**: `# ---------- x402 Token (KXUSD on Kite testnet) ----------` → `# ---------- x402 Token (PYUSD on Kite testnet) ----------`.
- **L11**: `X402_PAYMENT_TOKEN=0x1b7425d288ea676FCBc65c29711fccF0B6D5c293` → `X402_PAYMENT_TOKEN=0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9`.
- **L12**: `X402_EIP712_DOMAIN_NAME=Kite X402 USD` → `X402_EIP712_DOMAIN_NAME=PYUSD`.
- **L13**: `X402_EIP712_DOMAIN_VERSION=1` → **sin cambio** (version ya es `1`).
- **L14**: `X402_TOKEN_SYMBOL=KXUSD` → `X402_TOKEN_SYMBOL=PYUSD`.

> `.env` contiene secrets (Supabase, GH_TOKEN, Vercel). **NO commitear con `git add -A`**. Usá `git add` explícito por archivo (Paso 1.9).

### Paso 1.6 — `.env.example`

**L62-74**. Mismos valores que `.env` + actualizar comentarios descriptivos:

- **L62**: `# ─── x402 Token Configuration (KXUSD) ─────────────────────` → `# ─── x402 Token Configuration (PYUSD) ─────────────────────`.
- **L63**: `# ERC-20 token address for x402 payments on Kite testnet.` → **sin cambio**.
- **L64**: `# Default: KXUSD 0x1b7425d288ea676FCBc65c29711fccF0B6D5c293 (verified on chain 2368)` → `# Default: PYUSD 0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9 (canonical Kite testnet, chain 2368)`.
- **L65**: default value → PYUSD address.
- **L68**: `X402_EIP712_DOMAIN_NAME=Kite X402 USD` → `X402_EIP712_DOMAIN_NAME=PYUSD`.
- **L71**: sin cambio (version = `1`).
- **L74**: `X402_TOKEN_SYMBOL=KXUSD` → `X402_TOKEN_SYMBOL=PYUSD`.

### Paso 1.7 — `doc/INTEGRATION.md`

**Solo 3 líneas** — L196, L213, L235. NO tocar el resto del doc.

- **L196**: `**Asset:** \`KXUSD\` (EIP-3009 compliant), contract \`0x1b7425d288ea676FCBc65c29711fccF0B6D5c293\`` → `**Asset:** \`PYUSD\` (EIP-3009 compliant), contract \`0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9\``.
- **L213**: `"asset": "0x1b7425d288ea676FCBc65c29711fccF0B6D5c293",` → `"asset": "0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9",`.
- **L235**: `"...settles the KXUSD transfer on-chain..."` → `"...settles the PYUSD transfer on-chain..."`.

### Paso 1.8 — Validación local (serial, obligatoria)

Ejecutar en orden. Si algún paso falla → diagnose → fix → re-run. **NO commitear** hasta que los tres pasos estén verdes.

```bash
# 1) TypeScript — obligatorio explícito (CD-10, lección WKH-SEC-01)
npx tsc --noEmit
# Expected: 0 errors

# 2) Lint
npm run lint
# Expected: 0 new errors (baseline warnings pre-existentes son aceptables)

# 3) Tests
npm test
# o: npx vitest run
# Expected: 380/380 pass  (379 baseline + T11 nuevo)
```

**Sanity greps** post-fix (opcionales pero recomendados):

```bash
# En src/: 0 menciones de KXUSD (excepto el KXUSD_LEGACY intencional de T11)
grep -rn KXUSD src/

# payment.ts limpio
grep -n KXUSD src/adapters/kite-ozone/payment.ts   # → vacío

# PYUSD address aparece solo en los archivos esperados
grep -rln "0x8E04D099" src/ doc/ .env .env.example
```

### Paso 1.9 — Commit + push

```bash
git add \
  src/adapters/kite-ozone/payment.ts \
  src/adapters/__tests__/payment.contract.test.ts \
  src/services/fee-charge.ts \
  .env \
  .env.example \
  doc/INTEGRATION.md

git status   # verificar que NO hay otros archivos staged accidentalmente

git commit -m "$(cat <<'EOF'
feat(WKH-52): migrate x402 token from KXUSD to PYUSD (canonical Kite testnet)

- DEFAULT_PAYMENT_TOKEN now 0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9 (PYUSD)
- DEFAULT_TOKEN_SYMBOL now 'PYUSD' (was 'KXUSD' — community-made workaround)
- Backward-compat preserved: env override works with any valid address
- Tests: 10 existing updated to expect PYUSD + 1 new T11 for legacy env override
- .env + .env.example + doc/INTEGRATION.md aligned to PYUSD

Post-merge action required: update Railway env vars X402_PAYMENT_TOKEN,
X402_TOKEN_SYMBOL, X402_EIP712_DOMAIN_NAME to PYUSD values (see WKH-52 description).

Closes WKH-52
EOF
)"

git push -u origin feat/052-wkh-52-pyusd-migration
```

> **NO mergear a main** — ese paso lo hace F4/DONE vía PR.

---

## 5. Snippets de referencia (shape, NO copy-paste literal)

> Estos snippets son **guía de forma**. Adaptá los espacios, comillas y estilo al del archivo existente. Los literals son exactos; lo demás es estilo.

### 5.1 Constantes en `payment.ts`

```ts
const DEFAULT_PAYMENT_TOKEN =
  '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9' as `0x${string}`;
const DEFAULT_EIP712_DOMAIN_NAME = 'PYUSD';
const DEFAULT_EIP712_DOMAIN_VERSION = '1';  // sin cambio
const DEFAULT_TOKEN_SYMBOL = 'PYUSD';
```

### 5.2 Warn messages en `payment.ts`

```ts
// L48 (branch: env var ausente)
console.warn(
  `X402_PAYMENT_TOKEN not set — defaulting to PYUSD (${DEFAULT_PAYMENT_TOKEN})`,
);

// L57 (branch: formato inválido)
console.warn(
  `X402_PAYMENT_TOKEN has invalid format "${token}" — defaulting to PYUSD (${DEFAULT_PAYMENT_TOKEN})`,
);
```

Prefijos exactos a **preservar** (CD-7):
- `"X402_PAYMENT_TOKEN not set"`
- `"X402_PAYMENT_TOKEN has invalid format"`

### 5.3 T11 nuevo (AC-5 backward-compat)

```ts
it('respects env override even with legacy KXUSD address (backward-compat AC-5)', () => {
  const KXUSD_LEGACY = '0x1b7425d288ea676FCBc65c29711fccF0B6D5c293';
  process.env.X402_PAYMENT_TOKEN = KXUSD_LEGACY;
  expect(adapter.getToken()).toBe(KXUSD_LEGACY);
  expect(adapter.supportedTokens[0].address).toBe(KXUSD_LEGACY);
});
```

---

## 6. Tests esperados (inventario por archivo)

### `src/adapters/__tests__/payment.contract.test.ts`

Total post-HU: **15 tests** (14 existentes con labels/asserts actualizados + **T11 nuevo**).

| # | Test (label post-cambio) | Cambio | AC |
|---|--------------------------|--------|-----|
| 1 | `implements PaymentAdapter with name "kite-ozone"` | sin cambio | — |
| 2 | `has chainId 2368` | sin cambio | — |
| 3 | `has supportedTokens with PYUSD by default` | **label + 2 asserts** | AC-2, AC-4 |
| 4 | `reads token address from X402_PAYMENT_TOKEN env var` | sin cambio | AC-5 |
| 5 | **[T11 nuevo]** `respects env override even with legacy KXUSD address (backward-compat AC-5)` | **NUEVO** | **AC-5, AC-8** |
| 6 | `defaults to PYUSD when X402_PAYMENT_TOKEN is not set (warns once)` | **label + 1 assert** | AC-1 |
| 7 | `falls back to default when X402_PAYMENT_TOKEN has invalid format` | **1 assert** (rename) | AC-1 |
| 8 | `reads token symbol from X402_TOKEN_SYMBOL env var` | sin cambio | AC-5 |
| 9 | `defaults token symbol to PYUSD` | **label + 1 assert** | AC-2 |
| 10 | `settle() returns SettleResult shape` | sin cambio | — |
| 11 | `verify() returns VerifyResult shape` | sin cambio | — |
| 12 | `quote() returns QuoteResult with PYUSD token` | **label + 2 asserts** | AC-2, AC-4 |
| 13 | `sign() returns SignResult shape` | sin cambio | — |
| 14 | (resto del archivo, sin cambios) | — | — |

**Total**: 10 tests modificados + 1 nuevo = **11 ediciones**. Ninguno borrado.

### Otros archivos

- `src/adapters/kite-ozone/payment.ts`: **0 tests modificados aquí** (los tests viven en el contract.test.ts).
- `src/services/fee-charge.ts`: **0 tests modificados** — solo comment.
- `.env`, `.env.example`, `doc/INTEGRATION.md`: sin tests directos (QA manual en F4 para AC-6).

### Cobertura AC × Test

| AC | Test(s) que lo cubren |
|----|------------------------|
| AC-1 | #6 (default + warn), #7 (invalid format) |
| AC-2 | #3, #9, #12 |
| AC-3 | Implícito vía #3/#12 (supportedTokens refleja default); QA manual F4 contra `/orchestrate` |
| AC-4 | #3, #6, #7, #9, #12 (todos los modificados) |
| AC-5 | #4, **#5 (T11)** |
| AC-6 | QA manual F4 (lectura INTEGRATION.md) |
| AC-7 | Suite completa `vitest run` → 380/380 |
| AC-8 | **#5 (T11)** |

---

## 7. Anti-Hallucination Checklist (específico para esta HU)

Marcá cada ítem antes de cerrar la Wave:

- [ ] Leí `src/adapters/kite-ozone/payment.ts` completo **antes** de editarlo.
- [ ] Leí `src/adapters/__tests__/payment.contract.test.ts` completo **antes** de editarlo.
- [ ] Leí `src/services/fee-charge.ts` L115-125 **antes** de tocar L120.
- [ ] Leí `.env` y `.env.example` completos **antes** de editar.
- [ ] Leí `doc/INTEGRATION.md` L190-240 **antes** de tocar L196/L213/L235.
- [ ] **Preservé los prefijos exactos** de los warn messages: `"X402_PAYMENT_TOKEN not set"` y `"X402_PAYMENT_TOKEN has invalid format"`. (CD-7)
- [ ] **NO modifiqué** la lógica de `_warnedDefaultToken` (warn-once flag) — solo el texto del mensaje.
- [ ] **NO modifiqué** la regex `ADDRESS_RE` ni la validación de formato.
- [ ] **NO agregué** nuevos hardcodes de PYUSD fuera de los 3 `DEFAULT_*` constants + `.env` + `.env.example` + `INTEGRATION.md` + T11. (CD-8)
- [ ] **NO toqué** `gasless.ts`, `chain.ts`, lógica de `sign()`/`verify()`/`settle()`. (CD-3)
- [ ] **NO toqué** `scripts/demo-x402.ts`, `README.md`, `doc/sdd/037-*/`, `doc/sdd/WKH-KXUSD/*`. (CD-9)
- [ ] Hice sweep completo de `KXUSD_DEFAULT` → `PYUSD_DEFAULT` en el test file. `grep` post-cambio confirma 0 matches del nombre viejo. (CD-6)
- [ ] Corrí `npx tsc --noEmit` explícitamente, no solo vitest. (CD-10)
- [ ] Verifiqué que `git status` muestra **exactamente 6 archivos** modificados al final (ni uno más, ni uno menos).

---

## 8. Constraint Directives activos

| CD | Regla | Paso donde aplica |
|----|-------|-------------------|
| **CD-1** | PROHIBIDO `any` explícito — TS strict | 1.2, 1.3 |
| **CD-2** | OBLIGATORIO preservar backward-compat del env override (AC-5, AC-8) | 1.2 (no tocar getPaymentToken branch override), 1.3 (T11 blinda) |
| **CD-3** | PROHIBIDO tocar `gasless.ts`, `chain.ts`, sign/verify/settle | Todos |
| **CD-4** | OBLIGATORIO tests cubran: default PYUSD, env override, warn msg con "PYUSD" | 1.3 (asserts + T11) |
| **CD-5** | OBLIGATORIO 379/379 baseline + 1 nuevo = 380/380 | 1.8 |
| **CD-6** | PROHIBIDO sweep incompleto en rename `KXUSD_DEFAULT` → `PYUSD_DEFAULT` | 1.3 (grep post-cambio) |
| **CD-7** | PROHIBIDO romper prefijo `"X402_PAYMENT_TOKEN not set"` / `"has invalid format"` | 1.2 |
| **CD-8** | PROHIBIDO hardcodes nuevos de PYUSD fuera del scope definido | 1.2-1.7 |
| **CD-9** | PROHIBIDO expandir scope (README, demo-x402, SDDs históricos) | Todos |
| **CD-10** | OBLIGATORIO `npx tsc --noEmit` explícito (lección WKH-SEC-01) | 1.8 |

---

## 9. Done Definition

La Wave está **hecha** cuando todos estos checks son TRUE:

- [ ] Branch `feat/052-wkh-52-pyusd-migration` creada desde `main @ b6e503d` (o HEAD más reciente).
- [ ] Los **6 archivos** del Scope IN fueron modificados según Pasos 1.2-1.7.
- [ ] **NO se modificó** ningún archivo fuera del Scope IN.
- [ ] `npx tsc --noEmit` → **0 errors** (CD-10).
- [ ] `npm run lint` → **0 new errors** (baseline warnings pre-existentes OK).
- [ ] `npm test` → **380/380 pass** (379 baseline + T11 nuevo).
- [ ] `grep -n KXUSD src/adapters/kite-ozone/payment.ts` → **vacío**.
- [ ] `grep -n KXUSD src/` → solo matches intencionales en T11 (`KXUSD_LEGACY` + label del test).
- [ ] Commit con mensaje convencional (§4 Paso 1.9) creado y **pusheado a `origin/feat/052-wkh-52-pyusd-migration`**.
- [ ] Branch **NO mergeada a main** — eso lo hace DONE/PR post-F4.
- [ ] Anti-Hallucination Checklist (§7) completo.
- [ ] Resumen ejecutivo al orquestador con: SHA del commit, N de tests (380), branch pusheada.

---

## 10. Notas operativas para el Dev F3

- **Orden sugerido**: 1.1 → 1.5 → 1.6 → 1.7 (archivos más "seguros" primero, bajo riesgo de romper nada) → 1.4 (comment 1-línea) → 1.2 (src) → 1.3 (test + T11) → 1.8 (validación) → 1.9 (commit). Esto minimiza el tiempo con tests rojos.
- **Si el baseline inicial falla** (< 379 tests pass antes de tocar nada) → **STOP** y escalar. No intentes "arreglar" tests pre-existentes: eso no es parte de esta HU.
- **Si T11 falla** con un mensaje tipo "expected 0x1b7425..., received 0x8E04D099..." → señal de que el env override **NO** se está respetando; es un bug crítico que bloquea AC-5/AC-8. Diagnosticar antes de seguir.
- **Si la regex `ADDRESS_RE` rechaza la PYUSD address** por mayúsculas → **STOP**. El regex actual es `/^0x[0-9a-fA-F]{40}$/` y acepta `0x8E04D099...` sin problema. Si ves falla, probablemente tocaste la regex (CD violado).
- **Recordatorio post-merge**: El PR debe documentar en la descripción que Railway requiere update manual de `X402_PAYMENT_TOKEN`, `X402_TOKEN_SYMBOL`, `X402_EIP712_DOMAIN_NAME` para cutover real — ya está incluido en el commit message sugerido.

---

*Story File generado por nexus-architect — F2.5 · WKH-52 · 2026-04-20*
