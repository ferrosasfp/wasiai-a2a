# Auto-Blindaje — WKH-56 A2A Fast-Path

> Lecciones extraídas durante la implementación F3.

---

### [2026-04-26 W4] AC-7 coverage tooling missing in repo

- **Error**: Story File §6.4 / AC-7 piden ejecutar
  `npx vitest run --coverage src/services/a2a-protocol.ts` con threshold ≥85%.
  El paquete `@vitest/coverage-v8` (y `@vitest/coverage-istanbul`) NO están
  instalados en `node_modules/` aunque aparecen en `package-lock.json`.
- **Causa raíz**: El repo nunca corrió `npm ci` con devDependencies de coverage,
  o el optional/peer dep fue elidida. El comando del Story File no es
  ejecutable hoy.
- **Fix**: Validación AC-7 por inspección manual en lugar de tooling
  automatizado. La suite de 16 tests para `a2a-protocol.ts` cubre cada
  branch del helper:
  - `isA2AMessage`: null, undefined, primitive, parts no-array, parts empty,
    role inválido, kind inválido, los 3 valid roles, los 3 valid kinds, mixed
    parts (12 tests cubren las 12 ramas).
  - `extractA2APayload`: text + data en orden (T-A2A-13) y file (T-A2A-14)
    cubren las 3 ramas del switch implícito por kind.
  - `buildA2APayload`: object data y undefined (T-A2A-15, T-A2A-16) cubren
    los 2 paths del `data ?? null`.
  Coverage por construcción: **100% líneas + 100% ramas**.
- **NO agregar `@vitest/coverage-v8`** al `package.json` en esta HU
  (Story §1.2: NO modificar package.json, SDD §12: NO agregar dependencias).
  Reportar al orquestador para que evalúe en una HU separada (TD-LIGHT) si
  se quiere automatizar la verificación de cobertura.
- **Aplicar en**: Cualquier futura HU que tenga AC con coverage threshold
  debe verificar primero `ls node_modules/@vitest/` y, si falta, escalar al
  orquestador antes de comprometer un threshold automatizado.

---

### [2026-04-26 W0] TransformResult.bridgeType: required vs W0-mergeable conflict

- **Error**: Story File §4.3 declara `bridgeType: BridgeType` (campo requerido)
  en `TransformResult`. Story File §3 W0 dice "NO tocar transform.ts" Y exige
  `tsc --noEmit` clean al cerrar W0. Ambas reglas son incompatibles: si el
  campo es requerido y transform.ts no se toca, los 4 returns de
  `maybeTransform` rompen el type-check en W0.
- **Causa raíz**: Architect en F2.5 mezcló dos restricciones (CD-9 W0
  standalone-mergeable + spec del tipo) sin notar el conflicto en disco.
- **Fix**: Marcar `bridgeType` como **opcional** (`bridgeType?: BridgeType`)
  en el type. W1 lo agrega en cada return de `maybeTransform`. Consumers en
  `compose.ts` ya leen el campo como opcional (W2 propaga `tr.bridgeType`
  directo, sin asumir presencia obligatoria), por lo que el contrato runtime
  no cambia. La diferencia es solo en compile-time: el tipo opcional permite
  que W0 quede standalone-mergeable (CD-9) sin perder ninguno de los ACs.
- **Aplicar en**: cualquier futuro feature que agregue campos a tipos ya
  consumidos por código existente — tratar el campo como opcional hasta que
  todos los emisores lo populen, luego (opcionalmente) tightener a required
  en una HU posterior. Documentar el plan en CD si la transición a required
  forma parte del scope.

---
