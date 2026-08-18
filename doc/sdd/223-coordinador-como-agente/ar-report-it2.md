# AR it2 (re-AR acotado del fix-pack) — WKH-360 / 223

> ⚠️ **Materializado TARDE por el ORQUESTADOR, y eso es un error suyo.** El dev del fix-pack polleó este
> path **1200 s en dos tandas** y nunca apareció; trabajó de los ítems del mensaje, re-midiendo cada uno.
> Es la lección `reporte-declarado-que-no-existe`, pata de ORDEN, cometida el mismo día que se escribió.

**HEAD auditado** `d9a8cbb` · entrada del fix-pack `71fdaf7` · base `3823580`

## VEREDICTO: 🔴 RECHAZADO — 2 `BLQ-MED` · 2 `BLQ-BAJO` · 6 `MNR`

**Los 6 cierres declarados están cerrados en el comportamiento que declaran, verificados con mutación**: 6
de 8 mutantes re-corridos dieron número **y texto de muerte** exactos, y uno dio **más** rojos que lo
declarado. **Ningún hallazgo nuevo toca el orden respecto del dinero.**

Lo que bloquea es lo que el fix-pack **dejó fuera de su propia lista de residuales**.

## Línea base re-derivada
`5613 passed | 19 skipped`, exit 0 · `tsc` 0 · biome 0 (485) · ownership 13/13 · +19 netos · 0 `.sql`.

## Los 6 cierres, con el mutante corrido

| # | Cierre | Medido |
|---|---|---|
| 1 | hint a Sitios 2 y 3 | **3 rojos** (`T-L1-2c`, `T-L1-3c` por `debit: not called ⇒ called 1 times`; `T-PROP-5` por `expected undefined`) — exacto |
| 1b | hint en los routes | **2 rojos** (`T-L1+10`, `T-ROUTE-HINT`) — exacto |
| 1c | *calibración propia* | quitar sólo el sitio de `/orchestrate/execute` ⇒ 1 rojo en otra línea ⇒ **cada call-site tiene testigo propio** |
| 2 | guard de `readCoordinatorFee` | **2 rojos**: `T-U-FEE-5` con el `TypeError` literal, `T-FEE-7` con `expected false to be true` y `debit` en 1 — exacto |
| 3 | piso `[1,64]` | **1 rojo** (`T-U-MAX-6`). `T-U-MAX-6b` **no** muerde y **es correcto**: es el test de *fundamento* |
| 4 | rollup | **2 + 1 rojos** — exacto |
| 5 | `/health` | **3 rojos** (declaró 2): `T-HEALTH-CONTRACTING` ×2 **más** `T-HEALTH-BOTH` — **más cobertura que la declarada** |

Repro del body escalar: `"plain-string"`, `42`, `true`, `[]`, `null` ⇒ todos `undefined`, ya no tira. Y
`T-FEE-7` **mide el enunciado de AC-8**: bajo el mutante la aserción de `debit` **pasa** y muere
`result.success` ⇒ afirma *"el caller quedó cobrado por un step que falló"*, no *"el pipeline se rompió"*.

Repro del rango: `0`/`00`/`" 0 "` ⇒ default **+ warn propio**; `65` ⇒ warn de tope; `-1`/`abc` ⇒ ilegible;
`007` ⇒ 7. Prevaleció la posición del AR.

---

## 🔴 BLQ-MED-1 · Hay un TERCER caller in-process, entra por HTTP, es público y gasta plata de un tercero
`services/agent-link.ts:362` · `routes/agent-links.ts:147,158`

El fix-pack declara en **cinco superficies** que el residual sin envs son tres cosas (alias propios,
callers no-HTTP, `canonicalId`). **La enumeración está incompleta.**

```
POST /agents/links/:token/redeem   ← comentado "(público, auth por posesión del token)"
  → agentLinkService.redeem(token, input)        ← el req.hostname nunca sale del route
    → executeApprovedPlan(...sin selfHostHint...)
      → SITIO 2 se saltea · SITIOS 3 y 4 con conjunto []
```
Repro: `debit=1`, `fetchedUrls` contiene nuestra propia URL, `errorCode` undefined, `success` true.
**Byte por byte el escenario que `T-L1-2c` congela como cerrado.**

**Agravante de plata**: el plan usa `billingKeyRow: ownerKey` ⇒ **paga quien emitió el link**, y el caller
es anónimo.

## 🔴 BLQ-MED-2 · Sin las envs el caller no *agranda* el conjunto: lo **define**, y puede **vaciarlo**
El propio docblock (`:459-461`) escribe el criterio: *"una identidad que el caller puede MOVER es una que
puede VACIAR, y vaciarla sí sería un bypass"*. Con las envs ausentes `hosts` es literalmente
`[canonicalizeHost(hint)]` ⇒ **no hay conjunto base que agrandar**: la monotonía es verdadera como
enunciado y **vacía como propiedad de seguridad**. Y `T-L1-2d`, que la congela, setea la env en su primera
línea ⇒ **sólo ejercita el caso configurado**.

