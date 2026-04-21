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
