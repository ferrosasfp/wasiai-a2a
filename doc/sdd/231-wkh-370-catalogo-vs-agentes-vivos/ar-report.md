# AR — WKH-370 · El vigilante del catálogo

Rama `feat/231-wkh-370-catalogo-vs-agentes-vivos` · commit `20b3102` · base `091db28`
2026-08-27 · Ataque: **seguridad · falsabilidad de tests · lógica de clasificación**

> Materializado por el orquestador desde el reporte inline del `nexus-adversary`. Contenido íntegro.
> Árbol verificado byte-idéntico a `20b3102` tras todas las mutaciones (`sha256sum` contra backup).

## Veredicto: ❌ RECHAZADO — 3 BLOQUEANTES + 2 MENORES

| ID | Nivel | Una línea |
|---|---|---|
| `BLQ-MED-1` | MEDIO | **Tres mutantes sobreviven la suite 35/35 verde**, y uno produce un **falso verde end-to-end** |
| `BLQ-BAJO-1` | BAJO | Credencial **revocada** → `INALCANZABLE(2)`; **ausente** → `CONFIG(3)`. Mismo hecho, dos atribuciones |
| `BLQ-BAJO-2` | BAJO | Las filas 8/9 de la escalera **tapan** a las 10/11: 4 derivas reales salen bajo *"esto NO dice que el catálogo esté mal"* |
| `MNR-1` | MENOR | Un `/discover` que rompe su contrato con `200` sale como *"no contestó"* |
| `MNR-2` | MENOR | Los dos npm scripts son **el mismo comando sin `CHECK_MODE`** |

## El gate, corrido por el AR, árbol limpio

`tsc 0` · `lint 520` · `test 314/320` archivos · `6345/6364` casos. `6310 + 35 = 6345` cierra.

---

## 🔴 BLQ-MED-1 — Tres mutantes sobreviven, y uno da un FALSO VERDE end-to-end

Código sin defender: `check-catalog-vs-live.mjs:246-258` (las dos ramas `sin-dato` de
`evaluarCompletitud`) y `:518` (`obs.comparados += 1`).
El hueco: `test/check-catalog-vs-live.test.mjs:332-353` — T-C3 y T-C4 **siempre** pasan un
registro que ya trae `hasPayoutWallet: true`. Los únicos tests que tocan `sinDato` se lo inyectan
**directo a `classify`, saltándose la función que lo produce**.

| # | Mutante | Suite | Consecuencia |
|---|---|---|---|
| M8 | registro ausente → `completa` | **35 passed** 🟢 | una fila que el listado no devolvió se declara **sana** |
| M9 | registro sin el booleano → `completa` | **35 passed** 🟢 | **falso verde end-to-end** ↓ |
| M14 | `comparados += 1` arriba del `continue` | **35 passed** 🟢 | `comparados > 0` deja de significar "comparé algo" |

**El falso verde de M9, medido:**
```
exit=0  CONFORME: se comparó al menos un par y todo lo elegible está al día
        comparados=1 derivas=0 incompletas=0 sindato=0
```
contra el comportamiento actual, correcto, con el mismo input:
```
exit=3  CONFIG: no se pudo medir NI UNO de los elegibles — "no lo pude medir" no es "está bien"
        sindato=1
```

**Impacto**: la invariante que el propio docblock declara como razón de ser —*"un dato AUSENTE no
es un dato bueno; el exit 0 no puede afirmar lo que no se midió"*— **no tiene ningún test que la
defienda**. El día que alguien renombre `hasPayoutWallet`, la mitad de completitud pasa a exit 0
permanente **sin medir nada**, con un CONFORME diario. Es *un default que degrada en silencio: no
falla, MIENTE*.

**Y la asimetría muestra que es un olvido**: en la mitad de **deriva** el mismo mutante rompe T-J1
y T-J2. Un solo test end-to-end mata los tres, y **debe correr por `main()`, no por `classify()`**.

**Sobre el control positivo T-V2** (pregunta directa del encargo): en deriva es sólido —afirma
`llamadas` de longitud 2 y la URL del manifiesto—, pero **en completitud no existe**: M14 demuestra
que `comparados > 0` se satisface sin haber medido nada, con la suite verde.

---

## 🔴 BLQ-BAJO-1 — Una credencial revocada se reporta como caída de producción

`check-catalog-vs-live.mjs:460-464`. El propio docblock (`:23-26`) define:
`INALCANZABLE` = el otro no contestó · `CONFIG` = **yo no estoy en condiciones de preguntar**.

