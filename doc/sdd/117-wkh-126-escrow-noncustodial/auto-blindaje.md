# Auto-Blindaje — WKH-126b (F3 Dev)

Registro de errores cometidos y corregidos durante la implementación. Protege futuras HUs del mismo error.

### [2026-06-22 00:13] Wave 2 — `ReceiptType` no incluye `'deposit_verified'`
- **Error**: el Story File §4.2.4 (AC-11/DT-11) exige `receiptService.emit({ receiptType: 'deposit_verified', ... })`, pero `ReceiptType` en `src/types/receipt.ts` es la union estricta `'protocol_fee' | 'budget_debit'`. `tsc --noEmit` falló con `TS2322: Type '"deposit_verified"' is not assignable to type 'ReceiptType'` en `src/routes/auth.ts`.
- **Causa raíz**: el Story File listó `src/services/receipt.ts` en NO TOCAR y anticipó (R-3) el riesgo de un CHECK constraint a nivel DB, pero NO contempló que el valor también debe estar en la union TS `ReceiptType` (archivo distinto: `src/types/receipt.ts`, que no figura ni en Scope IN ni en NO TOCAR). El gate de compilación TS-strict no era satisfacible con los 8 archivos del Scope IN.
- **Fix**: cambio aditivo mínimo — se agregó `'deposit_verified'` a la union `ReceiptType` en `src/types/receipt.ts`, con JSDoc `PROVISIONAL — VERIFY-AT-IMPL` apuntando al posible CHECK constraint (R-3). `src/services/receipt.ts` quedó intacto (CD-6). No se usó cast (`as ReceiptType`) porque ocultaría el drift de tipos.
- **Aplicar en**: cualquier HU que agregue un nuevo `receiptType` debe extender la union en `src/types/receipt.ts` ADEMÁS de verificar el constraint DB del RPC `insert_receipt`. La union TS y el constraint Postgres son DOS gates separados.
- **Desvío del Story File (para AR)**: se tocó `src/types/receipt.ts`, archivo fuera de la lista de 8 del Scope IN (§1). Es la única forma de satisfacer la propia AC-11 del Story File bajo TS-strict. Documentado acá y marcado VERIFY-AT-IMPL.
