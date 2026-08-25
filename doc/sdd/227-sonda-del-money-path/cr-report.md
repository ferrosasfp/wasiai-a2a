# CR — WKH-364 · Sonda periódica del camino del dinero

**Veredicto: RECHAZADO (4 BLOQUEANTEs: 1 MEDIO, 3 BAJO) + 4 MENORes**
Rama `feat/227-sonda-money-path`, staged, contra `origin/main`. Revisión **estática** (el AR es
dueño de ejecutar suites); más dos `node -e` contra las **funciones puras exportadas**, sin red.

> ⚠️ **Procedencia**: el agente de CR entregó el reporte en su respuesta y su arnés le prohíbe
> escribir `.md` de hallazgos. Lo materializó el orquestador, verbatim salvo esta nota. Un reporte
> que se cita y nadie puede abrir es un artefacto fantasma.

## Check 8 — Scope (primero, porque puede abortar todo)

`/usr/bin/git diff --cached origin/main -- src/` → **vacío**. CD-2 y AC-7 cumplidos, medido.

13 archivos en el índice: los 6 del Scope IN + 4 artefactos de fases previas + 2 logs de evidencia
(fuera de presupuesto por §2) + `doc/sdd/_INDEX.md`. **Sin scope drift.**

## Check 7 — Escala del diff contra el presupuesto

**El reparto que declaró el Dev es EXACTO**, medido con un contador propio:

| Archivo | Total | Código | Comentario | Blanco | Presupuesto |
|---|---|---|---|---|---|
| `scripts/probe-money-path.mjs` | 367 | **241** | 92 | 34 | 260 |
| `test/probe-money-path.test.mjs` | 268 | **211** | 31 | 26 | 220 |
| `.github/workflows/probe-money-path.yml` | 110 | **72** | 29 | 9 | 95 |
| `package.json` + 2 README | 3 | 3 | — | — | 3 |
| **Total** | **752** | **527** | 152 | 69 | 578 (techo 1156) |

**Código solo: 527 vs 578 de presupuesto — entra, y por 51 líneas.** El 1,30x es íntegramente prosa
y espacio.

¿Prosa o peso? Aplicada la pregunta bloque por bloque:

- **No hay un solo comentario que explique JavaScript ni GitHub Actions.** Buscado; no está.
- Lo que hay son razones de dominio con su cita: `scripts:39` (los 6 códigos con
  `a2a-key.ts:105-111`), `scripts:81-83` (por qué `+1` para `integer` y por qué para `number` no hay
  épsilon que no sea inventado), `scripts:188-192` (por qué el discriminante es el VALOR de
  `agentFailure`), `yml:87-88`, `yml:14-15`.
- **Repetición medida**: `"de memoria"` 3 veces (2 son del test explicando T-1), `"falso rojo"` 1,
  `"segundo fallo silencioso"` 2 (una es el test). **No se encontró la regla repetida tres veces.**
  Lo único cosmético son 6 separadores de 92 líneas de comentario.
- Opinión con tono de medición: `scripts:31-33` justifica el techo de 120 s con "invoca a un agente
  remoto" sin p99 medido — pero está declarado como **decisión** en `auto-blindaje.md:29-40`. No es
  hallazgo.

**Check 7: OK.** Lo que falla son tres frases concretas, y por **falsas**, no por volumen.

---

## BLOQUEANTES

### 🔴 BLQ-MED-1 — El default de la escalera es PASS: un `/discover` no-2xx fuera de {404, 5xx} sale **exit 0 sin haber llamado a `/compose`**

**`scripts/probe-money-path.mjs:206-263`** (filas 1-2 en `:218-224`, default fila 11 en `:262`) +
`main` en `:308-312`.

`main` corta cuando `inputSchema` es falsy (`:312`), **cualquiera sea el status**. `ladder` sólo
atrapa `>=500`/red (fila 1) y `404` o `200-sin-schema` (fila 2). Todo el resto cae al
`return verdict('PASS', 0, …)` de `:262`.

Reproducción, ejecutada contra las funciones puras sin red:

```
0 PASS   <- discover 403 (WAF/edge)
0 PASS   <- discover 429 (rate-limit del edge)
0 PASS   <- discover 401
0 PASS   <- discover 204 sin schema
2 DOWN   <- CONTROL: discover 503
4 DRIFT  <- CONTROL: discover 404
```

Imprimiría `PASS: el camino del dinero cotiza … schemaSha256=- omitted=[] httpStatus=403` — afirma
que el camino cotiza **sin un solo POST**.

**Impacto**: exit 0 ⇒ job verde ⇒ no se abre issue **y el step de `yml:99-110` CIERRA un issue ya
abierto**. Un corte de `/discover` que se manifieste como 403/429 del edge (Railway y Cloudflare
devuelven esos, no sólo 5xx) **apaga la alarma que estaba encendida**. Es el modo de falla exacto
que la HU existe para eliminar: *"puede dar verde sobre algo roto, que es el modo peligroso"*.

