# Auto-Blindaje — HU-203 (compose: refund vs evidencia de broadcast)

### [2026-07-28 15:38] Wave 3 — `git checkout --` borró mi propio trabajo sin commitear

- **Error**: para restaurar `src/services/compose.ts` después de la primera mutación
  corrí `git checkout -- src/services/compose.ts`. Eso revierte al **HEAD**, no al
  estado de trabajo: se llevó puestas las ~160 líneas del fix, que todavía no estaban
  commiteadas. El `sha256sum -c` lo cazó en el acto (`FAILED`), y no la inspección
  visual — el archivo seguía compilando y la suite general seguía verde, porque lo que
  desapareció fue el fix, no la sintaxis.
- **Causa raíz**: confundí "revertir la mutación" con "revertir el archivo". La
  mutación era un delta sobre trabajo NO COMMITEADO, y git no tiene ese punto
  intermedio: su única referencia es el último commit.
- **Fix**: se reaplicaron los 9 edits desde el contexto y se verificó con `sha256sum`
  que el archivo quedara **byte-idéntico** al de antes de la mutación
  (`56dda5c48541f544a03d33ae2ce0489215c699a38a6d0a09b20e55c098557202`). Para el resto
  de las mutaciones el ciclo pasó a ser:
  `cp src/... $SCRATCH/backup/` → mutar → correr → `cp $SCRATCH/backup/... src/` →
  `sha256sum -c`.
- **Aplicar en**: CUALQUIER mutation testing sobre trabajo sin commitear, en este repo
  o en otro. Antes de mutar, copia física fuera del árbol de git y hash de referencia;
  `git checkout --`, `git restore` y `git stash` NO son mecanismos de undo para
  cambios no commiteados. El hash no es opcional: es lo único que distingue "restauré"
  de "creo que restauré".
