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

---

### [2026-08-19 00:44] Wave 4 — El barrido CD-A1 encontró citas rotas por MI diff en archivos que NO puedo tocar

- **Error**: el barrido de cierre (re-abrir toda cita `archivo:línea` del diff con `sed -n`) encontró
  que mi diff dejó en falso **7 citas de código VIVO** que yo nunca escribí. Mis edits cambiaron el
  largo de `src/services/agent.ts` (+~150 líneas) y `src/routes/agents.ts` (+~65), y hay módulos que
  las citan por número.
- **Causa raíz**: exactamente CD-A1 en su forma difícil. Un barrido natural mira **lo que
  escribiste**; estas citas las **desplazaste**. No aparecen en tu diff, no las toca ningún guardián
  mecánico (el de ownership sólo mira su propio campo `line`), y envejecen en silencio.
- **Qué encontré, medido contra `main` = `8242b16` y contra el árbol final**:

  ⚠️ **Dos celdas de esta tabla estaban MAL y las corrigió el fix-pack del AR** (ver la entrada
  `[2026-08-19 01:19] Fix-pack AR — BLQ-BAJO-1`). Los valores de abajo son los **corregidos y
  re-medidos por contenido**; el número que había antes está tachado al lado.

  | Archivo que cita | Cita | Ahora es | ¿Lo arreglé? |
  |---|---|---|---|
  | `src/routes/agents.ownership.test.ts:17` | `services/agent.ts:701` | `:808` | ✅ sí (Scope IN) |
  | `src/routes/agents.ownership.test.ts:18` | `services/agent.ts:715` | `:822` | ✅ sí (Scope IN) |
  | `src/routes/agents.ownership.test.ts:25` | `:184` (T-143B-06, del propio archivo) | `:211` | ✅ sí (Scope IN) |
  | `src/services/agent.ownership.test.ts:6` | `services/agent.ts:549` (el `.eq('owner_ref')` de **`listMine`**) y `:715` (el de **`delete`**) | **`:602`** (~~`:761`~~) y `:822` | ❌ **NO** — fuera de Scope IN |
  | `src/services/discovery.ts:255` | `services/agent.ts:429-440` — 🔴 **cita PREEXISTENTEMENTE FALSA**: ese ancla es el INSERT de `publish()`, no el SELECT de `listAsAgents` (ver `MNR-4`) | ancla desplazado: `:469-480` · **ancla que la prosa afirma: `:506-510`** | ❌ **NO** — **CD-6 prohíbe tocar `discovery.ts`** |
  | `src/services/orchestrate.ts:1160` | `services/agent.ts:526` (el `await supabase` de **`getBySlugAsAgent`**) | **`:579`** (~~`:599`~~) | ❌ **NO** — fuera de Scope IN |
  | `src/lib/self-published-auth.ts:29` | `routes/agents.ts:265` (`keyRow.owner_ref,` en la llamada a `publish()` del POST) | **`:338`** (~~`:330`~~ — el fix-pack de `MNR-1` agregó `+8` líneas arriba; ver la nota de abajo) | ❌ **NO** — fuera de Scope IN |

- **Hallazgo aparte, PRE-EXISTENTE (no es mío, y está medido)**: `src/types/index.ts` afirma
  *"`publish` la escribe `true` (`services/agent.ts:399`)"*, y en **`main`** la línea 399 de ese
  archivo está **VACÍA**. El ancla real (`enabled: true,`) estaba en `main:454` y ahora está en
  `:462`. O sea que esa cita ya estaba rota **antes** de esta HU, por ~55 líneas. No la corregí a
  propósito, para que el diff de WKH-316 siga siendo auditable como "lo que cambió esta HU"; va al
  reporte para que la resuelva quien corresponda.
- **Fix**: arreglé las 3 que caen dentro del Scope IN y **reporté las 4 que no**, con su valor nuevo
  ya medido, en vez de arreglarlas en silencio. Las ~100 citas restantes viven en `doc/sdd/` de HUs
  **cerradas**: son registros congelados de lo que se midió ese día y re-apuntarlas los falsearía.