Con el hint forjado el guard vuelve **al estado inerte pre-fix**. Y `'a b'`, `'http://x'`, `'::1'`, `''` ⇒
`hosts=[]`, `canonicalId=null`: **el agujero original, a pedido**.

**Posición sobre el `canonicalId` influenciable**: la aceptación es correcta en su lógica (sin hint no se
emite nada y el contador del vecino nunca avanza) y **mal dimensionada en su alcance**. Respuesta al ataque:
**puede nombrar a un tercero** — ese nombre sale en el header que **nosotros** emitimos hacia agentes
ajenos, así que es una afirmación sobre nuestra identidad, firmada por nosotros, con contenido elegido por
el caller. **No pido revertir el hint**: pido calificar las frases con *"contra un caller honesto"*, sumar
la medición del vaciado al residual, corregir NC-2 y darle a `T-L1-2d` un gemelo **sin** la env.

## 🟠 BLQ-BAJO-1 · `canonicalizeHost` devuelve `''`, y ese `''` se reporta como identidad CONFIGURADA
El paso 6 (rechazar vacío) corre **antes** del paso 7 (quitar el punto final) ⇒ el 7 fabrica el vacío que el
6 existe para rechazar. `'.'`, `'。'`, `'%2e'` ⇒ `""`.

Con `A2A_SELF_HOSTS=.`: estado `configured`, **sin warn**, `/health` ⇒ `{"selfHostCount":1,"source":"env"}`
—**byte-idéntico a un deploy correcto**— y el guard **inerte**. El operador sigue el procedimiento que
`.env.example` designa como verificación post-deploy, ve la señal de éxito, y el guard no existe.
**El instrumento que NC-1 nombra como único es el que miente.**

Segundo efecto: el guard de CD-18 compara `=== null`, no falsy ⇒ con `canonicalId === ''` **sí emitimos** una
cadena que **este mismo repo rechaza** con `CONTRACTING_CHAIN_MALFORMED`.

## 🟠 BLQ-BAJO-2 · El "avisa" del Cierre 3 no tiene ningún testigo
La razón (2) del bloqueante original era *"cero señal de arranque"*. La señal existe y su **texto** está
testeado; nada garantiza que se **emita**. Borrando el bloque entero: `tsc` 0, lint 0, **5613 passed, cero
rojos**. El precedente (`T-HEALTH-BOTH`) está en este mismo fix-pack.

## MENORes
**MNR-1** el "63 sin sha" no cerró: el comando publicado da **63** en el sha que declara **66** (cuenta sólo
la forma `../`) · **MNR-2** 2 de las 19 anclas textuales **no son únicas** y no están entre las 5 marcadas
AMBIGUA; la retirada del mapa es honesta pero **no verificó la propiedad que hace útil al mecanismo nuevo**
· **MNR-3** el rollup publica un monto **negativo** con status `complete` · **MNR-4** la frase del costo
**subestima**: `getAgent` hace **dos** lecturas de DB por llamada ⇒ 10-20 SELECT, no 5 · **MNR-5**
`MAX_HOSTNAME_CHARS` declarado y **no aplicado** ⇒ podemos emitir una cadena que supera el tope que el
receptor aplica · **MNR-6** quedan **dos factories amputadas** de `agent-price.js`, el mismo patrón que acá
costó 5 tests de facturación en 500.

**Punto 1 del ataque, verificado y ratificado**: el dev arregló esos 5 con `importOriginal` y **no** bajando
el guard; 9 de 11 archivos ya lo declaran.

## Categorías
Security 🟠 (BLQ-MED-2, BAJO-1) · Error Handling ✅ (`T-L1-3d` congela el fail-closed con débito y fetch en
cero) · Data Integrity ✅ con MNR-3 · Performance ✅ con MNR-4 · Integration 🟠 (BLQ-MED-1) · Type Safety ✅
(el `as Record` se reemplazó por `unknown` + guard) · Test Coverage 🟠 · Scope Drift ✅ · Migraciones / RPC /
Cache **N/A medido** · Ownership **N/A + verde**.

## Instrumentos fallidos declarados
**`npx biome check` da un falso rojo** (`could not determine executable`; el correcto es `npm run lint`) ·
**rtk reescribe `npx tsx` de forma no determinista** · `npx tsx -e` inusable · un probe en `/tmp` **no
resuelve `fastify`** · `console.log` en vitest bajo rtk **se pierde entero** · **falso positivo evitado por
re-medir**: su primera llamada usó una firma posicional inventada y devolvió `ok:true` para una cadena
malformada — *"el lector está bien; el instrumento estaba mal"* · no re-midió 2 de los 8 mutantes y lo dice.

---

> **Verificación independiente del orquestador**: `routes/agent-links.ts:6` comenta la ruta como
> *"(público, auth por posesión del token)"* y `agent-link.ts` llama `executeApprovedPlan` sin hint
> (BLQ-MED-1 ✅) · `canonicalizeHost('.')`, `('。')` y `('%2e')` devolvían `""` (BLQ-BAJO-1 ✅) — y tras el
> fix-pack devuelven `null`, o sea rechazado.