**Por qué no es "hueco del spec"**: §5 no numera esa fila, cierto. Pero el default de una escalera
de monitoreo **no puede ser la única clase que jamás debe alcanzarse por omisión**. `verdict('PASS')`
debería ser inalcanzable salvo tras un 2xx de `/compose` con `assertQuoteShape().ok === true`.

### 🔴 BLQ-BAJO-1 — El comentario dice que el issue "pega la línea de clase"; el cuerpo no la contiene

**`.github/workflows/probe-money-path.yml:63-64`** vs el cuerpo construido en `:73-85`.

`:63-64` dice: *"el texto NO afirma la causa: pega la línea de clase que emitió la sonda … y manda a
leer el log."* El `printf` de `:73-85` es 100 % estático más `$RUN_URL` y `$GITHUB_SHA`. **No hay
captura de stdout del step de la sonda en ningún lado del YAML** (`:51-56` no tiene `id:` ni
redirige salida). El Story File §1.2 lo pide explícitamente.

**Impacto**: quien recibe el issue a las 3 AM tiene que abrir Actions para saber si es CONFIG (no
toca producción) o DOWN. Eliminar ese costo **es la mitad del argumento de existencia de la HU**. Y
el comentario hace creer que ya está resuelto, que es peor que no decir nada.

### 🔴 BLQ-BAJO-2 — "En `pull_request` sale con SKIP y exit 0" es falso para un PR del propio repo

**`.github/workflows/probe-money-path.yml:47-50`** y **`:8-10`**.

GitHub no entrega secrets sólo a PRs **desde un fork**; a un PR de una rama del propio repositorio
se los entrega enteros. En este repo el flujo normal son ramas propias — **empezando por
`feat/227-sonda-money-path`**. Sobre ese PR el secret llega poblado, `readCredential` devuelve
`{run:true}` (`scripts:68-72`), y la sonda **hace el POST real contra producción y gasta ~0,0303
USDC en cada push a la rama**, con `continue-on-error` haciendo que nadie lo note.

Eso vuelve falsa también `:9`: *"La palanca para recalcular el gasto es UNA SOLA LÍNEA, la del
`cron`"*. Hay una segunda palanca sin presupuestar: el trigger `pull_request:` de `:17`.

**Impacto**: (a) gasto no presupuestado; (b) esas corridas consumen el mismo `DAILY_LIMIT`, que
`story-file §16` dimensiona **exactamente** para 48 corridas ⇒ un día con muchos pushes puede
agotarlo y hacer que la corrida por reloj reporte `CONFIG (DAILY_LIMIT)` — **un rojo de la sonda
causado por la sonda**, que es la clase de ruido que apaga controles.

### 🔴 BLQ-BAJO-3 — El self-test puede afirmar "el gateway aceptó un cuerpo que viola el schema" sin haber violado nada

**`scripts/probe-money-path.mjs:324-327`** (el `delete`) y **`:199-201`** (el veredicto).

`:326` hace `delete input[obs.selfTestField]` sin verificar que el campo **esté** en `input`. Con un
typo, o con un campo que la derivación ya omitió (`destCountry`, que es el caso por defecto de este
schema), el `delete` es un no-op, el cuerpo sale conforme, el gateway contesta 200, y `:199-201` lo
convierte en `exit 5: "SELF-TEST: el gateway aceptó un cuerpo que viola el schema publicado"`.

Reproducción: `PROBE_SELF_TEST_OMIT_REQUIRED=destCountry npm run probe:money-path` con credencial
válida ⇒ **exit 5 con un hallazgo inventado** y 0,0303 USDC gastados.

El path es **simétrico al que el Dev sí cerró tres líneas más arriba** (`:202`): reconoció la clase
y cubrió un miembro. En CI no se alcanza (`yml:56` cablea el literal), pero **D-2 es un comando a
mano** y ahí sí.

---

## MENORes

**MNR-1 — Tres guardianes nuevos escanean prosa junto con código; es el falso rojo que el propio
`auto-blindaje.md` dice cómo evitar.** `test:238` (T-9), `:244` (T-10) y `:253-255` (T-11) corren
sobre el texto entero. T-8 (`:234`) sí usa `sinComentarios` porque el YAML lo mordió —
`auto-blindaje.md:8-25`, cuyo *"Aplicar en"* dice **"TODA aserción nueva que busque un literal
prohibido dentro de un archivo que también lo explica"**. Consecuencia concreta: **el script no
puede documentar su decisión central** (por qué se omite `destCountry`) sin poner T-11 en rojo, y de
hecho el docblock de `:117-124` no la explica.