- **Aplicar en**: **toda HU que cambie el largo de un archivo muy citado.** El barrido correcto no es
  "releé tus citas": es `git ls-files | grep -oE '<archivo>\.ts:[0-9]+'` sobre el repo entero, y
  después separar en tres pilas — código vivo dentro de scope (arreglar), código vivo fuera de scope
  (reportar con el número nuevo ya medido), documentos históricos (no tocar).

---

### [2026-08-19 00:45] Wave 4 — Mi propio harness de mutación dio un falso "ABORT" cuando el reemplazo CONTIENE al original

- **Error**: `mutate.py` abortó en M24 con `ABORT: el original sigue presente`, pese a que la
  mutación **sí** se había aplicado (el test se puso rojo por el motivo correcto y el `md5` de
  restauración coincidió).
- **Causa raíz**: mi control de "la sustitución ocurrió de verdad" es `assert old not in <texto
  nuevo>`, y M24 era una mutación **aditiva**: le agregué una línea ARRIBA del bloque original sin
  borrarlo, así que el original sigue presente por construcción. El control estaba escrito asumiendo
  que toda mutación reemplaza.
- **Fix**: se leyó el resultado real (test rojo + `md5` restaurado a
  `0c19614ecf91c4669bd4802cb3fcd3ad`) en vez de creerle al assert. M24 cuenta como KILLED.
- **Aplicar en**: cuando un instrumento de verificación contradice a la medición, **primero verificá
  el instrumento** — que es justamente lo que este `ABORT` obligó a hacer. El control correcto para
  una mutación aditiva no es "el original desapareció" sino "el md5 cambió y volvió".

---

# Fix-pack del AR (veredicto RECHAZADO — 1 BLQ-BAJO + 4 MENORES)

> `ar-report.md` · `nexus-adversary` · 2026-08-19. Las 5 entradas de abajo son la respuesta,
> una por hallazgo. Lo que el AR confirmó a favor de la implementación no se re-litigó ni se tocó.

### [2026-08-19 01:19] Fix-pack AR — BLQ-BAJO-1 · Reporté 4 citas desplazadas con UN delta, y el archivo tiene DOS

- **Error**: en la tabla de la entrada `[2026-08-19 00:44] Wave 4` publiqué el "valor nuevo ya
  medido" de las 4 citas que no podía arreglar. **Dos de los cuatro valores eran falsos**:
  - `src/services/agent.ownership.test.ts:6` cita el `.eq('owner_ref', ownerRef)` de **`listMine`**
    (`main:549`). Reporté **`:761`**, que es el `.eq('owner_ref', ownerRef)` **del UPDATE de
    `update()`** — otra función, otro hueco, otro test. El correcto es **`:602`**.
  - `src/services/orchestrate.ts:1160` cita el `const { data, error } = await supabase` de
    **`getBySlugAsAgent`** (`main:526`). Reporté **`:599`**, que es la MISMA línea de texto pero
    dentro de **`listMine`**. El correcto es **`:579`**.
- **Causa raíz**: apliqué un **desplazamiento uniforme**. `update()` creció ~54 líneas **en el
  medio** del archivo, así que hay **dos deltas**: lo que está entre `publish()` y `update()` se
  corrió `+53`, y lo que está debajo de `update()` se corrió `+107`. Sumar un solo delta a un ancla
  de la zona de arriba lo manda 54 líneas más abajo de donde está. Es la misma causa que yo mismo
  nombré para W0 (*"el desplazamiento es parte de tu diff"*) sin sacarle la consecuencia: **el
  desplazamiento no es un número, es una función por tramos.**
- **Por qué no lo cazó nada, y es la lección**: los dos números equivocados **contienen el mismo
  texto** que el ancla que buscaba. `.eq('owner_ref', ownerRef)` aparece **6 veces** en
  `src/services/agent.ts` (`:13` en un docblock, `:602`, `:710` y `:717` en comentarios, `:761`,
  `:822`) y `const { data, error } = await supabase` aparece **9** (`:346`, `:371`, `:472`, `:506`,
  `:546`, `:579`, `:599`, `:757`, `:818`). O sea que **cualquier verificación que abra la línea y
  compare el texto da OK**: es evidencia que se auto-confirma, y muestra exactamente lo que el
  verificador esperaba ver. Lo único que discrimina es la **función contenedora**.
