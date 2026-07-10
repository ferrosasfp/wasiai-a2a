# Code Review (CR) — WKH-170 `remit-kyc-validator` (endpoint HTTP, etapa 1 / Free-KYC)

> Fase: CR (post-AR). Reviewer: nexus-adversary. Eje: **quality + pattern consistency**.
> Repo de código: `/home/ferdev/.openclaw/workspace/wasiai-remittance-agents/`
> Archivos de Scope IN: `route.ts`, `route.test.ts`, `README.md` (todos ya auditados en AR).

## Veredicto global: **APPROVED**

El endpoint es un fork byte-a-byte de `remit-corridor-fx` con core KYC bien confinado. No hay BLOQUEANTEs. La pattern consistency con WKH-171 (fila 167) es perfecta — mismo SDD, mismo stack, mismo deploy Vercel, mismo contrato `/invoke`. Tests no-tautológicos cubriendo PII. 0 MENOR.

---

## 1. Code Quality

### Readability & Maintainability
- `route.ts` (18 líneas): lineal, sin branches innecesarios. Comentarios claros en español (CD-6 context).
- `route.test.ts` (130 líneas): 8 tests cada uno con descripción explícita + por qué lo verifica.
- `README.md`: sección nuevapárrafo idéntico a `remit-corridor-fx`, redacción clara de precondiciones (Didit OFF).

### Type Safety
- No `any` explícito. `NextRequest`/`NextResponse` type-correct sin cast. Zod schema reutilizado (`KycInputSchema` from `@/agents/kyc-validator`).

### DRY (Don't Repeat Yourself)
- `KycInputSchema` y `runKycValidator` reutilizados del core (no duplicados). El endpoint es un **wrapper puro**, no reinventa la lógica.
- Test mock `vi.hoisted` + `vi.mock(...importActual)` copiado del exemplar `remit-corridor-fx`, patron establecido.

---

## 2. Pattern Consistency

| Elemento | WKH-171 exemplar | WKH-170 | Match? |
|----------|-----------------|--------|--------|
| Endpoint route | `src/app/api/agents/remit-corridor-fx/invoke/route.ts` | `src/app/api/agents/remit-kyc-validator/invoke/route.ts` | ✅ Byte-idéntico structure |
| Parser | `CorridorFxInputSchema.safeParse` | `KycInputSchema.safeParse` | ✅ Same pattern |
| 400 error | `{ error: "invalid_input", details: parsed.error.flatten() }` | Idem | ✅ |
| 200 wrap | `{ result }` | Idem | ✅ |
| 502 error | `{ error: "quote_unavailable" }` | `{ error: "verification_unavailable" }` | ✅ Code name matches core semantics |
| Log 502 | `console.warn(..., { errorName })` | Idem | ✅ |
| Test framework | vitest + `vi.mock(...importActual)` | Idem | ✅ |
| README section | Endpoint HTTP + deploy + etapa 1 context | Idem | ✅ |

---

## 3. Security (PII-centric)

**Verification re-checked from AR findings — all still hold:**
- ✅ `parsed.error.flatten()` is value-free (Zod native, not custom-message).
- ✅ `{result}` wrapping ensures no leak to `data.result ?? data` contract.
- ✅ 502 body fixed, console.warn only `err.name`.
- ✅ Tests 2, 5, 7 blind NO-PII with actual DNI (`"12345678"`) — not mocked.

**No new security surface introduced** (endpoint is stateless, no DB write, no cache, no external state).

---

## 4. Test Coverage & Non-Tautology

| Test # | Coverage | Tautology Risk? | Finding |
|--------|----------|-----------------|---------|
| 1 | 200 contrato + field count | None — `Object.keys(...).sort().toEqual([...])` checks exact set, not just presence | ✅ |
| 2 | 200 NO-PII HTTP | None — `JSON.stringify(...).not.toContain("12345678")` is real, input has DNI | ✅ |
| 3 | Didit OFF → `provenance:"local-fallback"` | None — depends on `vi.stubEnv("DIDIT_API_KEY","")`, testable state | ✅ |
| 4 | PROD fail-safe (payoutAllowed=false) | None — stubs 2 env vars independently, both exogenous | ✅ |
| 5 | 400 NO-PII HTTP | None — real error (senderCountry missing), real PII in input (DNI), real assert (not toContain) | ✅ |
| 6 | 400 on no-JSON | None — payload is genuinely malformed | ✅ |
| 7 | 502 on throw | Mock `mockImplementationOnce` forces deterministic throw w/ honeypot string (`"99887766"`); assert not present | ✅ |
| 2b (added post-AR) | 200 con campo extra PII inyectado | None — `extraPii:"87654321"`, Zod strippea, verify no leak | ✅ |

**Conclusion**: tests are **defensive**, not self-satisfied. Each asserts a real failure mode or a real mitigation.

---

## 5. Scope Drift

Verificado archivo-por-archivo (mtime):
- `route.ts` (2026-07-10 11:09): NUEVO, within window.
- `route.test.ts` (2026-07-10 11:18, incl. fix-pack test 2b): NUEVO, within window.
- `README.md` (2026-07-10 11:10): MODIFICADO, new section appended.
- `kyc-validator.ts` (2026-07-08 18:08): INTACTO (CD-1).
- `providers/kyc.ts` (2026-07-08 17:54): INTACTO (CD-1).
- `remit-corridor-fx/**` (2026-07-09): INTACTO (exemplar read-only).

**Zero drift detected.**

---

## 6. Constraint Directives

| CD | Verificación | Status |
|----|--------------|--------|
| CD-3 (slug byte-idéntico) | `SLUG="remit-kyc-validator"` in code, `name` in W4 payload both = `"remit-kyc-validator"` | ✅ |
| CD-6 (NO-PII en 200/400/502) | Visto en §3; tests 2/5/7 lo blinden | ✅ |
| CD-7 (mutaciones `!` humano) | El route NO hace deploy/registro, solo código — confirmado | ✅ |
| CD-8 (contrato `{result}/400/502`) | Byte-idéntico a WKH-171 exemplar | ✅ |

---

## 7. Findings

**Ningún BLOQUEANTE encontrado.**

**0 MENOR** — los 2 MENOR del AR (uno pre-existente código, uno opcional test) permanecen como hallazgos históricos, no regresión de esta CR.

---

## Cierre

- **Gate**: APPROVED. El código es un fork fiel del exemplar con scope bien delimitado. Pattern consistency con WKH-171 establecida. PII blindaje verificado.
- **Ready for F4 QA**: tests ejecutables, tipos limpios, no alucinaciones.

*CR generado por NexusAgil — nexus-adversary. Post-AR, WKH-170.*
