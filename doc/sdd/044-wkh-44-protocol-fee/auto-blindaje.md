# Auto-Blindaje — WKH-44 · Protocol Fee Real Charge

Registro de errores cometidos durante F3 y sus fixes, para proteger HUs futuras.

---

## [2026-04-21 01:58] Wave 1 — Supabase CLI no instalado en la máquina dev

- **Error**: intento de `supabase db push` para aplicar la nueva migration falla
  con `command not found`. `psql` tampoco está disponible.
- **Causa raíz**: el entorno de dev local no tiene Supabase CLI global ni
  cliente Postgres instalados. El proyecto está linkeado (ver
  `supabase/.temp/linked-project.json`: ref `bdwvrwzvsldephfibmuu`) pero el
  binario no está en PATH.
- **Fix**: la Story File (Paso 1.5) explícitamente autoriza "Si no tenés
  Supabase CLI autenticado, documentalo y sigue con la implementación — el F4
  QA verificará la aplicación". Migration queda en
  `supabase/migrations/20260421015829_a2a_protocol_fees.sql` y se aplicará
  en F4 o DONE. Los tests mockean `supabase.from(...)`, por lo que no
  dependen de la tabla real.
- **Aplicar en**: cualquier HU futura que requiera una migration — no
  bloquear el dev loop por falta de tooling local; documentar y delegar la
  aplicación real a QA/DONE.

---

## [2026-04-21 02:04] Wave 2 — Mismatch entre mock chain y chain real de supabase

- **Error**: FT-12 falla con `Cannot destructure property 'paymentRequest'
  of 'signResult' as it is undefined` en lugar de retornar `already-charged`.
- **Causa raíz**: el test helper `stubInsert` estaba encadenando
  `.select().maybeSingle()` después del `.insert()`, pero la implementación
  real de `chargeProtocolFee` usa `await supabase.from(...).insert({...})`
  directamente (el builder de Supabase retorna la promise desde el insert).
  Cuando `.select` no se llama, el mockFrom de `insert` nunca dispara; el
  siguiente `from()` (supuestamente UPDATE) recibe el chain de `.select` y el
  flujo se rompe más abajo (signResult undefined porque sign no se llama a
  tiempo).
- **Fix**: alinear el stub con la cadena real — `stubInsert` ahora retorna
  `{ insert: () => Promise<{error}> }`. Regla general: **el mock del chain
  de Supabase debe replicar EXACTAMENTE la cadena del impl, no una más
  larga, no una más corta**.
- **Aplicar en**: cualquier test que mockee Supabase con chain builders.
  Regla: leer el impl antes de escribir el stub; si el impl hace `.insert().select().single()`,
  el stub debe hacer lo mismo. Si el impl hace `.insert()` a secas, el stub
  también.

---
