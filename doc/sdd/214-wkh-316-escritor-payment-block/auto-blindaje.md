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

---

### [2026-08-19 00:12] Wave 1 — Un `git add -A` se llevó el archivo que OTRO agente estaba escribiendo

- **Error**: cerré W0 con `git add -A && git commit`. El commit se llevó
  `doc/sdd/212-wkh-314-x402-inbound-solana/story-file.md`, **843 líneas que no son mías**, que el
  arquitecto de WKH-314 estaba escribiendo en el mismo árbol en ese momento. Lo detectó el
  orquestador, no yo.
- **Causa raíz**: dos causas encadenadas. (a) `git add -A` agrega por AUSENCIA de regla, no por
  Scope IN: cualquier archivo que aparezca entre que mirás `git status` y que commiteás entra solo.
  (b) Yo había mirado `git status` al abrir la wave (00:04) y commiteé a las 00:08 — el archivo
  **no existía** en mi lectura y sí en el commit. El `git status` que respalda un `git add -A` está
  vencido en el instante en que lo leés si hay pipelines en paralelo sobre el mismo working tree, y
  en este repo los hay.
- **Fix**: `git rm --cached` de ese único path + `git commit --amend`. Verificado que el archivo
  volvió a `??` (untracked) y que su contenido en disco quedó **byte-idéntico**: `md5sum` antes y
  después = `7904ef74a1c46d7880e0ca5d38e3eed4`. El delta de 6 líneas del otro agente sigue en disco,
  sin commitear, como estaba.
- **Aplicar en**: **todo commit de este repo**. `git add -A` / `git add .` / `git commit -a` quedan
  prohibidos acá: se agrega **por ruta explícita**, y sólo rutas del Scope IN. Y antes de commitear,
  `git diff --cached --name-only` para leer lo que REALMENTE va — no el `git status` de hace cuatro
  minutos.

---

### [2026-08-19 00:14] Wave 1 — Escribí "no cubre `test/`" del lint y biome sí cubre los `*.test.ts` de `src/`

- **Error**: el Story File dice que `npm run lint` es `biome check src/` y **"no cubre `test/`"**. Lo
  leí como "no cubre archivos de test" y cerré W1.1 sin formatear
  `src/lib/operator-address.test.ts`. `npm run lint` dio **exit 1** por formato.
- **Causa raíz**: la frase es cierta sobre el DIRECTORIO `test/` de la raíz, y falsa sobre los
  `*.test.ts` que viven dentro de `src/` — que son la mayoría de los que toca esta HU (3 de los 4
  archivos de test del Scope IN están en `src/`). Confié en la glosa en vez de en el glob.
- **Fix**: `./node_modules/.bin/biome check --write` sobre los archivos nuevos. Ojo con el
  instrumento: `npx biome` **no resuelve el binario en este repo** (`npm error could not determine
  executable to run`) y el hook además mezcló su salida con la del comando anterior; hay que invocar
  `./node_modules/.bin/biome`.
- **Aplicar en**: W2, W3A y W3B, que crean o editan `src/**/*.test.ts`. Regla operativa: el alcance
  del linter se decide con el glob del script (`src/`), no con la prosa que lo describe.

---

### [2026-08-19 00:13] Wave 1 — `git checkout --` NO restaura un archivo untracked, y el mutante se quedó adentro

- **Error**: cerré el mutante M1 sobre `src/lib/operator-address.ts` con
  `git checkout -- src/lib/operator-address.ts`. El archivo **quedó mutado**: el módulo es NUEVO de
  esta wave y todavía no estaba commiteado, así que para git es **untracked** y no hay nada que
  restaurar. Git lo dijo (`error: pathspec … did not match any file(s) known to git`) pero eso no
  aparece hasta que lo buscás.
- **Causa raíz**: usé como instrumento de restauración uno que sólo funciona sobre archivos que YA
  están en el índice, en la única wave donde por definición no lo están. El daño real no es el
  mutante: es que **el mutante siguiente se hubiera corrido encima de un árbol ya sucio**, y todo
  KILLED posterior habría sido un falso positivo (habría matado a la mezcla de los dos, no al que yo
  declaraba).
- **Fix**: lo cazó el control, no yo. La restauración se verifica por **`md5sum` contra el hash
  medido ANTES de mutar**, y dio `5f322d91…` contra `9d90b4d6…` esperado. Restauré por texto y
  re-verifiqué el md5. Después escribí un harness que hace backup a disco (`scratchpad/mutate.py`),
  aborta si el sitio no aparece exactamente 1 vez, imprime el **texto resultante** de la línea
  mutada, y restaura del backup — funciona igual para tracked y untracked. Los 4 mutantes siguientes
  (M2..M5) volvieron todos a `9d90b4d678a3b90cdb834756b36ec053`.
- **Aplicar en**: W2 (`payment-spec-writer.ts` también nace en su wave) y toda HU que mida mutación
  sobre archivos nuevos. Regla operativa: **la restauración no se declara, se mide** — md5 antes,
  md5 después, y `git status` para el caso simétrico (un archivo tracked que quedó modificado). Un
  "restauré" sin hash es exactamente el mismo error que un "verde" sin correr la suite.
