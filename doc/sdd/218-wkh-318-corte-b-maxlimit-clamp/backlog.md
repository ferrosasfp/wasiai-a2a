# Backlog abierto — WKH-318 corte B (HU 218)

Lo que el AR y el CR marcaron y **NO se implementó acá**, con dueño y gatillo.
Escrito en su propio archivo (y no sólo en la tabla de deuda del `sdd.md`) por el
motivo que dio el CR: *una deuda que sólo vive en el SDD de la HU que la creó
desaparece cuando la carpeta deja de leerse*.

| # | Qué queda abierto | Origen | Dueño / gatillo |
|---|---|---|---|
| **TD-318B-3** | `POST/PATCH /registries` guarda `schema` sin validar | SDD + CR M-12 | **HU propia — pedir número** |
| **TD-318B-6** | El marcador "NO aplicar" de las migraciones gated no tiene control mecánico | AR MNR-2 | **HU propia — pedir número** |

---

## TD-318B-3 — El guard de escritura que le da sentido al de lectura

**Sale de esta carpeta con esta entrada** (CR M-12: era la única deuda sin
gatillo, "el más cercano a un cajón").

`routes/registries.ts:69` sólo chequea la **presencia** de `schema` y `:251` lo
guarda tal cual, sin `zod` ni equivalente. La columna es `jsonb`, así que en
runtime `schema.discovery.maxLimit` puede llegar como `"100"`, `0`, `-5`, `1.5`,
`null` o `{}` — y por eso el corte B tuvo que montar un guard de **lectura**
(`isUsableRegistryMaxLimit`, con su parámetro `unknown` deliberado) y un warn
para avisar. Es la contracara exacta: el guard de lectura existe porque el de
escritura no.

**Criterio de cierre**: validar el `schema` en el write-path (mínimo:
`discovery.maxLimit` entero `>= 1` cuando está presente, `limitParam` y
`nextCursorPath` strings). Cuando exista, el `unknown` de
`isUsableRegistryMaxLimit` puede reevaluarse — **pero no borrarse a ciegas**: las
filas ya escritas antes de la validación siguen pudiendo tener basura.

**Por qué NO se hizo acá**: `src/routes/registries.ts` está fuera del Scope IN de
esta HU (CD del story file), y validar un write-path público es una superficie
propia con sus propios ACs (¿se rechaza con 400 o se sanea? ¿qué pasa con las
filas existentes? ¿rompe algún registrante actual?).

---

## TD-318B-6 — El marcador "NO aplicar" no tiene control mecánico

*(AR MNR-2 — evaluado en el fix-pack y NO implementado, a propósito)*

Las dos migraciones de esta HU llevan en la **línea 2** el marcador
`-- NO aplicar: la aplica el founder (accion gated, classifier)`. Es una
convención **sólo en prosa**, y este repo ya aprendió que eso no sobrevive
(`discover-callsites.test.ts` existe por exactamente esa lección). Peor: la
herramienta que se corre sobre esos archivos imprime hoy
`[PASS] Pre-flight OK — safe to apply` y sale **0**, o sea que afirma lo
contrario del marcador.

**Diseño propuesto** (para quien la tome, ya medido dónde va):
`scripts/migrate-preflight.mjs` ya lee el archivo entero en `main()` (`:1105`).
El chequeo es leer la línea 2 y, si matchea el marcador, hacer que `decide()`
devuelva un veredicto propio — algo como
`[GATED] founder-applied migration — preflight does NOT authorize applying it`.

**Por qué NO se hizo en el fix-pack** (decisión, no olvido):
1. `scripts/migrate-preflight.mjs` está **fuera del Scope IN** de esta HU.
2. Es una herramienta **compartida** por todas las migraciones del repo y tiene
   Constraint Directives propias que un cambio así activa: CD-FP1 (cada
   detección nueva viene con 2 fixtures) y CD-FP3 (ninguna severidad se relaja).
   Su suite es `test/migrate-preflight.test.ts`.
3. Cambiar el **exit code** para un archivo gated puede poner en rojo cualquier
   CI que hoy corra el preflight sobre todas las migraciones. Hay que decidir si
   el veredicto es exit 0 con texto distinto o exit ≠ 0, y esa decisión es de la
   HU que la tome, no de un fix-pack.

**Gatillo**: la próxima HU que toque `scripts/migrate-preflight.mjs`, o la
primera vez que una migración gated se aplique por accidente (que es lo que esto
previene, así que mejor la primera).