**MNR-2 — `isRetryable` está exportada y ningún test la referencia.** `scripts:268` y `:339`
(`retryOnTimeout:false` para el POST). `grep -rn "isRetryable\|readCredential" test/` → **0**. El
comentario de `:329-330` afirma *"un POST que expiró pudo haberse ejecutado del otro lado, y
repetirlo paga dos veces"*: una frase que termina en instrucción y no tiene test. Cambiar `false`
por `true` deja la suite verde.

**MNR-3 — Un `PROBE_AMOUNT_USD` no numérico se reporta como DRIFT del contrato, no como CONFIG de la
sonda.** `scripts:315` hace `Number(...)` sin validar; `NaN` es `typeof 'number'` y pasa el guard de
`:127`. Reproducido: ⇒ fila 3 ⇒ `DRIFT: campo requerido no derivable`. Un typo en el env termina
diciendo "el catálogo cambió" — **la misma familia de misatribución que la HU cierra, en su propia
configuración**.

**MNR-4 — `.replace('( ', '(')` en `scripts:259` parchea un artefacto de formato** en vez de
construir el mensaje con las partes presentes. Dependencia invisible entre dos funciones.

---

## Checks OK, con lo que se leyó para poder afirmarlo

**Check 1 — Naming: OK.** `package.json:17` es `"probe:money-path"`, insertado **después** de `:16`
como exige CD-7. `package.json:11` sigue siendo `"lint"` y es la única línea citada del archivo.
`probe:money-path` no matchea `^npm\s+(?:test|run\s+test)` ⇒ el step con `continue-on-error` no entra
a `untranslatable`. Los 7 nombres del Story File §10 coinciden uno a uno.

**Check 2 — La escalera: OK salvo BLQ-MED-1.** No es cascada opaca: filas numeradas `// 0`…`// 11`
en el mismo orden que §5, y **la tabla legible vive en el test** (`test:127-144`, 16 casos). Los
mensajes dicen la causa, no "falló". T-6 verifica que DRIFT y DOWN no contengan la palabra del otro.
Nit de legibilidad: el ternario anidado de `:246`.

**Check 3 — DRY / cohesión: OK.** Separadas las tres: derivación (`deriveInput:126-143`, pura),
clasificación (`ladder:206-263`, pura) y reporte (`emit:347-354`). `main` es un orquestador de ~50
líneas. Ninguna función hace las tres.

**Check 4 — Exemplar: OK.** Comparado línea a línea contra `smoke-downstream.yml`. Se conservan
`permissions`, `checkout@v7`+`setup-node@v6`, `continue-on-error` condicional, apertura con
`failure() && schedule`, dedup por título exacto, cierre con `success() && schedule`, y **sin
`--label`** con su razón. Única divergencia estructural: no tiene `push: branches:[main]`, correcta
y explícita — acá cada corrida cuesta USDC.

**Check 6 — `auto-blindaje.md`**: la primera entrada bien resuelta **pero a medias** (ver MNR-1); la
segunda, decisión correcta. `git add -f` sin tocar `.gitignore` es lo correcto (no está en Scope IN
y una regla global es política del repo). Verificado efectivo: `git ls-files .../evidence/` devuelve
los dos `.log`.

**La desviación §7 vs §5: honra las dos secciones, no inventó una clase.** El cruce vive en
`assertQuoteShape:174` (marca `drift:true`) y la fila 10 (`:255-260`) ramifica: `drift` ⇒ DRIFT(4),
lo demás ⇒ DOWN(2). Siguen siendo las mismas clases. Testeado en `test:161-165` y `:196`.

**Evidencia AC-4: honesta.** `D-1-credencial-invalida.log:8` es una corrida real contra producción.
`D-2-D-3-NO-EJECUTADOS.log` **no simula nada** y mide la ausencia del secret.

**Conteo derivado (CD-12): correcto.** `git ls-files | grep -cE ...` → **305**, exactamente los globs
de `vitest.config.ts:5`, y es lo que publican `README.md:378` y `README.es.md:412`.

---

## Orden sugerido del fix-pack

1. `BLQ-MED-1` — el default PASS de la escalera (`scripts:262` + `main:312`)
2. `BLQ-BAJO-1` — el issue no pega la línea de clase (`yml:63-64` / `:73-85`)
3. `BLQ-BAJO-2` — la frase del `pull_request` y la segunda palanca de gasto (`yml:47-50`, `:8-10`)
4. `BLQ-BAJO-3` — el self-test con `delete` no-op (`scripts:324-327`)
5. MENORes 1-4, si entran

**Nota**: `BLQ-MED-1` y `MNR-2` pueden aparecer también en el AR; si vienen duplicados, contalos una
vez.
