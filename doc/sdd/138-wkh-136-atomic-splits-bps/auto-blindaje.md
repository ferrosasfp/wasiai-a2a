# Auto-Blindaje — WKH-136 (splits atómicos bps)

Registro de errores/tensiones detectados y resueltos durante F3, para blindar HUs futuras.

### [2026-07-03] Wave 2 — Tensión "todos los legs en a2a_fee_splits" vs test out-of-scope

- **Error**: El diseño literal del SDD sugería rutear TODOS los legs (incl.
  plataforma) por `a2a_fee_splits` con idempotencia de dos claves
  (`.eq('orchestration_id').eq('recipient_role')`). Eso ROMPE
  `fee-charge.test.ts` (fuera del Scope IN, CD-P7 prohíbe editarlo): su mock de
  supabase sólo soporta un `.eq()` por cadena (`select→eq→maybeSingle`). Un
  segundo `.eq` deja el mock en `undefined → TypeError`.
- **Causa raíz**: `fee-charge.test.ts` no está en la tabla de 8 archivos (no se
  puede tocar) y T-REGR exige que quede verde SIN cambios. El leg de plataforma
  DEBE conservar el flujo `a2a_protocol_fees` de una sola clave para ser
  byte-idéntico.
- **Fix**: **Diseño híbrido** (avalado por la redacción de CD-2: "PROHIBIDO
  reusar la PK de `a2a_protocol_fees` para >1 recipient" ⇒ esa tabla SIGUE siendo
  el registro del leg de plataforma). El leg de plataforma se cobra por el flujo
  `a2a_protocol_fees` existente (byte-idéntico); los legs adicionales
  (creador/referral) + filas `skipped` van por el engine `settleFeeSplits` sobre
  `a2a_fee_splits` (idempotencia por recipient). Con default `10000/0/0` no hay
  extras ni skipped ⇒ `settleFeeSplits` NO se invoca ⇒ cero writes a
  `a2a_fee_splits` ⇒ byte-idéntico verificado (`fee-charge.test.ts` 20/20 verde,
  suite money-path 40/40 verde).
- **Aplicar en**: cualquier HU que "generalice" un money-path con un test de
  no-regresión FUERA de scope. Verificá el shape del MOCK del test intocable
  ANTES de elegir el shape de las queries nuevas; el test out-of-scope es un
  contrato duro.

### [2026-07-03] Wave 1 — Firma de `chargeProtocolFee` no transporta el agente primario (CD-P1)

- **Error**: `resolveRecipients` necesita el agente primario (step[0]) para
  resolver creador/referral, pero la firma pública de `chargeProtocolFee`
  (`{orchestrationId, feeBaseUsdc, feeRate}`) NO lo trae y NO se puede ampliar
  (CD-P1).
- **Causa raíz**: v1 mantiene la firma intacta (los dos call-sites no se tocan).
- **Fix**: Seguí la Escalation Rule del Story File (ya ratificada): en v1
  creador/referral se resuelven a ausente ⇒ su bps se re-ruta a plataforma (fila
  `skipped`, SG-6). El engine (`settleFeeSplits`/`resolveRecipients`/
  `reverseFeeSplits`) es seam-compatible y queda EXPUESTO + testeado (T-SPLIT,
  T-PARTIAL, T-REV, etc. lo ejercitan con contexto server-side), listo para el
  wiring futuro. NO se amplió la firma.
- **Aplicar en**: cuando la resolución server-side requiera datos que la firma no
  transporta, resolvé a `null` → fallback documentado, NO amplíes la firma
  pública sin ratificación.

### [2026-07-03] Wave 3 — `noThenProperty` en mock thenable de supabase

- **Error**: `biome check` marcó `lint/suspicious/noThenProperty` en el mock del
  query-builder de supabase (objeto con `.then` para ser awaitable en el path de
  `reverseFeeSplits`, que awaitea la cadena sin `.maybeSingle()`).
- **Causa raíz**: un objeto con propiedad `then` es un antipatrón real, pero acá
  es intencional (imitar un builder awaitable).
- **Fix**: `// biome-ignore lint/suspicious/noThenProperty: intentional thenable`
  puntual en cada asignación. Cero supresiones amplias.
- **Aplicar en**: mocks de clientes DB/HTTP awaitables → suprimí puntual, nunca
  a nivel archivo.

### [2026-07-03] Wave 0/2 — `exactOptionalPropertyTypes` en objetos con opcionales (CD-8)

- **Error potencial**: construir `SplitLeg`/`FeeChargeResult.splits` con
  `x: cond ? v : undefined` rompe `exactOptionalPropertyTypes:true`.
- **Fix**: asignación condicional (`if (v !== undefined) obj.x = v`) en TODOS los
  builders (`chargeLeg`, `buildSplits`, `reverseFeeSplits`, agregado de
  `settleFeeSplits`). `tsc --noEmit` verde.
- **Aplicar en**: WKH-133/134/136 recurrente — nunca `?:` con `undefined` en
  objetos tipados con opcionales.
