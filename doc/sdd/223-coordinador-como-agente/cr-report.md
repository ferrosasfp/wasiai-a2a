# CR (calidad) — WKH-360 / 223 · el coordinador es un agente

> **Materializado por el ORQUESTADOR.** Cuerpo del agente. Corrió en worktrees detached (`/tmp/cr360` @
> `71fdaf7`, `/tmp/cr360base` @ `3823580`); `wt-360` intacto. **No leyó el reporte del AR**: si hay solape,
> el AR manda en security/integrity y éste en calidad/patrones.

## VEREDICTO: 🔴 RECHAZADO — 1 `BLQ-MED` · 3 `BLQ-BAJO` · 6 `MNR`

> *"Esta es la implementación de mayor calidad que he revisado en este repo. Los tres cortes pre-débito son
> reales y los re-medí uno por uno; la batería de 18 es re-derivable y sus números son exactos; los tres
> testigos únicos están anotados en el testigo y dicen la verdad. Ningún hallazgo toca el núcleo. Lo que
> bloquea son cuatro afirmaciones/controles que no miden lo que dicen medir."*

## §1 · Números publicados — TODOS re-derivados y exactos
Suite HEAD `286|6` / `5594|19` exit 0 ✓ · baseline `5441|19` ✓ · **+153 = 5594−5441** ✓ · `tsc` 0 ✓ ·
`biome` 0 (485) ✓ · ownership guard **13/13** ✓ · leaf `grep -c "^import"` = **0** ✓ · README: 183 envs /
292 archivos / 485 lintables, **los tres derivados, no incrementados** ✓ · CD-20 (W3): "66 archivos" ⇒
**66 exactos** ✓. Y `self-published-auth.ts:82` sigue diciendo "sin punto final" ⇒ **NC-6 confirmado, no
arreglado (correcto)**.

## §2 · Waves — muestreó 3 y re-corrió sus criterios
W1 ✅ exacto · W2 ✅ exacto · **W0 ❌** → BLQ-BAJO-1.

## §3 · La batería de 18 — **re-derivable**, y re-midió 8
Los 3 de orden de débito, los 2 de calibración y los 3 de testigo único: **los 8 exactos en número Y en
testigos**. **Cero errores de atribución** (el defecto de la HU hermana de chaski no se repite). Verificó el
**motivo** de cada muerte leyendo el texto: MUT-01/02/03 mueren por `expected "vi.fn()" to not be called` /
conteo, **no por status**.

**El punto fino, con evidencia independiente**: escribió `MUT-02b` (misma detección, rechazo movido después
del débito) y midió que `T-FLAG-1` —el único que asserta el 400 **antes** que el débito— **pasa la aserción
de status y muere en la del débito**. Confirmado: el 400 sale igual y un test de status habría sobrevivido.
**Los otros cortes miran el efecto**, no el status (`T-L1-2` cuenta débitos y URLs; `T-L1-7` asserta fetch no
llamado + nivel `error`).

Los tres testigos únicos: la anotación existe **en el testigo**, con sha, y **es verdadera**. `T-PROP-3`
incluso documenta que su primera versión **no mataba** a MUT-15.

---

## 🔴 BLQ-MED-1 · "sin ninguna configuración el bucle directo queda cubierto" es falso para 3 de 4 sitios, y está en 4 lugares operativos
`contracting-chain.ts:313-315` y `:336-345` (**el texto del warn de arranque**) · `index.ts:100-101` y
`:225-227` · el bloque `A2A_SELF_HOSTS` de `.env.example`.

El `hint` entra en **2 call-sites** y sólo uno es de Capa 1. `isSelfDestination` con conjunto vacío
`return false` (`:678`), y en `/orchestrate` el `if (selfHosts.length > 0)` salta el guard entero.

**Reproducción ejecutable** (probe con el harness del repo, que ya borra las dos envs en su `beforeEach`):
```
steps: [ {a → https://a.example/run}, {self → https://gw.wasiai.example/compose} ]
sin A2A_SELF_HOSTS ni BASE_URL
⇒ debit llamado 1 vez · balance < 100 · fetchedUrls() CONTIENE 'https://gw.wasiai.example/compose'
  · errorCode === undefined      (1 passed, exit 0)
```
**Se cobró el step propio y salió la invocación contra nosotros mismos.** El caso del `.env.example` sólo
está cubierto si el step es el **step 0** de `/compose`; en `/orchestrate` **ningún** step tiene Capa 1 sin
config, y `T-L1+9` lo congela como esperado. Por CD-18, `canonicalId === null` ⇒ tampoco se emite traza.
**Coincide con el BLQ-MED-1 del AR, encontrado de forma independiente.**

