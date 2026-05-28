# Auto-Blindaje — WKH-112 [BASE-07] downstream chain-aware

### [2026-05-27 18:12] FIX-PACK iter.1 — `adapter.sign` sin `timeoutSeconds` regresó la ventana EIP-3009 (AR BLQ-MED-1)
- **Error**: en el refactor a thin-orchestrator llamé `adapter.sign({ to, value })` sin `timeoutSeconds`. El default del adapter es 60s; el legacy usaba `VALID_BEFORE_SECONDS = 300`. Esto cambió el comportamiento observable del path Avalanche → violó CD-1 (paridad de comportamiento).
- **Causa raíz**: el Story File (`:163`, `:436`) prescribía `adapter.sign({ to, value: ..., timeoutSeconds })` explícito, y `VALID_BEFORE_SECONDS` figuraba entre las constantes legacy a "trasladar" vía ese param. Lo omití al inlinear el call y no había test que afirmara el window → el drift pasó desapercibido en F3.
- **Fix**: definí la constante nombrada `DOWNSTREAM_AUTH_WINDOW_SECONDS = 300` (con comentario citando CD-1/BLQ-MED-1) y la paso como `timeoutSeconds` al `adapter.sign(...)`. Agregué test `T-AuthWindow` que captura el arg del mock `sign` y verifica `toMatchObject({ timeoutSeconds: 300 })`.
- **Aplicar en**: cualquier orchestrator que delegue firma EIP-3009 a un adapter — los parámetros de ventana/timeout NO son opcionales aunque el tipo los marque `?`. Cuando un Story File prescribe un campo explícito al delegar, debe quedar afirmado por un test, no asumir defaults del adapter.

### [2026-05-27 18:12] FIX-PACK iter.1 — limpieza skip-codes muertos (MNR-2 / CR-MNR-1)
- **Error**: la union `DownstreamSkipCode` conservaba `'NETWORK_ERROR'` y `'CONFIG_MISSING'` sin uso tras el refactor (drift cosmético entre la union y los codes realmente emitidos).
- **Causa raíz**: arrastre de la versión legacy del módulo; ningún code-path los emite.
- **Fix**: removidos ambos de la union tras verificar con grep que NO aparecen en ningún `return`/log de `src/`.
- **Aplicar en**: al refactorizar un módulo, recortar las unions de error/skip-codes a los efectivamente emitidos para evitar drift type↔runtime.
