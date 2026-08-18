# AR — WKH-360 / 223 · el coordinador es un agente

> **Materializado por el ORQUESTADOR.** Cuerpo del agente. Los hallazgos de carga los verifiqué de forma
> independiente (nota al pie).

**Rama** `feat/223-wkh-360-coordinador-agente` · **HEAD** `71fdaf7` · **base** `3823580`

## VEREDICTO: 🔴 RECHAZADO — 3 `BLQ-MED` · 3 `BLQ-BAJO` · 6 `MNR`

**El corazón está SANO y lo verificó, no lo aceptó**: los tres guards de dinero cortan antes de su débito y
sus tests miden **conteo de débitos**, no status. **Ningún bloqueante toca el orden respecto del dinero.**

## Línea base (medida en worktree propio)
`286 passed | 6 skipped (292)` · `5594 passed | 19 skipped (5613)` · RC=0 · `tsc` 0 · `biome` 0 (485 archivos)
· prod `POST /discover` = 25 agentes, **0 al gateway**, 0 declaran `protocolFeeStatus`.

## §1 · El orden respecto del dinero — OK, con 3 mutantes propios

| Mutante | Rojos | Testigos | Texto de la muerte |
|---|---|---|---|
| MUT-02 (Sitio 1) | **6** | `T-L1-1/4/5/6`, `T-L1+4`, `T-FLAG-1` | `expected "vi.fn()" to not be called, but called 1 times` — args `["k1", 2368, 0.001]`: **débito real** |
| MUT-03 (Sitio 2) | **2** | `T-L1-3`, `T-L1-3b` | idem, conteo de `debit` |
| MUT-01 (Sitio 3) | **3** (1 es ruido propio, descontado) | `T-L1-2`, `T-L1-2b` | `expected 1 times, but got 2` |

**Ratifica la afirmación del dev sobre MUT-02**: bajo el mutante el endpoint **sigue devolviendo 400**, así
que un test de status **habría sobrevivido**. Lo único que mata es el conteo, y en `T-L1-1:219-221` esos
asserts van **antes** del de status, con el comentario `── EL DINERO PRIMERO. Estas dos líneas son el test;
el status es contexto.` Buscó `finally`, reembolso best-effort y reordenamiento por `await` entre corte y
débito: **no hay**.

## §2 · El Sitio 4 — OK
Declarado en el código (`compose.ts:1653-1668`, `⛔ ESTE NO ES EL GUARD DE DINERO`), loguea con `log.error`
(el logger **del módulo**, no el inyectable — que no tiene `error`), y `T-L1-7` asserta `mockFetch` no
llamado + nivel `error` + `best-effort` en el mensaje.

## §3 · Identidad — OK · 12 variantes medidas
Punto final, mayúsculas, esquema, puerto, userinfo, sin path, `%2e`, **punto ideográfico U+3002**, punycode ⇒
**todas cortan**. IP literal y `[::1]` ⇒ no (R-3, **declarado en el código** `:121-124`, en `.env.example` y
en un test). `gw.example.com..` descartado: `dns.lookup` da `ENOTFOUND`. **No se reusó
`canonicalizeHostKey`**, y el leaf es leaf de verdad (`grep -nE "^import"` ⇒ vacío).

## §4 · El header — OK
17 valores de profundidad (`'1e9'`, `''`, `' 2'`, `'0x10'`, `'+1'`, `'-1'`, dígitos árabes…) ⇒ **todos
`DEPTH_MALFORMED`**; `''` **no** degrada a 0. 13 formas de cadena: 8192 chars rechazado **antes del split**,
inyección `\r\n` ⇒ `CHAIN_MALFORMED`. **Duplicados**: el dev escribió que llegan como `string[]`, **la
medición lo desmintió** (Node los joinea) **y él lo corrigió**. CD-14 cumplido.

## §5 · CD-1 — OK behavioral
El barrido del leaf da exactamente `['BASE_URL','DEPTH_MAX_ENV','SELF_HOSTS_ENV']`. Mutante `=== 'true'`
default OFF en el middleware ⇒ **24 rojos**. Calibración inversa: el barrido textual sigue verde ⇒ `MNR-2`.

