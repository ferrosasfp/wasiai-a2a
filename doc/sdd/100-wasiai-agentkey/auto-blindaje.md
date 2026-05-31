# Auto-Blindaje — WKH-100 (ERC-8004 Identity Binding, Fase 1)

### [2026-05-31] Wave 4 — Nuevo named export rompe mocks de tests existentes
- **Error**: tras agregar `import { isIdentityVerified }` en `src/routes/auth.ts`
  y `src/middleware/a2a-key.ts`, 46 tests existentes (`auth.test.ts`,
  `a2a-key.test.ts`) empezaron a devolver 500 (TypeError: `isIdentityVerified is
  not a function`).
- **Causa raíz**: esos test files mockean `../services/identity.js` con un factory
  manual (`vi.mock(..., () => ({ identityService: {...} }))`) que NO exportaba el
  nuevo named export. Al consumir el módulo mockeado, `isIdentityVerified` era
  `undefined`.
- **Fix**: agregar `isIdentityVerified` (impl derivada `row?.erc8004_identity != null`)
  al factory de mock de ambos test files, + `bindErc8004Identity`/
  `resolveIdentityForSlug` en el mock de `identityService` en `auth.test.ts`.
- **Aplicar en**: cualquier HU que agregue un NUEVO named export a un módulo que
  ya tenga mocks con factory manual (`vi.mock(path, () => ({...}))`). Esos mocks
  reemplazan el módulo entero → hay que reflejar TODOS los exports consumidos por
  el código bajo test. Grep `vi.mock('<modulo>'` antes de agregar exports nuevos.
