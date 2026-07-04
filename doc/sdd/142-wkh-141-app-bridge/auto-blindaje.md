# Auto-Blindaje — WKH-141 (APP Bridge)

### [2026-07-04 02:02] Wave 3 — Disclaimer de ejemplo violaba su propia CD-3
- **Error**: usé literal el disclaimer de ejemplo del Story File
  (`'...not an end-to-end certified interop.'`), que contiene la palabra
  "certified". El test de honestidad (derivado de CD-3) falló.
- **Causa raíz**: contradicción interna en el Story File. CD-3 (inviolable)
  prohíbe la substring "certified"/"100%" en el `disclaimer`, pero el string de
  ejemplo ("Ejemplo de tono") justamente contenía "certified". El ejemplo es
  ilustrativo; la CD es normativa.
- **Fix**: reformulé la constante `APP_ALIGNMENT_DISCLAIMER` a
  `'...not an end-to-end verified interop.'` (evita "certified", mantiene el tono
  honesto de alineamiento conceptual).
- **Aplicar en**: cuando un Story File da un string de ejemplo, validarlo contra
  las CDs antes de copiarlo literal. La CD gana sobre el ejemplo. Aplica a
  cualquier string honesto/legal horneado (disclaimers, notas de compliance).
