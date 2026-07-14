# CR Report — WKH-196 (uint256 NUMERIC(78,0) precision-loss fix)

- **Branch/commits**: `fix/181-wkh-196-uint256-numeric-precision-read` @ `d024b6c` (fix funcional) + `148babd` (fix-pack type-safety)
- **Reviewer**: nexus-adversary (CR)
- **Money-path / on-chain**: SÍ (escrow debit two-hop settle, epic WKH-191)
- **Veredicto**: **CR APROBADO — 0 BLQ, 0 MENOR**

---

## Resumen ejecutivo

El fix es **funcionalmente correcto, completo y bien testeado**. Los 5 selects castean exactamente las 3 columnas identificadas en el inventario cerrado del SDD (sin missed, sin sobrecasting). Cero alias (key preservada), cero cambios de schema, cero cambios de contrato de tipos. El AR inicial cazó 1 BLQ-BAJO de type-safety en el test nuevo; fix-pack aplicado (`148babd`, tipar arg mock select → `_cols?: string`). Post-fix: `npx tsc --noEmit` = 0 errores, `npm test` = 2994 passed (102 nuevos, 2892 previos intactos), `npm run build` = 0 errores, `npx biome check` = 0 errores.

---

## Hallazgos por categoría

| # | Categoría | Veredicto | Detalle | Archivo:línea |
|---|-----------|-----------|---------|---------------|
| 1 | **Completitud del fix** | ✅ OK | Inventario cerrado: 3 columnas NUMERIC(78,0), 5 selects identificados, todos casteados sin missed. Barrido exhaustivo `.from(a2a_payment_intent_debit_signatures)` y `.from(a2a_arbiter_nonces)` — ÚNICOS sitios en codebase. No hay `.select('*')` sobre ninguna de las 2 tablas. | ar-report.md §Completitud(OK) |
| 2 | **Corrección del cast** | ✅ OK | 5 selects castean columnas NUMERIC precisas sin alias: `debit_nonce::text`, `debit_amount_atomic::text`, `nonce::text`. Key preservada en JSON (PostgREST `::text` no renombra). Mapeo `row.<col>` intacto. | debit-capture.ts:L114-116, arbiter.ts:L108, reconciliation.ts:L184-187/L222-225/L407 |
| 3 | **CD-6: no castear absent cols** | ✅ OK | `driftCheck` (reconciliation.ts:L407) castea SOLO `debit_amount_atomic::text` — no trae `debit_nonce`. `debit_deadline` BIGINT nunca casteado (reader L115). Test T-NEW-8 verifica select contiene `amount::text` pero NO `nonce::text`. | reconciliation.ts:L407-409; test:T-NEW-8 |
| 4 | **CD-1: byte-idéntico < 2^53** | ✅ OK | Valores representables exactos en float64 (p.ej. `7`, `3000000000000000000`) retornan IDÉNTICO string sin cambio de comportamiento observable. Cast `::text` no altera values < 2^53. Tests T-NEW-3 (nonce `'7'`) + T-NEW-9 (amount `'3000000000000000000'`) verifican byte-identidad. | test:T-NEW-3/T-NEW-9; ar-report.md §Regresión |
| 5 | **Ownership Guard (WKH-53)** | ✅ OK | Cadenas `.eq('owner_ref', ownerRef)` INTACTAS en arbiter.ts:L110 (read-first) y reconciliation.ts (heredadas de selects previos). Cero modificación al path de ownership. | arbiter.ts:L110; ar-report.md §Ownership Guard |
| 6 | **Type-safety (tsc)** | ✅ OK (post-fix-pack) | Fix-pack `148babd` tipó arg mock select `_cols?: string` → `as string \| undefined`. Re-run `npx tsc --noEmit` = 0 errores whole-project. Repo tsc-clean preservado (DT-5). | commit:148babd; `npx tsc --noEmit` output |
| 7 | **Test coverage / anti-tautología** | ✅ OK | 9 tests nuevos: (a) cast-presence (captura literal del `.select()`, falla si Dev quita `::text` = guarda real AC-6); (b) round-trip exacto de `4312989337224638380` a través de `BigInt()` (guarda CD-2 sin corrupción); (c) byte-idéntico < 2^53 (CD-1). Cero tautologías `expect(true).toBe(true)`. | debit-capture.test.ts:T-NEW-1/T-NEW-2/T-NEW-3 + arbiter.test.ts:T-NEW-4/T-NEW-5 + reconciliation.test.ts:T-NEW-6..T-NEW-9 |
| 8 | **Bug-alive post-fix** | ✅ OK | Todos los sinks hacen `BigInt(string)` directo SIN paso intermedio `Number()` o `JSON.parse()` redondeador. Payment-intent.ts:L539/L541, reconciliation.ts:L200/L250/L431, arbiter.ts:L121 (`BigInt(String(existing.nonce))`). String del select directo al `writeContract` firma. | payment-intent.ts:L539-541; reconciliation.ts:L200/L250/L431; arbiter.ts:L121 |
| 9 | **Scope integridad** | ✅ OK | Diff acota a 6 archivos (4 producción: debit-capture.ts, arbiter.ts, reconciliation.ts ×1-3; 2 test: debit-capture.test.ts, arbiter.test.ts, reconciliation.test.ts). Cero artefactos ajenos (no .sql, no schema, no tipos modificados, no flags nuevos). | git diff d024b6c^..d024b6c + 148babd |
| 10 | **Build integridad** | ✅ OK | `npm run build` = 0 errores (excluye .test.ts, por eso AR tuvo que correr tsc separado). `npm test` = 2994 passed (102 nuevos, 2892 previos sin regresión). `npx biome check` = 0 errores. Suite completa verde. | `npm run build`; `npm test`; `npx biome check` output |
| 11 | **Destructive migrations** | N/A | Sin migración (CD-3). Fix 100% capa de lectura PostgREST. | work-item.md §Scope OUT |
| 12 | **RPC security (SECURITY DEFINER)** | N/A | No se agregó/modificó ninguna RPC. Los outputs de RPC (`get_or_create_arbiter_nonce.persisted_nonce`) ya castean a NUMERIC → string (Scope OUT). | ar-report.md §Hallazgos categoría |

