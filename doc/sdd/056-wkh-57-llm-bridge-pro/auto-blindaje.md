# Auto-Blindaje — WKH-57 LLM Bridge Pro

> Lecciones extraídas durante la implementación F3.

---

### [2026-04-26 W2] Mock chain Supabase: 3 .eq() en lugar de 2

- **Error**: Tras agregar `.eq('schema_hash', ...)` al chain de `getFromL2`,
  los tests T-1..T-5 en `transform.test.ts` rompen el shape del mock —
  `eq2.mockReturnValue({ single })` falla porque ahora hay un `.eq3` antes
  del `.single()`.
- **Causa raíz**: La cadena Supabase es posicional; cualquier helper que
  agregue otro `.eq()` requiere extender el mock. El test no recibe error
  TS — recibe `undefined.single is not a function` en runtime.
- **Fix**: En `beforeEach` y en T-2/T-3 que re-construyen el mock chain,
  agregar `eq3 = vi.fn().mockReturnValue({ single })` y enlazarlo:
  `eq2 = vi.fn().mockReturnValue({ eq: eq3, single })`. El `single` también
  se expone en `eq1`/`eq2` por seguridad.
- **Aplicar en**: cualquier futura HU que agregue una columna al filtro de
  `kite_schema_transforms` (o cualquier tabla con mock fluent-API). Antes
  de modificar `getFromL2`/`persistToL2`/`getFromL3`, contar el número
  exacto de `.eq()` en la cadena nueva y replicar en TODOS los `beforeEach`
  y mocks específicos de tests existentes. Pattern: el mock debe ser
  un superset de la cadena real (acepta `.eq()` extra sin romper).

---

### [2026-04-26 W3] generateTransformFn debe NO usar inputSchema cuando es {}

- **Error potencial**: Se pasa `schema = inputSchema ?? {}` al
  `generateTransformFn`. Si `inputSchema` es `undefined` (path raro pero
  posible), el LLM recibe `{}` como schema y debe inventarse el shape.
- **Causa raíz**: `maybeTransform` permite `inputSchema?: undefined`. La
  lógica de `isCompatible(undefined)` devuelve `true` → SKIPPED, así que
  realmente NUNCA llegamos al LLM con schema undefined. La defensa con
  `?? {}` es redundante pero correcta.
- **Fix**: Mantener `?? {}` como defensa-en-profundidad; el path es
  inalcanzable según el flow actual pero el costo de la guardia es 0.
- **Aplicar en**: similar pattern en otros services con schema opcional
  — preferir defensa explícita `?? {}` antes que asumir invariantes
  (los invariantes pueden romperse en refactors futuros).

---

### [2026-04-26 W5] Tests con `setupSupabaseMissChain` redundante en T-VER-7c

- **Error**: T-VER-7c (CACHE_L1 hit) hace una primera llamada que primea
  L1, luego `vi.clearAllMocks()` y re-llama esperando hit de L1 sin
  consultar Supabase. Sin el `setupSupabaseMissChain()` post-clear, si
  por algún motivo la lógica decide consultar L2 (regresión), el mock
  rompería con error opaco en lugar de "L1 hit confirmed".
- **Causa raíz**: `vi.clearAllMocks()` resetea el `mockReturnValue` del
  `supabase.from`, dejándolo retornar `undefined`. Cualquier `.from(...)`
  que llegue rompe con TypeError.
- **Fix**: Llamar `setupSupabaseMissChain()` después de `clearAllMocks()`
  en tests que validan ausencia-de-DB-call — esto es defensivo: si la
  lógica consulta DB, recibirá un miss (no un crash), y el assert
  `mockCreate not called` igualmente fallaría con un mensaje claro.
- **Aplicar en**: cualquier test de "cache hit" donde la expectativa es
  cero llamadas a la capa más profunda. Resetear los mocks de la capa
  profunda con un valor "safe miss" en lugar de dejarlos undefined.

---
