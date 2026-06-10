# Auto-Blindaje — WKH-117 (Kite Passport dual-auth)

### [2026-06-10 12:38] Wave 3 — `logOwnershipMismatch` op union no incluye 'bindPassport'
- **Error**: en `identity.ts:bindPassport` llamé `logOwnershipMismatch('bindPassport', keyId, ownerId)` → `tsc` TS2345: el overload posicional legacy solo acepta `'getBalance' | 'deactivate'`.
- **Causa raíz**: el snippet de referencia del SDD usaba `'bindPassport'` como literal, pero el overload posicional de `logOwnershipMismatch` (errors.ts:300-304) tiene un union restringido; `errors.ts` está FUERA de Scope IN, así que no puedo ampliar el union ni `OwnershipOp`.
- **Fix**: reusar la op `'deactivate'` del overload posicional, exactamente como hace el exemplar `bindFundingWallet` (identity.ts:159). El logger es PII-safe (hashea keyId/ownerId), así que el label no expone nada. `errors.ts` queda intacto (in-scope respetado).
- **Aplicar en**: cualquier nuevo método ownership-guarded clonado de `bindFundingWallet`/`deactivate` — usar SIEMPRE una op ya presente en el union posicional (`'getBalance' | 'deactivate'`) salvo que el cambio en `errors.ts` esté explícitamente en Scope IN.