## §6 · POSICIÓN: `A2A_CONTRACTING_DEPTH_MAX=0` — 🔴 **RECHAZA. Debe ser INVÁLIDO** → BLQ-MED-3
`readInboundContracting(sin headers, [self], 0)` ⇒ `CONTRACTING_DEPTH_EXCEEDED`: **el 100% del tráfico**.
Tres razones medidas: (1) **el repo enseña lo contrario** — `maxBudget: 0` y el ceiling ausente significan
*sin límite*; un operador que escribe 0 pidiendo "sin tope" **apaga el money-path**; (2) **cero señal de
arranque** (`isContractingDepthMaxMisconfigured('0')` ⇒ `false`, porque 0 es legible) y el mensaje del 400 lo
manda a buscar un bucle en el caller; (3) **no existe caso de uso**: `1` ya es el ajuste más restrictivo útil.

## §7 · POSICIÓN: la desviación del Sitio 2 — ✅ **RATIFICADA**
Verificó el orden él mismo: el `return loopResult` (`orchestrate.ts:1215`) está **a nivel top-level** del
método, después del cap gate, así que **el camino atómico también queda cubierto**; el `debit` está en
`:1251`. MUT-03 mata por conteo. El motivo es verificable (6 call-sites en 5 archivos, 3 fuera de Scope IN) y
el 400 es consistente con la familia del repo.

## §8 · AC-9 · auto-inmunidad — OK
Los 4 call-sites son exactamente los declarados; ninguno con allow-list, `skip` ni condición por registry. La
Capa 1 **no lee headers del caller**. El `hint` sólo **agrega**: un `Host` forjado consigue que el gateway se
**niegue** a llamar a ese destino (auto-DoS de un request), y **no puede vaciar** el conjunto. El
`canonicalId` saliente se resuelve **sin hint**.

---

## 🔴 BLQ-MED-1 · Los Sitios 2, 3 y 4 quedan INERTES por default, y la prosa dice lo contrario en tres lugares
`orchestrate.ts:1150-1155` · `compose.ts:429`, `:1672` · `contracting-chain.ts:336-345` · `.env.example:573-577`

El `hint` que hace funcionar el guard sin configuración existe en **2 de 5 superficies**. Los Sitios 2/3/4
llaman `resolveSelfHosts()` **sin hint** (no tienen `FastifyRequest`). Con `BASE_URL` y `A2A_SELF_HOSTS`
ausentes:

```
resolveSelfHosts().hosts                    => []
gate del Sitio 2 (hosts.length > 0)         => false   ⇒ step-0 de /orchestrate SIN guard
Sitio 3/4: isSelfDestination(url, [])       => false   ⇒ steps 1..N SIN guard (donde vive el 5^k)
canonicalId                                 => null    ⇒ no se emite traza saliente
```
Y el camino MCP no tiene preHandler **ni** hint. **Las tres frases que un operador leería primero dicen que
está cubierto**, y una de ellas **cita CD-1** para defender el estado que CD-1 prohíbe.

**No es ALTO por honestidad**: no pudo verificar si `BASE_URL` está en el Railway de prod (NC-1 sigue
abierto: la `url` de la carta es indistinguible entre las dos lecturas, y `/health` de prod aún no publica
`contractingGuard`). **La exposición real en prod es DESCONOCIDA.**

## 🔴 BLQ-MED-2 · `readCoordinatorFee` TIRA sobre una respuesta JSON que no es objeto — y después del débito
`contracting-chain.ts:724`, invocado en `compose.ts:1732`. El `in` sobre `raw` viene de un
`as Record<string, unknown>` que es promesa a `tsc`, no hecho: un agente puede responder 200 con un JSON que
sea **string, número o booleano**.

```
invokeAgent con body 'plain-string' / 42 / true
=> TypeError: Cannot use 'in' operator to search for 'protocolFeeStatus' in plain-string
   Tests 3 failed
```
**Calibrado en las dos direcciones**: neutralizando esa línea ⇒ `3 passed`. En el árbol base el mismo body
**funcionaba**. El throw lo agarra el catch per-step, que corre **después** del `debit` de `:613` ⇒ **el
caller queda cobrado** por un step que ahora falla. Rompe AC-8 en el sentido más caro: **cambia el cobro**.

## 🔴 BLQ-MED-3 · `A2A_CONTRACTING_DEPTH_MAX=0` cierra el servicio, es legible y silencioso
Desarrollado en §6.

