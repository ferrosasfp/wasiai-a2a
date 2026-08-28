# AR-2 — WKH-370 · Re-AR del fix-pack de los 5 bloqueantes

Rama `feat/231-wkh-370-catalogo-vs-agentes-vivos` · commit `7fdd4fc` · base `091db28`
2026-08-27 · Alcance: **verificar EJECUTANDO que los 5 cierres se sostienen** + buscar regresiones.

> Materializado por el orquestador desde el reporte inline del `nexus-adversary`. Contenido íntegro.
> ⛔ No se le creyó al Dev en ningún punto: cada cierre se re-hizo con mutación o arnés propio.
> Árbol byte-idéntico a `7fdd4fc` tras todas las mutaciones. Nunca `git checkout --`.

## Veredicto: ✅ APROBADO con MENORes — los 5 cierres se sostienen · 0 BLOQUEANTES

| Cierre | Verificado por | |
|---|---|---|
| BLQ-1 · el falso verde | M8, M9 y M14 **re-hechos**, cada uno rojo por su motivo declarado | ✅ |
| BLQ-2 · las citas de la prosa | 11 anclas re-derivadas + **el silencio medido con control positivo** | ✅ |
| BLQ-3 · `401/403` → `CONFIG` | arnés propio: `401`,`403`,`503`,`500`,`429` | ✅ sin pasarse de rosca |
| BLQ-4 · colisión de la escalera | **378 combinaciones** contra semántica de referencia escrita a mano | ✅ 0 divergencias |
| BLQ-5 · docblock de `owner_ref` | **7 mutantes**, tres sobre el TIPO | ✅ `T-S6` no se lee a sí mismo |

**Gate corrido por el AR-2, árbol limpio**: `tsc 0` · `lint 520` · `314/320` archivos ·
`6350/6369` casos · exit 0. Idéntico a la entrada declarada del fix-pack.

---

## 1 · BLQ-1 — los tres mutantes mueren por su motivo

| Mutante | Suite | Aserción que lo mata |
|---|---|---|
| **M8** registro ausente → `completa` | 35 PASS / 1 FAIL | `expect(r.exit).toBe(CONFIG)` → `expected +0 to be 3` |
| **M9** sin el booleano → `completa` | 35 PASS / 1 FAIL | idem → `expected +0 to be 3` (**el falso verde e2e**) |
| **M14** `comparados += 1` arriba del `continue` | 35 PASS / 1 FAIL | ⚠️ **el exit sigue siendo CONFIG(3), correcto**. Lo mata **sólo** `toMatch(/ comparados=0 /)` |

**La aserción `comparados=0` NO se satisface trivialmente**, probado en las dos direcciones: M14 la
pone roja con el valor `1`, y el **contraste positivo** del mismo test afirma `comparados=1` sobre
el camino con el dato presente — el mutante `MX16` (borrar el incremento) lo pone rojo. Además, en
cada iteración hay un **control positivo previo**: si el chequeo no salió a preguntar, el resto no
prueba nada.

**Barrido adicional: 18 mutantes nuevos, 15 MUERTOS** por el motivo correcto. Los 3 que sobreviven
van como MENOR.

---

## 2 · BLQ-2 — y el silencio del guardián está MEDIDO, con control positivo

⚠️ El CR decía `:711`/`:886`. **Al `7fdd4fc` son `:715`/`:890`**: el propio fix-pack desplazó
`agent.ts` **+4** al reescribir el párrafo. **El Dev re-derivó, no sumó el delta**, y da bien.
Método contenedor confirmado: `:715` ⊂ `async update(`, `:890` ⊂ `async delete(`.
Los **11 anclas** verificados uno por uno.

### La afirmación fuerte, medida — y es cierta

Podrí **tres** citas de prosa de `ownership-filter-guard.exceptions.ts` a líneas inexistentes y
corrí el gate completo:
```
Test Files 314 passed | 6 skipped (320) · Tests 6350 passed | 19 skipped (6369)   exit 0
```
**VERDE. Ningún guardián mira ese archivo.**

**Control positivo del instrumento** —porque un verde no vale si el instrumento no puede ponerse
rojo—: podrí el campo **estructural** `line:` de `citations.ts` y ese guardián dio
`3 failed | 9 passed`, exit 1. ⇒ **el verde de arriba es silencio real, no un instrumento roto.**
`TD-370-EXCEPTIONS-SIN-GUARDIAN` está bien declarada.

---

## 3 · BLQ-3 — `401/403` → `CONFIG`, y el `503` no se movió

