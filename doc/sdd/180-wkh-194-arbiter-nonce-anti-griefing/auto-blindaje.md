# Auto-Blindaje — WKH-194 (nonce del árbitro anti-griefing)

### [2026-07-13] Wave 3 — TDZ en factory de `vi.mock('../../lib/logger.js')`
- **Error**: al agregar el mock del logger en `arbiter-executor.test.ts` para T3
  (verificar que el secreto nunca se loguea), la suite falló con
  `Cannot access 'mockLogWarn' before initialization`.
- **Causa raíz**: `vi.mock(...)` se hoistea por encima de todos los `const` del
  módulo. El factory referenciaba `const mockLogWarn = vi.fn()` declarado más
  abajo → TDZ (temporal dead zone) al ejecutarse el factory durante el import.
- **Fix**: declarar el spy con `vi.hoisted`:
  `const { mockLogWarn } = vi.hoisted(() => ({ mockLogWarn: vi.fn() }));`. Así el
  binding se inicializa antes de que corra cualquier factory hoisteado.
- **Aplicar en**: cualquier mock de módulo (`vi.mock`) cuyo factory referencie
  variables de test (spies, dobles). Los mocks de viem ya presentes funcionan
  porque sus closures se resuelven en runtime (al invocar el cliente), no al
  definir el factory; los del logger corren en el import → requieren `vi.hoisted`.

### [2026-07-13] FIX-PACK (AR MNR-1) — el guard de entropía rompía los "strong" de los tests existentes
- **Error**: al agregar el chequeo de entropía (≥16 caracteres únicos) a
  `getArbiterNonceSecret`, algunos secretos "fuertes" de los tests eran de baja
  entropía y empezaron a caer como weak: `arbiter-executor.test.ts` usaba
  `'z'.repeat(48)` (1 único) y `'S3cr3t'.repeat(8)` (5 únicos); `arbiter.test.ts`
  usaba `TEST_SECRET = 'x'.repeat(64)` (1 único) como valor de `ARBITER_NONCE_SECRET`
  en los flujos T4/T8/etc → `getArbiterNonceSecret` devolvía null → fallback
  custodial → los flujos escrow-ON dejaban de ejercitarse.
- **Causa raíz**: los tests previos elegían secretos "≥32 chars" repitiendo un
  patrón trivial. El largo alcanzaba pero la entropía no — exactamente el hueco que
  cerró AR MNR-1.
- **Fix**: reemplazar los secretos de test por hex de alta entropía
  (`'0123456789abcdef'.repeat(4)` = 64 chars, 16 únicos, espeja `openssl rand -hex 32`).
  `'y'.repeat(64)` (rotación en T4) se dejó intacto: la 2ª pasada pega en read-first
  ANTES del secret-getter, así que su baja entropía es irrelevante. `TEST_SECRET`
  también alimenta `EXPECTED_NONCE` vía `deriveArbiterNonce` (que NO chequea entropía),
  así que cambiar el valor mantiene la consistencia del assert.
- **Aplicar en**: cualquier test que setee `ARBITER_NONCE_SECRET` y espere que el
  árbitro proceda (no-fallback) DEBE usar un secreto de alta entropía (≥16 únicos),
  no `'X'.repeat(N)`.

### [2026-07-13] Wave 2 — `database.types.ts` fuera del Scope IN pero obligatorio
- **Error potencial**: `tsc` falló con 7 errores en `arbiter.ts`
  (`"a2a_arbiter_nonces"` / `"get_or_create_arbiter_nonce"` no asignables a los
  literales de tabla/RPC) porque el cliente Supabase está tipado con
  `src/types/database.types.ts` (generado), que no incluía la tabla/RPC nuevos.
- **Causa raíz**: el Story File lista la migración (W0) pero no el archivo de
  tipos generado que la acompaña. Las HUs previas (191a/b/c) SÍ registraron sus
  tablas/RPCs ahí — es un artefacto de contrato de datos, no scope creep.
- **Fix**: agregar `a2a_arbiter_nonces` (Row/Insert/Update/Relationships) y
  `get_or_create_arbiter_nonce` (Args/Returns) a `database.types.ts`, byte-a-byte
  con el patrón de `a2a_payment_intent_debit_signatures` / `record_debit_hop1`.
- **Aplicar en**: TODA migración que cree tabla/RPC consumidos por el cliente
  Supabase tipado desde `src/` debe reflejarse en `database.types.ts` en la MISMA
  wave W0 (contratos de datos), aunque el Story File no lo liste explícitamente.