Un `401`/`403` de `/agents` significa que el otro lado **sí contestó y rechazó mi credencial** ⇒
`CONFIG` por definición propia. Y el script ya trata el caso hermano así: credencial **ausente**
sale `CONFIG(3)` nombrándola. **Ausente y revocada son el mismo hecho y salen por códigos distintos.**

```
/discover 200 · /agents 401 → exit=2 INALCANZABLE "(/agents 401) — esto NO dice que el catálogo esté mal"
                    esperado → exit=3 CONFIG "la credencial fue rechazada (401)"
```

**Impacto**: con la key rotada —operación rutinaria acá— el humano mira Railway en vez de rotar el
secret. Y la mitad de completitud queda **apagada para siempre** con un aviso diario que se lee
como blip transitorio. Es *acotar no es cerrar*: el agujero que el chequeo existe para tapar queda
sin medir.

---

## 🔴 BLQ-BAJO-2 — Colisión de la escalera: las filas 8/9 tapan a las 10/11

`check-catalog-vs-live.mjs:340-354`. El Dev escribió el principio correcto en el docblock de la
fila 10 —*"si coexisten manda la que cuesta dinero"*— y lo aplicó entre 10 y 11, **pero no a 8/9**,
que van antes y no acusan a nadie.

```
Caso H: 1 manifiesto caído + 4 derivas REALES
  exit=2 INALCANZABLE "… esto NO dice que el catálogo esté mal" | derivas=4
```

**El mensaje afirma que el catálogo está bien en la misma línea que dice `derivas=4`.** Quien
confía en el exit code —que es lo que AC-8 le pide— se pierde 4 derivas reales, y un solo
manifiesto flaky enmascara la señal todos los días.

**Contraste que prueba que es olvido y no diseño**: la colisión 10 vs 12 **sí** está bien resuelta
(1 sin-dato + 4 incompletas → `exit=5 INCOMPLETA`). La regla está bien aplicada abajo y no arriba.

---

## Lo que ataqué a fondo y NO rompió

**Seguridad — OK, las 5 mitigaciones existen y funcionan.**

| Vector | Medido |
|---|---|
| ¿El secreto viaja a PRs? | `if: github.event_name != 'pull_request'` en el job de completitud; **sin `pull_request_target`** |
| ¿Se nombra más de una vez? | 1 sola ocurrencia, y T-Y5 lo fija sobre el YAML real |
| ¿Sale por logs? | `emit()` no recibe la credencial ni nada derivado; mutarlo pone T-S2 rojo |
| ¿Puede mutar algo? | el fuente sin comentarios no contiene `POST\|PATCH\|DELETE\|PUT`; único `method:` es `GET` |
| Inyección en el log | **cerrada**: los slugs son server-derivados y `emit()` escribe la línea real al final; el step usa `tail -n 1` |

**Coste 0 USDC — verificado, no creído**: `/discover` no tiene `preHandler`; `requireA2AKey()` es
auth-only y **no debita**; el inventario congelado de rutas que cobran **no tiene ningún GET**.

**🎯 El guard de I-2 NO es decorativo — medido.** Inserté `verified: row.payout_wallet !== null`
en `mapRowToAgent` y corrí `tsc`:
```
L211: TS2339 Property 'payout_wallet' does not exist on type 'AgentRow'.
```
**La barrera es el tipo, no la buena voluntad.**

**`hasPayoutWallet` no filtra**: los 3 caminos que emiten el shape del dueño son owner-scoped, y
T-B2 lo verifica **por valor** (`not.toContain('So1111…')`), no sólo por clave. Sin enumeración.

**Nueve mutantes más, todos muertos por el motivo correcto** — incluidos los 3 del Dev,
reproducidos exactos. Dato útil: la fila 10 movida debajo de la 11 la mata **sólo** la aserción
pura, no la corrida e2e.

**Performance OK** (2 GET/día + hasta 5 manifiestos; `T-S3` fija las únicas URLs) ·
**Type Safety OK** · **Scope Drift OK** (1.766 líneas contra un techo de 2.200) ·
**Migraciones / RPC / Cache — N/A, revisadas y descartadas explícitamente.**

Sobre `AC-2` y `outputSchema`: la implementación no lo exige, y **está autorizado por contrato**
(la decisión D-1 lo saca con medición, lo deja contado en la línea y obliga a `T-C5`, que existe y
está verde). **Revisado y descartado: no es drift.**

---

## Orden del fix-pack

1. **`BLQ-MED-1`** — el test que mata M8/M9/M14. El más barato y el único **falso verde** demostrado.
2. **`BLQ-BAJO-1`** — partir `401/403` hacia `CONFIG(3)`.
3. **`BLQ-BAJO-2`** — resolver la colisión 8/9 vs 10/11.
4. `MNR-1`, `MNR-2` — no bloquean DONE.