```
/agents 401 → exit=3  CONFIG: el listado propio rechazó la credencial A2A_CATALOG_OWNER_KEY (401) — hay que rotarla
/agents 403 → exit=3  idem
/agents 503 → exit=2  INALCANZABLE   ← el contraste NO se movió
/agents 500 → exit=2  ·  /agents 429 → exit=2
```
No imprime ningún valor de credencial: sólo el status y el **nombre** de la env. El mutante que
parte sólo por `401` muere (`status 403: expected 2 to be 3`). La fila `4b` va **antes** de la
anti-vacuidad, así que sale con el mensaje que dice qué hacer y no con el genérico.

⚠️ **Nota de instrumento del propio AR**: su primera corrida dio `CONFIG` para los cinco status —
porque su fixture nunca llegaba a `/agents`. **Lo cazó el registro de llamadas, no el exit.**

---

## 4 · BLQ-4 — exhaustivamente medido

El Dev reusó el guard `!acusaAlCatalogo` en las filas 8 y 9 **sin mover filas**. El AR recorrió los
6 contadores en `{0,1,2}` y comparó contra una **semántica de referencia escrita a mano** —"10 y 11
antes que 8 y 9"—, **no derivada del fuente**, para no compararse consigo mismo:

```
casos evaluados: 378 · divergencias: 0 · caídas al fondo de la escalera: 0
```
⇒ **la afirmación del docblock es verdadera en TODO el espacio de contadores.**

```
inalcanzables=1 derivas=4  (coexisten)    → DERIVA(4)
inalcanzables=1 derivas=0  (NO coexisten) → INALCANZABLE(2)   ← la fila 8 sigue ganando
SOLO un manifiesto caído                  → INALCANZABLE(2)   ← 🎯 el caso legítimo NO quedó tapado
```
Los 6 mutantes del guard mueren, incluido el de **negarlo** — el modo de falla "tapa el caso
legítimo". **El guard no es decorativo en ninguna de sus dos patas.**

---

## 5 · BLQ-5 — `T-S6` puede fallar y NO se lee a sí mismo

7 mutantes, todos muertos. 🎯 **N1/N2/N3 mutan el TIPO `AgentRow`, no el párrafo**, y el test se
pone rojo igual: el ancla de verdad se **deriva del fuente** y el docblock se contrasta contra ella.
**N6b** (aparece un cuarto llamador) prueba que el número también se **cuenta**, no se recuerda.

---

## Regresiones del fix-pack — buscadas, ninguna encontrada

`CD-9` respetado (las 3 citas que deben quedar podridas, podridas; `discovery.ts` intacto).
`CD-22` respetado: **cero `:<dígito>` en TODA la HU** sobre `agent.ts`.
El `401` no filtra la credencial. `T-S4` quedó **descongelado**: antes clavaba el cuerpo duplicado.

## MENORes nuevos (ninguno bloquea)

**`MNR2-1`** — 🔴 el único que importa: un mutante **alcanzable** sobrevive.
Quitar `|| schema === null` de `:266` deja la suite en **36 passed**. Y es alcanzable por un camino
real: `PATCH /agents/:slug` con `{"inputSchema": null}` persiste `metadata.inputSchema: null`
(`agent.ts:817-818`, `null !== undefined`), y `/discover` lo publica. Con ese mutante, un agente
cuyo schema fue **borrado** sale `completa` ⇒ `CONFORME(0)`. **Misma familia que el BLQ-1 recién
cerrado**, sobre la cláusula hermana. El código de hoy es correcto; falta el test.

**`MNR2-2`, `MNR2-3`** — dos mutantes que sobreviven pero son **equivalentes / defensivos puros**:
sus ramas son inalcanzables por el camino real. Documentados para que no se re-descubran.

**`MNR2-4`** — ⚠️ `_INDEX-row.md` lleva **5 citas podridas**, escritas en F1 contra el árbol
pre-implementación. **`nexus-docs` pega esa fila en `doc/sdd/_INDEX.md` al cerrar** ⇒ se publicarían
5 citas falsas en el índice del proyecto. Se re-derivan **en DONE, al final, después de que nadie
vaya a mover nada más**.

**`MNR2-5`** — una cita cuyo `mustContain` **no sostiene la frase que decora**: el ancla verifica
que la línea existe, no que respalde lo que se afirma al lado. **Pre-existente**, fuera de Scope IN.

---

## El hallazgo del AR-2

> Los 5 cierres se sostienen, y **tres mejoraron la afirmación en vez de taparla**: el `comparados=0`
> mata al mutante que dejaba el exit correcto; el guard resultó equivalente a "10/11 primero" en las
> **378** combinaciones, no sólo en las cuatro pedidas; y `T-S6` deriva del **tipo**.
>
> Lo que sigue abierto es siempre la misma clase, y ya tiene nombre acá: **un guardián verde sobre
> una frase falsa.** Ninguna bloquea, y las dos se cierran en el mismo lugar: **abriendo la línea,
> al final, después de que nadie vaya a mover nada más.**
