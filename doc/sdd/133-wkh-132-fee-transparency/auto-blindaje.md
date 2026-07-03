# Auto-Blindaje — WKH-132 (fee transparency)

### [2026-07-03 13:38] F3 — Biome format en `it.each(...)` multilínea
- **Error**: el bloque de test parametrizado (`it.each([...] as const)(...)` para AC-2)
  quedó con un salto de línea entre el `)` del array y los argumentos, que Biome
  colapsa a una sola línea; `biome check` marcó 2 errores de formato.
- **Causa raíz**: escribí el `it.each` con el estilo de indentación de un `it`
  normal, sin correr el formatter antes de dar por cerrado el archivo.
- **Fix**: `biome check --write` sobre los 2 archivos tocados; re-corrida de
  tests (23 PASS) para confirmar que el reformat no cambió semántica.
- **Aplicar en**: cualquier test nuevo — correr `./node_modules/.bin/biome check`
  sobre los archivos tocados antes del commit (el `npm test`/`tsc` no cubre formato).

### [2026-07-03] FIX-PACK AR — protocolFeeUsdc del quote reportaba el RESIDUAL del techo (BLQ-MED-1)
- **Error**: en `POST /orchestrate/plan` el `protocolFeeUsdc` reportado era el residual
  del techo (`maxQuotedCostUsdc − totalCostUsdc`). En steps con price 0/no-resoluble el
  techo suma `PLACEHOLDER_FEE_USD` (~$1) → el residual se inflaba (~1.01) y NO reconciliaba
  con `feeRatePercent` (la garantía `protocolFeeUsdc ≈ total × rate` fallaba justo en el
  caso placeholder). El test de consistencia CD-3 usaba un fixture cocinado (mock del
  service) y no ejercitaba el cálculo real, así que no lo detectaba.
- **Causa raíz**: se reusó el residual `maxQuoted − total` como si fuera el fee, mezclando
  dos conceptos: el TECHO de seguridad del /execute (con headroom por placeholder) vs el
  fee real cost-based. El invariante asumido era `maxQuoted == total + fee`, falso cuando
  hay steps sin precio.
- **Fix** (opción A): el `protocolFeeUsdc` reportado pasa a ser el fee REAL cost-based =
  `round(totalCostUsdc × getProtocolFeeRate())`, reconcilia con `feeRatePercent` por
  construcción. Derivado a nivel respuesta en `routes/orchestrate.ts` (espejo de
  `feeRatePercent`) y también en el service (`services/orchestrate.ts`), que ahora unifica
  `protocolFeeUsdc == feeUsdc` (reserva cost-based). `maxQuotedCostUsdc` queda intacto como
  el techo. Nuevo invariante documentado: `maxQuotedCostUsdc ≥ totalCostUsdc + protocolFeeUsdc`.
  Análisis confirmó que el residual NO se cobra: `executeApprovedPlan` usa `plan.feeUsdc`
  para la reserva de `maxBudget` y `pipeline.totalCostUsdc × rate` para el charge real
  (`chargeProtocolFee`); `plan.protocolFeeUsdc` sólo se serializaba en la respuesta del /plan.
  Money-path (`/orchestrate/execute`, cap, tasa, clamp) SIN tocar.
- **Test real (MNR-1)**: se agregó `MNR-1` en `services/orchestrate.test.ts` (pipeline mixto
  real+placeholder, cálculo real sin mock del service) y se reescribió el CD-3 de
  `routes/orchestrate.test.ts` para que el mock devuelva un `protocolFeeUsdc` inconsistente
  (residual) y se asserte que la ruta lo IGNORA y deriva cost-based. Se corrigió el par
  incoherente del `readyPlan()` default (0.05 → 0.005). AC-1/AC-2/AC-9/BLQ-BAJO-1/T-PLAN-1
  actualizados al invariante `≥` y al fee cost-based.
- **Aplicar en**: cualquier valor "reportado" derivado de un cap/techo — no confundir el
  techo de seguridad (puede incluir headroom) con la magnitud económica real. Si un test de
  consistencia mockea el service que produce el valor bajo prueba, no está ejercitando el
  cálculo real: mockear las dependencias (discovery/getAgent/LLM) y correr el service de verdad.