- **Fix**: re-medidos los dos por contenido, y cada uno verificado con su función contenedora:

  | Ancla en `main` @ `8242b16` | Función en `main` | HEAD | Función en HEAD | Cómo se verificó |
  |---|---|---|---|---|
  | `:549` `.eq('owner_ref', ownerRef)` | `listMine` (`main:545`) | **`:602`** | `listMine` (`:598`) | `awk` de la firma de `listMine` (`:598`) hasta `:606`; la siguiente firma es `update` en `:619`, así que `:602` cae adentro |
  | `:526` `const { data, error } = await supabase` | `getBySlugAsAgent` (`main:525`) | **`:579`** | `getBySlugAsAgent` (`:578`) | ídem: firma en `:578`, siguiente firma `listMine` en `:598` |

  Las otras dos citas de la tabla se re-verificaron igual y **estaban bien**: `main:715` → `:822`
  (las dos en `delete`, `main:691` / `:798`) y `routes/agents.ts:265` → `:330` (las dos son
  `keyRow.owner_ref,` en la llamada a `publish()` del POST).
- **Aplicar en**: **todo re-apuntado de citas.** Dos reglas operativas, y la segunda es la que
  faltaba:
  1. Si tu diff inserta líneas **en el medio** de un archivo, ese archivo tiene **más de un delta**.
     Derivá uno por tramo, o mejor: no derives ninguno.
  2. **Un ancla no se localiza por su texto, se localiza por su función contenedora.** Si la cadena
     que buscás aparece más de una vez en el archivo —y en un service con N métodos, toda cadena de
     query aparece N veces— el texto no discrimina nada. El control es: `awk` desde la firma de la
     función hasta la firma siguiente, y verificar que el número cae **dentro** de ese rango.

---

### [2026-08-19 01:19] Fix-pack AR — MNR-1 · El log del 422 llevaba el `payment` crudo del caller, sin cota

- **Error**: `src/routes/agents.ts:277` (POST) y `:492` (PATCH) **—numeración PRE-fix, la del árbol
  que auditó el AR—** logueaban `{ field, code, value: body.payment }`. `body.payment` es JSON
  **elegido por el caller**, y `src/index.ts` construye Fastify **sin `bodyLimit`** (verificado:
  `grep -n bodyLimit src/index.ts` → exit 1, cero coincidencias), así que rige el default de
  **1 MiB** y cada 422 escribía hasta ~1 MiB de JSON arbitrario a los logs — en el camino del
  dinero, en un repo público. Post-fix el manejo del rechazo está en `:272-291` (POST) y `:495-507`
  (PATCH), y la línea de log en `:282-288` y `:498-504`.
- **Causa raíz**: escribí el log mirando qué me sería útil para diagnosticar, no qué hacen los
  **guards hermanos del mismo archivo**. Los 5 que ya estaban —`priceUsdc` (`:220`), `payoutWallet`
  (`:237`), `referrerRef` (`:252`), `enabled` (`:459`), `capabilities` (`:475`), los cinco re-medidos
  en el árbol POST-fix, porque este mismo fix desplazó `+8` todo lo que está debajo del guard del
  POST— loguean **sólo el
  `field`**, y ninguno el valor. Además el repo ya tiene esta clase de deuda con nombre
  (**TD-322-4**, `src/lib/discovery-query.ts:219-229`, por una línea de log que crece con el input
  del atacante), o sea que el criterio estaba escrito y yo no lo apliqué.
- **Fix**: los dos sitios pasan a `{ field, code }`, alineados con sus 5 hermanos. Los dos valores
  son literales del validador (`PaymentBlockRejection`), así que la línea queda de **longitud
  acotada**. Se fija con dos tests nuevos, `T-316-27` (POST) y `T-316-28` (PATCH), que capturan la
  línea de pino real con un stream propio.