---

## Evidencia crítica clave

### Cast-presence (guarda AC-6)
Los 3 nuevos tests de cast-presence (T-NEW-1 arbiter, T-NEW-4 reader, T-NEW-6/T-NEW-8 reconciliation) capturan el arg literal pasado a `.select()` vía `mock.calls[0]?.[0]` (double `select` como `vi.fn`). Si Dev quita `::text`, el assert falla directamente — regresión AC-6 real, no simulable de otro modo.

Ejemplo T-NEW-1:
```typescript
const selectArg = builder.select.mock.calls[0]?.[0] as string;
expect(selectArg).toContain('debit_nonce::text');
expect(selectArg).toContain('debit_amount_atomic::text');
expect(selectArg).not.toContain('debit_deadline::text'); // CD-6 guard
```

### Round-trip exacto (guarda CD-2)
Los tests de round-trip ejercitan `BigInt(string)` sobre el valor **real del incidente** (`4312989337224638380`, uint256 no-redondo > 2^53). Sin el fix, `JSON.parse` lo reduce a `4312989337224638464n` (corrupto). Con cast `::text`, PostgREST devuelve `"4312989337224638380"` (string exacto) → `BigInt()` reconstruye `4312989337224638380n` bit-a-bit.

Ejemplo T-NEW-2 (reader):
```typescript
const row = await readValidDebitSignature(..., {debit_nonce: '4312989337224638380', debit_amount_atomic: '1500000'});
expect(row.debit_nonce).toBe('4312989337224638380'); // string exacto
expect(BigInt(row.debit_nonce)).toBe(4312989337224638380n); // no 4312989337224638464n
```

### Inventario cerrado + barrido
AR verificó exhaustivamente:
- `.from('a2a_payment_intent_debit_signatures')` en 2 sitios (debit-capture.ts:L115, reconciliation.ts:L183/L221/L405) — todos casteados
- `.from('a2a_arbiter_nonces')` en 1 sitio (arbiter.ts:L107) — casteado
- `.select('*')` sobre ambas tablas: 0 resultados
- Parámetros de RPC `p_nonce`/`p_amount_atomic` (Scope OUT, outputs YA castean)
- Columnas USD/BIGINT epoch (Scope OUT, fuera de riesgo)

**Conclusión:** 3 columnas, 5 selects, 5 casts. SIN MISSED, SIN SOBRECASTING.

### Ownership Guard WKH-53 intacto
`.eq('owner_ref', ...)` filtros heredados de selects previos + read-first arbiter.ts:L110 que valida `owner_ref`. Cero modificación al path de propiedad, compliance WKH-53 preservado.

---

## Type-safety journey

**AR inicial** encontró 2 errores tsc en T-NEW-1 (`debit-capture.test.ts`):
- TS2493: Tuple type `[]` of length 0 has no element at index 0
- TS2352: Conversion of type `undefined` to type `string` may be a mistake

**Root cause:** Mock `select` definido sin arg → sig `() => builder` → `mock.calls` tipado como `[][]` (tupla vacía) → `.mock.calls[0]?.[0]` dispara los errores.

**Fix-pack `148babd`:** Tipar arg mock select → `select: vi.fn((_cols?: string) => builder)` → `mock.calls[0]?.[0]` ahora es `string | undefined` → cast `as string | undefined` → tsc satisfecho.

**Verification post-fix:** `npx tsc --noEmit` = 0 errores whole-project (repo tsc-clean preservado, DT-5).

---

## Summary: OK for merge

✅ **0 BLQ, 0 MENOR**

El fix es sound, completo y testeado. Cero riesgo de regresión (cast-presence), cero riesgo de precisión (round-trip), cero riesgo de cambio inadvertido (byte-idéntico < 2^53). AR inicial cazó type-safety correctamente; fix-pack resolvió trivially. CR verifica: tsc 0, build 0, suite 2994 passed, biome 0. Listo para merge a `main`.

**Próximo paso:** Orquestador mergea a main + deploy. AC-7 (E2E on-chain two-hop con firma real) se valida post-activación WKH-191 (depende también de WKH-192/194/195 + flag `ESCROW_SETTLE_ENABLED=true` en Railway).
