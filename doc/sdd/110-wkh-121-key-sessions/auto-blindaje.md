# Auto-Blindaje — WKH-121 (Session Keys server-side)

Registro de errores cometidos durante la implementación y su corrección, para
proteger futuras HUs del mismo error.

---

### [2026-06-19 10:47] Wave 5-FIX — Assertions de `mockDebit` con aridad fija rompen al agregar el 6º/5º arg
- **Error**: tras agregar `request.keySessionContext` como nuevo arg posicional de `budgetService.debit(...)` en `compose.ts`, dos tests en `src/services/orchestrate.billing.test.ts` (T-BILL-1 y T-BILL-2) fallaron: las aserciones `toHaveBeenCalledWith('k1', 2368, 0.02, undefined)` esperaban 4 args pero la llamada real ahora tiene 5 (`..., undefined` extra por `keySessionContext`).
- **Causa raíz**: `vitest` `toHaveBeenCalledWith` / `toHaveBeenNthCalledWith` matchea la lista COMPLETA de args (es estricto en aridad). Agregar un arg posicional opcional al final de una función mockeada rompe TODA aserción existente que enumere args, aunque el valor sea `undefined`. El cableado pasa por la cadena `orchestrate.ts → compose.ts → budgetService.debit`, así que afecta no solo a `compose.test.ts` sino a cualquier test que ejercite compose vía orchestrate.
- **Fix**: agregar el trailing `undefined` (nuevo arg `keySessionContext`) a las 4 aserciones de `orchestrate.billing.test.ts` y a las 7 de `compose.test.ts` que enumeraban args de `mockDebit`. Las aserciones que llaman `debit` directo con 3 args (middleware/gasless, step 0) NO se tocan: esas llamadas siguen teniendo 3 args reales (no pasan por compose).
- **Aplicar en**: cualquier futura ampliación de la firma de `budgetService.debit` (o de funciones mockeadas muy llamadas). Antes de agregar un arg posicional: `grep -rn "<mockName>).toHaveBeenCalledWith\|toHaveBeenNthCalledWith"` en TODO `src/` para encontrar TODAS las aserciones de aridad, no solo las del archivo de test "obvio". Distinguir las llamadas que pasan por la cadena modificada (suman el arg) de las directas (no lo suman).
