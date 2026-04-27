# Auto-Blindaje — WKH-56 A2A Fast-Path

> Lecciones extraídas durante la implementación F3.

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
