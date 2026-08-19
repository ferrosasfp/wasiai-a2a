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

---

### [2026-08-19 00:21] Wave 2 — Un guardián que sólo ve el ÍNDICE DE GIT explotó una wave TARDE

- **Error**: la puerta de W1 dio verde (`287 passed | 6 skipped`). La de W2 arrancó con
  `test/readme-numbers.test.ts` en **4 failed**, y dos de los cuatro eran por el archivo que había
  agregado en **W1**, no en W2.
- **Causa raíz**: ese guardián deriva sus números de `git ls-files` (`test/readme-numbers.test.ts:83`),
  o sea del **índice de git**, no del disco — a propósito, porque un archivo sin trackear no lo ve
  nadie más y Biome respeta el `.gitignore`. Consecuencia que no es obvia: **un archivo nuevo no
  cuenta hasta que lo agregás al índice**, así que la puerta de la wave que lo crea pasa en verde y
  la que explota es la SIGUIENTE. El instrumento estaba bien; mi modelo de cuándo mide, no.
- **Fix**: `git add` de los archivos de la wave **ANTES** de correr la suite de la puerta, y recién
  ahí leer los conteos. Medido con el índice ya cargado: `294` archivos de test y `489` que linta
  Biome (base `292` / `485`; `+2` test y `+4` lint entre W1 y W2). Se actualizaron los cuatro
  números publicados, en `README.md:378` y `:383` y en `README.es.md:405` y `:410`.
- **Aplicar en**: W3A, W3B y W4, que agregan más archivos de test. Y en cualquier HU de este repo
  que cree archivos: **el orden correcto es `git add` → correr la puerta → commitear**, nunca
  `correr la puerta → git add → commitear`. Un verde medido con el índice desactualizado no dice
  nada sobre el árbol que el próximo clon va a ver.