## 🟠 BLQ-BAJO-1 · El commit de W0 declara `exit 0 / 5497 passed` y ese árbol tiene **4 rojos**
En detached a `23a27dd`: `suite_exit=1` · `1 failed | 280 passed` · `4 failed | 5493 passed` ·
`FAIL test/readme-numbers.test.ts (×4)`: `expected 286 to be 287`, `expected 477 to be 479`.

**Y el dev conoce el mecanismo**: su `auto-blindaje.md:105-128` lo documenta con precisión (*"mi verde de W0
era cierto en el momento en que lo medí y falso un segundo después, por mi propio commit"*) y cambió el
protocolo — **pero no corrigió la cifra declarada de W0**. Se arregla en W1 (verificado). Riesgo: un
`bisect`, un revert o un merge parcial dan CI rojo con un commit que dice estar verde.

## 🟠 BLQ-BAJO-2 · El campo `contractingGuard` de `/health` no lo verifica **ningún** test, en ninguno de los dos handlers
§3.4 lo pone en los dos con motivo explícito, y **NC-1 lo designa como el único instrumento** post-deploy
para saber si las envs quedaron puestas (de eso depende BLQ-MED-1). Mutación: borré el campo de
`e2e/setup.ts:361` ⇒ `suite_exit=0`, **5594 passed, cero rojos**. El precedente está 20 líneas más arriba en
el mismo archivo (`T-HEALTH-SHAPE` sí testea el campo análogo vía `inject('/health')`).

## 🟠 BLQ-BAJO-3 · El costo declarado del Sitio 2 es falso ("cache de 60 s") y su fallo no está manejado
`orchestrate.ts:1146-1149` dice *"N lookups con cache de 60 s"*. **Medido: ese cache no cubre este camino.**
El `Map` de `agent-price.ts:17` lo consulta **sólo** `resolveAgentPriceUsdc`; `resolveAgentDestination`
(`:117-131`) llama `discoveryService.getAgent` **directo**, que hace un SELECT + **un `ssrfFetch` outbound
por registry habilitado**. Para un plan de 5 steps: hasta 5 SELECT + 10 fetches **secuenciales y antes del
débito**. Ironía operativa: **el guard es gratis cuando es inerte y caro cuando sirve.**

Segunda arista: ese `await` **no está en ningún `try`** ⇒ un blip de DB sube al catch del route, que
re-lanza ⇒ **superficie de 5xx nueva en el pre-débito**, sin test y sin declarar. Es fail-closed (dirección
correcta), pero no está escrito.

## MENORes
- **MNR-1** · El propio dev escribió el criterio (*"una cita verbatim, aunque sea histórica, deja el grep con
  un hit y un auditor no puede distinguirla del claim vivo"*) y en `routes/compose.ts:1124-1125` **la
  reproduce verbatim**. Lo salva un salto de línea. El criterio se aplicó en un archivo y no en el otro, y no
  quedó escrito para el próximo.
- **MNR-2** · `GUARD_SOURCES` cubre 1 de los 2 archivos del guard, y cita un archivo **inexistente**.
- **MNR-3** · Dos suites declaran `saved` para restaurar env y **nunca lo leen** (sin `afterEach`).
  Calibrado: con la config del repo **no hay fuga**; con `--no-isolate` **sí** ⇒ impacto cero hoy, latente.
- **MNR-4** · "la respuesta actual no se mueve un byte" mientras el 200 gana 2 claves incondicionales.
  Tensión de contrato registrada: CD-2 pide "ni body" y AC-10 exige cambiarlo; lo resuelve AC-12 (aditivo).
- **MNR-5** · "63 archivos mockean..." **sin sha**: hoy son **67**, envejeció dentro de la propia HU. Y cero
  `it.each`: los bucles de casos no assertan la cantidad de filas (borrar una fila no pone nada en rojo).
- **MNR-6** · El contrato (`story-file.md` 1485 líneas, `sdd.md` 1358) **no está en git** — hoy se borra con
  un `git clean` y ningún guardián lo nota. **CERRADO por el orquestador.**

## §5 · Los 23 CD
**PASS: 21** (CD-1..11, 13..23), varios verificados por mutación. **FAIL: CD-12** (toda cifra con su comando
y su sha) → BLQ-BAJO-1, BLQ-BAJO-3, MNR-5. **CD-8 N/A medido**: el diff no agrega ningún `.from(`/`.rpc(`, así
que el régimen de `deriveTables()` no se activa; el guardián da 13/13.

Destacados: **CD-3** es *"el más medido de la HU"* · **CD-14** *"la declaración del dev es honesta y
completa"* (el único `Number(` de código está en el rollup de fees, no en profundidad) · **CD-17** el Sitio 4
declara `⛔ NO satisface CD-3` y loguea con `log.error` del módulo por una decisión documentada · **CD-20** el
dev se comió el hazard en su propio mock nuevo y lo dejó escrito.

## §6 · Las 4 desviaciones — juzgadas
1. **Canal de corte del Sitio 2** — justificada con números, escrita en tres lados, **RATIFICADA** (el orden
   no cambió).
2. **5º sitio de mock** — justificada; el fixture quedó **como testigo del campo que el guard necesita**.
3. **2 exports del leaf** — justificados, pero `readContractingGuardHealth` **destapa** BLQ-BAJO-2.
4. **`depth_max=0`** — **RATIFICADA como está** por este CR (fail-closed y advertido en el archivo que el
   operador edita). ⚠️ **El AR la RECHAZÓ.** Decisión del orquestador: prevalece el AR.

## §7 · Calidad de los ~153 tests
Se cuenta **lo ejecutado**, no la condición (el mock de `debit` decrementa un saldo real; `fetch` ruteado al
mismo espía para global y `undici`). Los positivos usan **los dos hosts reales de prod**. El espía de CD-16
tiene control positivo. **Un control que se comparaba consigo mismo fue detectado y arreglado por el propio
dev** (`T-CARD-3` ahora **deriva** los prefijos y asserta que la derivación no vino vacía).

## §8 · Las 11 categorías
Security **OK con salvedad** (el log saca el **tamaño** del header, nunca su valor; `/health` publica el
conteo, no los hosts; el `hint` es **monótono**) · Error Handling 🟠 (BLQ-BAJO-3) · Data Integrity ✅ (nada
persiste; DT-7 respetado) · Performance 🟠 (BLQ-BAJO-3) · Integration ✅ (estrictamente aditivo; los
`errorCode` caen en el `default = 400` ya existente) · Type Safety ✅ · Test Coverage 🟡 · Scope Drift ✅
(los README justificados: `readme-numbers.test.ts` re-deriva esos conteos y las 2 envs nuevas los volvieron
falsos; `_INDEX.md` **no tocado**) · Migraciones / RPC / Cache **N/A medido**.

## §9 · Instrumentos fallidos declarados
`--poolOptions.forks.singleFork` **no existe en vitest 4**: la primera sonda murió con `CACError` y **no
midió nada** (exit 1 que se leería como "hay fuga"); re-hecha y calibrada en las dos direcciones · **su
primer MUT-02 no era equivalente al del dev** (re-resolvía el destino y consumía un `mockResolvedValueOnce`):
los 6 rojos coincidían igual, pero **con ese mutante no podía adjudicar la sub-afirmación del 400**, y por eso
escribió MUT-02b · `grep` bajo `rtk` deforma la salida, y para el barrido multilínea de CD-21 **ni el grep ni
su sweep en node ven la cita** — ese doble fallo **es** el contenido de MNR-1 · **no re-midió 10 de los 18
mutantes**: los toma como declarados y lo dice.

## §10 · Orden del fix-pack
1. **BLQ-MED-1** — propagar el hint a los Sitios 2/3 **o** calificar las 4 frases. Es el que cambia lo que un
   operador hace con el deploy.
2. **BLQ-BAJO-2** — un `it` de `/health` siguiendo `T-HEALTH-SHAPE`. Barato, y es el único instrumento de
   NC-1.
3. **BLQ-BAJO-3** — corregir la frase del cache y **decidir explícitamente** el manejo del throw.
4. **BLQ-BAJO-1** — una fila con el número real de `23a27dd`.
Después los 6 MENORes.
