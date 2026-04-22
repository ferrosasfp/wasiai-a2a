# Auto-Blindaje — WKH-53 CONSOLIDADO (F3 Dev + AR + CR + F4)

Historial de errores encontrados durante la implementación y hallazgos post-implementación.
Este documento protege futuras HUs del mismo error.

---

## AB-WKH-53-#1: Baseline lint pre-existente (DRIFT FROM STORY, MitigaDA)

**[2026-04-22 W0] Drift encontrado durante implementation kickoff**

- **Error**: `npm run lint` falla con 6 errores de formatter/organizeImports en baseline (branch `main` @ `87f0053`).
- **Archivos afectados**: `src/adapters/kite-ozone/payment.ts`, `src/mcp/rate-limit.test.ts`, `src/mcp/tools/get-payment-quote.test.ts`, `src/mcp/tools/pay-x402.test.ts`, `src/mcp/tools/pay-x402.ts`, `src/mcp/url-validator.test.ts`
- **Causa raíz**: Violaciones de formato heredadas de commits previos (no del merge de WKH-52). Pre-existentes antes de iniciar WKH-53.
- **Clasificación**: DRIFT FROM STORY — el story asumía lint baseline green, pero realidad mostró violations out-of-scope.
- **Mitigación aplicada en F3**: 
  - W0 Readiness Check: documentar violations baseline
  - Validar que archivos del scope (budget.ts, identity.ts, security/, a2a-key.ts) están clean
  - Resultado: `npx biome check src/services/{budget,identity,security} src/middleware/a2a-key.ts` → 0 errors ✅
- **Lección para futuras HUs**: 
  1. W0 ritual: ejecutar `npm run lint` completo y documentar violations baseline
  2. Tomar screenshot de `npm run lint` baseline ANTES de iniciar F3
  3. Agregar regex `.gitignore` para archivos out-of-scope si no existe
  4. Verificar lint solo en archivos del scope al cierre de F3

---

## AB-WKH-53-#2: Story §5 asumió asserts inexistentes (DRIFT FROM STORY M6, CR Verificado)

**[2026-04-22 W1] Descubierto durante F3 implementation, confirmado en CR**

- **Error en story**: Story §5 M6 dice "actualizar asserts `mockGetBalance.toHaveBeenCalledWith(kid, chainId)` a 3 args en `src/middleware/a2a-key.test.ts`".
- **Realidad encontrada**: `grep -n "mockGetBalance" src/middleware/a2a-key.test.ts` → 6 usos, **todos son `.mockResolvedValue()`**. NO existen asserts `toHaveBeenCalledWith`.
- **Causa raíz**: Architect en F2.5 proyectó cambios basándose en análisis arquitectural (DT + firma nueva), no en lectura en disco del código actual.
- **Impacto**: M6 resultó no-op. El cambio de firma `getBalance(keyId, chainId)` → `getBalance(keyId, chainId, ownerId)` **NO rompe nada** porque mockResolvedValue ignora aridad del caller. Tests del middleware siguen PASS sin modificación.
- **Veredicto CR**: MAYOR docs drift (story desactualizado) pero **CÓDIGO OK** → aceptado como backlog deuda, no blocker.
- **Lección para futuras HUs**:
  1. Architect en F2/F2.5: buscar cada assert mencionado con `grep -rn "toHaveBeenCalledWith.*methodName"` ANTES de escribir story
  2. Confirmar que el patrón de mock existe en disco
  3. Si el patrón no existe, reescribir story a "crear nuevo test" en lugar de "modificar assert existente"
  4. Aplicable a: cualquier HU con cambios de firma en métodos testeados

---

## AB-WKH-53-#3: Edge case `ownerId=""` no cubierto (MNR-1 AR, Aceptado)

**[2026-04-22 AR phase] Identificado en Adversarial Review**

- **Hallazgo**: Test fixtures en `src/services/security/ownership.test.ts:50-68` usan UUID válido (`'owner-123'`, `'owner-456'`). No hay test que verifique comportamiento cuando `ownerId=""` (cadena vacía).
- **Riesgo residual**: **BAJO** — app-layer nunca genera `owner_ref=""` porque DB constraint es `NOT NULL`. Middleware siempre resuelve `keyRow.owner_ref` válido. Edge case teórico pero imposible en runtime.
- **Clasificación**: MENOR (MNR-1 AR) — aceptado como deuda en backlog.
- **Resolución**: 
  - **NO blocker** para F4 QA (código funciona correctamente)
  - **Candidato a WKH-54** (Fase B — RLS real en Postgres)
  - **Candidato a WKH-55** (Security hardening — RPC internals)
- **Lección para futuras HUs**:
  1. Cuando migres a RLS real (CREATE POLICY en DB), agrega test coverage para:
     - Empty owner refs (`ownerId=""`)
     - NULL owner_ref (si schema permite)
     - Permission boundary tests a nivel SQL
  2. Aplicable a: WKH-54 y WKH-55 (próximas fases de seguridad)

---

## AB-WKH-53-#4: Story catalog desactualizado post-F3 (MAYOR-1 CR, Documentado)

**[2026-04-22 CR phase] Identificado en Code Review**

- **Hallazgo**: Story file §5 describe "actualizar asserts en a2a-key.test.ts" pero esos asserts no existen (AB-WKH-53-#2). En F4 QA debe validarse: **story catalog vs git diff real**.
- **Causa raíz**: F2.5 story generation asumió structure sin verificar runtime en disco.
- **Impacto actual**: **NO code defect** — el story fue seguido correctamente (0 asserts existentes = 0 asserts actualizados). Pero docs drift existe (story desactualizado).
- **Veredicto CR**: MAYOR docs drift (aceptado, no blocker porque código OK)
- **Resolución**:
  - CR aprobó el código (0 defects)
  - Docs drift será corregida en: WKH-55 (retro NexusAgil) o backlog update de a2a-key.test.ts en próxima HU
  - NO cierra esta HU
- **Lección para futuras HUs**:
  1. **QA en F4** debe comparar:
     - story file §5 (test catalog planeado)
     - vs git diff (test cambios reales)
  2. Si hay mismatch:
     - Si código PASS → docs drift (aceptado como deuda)
     - Si código FAIL → BLOCKER para F4
  3. Documentar mismatch en auto-blindaje para retro
  4. Aplicable a: cualquier HU modo QUALITY (AR + CR)
