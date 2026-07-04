# Auto-Blindaje — WKH-136 (splits atómicos bps)

Registro de errores/tensiones detectados y resueltos durante F3, para blindar HUs futuras.

### [2026-07-04] FIX-PACK — BLQ-MED-1: `SplitConfigError` tumbaba `/orchestrate/execute` ya cobrado (money-path)

- **Error**: `getSplitConfig()` (`split-config.ts`) lanzaba `SplitConfigError` en
  config inválida (Σ≠10000 / bps fuera de rango), y esa llamada corría FUERA del
  try/catch de CD-B en `chargeProtocolFee` (`fee-charge.ts`, antes de la línea
  198). `/compose` envuelve la llamada en try/catch (`compose.ts:611`) → responde
  200 con `feeChargeError`; pero `/orchestrate/execute` (`orchestrate.ts:1065`) NO
  tiene try/catch → el throw propagaba a `routes/orchestrate.ts:451-461` y el
  caller recibía un ERROR en vez de su resultado ya pagado (el pipeline ya había
  tenido éxito y el caller ya estaba debitado). Asimetría entre call-sites +
  violación del invariante "un fallo del fee NUNCA rompe la respuesta 200"
  (`orchestrate.ts:1061-1063`).
- **Causa raíz**: se replicó el patrón de `ProtocolFeeError` (throw fuera del
  try/catch, "espejo") sin notar que el ÚNICO call-site que lo blindaba era
  `/compose` (que envuelve en try/catch). `/orchestrate/execute` nunca envolvió la
  llamada porque confiaba en el contrato CD-B ("`chargeProtocolFee` JAMÁS rechaza
  la promise") — contrato que el throw pre-transfer rompía.
- **Fix**: capturar `SplitConfigError` DENTRO de `chargeProtocolFee`
  (`fee-charge.ts`, `let splitConfig: SplitConfig; try { getSplitConfig() } catch`)
  y devolverla como el shape CD-B `{status:'failed', feeUsdc, error}` — igual que
  todo otro fallo de fee. Ambos call-sites ahora se comportan igual: fee NO
  cobrado (fail-CLOSED intacto: cero sign/settle, cero cobro parcial), pero la
  orquestación exitosa se responde 200. Solo cambió el MECANISMO de propagación
  (return failed en vez de throw), NO la semántica de seguridad. NO se tocó la
  firma (CD-P1) ni `orchestrate.ts`/`compose.ts`. Test T-SUM actualizado:
  `.rejects.toBeInstanceOf(SplitConfigError)` → `result.status === 'failed'` +
  cero sign/settle (simétrico con /compose).
- **Aplicar en**: cualquier helper best-effort con contrato "nunca rechaza"
  (CD-B) que tenga MÚLTIPLES call-sites. Un `throw` pre-guarda (validación antes
  del try/catch interno) rompe el contrato SOLO en los call-sites que no lo
  envuelven. Regla: si el contrato dice "nunca rechaza", TODA ruta de salida
  (incl. validaciones tempranas) debe devolver el shape de error, no throw —
  salvo el 1 caso deliberadamente reservado a HTTP 400 (`ProtocolFeeError`,
  feeUsdc>budget) que AMBOS call-sites ya blindan explícitamente.

### [2026-07-04] FIX-PACK — Notas seam documentadas (MNR-2, MNR-3, inalcanzables en v1)

- **MNR-2** (`fee-split.test.ts` T-REV): `reverseFeeSplits` revierte SOLO los
  legs de `a2a_fee_splits` (creator/referral). El leg de PLATAFORMA vive en
  `a2a_protocol_fees` (PK orchestration_id) y su reverse es responsabilidad del
  path de reversal de esa tabla (WKH-129), NO de `reverseFeeSplits`. AC-4 completo
  = `reverseFeeSplits` (splits) + reversal de `a2a_protocol_fees` (plataforma).
  El comentario del T-REV se ajustó: las `rows` incluyen una fila 'platform' SOLO
  para probar que el iterador CD-4 revierte TODAS las filas que recibe (no se
  corta en la primera), NO porque en prod la plataforma se persista en
  `a2a_fee_splits`.
- **MNR-3** (`fee-charge.ts`): `extrasFailed` hoy SOLO se evalúa en el path de
  éxito post-settle. Los returns TEMPRANOS (`already-charged` charged/in-progress
  + 23505 unique_violation) NO lo consultan. Inalcanzable en v1 (default sin
  extras; creator/referral se re-rutan a plataforma → skipped, no falla el leg).
  Al cablear el seam (recipients reales que SÍ pueden fallar), esos returns
  tempranos DEBEN también degradar a 'failed' cuando `extrasFailed`. Nota TODO
  dejada en el código junto al cómputo de `extrasFailed`.

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
