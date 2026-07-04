# Auto-Blindaje — WKH-139 v2 (Agente-Árbitro Autónomo)

Registro de errores cometidos y corregidos durante F3 (implementación). Cada
entrada protege futuras HUs del mismo error.

### [2026-07-04 W2] Recovery lanzaba INTENT_NOT_OPEN sobre intent terminal
- **Error**: `recoverArbClosing` invocaba `mapArbPgError` sin distinguir el caso
  benigno: cuando el intent ya es terminal (settled/refunded/failed), el RPC
  `close_payment_intent_for_arbitration` lanza `INTENT_NOT_OPEN`, y la recovery lo
  propagaba como error en vez de tratarlo como no-op.
- **Causa raíz**: un barrido/retry de recovery puede correr sobre un intent que YA
  fue resuelto (por otro retry o por el path directo). En el money-path un
  "ya-resuelto" es éxito, no error.
- **Fix**: en `recoverArbClosing`, si `error.message` incluye `INTENT_NOT_OPEN`,
  `return` (no-op). Cualquier otro error sí escala vía `mapArbPgError`.
- **Aplicar en**: cualquier función de recovery/sweep idempotente que reuse un RPC
  con status-gate — la ausencia del estado esperado NO es error, es idempotencia.

### [2026-07-04 W4] Expectativa incorrecta: settled+finalize-blip NO lanza INTERNAL
- **Error**: un test asumía que un settle on-chain exitoso seguido de un finalize
  fallido (blip DB) debía lanzar `INTERNAL`.
- **Causa raíz**: mala lectura del exemplar `closeSession`. La rama `settled` NO
  chequea el retorno de `finalizePaymentIntent` (el dinero ya se movió on-chain →
  se reporta `settled`; el residual se acredita después por recovery). SÓLO las
  ramas de fallo (`unequivocal`/`ambiguous`) lanzan INTERNAL si finalize falla,
  para que el retry re-aplique el veredicto persistido.
- **Fix**: alinear `executeArbitration` y el test con la semántica real:
  settled+blip → `executed` (huérfano `arb_closing` recuperable), recovery acredita
  el residual exactamente una vez.
- **Aplicar en**: replicar money-path desde un exemplar exige copiar la asimetría
  éxito/fallo de la verificación de finalize, no uniformarla.

### [2026-07-04 W1] Imports redundantes en evidence.ts (CD-16)
- **Error**: importé `ArbiterError` como type y como valor por separado + un
  re-export "por si acaso" que nadie consumía.
- **Causa raíz**: armar imports antes de saber el uso final.
- **Fix**: `import { ArbiterError, type DisputeEvidence } from '...'` y borrar el
  re-export; biome `check` valida cero imports sin usar.
- **Aplicar en**: correr `biome check` sobre cada archivo nuevo ANTES de cerrar la
  wave (CD-16), no al final.

### [2026-07-04 W4] `then` property en el test double del builder supabase
- **Error**: el builder in-memory de `supabase.from().update().eq()...` usaba un
  método `then` para ser awaitable → biome `lint/suspicious/noThenProperty`.
- **Causa raíz**: un thenable manual dispara la regla anti-`then` de biome.
- **Fix**: `// biome-ignore lint/suspicious/noThenProperty: awaitable supabase
  builder test double` (idéntico patrón al `noExplicitAny` que ya usan los test
  doubles del repo). El thenable es intencional y acotado al test.
- **Aplicar en**: test doubles awaitables de builders (supabase/postgrest) →
  suprimir la regla puntualmente, no reescribir la cadena.

### [2026-07-04 FIX-PACK] `disputed` era trampa terminal irrecuperable (BLQ-BAJO-1)
- **Error**: `openDispute` transicionaba `open→disputed` (RPC `open_dispute`) y
  RECIÉN DESPUÉS corría el testnet guard y `readEvidence`. Si algo tiraba post
  transición (intent mainnet → `CHAIN_NOT_SUPPORTED`, o `readEvidence` → `INTERNAL`),
  el intent quedaba permanentemente `disputed`: `closeSession` daba `INTENT_NOT_OPEN`,
  `expireStale` no lo barría y `open_dispute` exige `open` → settlement inhabilitado
  sin recovery.
- **Causa raíz**: efecto secundario irreversible (la transición de estado) ejecutado
  ANTES de las validaciones que pueden fallar. Orden invertido: validar → mutar.
- **Fix (3 capas)**: (1) PRIMARIO — pre-check owner+chain money-free ANTES de
  `open_dispute` (mainnet se rechaza sin transicionar); (2) ROBUSTEZ — `try/catch`
  alrededor de `resolveDispute`: si tira mientras sigue `disputed`, `revertDisputeToOpen`
  (update owner+status-guarded `status='disputed'`→`'open'`, money-free); (3) DEFENSA
  EN PROFUNDIDAD — `expireStale` barre `disputed` stale revirtiéndolos a `open`.
- **Aplicar en**: cualquier flujo money-path que transicione estado ANTES de validar
  precondiciones (chain, evidencia, cap). Regla: validá TODO lo que pueda fail-closed
  ANTES de la mutación irreversible; envolvé el resto en rollback status-gated; agregá
  un sweep como red de defensa. El rollback NUNCA mueve fondos y va gated al estado
  exacto del que revierte (no toca `arb_closing`/`arb_hold`).

### [2026-07-04 W0] Validación de migración en Postgres efímero: rollback por rows huérfanas
- **Error**: la 1ª corrida del `_down` en el Postgres efímero falló al restaurar el
  `status` CHECK porque el smoke test había dejado filas en `arb_closing`/`disputed`.
- **Causa raíz**: NO es un bug del `_down` — es correcto que no puedas revertir el
  set de estados mientras existan filas en los estados nuevos. El `_down` corre en
  una tx (`BEGIN…COMMIT`) → el fallo hizo rollback atómico (confirmado: los DROP se
  revirtieron).
- **Fix**: validar el `_down` en slate limpio (sin filas en estados de arbitraje).
  Nota operacional: en prod, revertir requiere que ningún intent esté en disputa.
- **Aplicar en**: al validar `_down` de una migración que estrecha un CHECK,
  limpiar primero las filas de los valores que se remueven (o documentar el
  precondición para prod).