- **Lo que los tests verifican, y por qué así**: se assertea la **AUSENCIA DE LA KEY**
  (`expect(Object.keys(line)).not.toContain('value')`), no un valor vacío. Un `value: ''` o un
  `value: '[redacted]'` pasarían un `not.toContain(marker)` y **no acotarían nada** el día que
  alguien "arregle" el problema con un `slice()`. Los dos tests además tienen **control de
  vacuidad** (`expect(rejected).toHaveLength(1)` + `field`/`code` con su valor exacto): sin él, un
  guard que no loguea nada —o un stream que no captura— haría pasar todas las aserciones.
- 🔴 **Y este fix, al arreglar `MNR-1`, rompió TRES citas más — dos de prosa y una de número.**
  Es `BLQ-BAJO-1` otra vez, en el mismo fix-pack que lo corrige, así que va acá completo:
  1. `src/routes/agents.ts:112` decía *"El valor va al `request.log.warn`, que es server-side"*.
     Era **cierto** cuando se escribió y **dejó de serlo** con este fix. Corregido — está en Scope IN
     (mismo archivo).
  2. `src/lib/payment-spec-writer.ts:93` decía lo mismo (*"El valor va al `request.log.warn` del
     route"*). Corregido — `payment-spec-writer.ts` también es del Scope IN de esta HU.
  3. `src/lib/self-published-auth.ts:29` cita `routes/agents.ts:265`. En la tabla de W4 yo había
     publicado que "ahora es `:330`"; **mi propio fix-pack lo movió a `:338`** (+8 líneas del
     comentario nuevo, arriba de ese ancla). La celda quedó actualizada al valor del **árbol final**.
  Las dos correcciones de prosa se hicieron **línea-neutras a propósito** (verificado: el diff de
  `payment-spec-writer.ts` es `2 insertions / 2 deletions` y el del docblock de `routes/agents.ts`
  también, contra el conteo de líneas de `HEAD`), justamente para **no** disparar una tercera ronda
  de citas desplazadas en dos archivos muy citados. El único desplazamiento que este fix-pack
  introduce es `+9` en `src/routes/agents.ts` (+8 en el POST, +1 en el PATCH), y está barrido:
  `grep -rn 'routes/agents\.ts:[0-9]' src/ test/ doc/INTEGRATION.md README*.md` devuelve **una sola**
  cita de código vivo, la de `self-published-auth.ts:29`, que es la del punto 3.
- **Aplicar en**: **todo `request.log.*` que reciba un valor del body.** Regla operativa: antes de
  loguear un valor del caller, mirá qué loguean los guards hermanos del mismo archivo; si sos el
  único que loguea el valor, el que está mal sos vos. Y si el valor es necesario para diagnóstico,
  la pregunta no es "¿lo logueo?" sino "**¿cuál es su cota?**" — `MAX_ECHOED_PARAM_NAME_LENGTH`
  (`discovery-query.ts`) es el patrón que ya existe acá para eso.
  Y la segunda regla, que este fix-pack aprendió sobre sí mismo: **cuando acotás una salida,
  buscá la prosa que describía la salida vieja.** Una frase que era cierta cuando se escribió
  envejece por tu edición sin aparecer en tu diff como error — aparece como contexto sin tocar.
  Si además la corrección de la prosa puede hacerse **línea-neutra**, hacela así: el desplazamiento
  que evitás es el que no vas a tener que barrer después.

---

### [2026-08-19 01:19] Fix-pack AR — MNR-2 · Desviación de contrato declarada: `POST /agents` con `payment: null` pasó de 201 a 422

- **Qué cambió**: en `main` @ `8242b16`, `payment` era una key **desconocida** del body del POST y se
  ignoraba en silencio (mismo criterio que el `slug`, `routes/agents.ts:296-298` post-fix), así que
  `{"…","payment":null}` daba **201**. En esta rama entra al validador (`body.payment !== undefined`)
  y cae en el paso 0 (`payment-spec-writer.ts:168-170`) → **422 `INVALID_PAYMENT_BLOCK`**. Lo mismo
  con `payment: {}`, `payment: "x"`, `payment: []`.
- **Es deliberado**: en un ALTA no hay nada que borrar, así que aceptar el `null` en silencio sería
  inventarle un significado a un valor que la HU usa para otra cosa. "Sin bloque" se dice **omitiendo
  la key** (AC-11). El porqué ya estaba escrito en el route (`:265-268`) y en `doc/INTEGRATION.md`
  ("Deleting the block").
- **Error, entonces, cuál fue**: no que el comportamiento sea ese, sino que **ningún AC lo cubría**
  (AC-11 sólo habla de omitir la key entera) y **no figuraba en la lista de desviaciones declaradas**.
  Es un cambio de contrato de una **API pública de escritura** que quedó documentado como nota de
  diseño en vez de como desviación. Rompe a un cliente que serialice el campo como nullable, que es
  lo que hace cualquier ORM/DTO que emite `null` para "sin valor".
- **Fix**: declarado acá, y con test: **`T-316-29`**, escrito como **PAR**, que es lo que lo hace
  no-vacío — el MISMO `null` es **422 en el POST** y **BORRADO (200) en el PATCH** (AC-8). El par
  mata la "simplificación" obvia (alinear el POST con el PATCH poniéndole
  `&& body.payment !== null`) en la dirección que importa: sin el segundo test, alguien podría en
  cambio alinear el PATCH con el POST y romper el borrado.
- **Aplicar en**: cuando un campo nuevo entre a un endpoint público de escritura, **preguntá qué
  hacía ese endpoint con ese campo ANTES**. Si antes era una key desconocida, cualquier valor que
  ahora rechaces es un cambio de contrato, y "está documentado en el INTEGRATION.md" no es lo mismo
  que "está declarado como desviación y tiene un test que lo fija".

---

### [2026-08-19 01:19] Fix-pack AR — MNR-4 · Reporté el valor nuevo de una cita que ya era FALSA, así que el valor nuevo también es falso

- **Error**: `src/services/discovery.ts:254-256` afirma
  *"`listAsAgents()` es un SELECT sin `limit` ni cursor (`services/agent.ts:429-440`)"*. Yo reporté
  que ese ancla "ahora es `:469-480`" — mecánicamente correcto (el mismo ancla, `+40`) y
  **semánticamente falso igual que antes**: `:469-480` es el **INSERT de `publish()`**, no el SELECT
  de `listAsAgents`.
- **Medido (verificado por mí en el fix-pack, no copiado del AR)**:
  - `main:429-436` = `if (input.referrerRef !== undefined)` + `.from('a2a_agents').insert(row).select().single()` → **el INSERT de `publish()`**.
  - `HEAD:469-480` = **lo mismo, desplazado**. Sigue siendo el INSERT.
  - `HEAD:506-510` = `const { data, error } = await supabase` / `.from('a2a_agents')` / `.select('*')`
    / `.eq('enabled', true)` / `.order('created_at', …)`, dentro de `listAsAgents` (firma en `:505`,
    siguiente firma `listPublisherAnchors` en `:537`). **Ése es el ancla que la prosa afirma.** El
    equivalente en `main` es `:453-457`.
- **Causa raíz**: mi barrido CD-A1 verificaba **que la cita apunte a la misma línea de antes**, no
  **que la línea diga lo que la prosa afirma**. Contra una cita que nació rota, ese control la
  propaga rota y encima le pone la apariencia de haber sido verificada. Es la misma trampa que
  `BLQ-BAJO-1` por otro lado: el instrumento confirmaba la continuidad del ancla, no su contenido.
- **Fix**: **no se edita `discovery.ts` — CD-6 lo prohíbe.** Queda registrado en la tabla de citas de
  la entrada de W4 con las dos cosas que el próximo necesita y que nadie más va a re-derivar:
  (a) el defecto es **PREEXISTENTE a esta HU**, y (b) el ancla correcto es **`:506-510`**. Quien la
  arregle tiene que corregir la **semántica**, no sólo el número.
- **Aplicar en**: todo re-apuntado de una cita de prosa. Regla operativa: **antes de re-apuntar una
  cita, verificá que la cita era CIERTA.** Un ancla desplazado se arregla con aritmética; un ancla
  equivocado se arregla leyendo la afirmación y buscando qué línea la sostiene. Si no distinguís los
  dos casos, publicás un número nuevo para una mentira vieja.

---

### [2026-08-19 01:19] Fix-pack AR — MNR-3 · DEUDA TÉCNICA `TD-316-METADATA-LWW` (diferida a propósito, no arreglada)

- **Qué es**: `update()` (`src/services/agent.ts:624` `const existing = await this.getRow(slug)` →
  `:734-754` merge → `:757-763` UPDATE) es un **read-modify-write** que reescribe el objeto
  `metadata` **completo**, sin versión, sin `updated_at` esperado y sin `WHERE metadata = <lo que
  leí>`. Dos PATCH concurrentes se pisan **a nivel de objeto `metadata`**, no de campo (last-writer-wins).
- **El interleaving concreto** (no es un riesgo teórico — son cuatro pasos, mismo dueño, mismo slug):
  1. `PATCH /agents/mi-agente {"payment": {…}}` lee `existing.metadata = {inputSchema}`.
  2. `PATCH /agents/mi-agente {"discoverable": true}` lee `existing.metadata = {inputSchema}`.
  3. (1) escribe `{inputSchema, payment}`.
  4. (2) escribe `{inputSchema, discoverable}` → **el bloque `payment` desaparece.**

  Las dos respuestas son **200**, y **el log de auditoría no delata nada**: el de (1) reporta
  correctamente el cambio que sí hizo, y (2) no loguea porque su `updates.payment` es `undefined`.
  El agente queda **sin declaración de cobro** y vuelve al riel default del gateway —que es
  exactamente lo que `doc/INTEGRATION.md` dice que pasa sin bloque— sin que nadie se entere.
- **Por qué sube de severidad con esta HU, aunque el patrón sea preexistente**: `inputSchema`,
  `outputSchema` y `discoverable` ya se mergeaban así antes de WKH-316. Lo que esta HU mete dentro
  de esa ventana es **la billetera de cobro**. La ventana no la abrí yo; lo que puse adentro, sí.
- **Por qué se DIFIERE y no se arregla acá**: el arreglo correcto es **concurrencia optimista**
  (columna de versión + reintento del read-modify-write, o `jsonb_set` server-side sobre la key
  `payment` en vez de reescribir el objeto). Las dos opciones son cambios de contrato de escritura
  de `update()` que afectan a **los 4 campos del `metadata`**, no sólo a `payment`, y la de la
  columna de versión necesita **DDL** — y esta HU es explícitamente cero-DDL/cero-migración
  (CD-14, AC-9: ninguna fila preexistente se toca). Meterlo en un fix-pack de AR sería exactamente
  el scope-creep que el fix-pack no puede tener. **Es otra HU.**
- **Qué la dispararía** (los tres, cualquiera alcanza):
  1. Que aparezca **cualquier** cliente que emita PATCH concurrentes sobre el mismo slug — un panel
     que guarde campo por campo con auto-save ya lo hace, sin proponérselo.
  2. Que el bloque `payment` empiece a gatear un cobro **real** (hoy `readPaymentSpec` tiene dos
     consumidores y ninguno está en el camino de `requirePayment`): ahí la pérdida silenciosa del
     bloque deja de ser "vuelve al default" y pasa a ser plata que cobra otro.
  3. Que se agregue un **quinto campo** al `metadata`, que multiplica los pares de PATCH que pueden
     interleavearse.
- **Mitigación mientras esté abierta — cuál es, y cuál NO es**: hoy la ventana requiere concurrencia
  del **mismo dueño** sobre el **mismo slug**, que es poco frecuente. Eso **acota la probabilidad,
  no cierra el camino**: no hay ningún guard que impida el interleaving, y no hay ninguna señal
  —ni en la respuesta HTTP ni en el log— de que ocurrió. Un `payment` que desaparece hoy se descubre
  cuando alguien cobra donde no debe, no cuando pasa.
- **Aplicar en**: toda HU que meta un dato **money-relevante** dentro de un merge en memoria
  preexistente. Regla operativa: heredar un patrón no es heredar su severidad — **la severidad la
  fija el dato que metés, no el que ya estaba**.