- **Desviación de scope que esto obliga**: `README.es.md` **no está en el Scope IN** del Story File
  (sólo `README.md`, archivo #12). El guardián verifica los DOS. Se toca, y sólo para mover esos dos
  números.

---

### [2026-08-19 00:20] Wave 2 — T-316-09 no se puede escribir como está especificado, y escribirlo igual habría dado un verde falso

- **Error**: implementé T-316-09 tal como lo pide el Story File —*"`0x0000…0000` en **3 cajas
  distintas** → `ZERO_PAYMENT_PAYTO` las 3 veces"*— y el caso `0X0000…0000` dio
  `INVALID_PAYMENT_PAYTO_FORMAT`, no `ZERO_PAYMENT_PAYTO`.
- **Causa raíz**: dos hechos que el Story File no midió. (1) **La zero address no tiene un solo
  carácter con caja**: son 40 ceros, así que el conjunto de "cajas distintas" de su cuerpo tiene
  tamaño **1**. (2) Lo único con caja es el prefijo, y `isValidWallet('0X' + '0'.repeat(40))` es
  **`false`** (medido), así que ese candidato lo rechaza el **paso 4** y nunca llega al paso 5.
- **Fix**: el test se reescribió para afirmar lo que de verdad pasa —`0x000…0` →
  `ZERO_PAYMENT_PAYTO`, `0X000…0` → `INVALID_PAYMENT_PAYTO_FORMAT`— **asserteando el `error_code` en
  los dos** (CD-A4), con el porqué escrito al lado. El `toLowerCase()` de la rama EVM del paso 5 se
  **mantiene** porque lo manda el diseño y quedaría correcto si el guard de formato se aflojara,
  pero queda escrito que **no es load-bearing**: ningún input que pase el paso 4 cambia de valor al
  bajarle la caja Y además es la zero address. Donde la insensibilidad a la caja EVM sí decide algo
  es en el paso 7, y eso lo fija T-316-10.
- **Aplicar en**: cualquier test que diga "en N cajas distintas". **Antes de escribirlo, mirá si el
  valor TIENE caracteres con caja.** Si lo hubiera escrito con `expect(r.ok).toBe(false)` en vez de
  con el `error_code`, los tres casos habrían pasado y yo habría publicado que AC-5 es
  case-insensitive — que es falso, y encima el test habría muerto por la razón barata (AC-4). Es
  CD-A4 exactamente: un testigo que muere por el motivo equivocado no prueba lo que dice probar.

---

### [2026-08-19 00:33] Wave 3B — 🔴 Mi log de auditoría reportaba la billetera NUEVA como si fuera la vieja

- **Error**: escribí el log de auditoría del PATCH leyendo el bloque anterior **después** del merge:
  `prev: readStoredPaymentBlock(readMetadataObject(existing.metadata))`, puesto abajo de todo junto a
  la llamada. El test del reemplazo salió rojo con
  `prev.contract === next.contract === 'Vote111…'`.
- **Causa raíz**: `readMetadataObject` **no copia**: devuelve `raw as Record<string, unknown>`, el
  MISMO objeto. El merge de `update()` hace `meta.payment = paymentBlock` sobre ese objeto, así que
  **muta `existing.metadata` en el lugar**. Para cuando yo leía `prev`, ya era `next`.
- **Por qué importa más que un test rojo**: ese log tiene UNA razón de existir — contestar *"¿a qué
  billetera se re-apuntó, y cuándo?"* el día que un cobro aparezca donde no debe. Un `prev` que
  repite el valor nuevo **no es un log incompleto: es un log que miente**, y miente justo en la
  pregunta para la que se escribió. Y en producción no hubiera fallado nada: el objeto mutado es una
  fila recién traída de Supabase, así que no hay corrupción visible. Habría envejecido en silencio
  hasta la primera investigación.
- **Fix**: capturar `previousPaymentBlock` **antes** del bloque de merge, con el porqué escrito al
  lado en el código. Verificado por mutación (M14): devolviendo la lectura a su lugar de abajo, los
  dos tests de auditoría se ponen rojos.
- **Aplicar en**: cualquier lectura de "estado anterior" en un método que también mergea. Regla
  operativa: **si vas a loguear un `prev`, capturalo en la primera línea que tenga el dato, no donde
  te queda cómodo escribirlo**. Y antes de asumir que una función de narrowing devuelve una copia,
  leele el `return`: acá el `as` sobre el mismo objeto está a la vista.

---

### [2026-08-19 00:33] Wave 3B — El validador SSRF hace un DNS REAL, y mi suite lo descubrió con ENOTFOUND

- **Error**: los 5 tests nuevos de `publish()` murieron con
  `Invalid agentUrl: getaddrinfo ENOTFOUND mi-agente.example`, antes de llegar al insert que querían
  medir.
- **Causa raíz**: `publish()` corre `validateRegistryUrl` (defense-in-depth de SSRF), que **resuelve
  DNS de verdad**. `src/services/agent.payment.test.ts` era hasta ahora un archivo sólo de LECTURA
  (`listAsAgents`/`getBySlugAsAgent`), así que nunca había necesitado mockear `node:dns`. Al
  agregarle tests de ESCRITURA, heredó una dependencia de red que su harness no tenía.
- **Fix**: `vi.mock('node:dns', …)` con el mismo patrón que `agents.publish.test.ts:33-35`, y
  `mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])` en el `beforeEach` del
  bloque de altas.
- **Aplicar en**: cuando le agregues a un archivo de test un camino que no ejercitaba antes,
  **el harness que alcanzaba para el camino viejo no alcanza**. Lo que hay que revisar no es qué
  mockea el archivo, sino qué I/O toca el camino NUEVO. Es la cara "de adentro" de CD-A6: ahí se
  revisan los mocks de los consumidores del módulo que cambiás; acá, los del camino que estrenás.

---

### [2026-08-19 00:35] Wave 3B — Desviación declarada: `buildMetadata` recibe el `payment` por un parámetro APARTE

- **Qué dice el Story File** (§F, punto 3): *"`buildMetadata`: agregar `payment` al tipo del
  parámetro y `if (source.payment !== undefined) meta.payment = source.payment;"*.
- **Por qué no lo hice así**: con `payment` como key de `source`, la llamada que ya existe
  —`buildMetadata(input)`— tomaría **`input.payment`**, que es el objeto CRUDO del caller. O sea que
  el punto 3 del Story File construye exactamente el agujero que DT-STORY-2 declara normativo cerrar,
  y lo deja dependiendo de que nadie se equivoque en el call-site.
- **Qué hice**: `buildMetadata(source, payment?)`. Como parámetro separado, el único valor que se le
  puede pasar es el que produjo `validatePaymentBlock`. La regla deja de ser una prohibición y pasa a
  ser una imposibilidad. Es un ENDURECIMIENTO del Story File, no una relajación, y el comportamiento
  observable es idéntico.
- **Verificado por mutación (M16)**: cambiando la llamada a `buildMetadata(input, input.payment)`,
  T-316-02 se pone rojo. O sea que el test cubre el agujero **aunque** alguien revierta la firma.
- **Aplicar en**: cuando un Story File te pida una firma que permite el error que él mismo prohíbe,
  la salida no es elegir uno de los dos: es implementar el invariante en el tipo y **declarar la
  desviación**.