## 🟠 BLQ-BAJO-1 · El rollup del fee FABRICA un `0` y puede emitir `null` — CD-5 violado
`contracting-chain.ts:777`. `rollUpCascadedFee([{declared:true, usdc:1e-9}])` ⇒
`{cascadedOrchestrationFeeUsdc: 0, status:'complete'}` — **un cero fabricado con status "estoy seguro"**. Y
con dos montos enormes ⇒ `Infinity` ⇒ `JSON.stringify` lo publica como **`null`**. Los dos valores los
controla **un tercero**. Campo de sólo lectura ⇒ BAJO.

## 🟠 BLQ-BAJO-2 · El mapa de desplazamiento de citas está mal en 3 de 5 filas, todas por **+11**
`implementation-log.md:122`. Verificado por CONTENIDO: `:1463`→**`:1474`**, `:1738`→**`:1749`**,
`:1773`→**`:1784`**. Las otras 2 filas y las de los demás archivos sí dan. Error **sistemático**, se arregla
recomputando una vez. Modo de falla **auto-confirmante**: los destinos equivocados muestran prosa plausible.
Sexta recurrencia de esta clase.

## 🟠 BLQ-BAJO-3 · `sdd.md` y `story-file.md` NO ESTÁN EN GIT — dirigido al orquestador
El código y el `implementation-log` citan `CD-1..23`, `AC-1..12`, `R-3`, `TD-360-1/2`, `NC-1..6`, `T-*` y
`MUT-01..16`, **todos definidos únicamente ahí**. Si entra a `main` (que es producción), cada cita apunta a la
nada. **CERRADO por el orquestador**: los dos commiteados, verificado con `git ls-tree`.

## MENORes
- **MNR-1** · La mitigación de R-3 **no existe para IPv6**: `'69.46.46.64'` ⇒ configurado, pero `'::1'` /
  `'[::1]'` ⇒ `invalid` ⇒ **el proceso no arranca**. Un operador que siga la doc voltea el arranque.
- **MNR-2** · El barrido textual de CD-1 mira **el archivo donde la bandera NO iría**: `GUARD_SOURCES` sólo
  tiene el leaf. Medido: con la bandera puesta en el middleware, ese test sigue en `76 passed`.
- **MNR-3** · Cita a `contracting-chain.flag.test.ts`, que **no existe**.
- **MNR-4** · "la respuesta actual no se mueve un byte" donde el 200 gana **2 claves incondicionales**.
- **MNR-5** · **R-4 no es teórico: es la topología de HOY.** 22 de 25 agentes viven en `wasiai-v2`, que **nos
  llama** y **no reenvía** los headers nuevos ⇒ la Capa 2 nace con cobertura efectiva ~0 en el camino real.
  Merece HU de seguimiento en `wasiai-v2`.
- **MNR-6** · El candado "verificable con un grep" de CD-14 quedó **romo en el mismo commit**: hay 10 hits de
  `parseInt|Number(` en el archivo (uno legítimo del rollup), así que el grep ya no discrimina.

## Categorías
Security 🟠 (BLQ-MED-1) · Error Handling 🟠 (BLQ-MED-2) · Data Integrity 🟠 (BLQ-MED-3 + BAJO-1) ·
Performance ✅ · Integration 🟡 · Type Safety 🟠 (el `as` oculta el caso escalar) · Test Coverage 🟡 ·
Scope Drift ✅ · Migraciones / RPC / Cache **N/A medido** · Ownership guard **N/A + verde 13/13**.

## Prosa — las tres verificadas
"Transitivo cerrado" **no aparece** y está **negado en 8 archivos** desde una sola constante que viaja en el
body del error **y** en la Agent Card. "IP literal cerrada" no aparece. "Drenaje en curso" no aparece y está
negado en tres artefactos.

## Instrumentos fallidos declarados
Un `ln -s` sobre un symlink existente **escribió dentro del `node_modules` del dev** (borrado y verificado) ·
vitest corre silencioso: dos corridas dieron `8 passed` con salida vacía, indistinguible de "no salió nada" ·
**`curl` bajo `rtk` reescribe el body** (devolvió un esquema inventado en vez de la respuesta) · su propia
sonda fabricó un hallazgo falso (`{"query":""}` ⇒ "prod no tiene agentes"; el parámetro es `q`) · su probe
rompió la precondición `tsc` del harness · restauró una vez con `git checkout --`, que el contrato prohíbe.

---

> **Verificación independiente del orquestador**: `git ls-tree` confirmó que sólo `work-item.md` estaba
> trackeado (BLQ-BAJO-3 ✅, ya cerrado) · `node -e "'x' in 'plain-string'"` tira `TypeError` (BLQ-MED-2 ✅).
