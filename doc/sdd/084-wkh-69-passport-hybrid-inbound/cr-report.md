# CR Report — WKH-69 Kite Passport Hybrid

**Reviewer**: nexus-adversary (CR mode) | **Date**: 2026-05-04 | **Branch**: feat/084-wkh-69-passport-hybrid-inbound @ 96447c9

## Veredicto
**APROBADO con MENORES** — 0 BLQs, 8 MNRs (todos polish/style)

## Resumen ejecutivo

Implementation clean, sigue el opt-in factory pattern canónico de `forward-key.ts`, 16 tests nuevos con AC IDs claros, paridad con codebase mantenida. 8 MNRs son polish — ninguno bloquea merge.

## Quality scorecard

| Area | Score | Notes |
|------|-------|-------|
| Naming consistency | 4/5 | `paymentOrigin` camelCase + `payment_origin` snake-case JSONB consistente con metadata convention |
| Code organization | 5/5 | Factory + tests + fixture clean separation. Cross-rootDir documentado |
| Test quality | 4.5/5 | 16 tests con T-AC IDs, asserts shape-match deepEqual, mocks scoped |
| Paridad codebase | 4/5 | Matches forward-key.ts exemplar, una excepción (header constant) |
| Documentation | 4.5/5 | 261-line onboarding doc completo, smoke test marked deferred |
| Maintenance debt | 5/5 | No TODOs, no console.log, no any |
| JSDoc / type safety | 4.5/5 | All exports documented, union literal types |
| Auto-Blindaje | 5/5 | TS6059 entry honest + scoped + 2 follow-up options |

## BLOQUEANTES
Ninguno.

## MENORES

| # | Área | archivo:línea | Issue | Sugerencia |
|---|------|---------------|-------|------------|
| MNR-CR-1 | Naming | `test/fixtures/passport-shape.ts:99` | `buildEoaPaymentHeader(opts: PassportShapeOpts)` reuses Passport-shaped opts (functional pero confuso) | Rename a `PaymentShapeOpts` o alias `EoaShapeOpts = PassportShapeOpts` |
| MNR-CR-2 | Naming | `event-tracking.ts:67-79` | `payment_origin` snake_case en metadata camelCase object | Mandado por spec (work-item AC-4); flag for awareness |
| MNR-CR-3 | Test IDs | `event-tracking.test.ts` | Mixed schemes `T-AC{N}-{M}` vs pre-existing `AC-{N}` | Standardize sobre `T-AC*` going forward |
| MNR-CR-4 | Paridad | `x402.ts:110`, fixture:89,116 | `'x-passport-session'` magic string (3 occurrences) — paridad con forward-key.ts:31-32 querría constante | **Extract `const X_PASSPORT_SESSION_HEADER`** in x402.ts |
| MNR-CR-5 | Paridad | `passport.ts:31` | JSDoc no menciona constante por nombre | Optional polish |
| MNR-CR-6 | Doc refs | `passport-onboarding.md:194`, `fixture:9` | "decision-doc.md line 168" off by 5 lines (actual 173); fixture cite "line 91-92" should be "line 91" | **Replace numeric line refs with section anchors** |
| MNR-CR-7 | Doc style | `passport-onboarding.md` | H2 sections sin numerar | Optional |
| MNR-CR-8 | Pattern | `event-tracking.ts:77-79` | Spread-conditional functional pero helper `omitUndefined()` sería clearer | Leave as-is, comment sufficient |

## Verificación cruzada AR

- MNR-CR-4 (header magic string) overlaps potentially con AR's surface attack: si AR flag header constant como auth surface gap, este MNR escala a BLQ. **Mark "(also AR finding)" si AR lo detecta** — AR no lo flagged como BLQ, classified as MNR-1 doc clarification.
- Spread-conditional CD-WKH69-7 verificado: existing 10× `toHaveBeenCalledTimes(1)` preservados.
- No overlaps fundamentales con AR findings.

## Quality strengths (positivos destacados)

- Factory return type explícito: `preHandlerAsyncHookHandler[]`
- `paymentOrigin?: 'passport' | 'eoa'` literal union (no `string`)
- `'payment_origin' in metadata` strict semantic (T-AC4-3) — distingue key absent vs value undefined
- PASSPORT-MOCK-SHAPE comment block 19 líneas comprehensive (CD-WKH69-6)
- `.env.example` block 26 líneas con explicit "any value other than 'true' → not mounted"
- Smoke Test section explícitamente "DO NOT execute during code review or CI" (line 152-153)

## Recomendación

APROBADO con MENORES. **Para fix-pack pre-F4** (production-grade), priorizar:
1. MNR-CR-4 — extract header constant (5 líneas)
2. MNR-CR-6 — replace line refs con section anchors (3 líneas)
3. MNR-CR-1 — alias EoaShapeOpts (1 línea)

MNR-CR-2/3/5/7/8 → polish opcional, no urgente.

**Mergeable as-is**.
