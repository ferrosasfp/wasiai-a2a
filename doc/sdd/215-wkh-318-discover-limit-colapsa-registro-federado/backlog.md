# Backlog abierto — WKH-318

Hallazgos que el AR y el CR marcaron **explícitamente como "no lo toques ahora"**.
Quedan escritos acá para que no se pierdan al cerrar el corte A. Ninguno se
implementó en esta HU.

---

## B-1 — `discover({registry:'inexistente'})` devuelve `complete` sin haber consultado nada

*(AR MNR-6)*

Cuando el caller filtra a un registry que no existe, `getWithSecrets` devuelve
`undefined`, la lista de registries queda vacía, y el early-return declara
`catalogStatus: 'complete'`. Formalmente es coherente con la regla "sin fuentes no
hay nada que haya fallado" (`T-SRC-13` la fija), pero un caller que pidió una
fuente concreta y no la obtuvo está recibiendo un "catálogo completo" que no
contiene lo que pidió.

Candidato a resolverse igual que el resto de la HU: distinguir *no había a quién
preguntarle* de *le pediste algo que no existe*, probablemente con un 404/400 en
la ruta antes que con un estado de catálogo.

---

## B-2 — `nextCursorPath` es input semi-confiable y alimenta un lector que recorre la cadena de prototipos

*(CR, nota de seguridad para el corte B)*

`nextCursorPath` sale de una fila de `registries` que **cualquier caller
autenticado puede crear** (`POST /registries` entra con `enabled ?? true`,
`routes/registries.ts:253`), y se pasa a `getNestedValue`, que **recorre la cadena
de prototipos**: un path como `"constructor"` resuelve a algo siempre truthy, lo
que **fuerza `truncated`** en esa fuente.

Hoy el impacto es sólo de lectura, y quien puede crear un registro ya puede
inyectar agentes — o sea que no agrega un poder que no tuviera. **Con
`requireCompleteCatalog` (corte B) eso cambia de naturaleza: pasa a poder forzar
rechazos en el money-path.** Un registro creado por un tercero podría hacer que
toda request estricta sea rechazada.

Mitigaciones a evaluar cuando entre el corte B (ninguna aplicada acá):
- que `getNestedValue` no salga del objeto propio (`Object.hasOwn` por tramo), o
  un lector distinto para paths de configuración;
- validar `nextCursorPath` en el write-path de `POST/PATCH /registries`;
- que sólo un registro administrado pueda declarar `nextCursorPath`.

---

## B-3 — Tercera forma de truncamiento: el clamp silencioso del upstream

*(AR MNR-E, consecuencia medida)*

Si un registro **clampea en silencio** (le pedimos 200 y devuelve 100 sin cursor),
la página no se llena, así que la heurística `page_full` no dispara y —al haber
enviado un límite— el resultado se lee como evidencia de completitud: `state: 'ok'`.

El corte A no lo cubre. **W3 lo cierra** por construcción: con `maxLimit`
declarado se envía `min(over-fetch, maxLimit)`, la página se llena, y `page_full`
marca la fuente como `truncated`. Documentado en el docstring de
`RegistrySchema.discovery.maxLimit`.

---

## B-4 — Precondición de deploy, no comentario en un SQL

*(consecuencia de BLQ-1)*

Con el fix de BLQ-1 el código ya **no miente** sin la migración: reporta
`unverified` en vez de `complete`. Pero eso significa que, **hasta que
`20260730010000_wkh318_registry_next_cursor_path.sql` se aplique a bdwv**, el
camino sin `limit` de producción reporta `catalogStatus: 'unverified'`, y un
caller del corte B con `requireCompleteCatalog: true` sería **rechazado**.

Queda registrado como **precondición del corte B**, no del corte A: el corte A es
desplegable tal cual (sólo cambia lo que declara). La migración la aplica el
orquestador, sólo a **bdwv**, y F4 debería evidenciarla antes de habilitar el modo
estricto.
