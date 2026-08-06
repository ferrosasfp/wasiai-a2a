# Auto-Blindaje — WKH-SEC-03

Errores cometidos **durante la implementación** y corregidos antes de commitear. No es la lista
de hallazgos del AR ni del CR (esos viven en `adversarial-review.md` y `code-review.md`): es lo
que se me escapó a mí mientras arreglaba.

---

### [2026-08-06 01:50] Fix-pack del CR — Pegué en el log un `archivo:línea` que no había leído

- **Error**: al escribir el paso 3 de M-G9 en `mutation-log.md`, puse
  `× G-08 ... src/services/spend-policy.ts:233 · a2a_key_spend_policies · select` como salida de
  una corrida cuyo `tail` sólo me había mostrado el rojo de G-09. El `233` lo deduje de dónde
  había quedado la cadena sintética; la línea real es **`230`**.
- **Causa raíz**: filtré la salida (`tail -8`) por comodidad y después escribí de memoria lo que
  "tenía que haber salido". Es exactamente el modo de falla que esta HU documenta en los tests:
  afirmar el resultado esperado en vez de pegar el observado.
- **Fix**: volví a montar el escenario, capturé la salida con
  `grep -E "a2a_key_spend_policies · |expected 42|Tests "` y separé en el log lo que quedó
  capturado en la corrida original (G-09) de lo que sí tengo completo (el mismo control
  re-corrido después del fix, con `src/services/spend-policy.ts:230`).
- **Aplicar en**: cualquier fila de `mutation-log.md`. Regla operativa: si el `archivo:línea` no
  está en una salida que se pegó, no se escribe — o se escribe diciendo de qué corrida salió.

### [2026-08-06 01:59] Fix-pack del CR — Mis propias ediciones corrieron una línea que yo citaba

- **Error**: el docblock nuevo del guardián citaba `mutation-log.md:212` para «los 12 sitios de
  SEC-04, sin mutar». Después agregué una nota de 4 líneas más arriba en ese mismo archivo, y la
  cita quedó apuntando a otra línea (la real pasó a ser `:216`).
- **Causa raíz**: escribí la cita antes de terminar de editar el archivo citado, y no la re-verifiqué.
- **Fix**: `grep -n` de la frase citada al final del fix-pack, y corrección de la cita. También
  verifiqué que `mutation-log.md:70-87` (§1) no se hubiera movido: mis ediciones fueron todas
  posteriores a esa sección.
- **Aplicar en**: toda cita `archivo:línea` a un archivo que la misma tarea modifica — hay que
  re-verificarla al cierre, no al escribirla. Vale para `sdd.md:146-147`, `sdd.md:494-497` y las
  citas a `spend-policy.ts` / `routes/auth/spend-policy.ts` de este PR, todas re-verificadas.

### [2026-08-06 01:52] Fix-pack del CR — Casi copio el conteo del CR sin medirlo

- **Error**: el CR declara «125 líneas a 6 espacios, 62 cabeceras, 63 `};`». Iba a usar esos tres
  números como base de G-13.
- **Causa raíz**: el número venía de un revisor confiable y cerraba (62 + 63 = 125).
- **Fix**: lo medí con un probe propio antes de escribir el control. Da **62 cabeceras, 62 cierres
  `};` y 1 apertura de comentario** (`database.types.ts:1054`) = los mismos 125. La clasificación
  del CR y la mía difieren en esa línea; el total coincide, y G-13 necesita las **tres** cajas
  —no dos— para no ponerse rojo por el comentario. Copiar el 63 habría dado un control roto.
- **Aplicar en**: cualquier número que venga de un artefacto de revisión. Si un control se va a
  apoyar en él, se re-mide con instrumento propio; que el total cierre no valida la partición.
