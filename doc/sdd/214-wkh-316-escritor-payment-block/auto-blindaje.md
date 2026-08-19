# Auto-Blindaje — #214 · WKH-316 · El escritor del bloque `payment`

> Errores cometidos y corregidos DURANTE la implementación (F3). Cada entrada se escribió
> al momento de corregir, no al final.

---

### [2026-08-19 00:07] Wave 0 — Mi edición de `src/services/agent.ts` puso en falso 5 citas de un guardián, y el Story File decía que ese archivo no se toca

- **Error**: agregué 8 líneas a `src/services/agent.ts` (1 de import + 7 del campo
  `PublishedAgentRecord.payment`). `npm test` pasó de 5624 passed a **2 failed**:
  `test/ownership-filter-guard.test.ts` G-08 y G-09. Ninguna cadena `supabase.from(...)`
  nueva — las 5 existentes se **corrieron de línea**.
- **Causa raíz**: `test/ownership-filter-guard.exceptions.ts` fija cada excepción por
  `{ file, line }`. Cualquier edición que desplace líneas en un archivo con excepciones la
  invalida, aunque el diff no toque una sola query. El Story File dice
  *"`test/ownership-filter-guard.exceptions.ts` **no se toca** (esta HU no agrega ni una
  cadena `supabase.from(...)` nueva)"*: la premisa es cierta y la conclusión no se sigue.
  El guardián no vigila que no agregues cadenas, vigila que las citas apunten.
- **Fix**: re-apunté **sólo** las 5 entradas de `src/services/agent.ts` (`318→326`,
  `343→351`, `454→462`, `494→502`, `527→535`, todas `+8`) y, en esas mismas 5 entradas,
  las citas de PROSA que apuntan a `src/services/agent.ts` y que mi diff también desplazó
  (`:330-335→:338-343`, `:450→:458`, `:580→:588`, `:701→:709`, `:407→:415`). Cada destino
  nuevo se re-abrió con `sed -n` antes de escribirlo. Cero entradas nuevas, cero motivos
  cambiados, cero entradas de otros archivos tocadas.
- **Aplicar en**: **toda wave que edite `src/services/agent.ts`** (W3B lo vuelve a hacer) y
  cualquier HU futura que edite `src/services/{agent,identity,arbiter,…}.ts`. Regla
  operativa: si tu diff cambia el número de líneas de un archivo que aparece en
  `test/ownership-filter-guard.exceptions.ts`, el desplazamiento es parte de tu diff, no un
  daño colateral. Es CD-A1 en su forma más barata de pasar por alto: la cita no la
  **escribiste** vos, la **moviste** vos.
