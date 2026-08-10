# Implementation Log — WKH-345 (F3)

Rama `fix/222-wkh-345-uuid-param-validation`, worktree `/home/ferdev/.openclaw/workspace/wt-345`.
Todos los conteos los medí en esta sesión, con su commit al lado (P-14).

---

## Línea base (W0, primer acto)

```
git rev-parse --short HEAD → 2745bb2
npm test → Test Files 274 passed | 6 skipped (280)
           Tests  5391 passed | 19 skipped (5410)
```

**Línea base: `5391 passed | 19 skipped` @ `2745bb2`.**
No es el `5330 passed | 19 skipped` que circula: ése es de `b7fa4e7`.

---

## Las dos corridas del protocolo de dos pasos

| Paso | Wave | Commit | Test Files | Tests |
|---|---|---|---|---|
| **A** | W1 (sólo fixtures) | `c9bcee0` | 275 passed \| 6 skipped (281) | **5395 passed** \| 19 skipped (5414) |
| **B** | W3 (cierre) | `7862f88` (árbol limpio) | 1 failed \| 275 passed \| 6 skipped (282) | **2 failed** \| 5405 passed \| 19 skipped (5426) |

### Paso A — la evidencia de AC-5

W1 cambió **27 sitios** de path param en 5 archivos de test y **cero líneas** de
`src/routes/*.ts`. Control ejecutado:

```
git diff --name-only -- src/ | grep -v '\.test\.ts$'   → vacío
```

`src/lib/uuid.ts` ya existía en ese commit pero **ningún route lo importaba**: era
código inalcanzable a propósito, para que la medición separe "no cambié el camino
válido" de "moví el fixture hasta que pasó".

Contabilidad: 5391 + 4 (T-U1..T-U4) = **5395**. Todo el delta se explica por los
unitarios nuevos, o sea que **ningún test preexistente se movió** cuando los 27
path params pasaron a tener forma de UUID, con el código de producción de antes.
Eso es AC-5 medido, no prometido.

### Paso B — 2 rojos, y no son de esta wave

Los 2 fallos están en **`src/services/arbiter.test.ts`**, que **no está en el
Scope IN**. Ver "Bloqueante" abajo.

---

## Qué hizo cada wave

| Wave | Commit | Qué |
|---|---|---|
| **W0** | `af4e126` | `src/lib/uuid.ts` (extracción byte a byte de `tasks.ts:90-95`) + `src/lib/uuid.test.ts` (T-U1..T-U4). Ningún route lo importa todavía. |
| **W1** | `c9bcee0` | Sólo fixtures: 27 path params + los asertos que nombran ese mismo path param. |
| **W2** | `2d8168c` | 9 guards en 5 archivos de producción + 6 tests de ruta + `payments.uuid-param.test.ts` nuevo. |
| **W3** | — | Gates, mutación, censo, re-verificación de citas, estos documentos. |

### Los 9 guards, con su línea medida en `2d8168c`

| Archivo | Líneas | Respuesta |
|---|---|---|
| `src/routes/receipts.ts` | `:83`, `:114` | `400 { error_code: 'INVALID_INPUT' }` |
| `src/routes/auth/key-session.ts` | `:136`, `:195` | `400 { error_code: 'INVALID_INPUT' }` |
| `src/routes/auth/delegation.ts` | `:143` | `400 { error_code: 'INVALID_INPUT' }` |
| `src/routes/payments.ts` | `:262`, `:304`, `:357`, `:508` | `422 { error_code: 'INVALID_INPUT' }` |

`src/routes/tasks.ts` no lleva guard nuevo: ya tenía el suyo (`validateTaskId`).
Sólo dejó de declarar el predicado y ahora lo importa (`:76`).

### Desplazamiento real de `tasks.ts` (medido, no asumido)

El borrado del helper quita 7 líneas y el import agrega 1: **−6 netas**.

| Qué | En `2745bb2` | En `2d8168c` |
|---|---|---|
| `function validateTaskId` | `:127` | `:121` |
| `return { error: 'Invalid UUID format' }` | `:130` | `:124` |

`tasks.no-charge-before-validating.test.ts` (el pin de byte-identidad) **no se
tocó** y sigue verde.

---

## Mutación

Cada mutante se aplicó exigiendo que el `sha256sum` **difiera** antes de correr la
suite (R-1), se juzgó contra **mi** línea base (R-3), y se restauró probándolo con
`git diff` vacío (R-2). `src/lib/uuid.ts` original: `3595862d0c6383495edaf667a69757e1…`.

| ID | Mutante | `sha256sum` mutado | Esperado | **Medido** |
|---|---|---|---|---|
| **M-1** | `return UUID_RE.test(id)` → `return true` | `6ae64af867f67e00…` | T-U1 + 11 tests de ruta rojos | **15 rojos**: T-U1, los **9** tests de ruta de presencia (T-1a, T-1b, T-2a, T-2b, T-3, T-4a..T-4d) y **5 preexistentes de `tasks`**. T-4e y T-5 quedan verdes **por construcción** (ver abajo). |
| **M-2** | endurecer el patrón a v4 | `062d6ff27f4a7890…` | sólo T-U2 rojo | **13 rojos**: T-U2, **T-U4**, y **11 fuera de `uuid.test.ts`**. La expectativa era falsa: ver auto-blindaje #1. |
| **M-3** | flags `i` → `gi` | `c861d2f23de12a82…` | T-U3 rojo | **33 rojos**: T-U3 + 30 colaterales en 10 archivos + los 2 preexistentes. El `lastIndex` compartido rompiendo ids válidos, medido. |
| **M-4** (propio) | mover el guard **arriba** del gate de prefijo en `DELETE /key-session/:id` | `7472834d14892925…` (de `29770366321c21ff…`) | — | **T-5 rojo** (`400` donde espera `403`), **T-SUBSESSION verde**. Justifica el desvío de T-5. |

### Por qué M-1 da 9 y no 11

T-4e y T-5 **no pueden** morir con M-1, y eso es correcto: no son tests de
*presencia* del guard, son tests de su **orden**. Con el guard anulado, T-4e sigue
recibiendo el `404` del gate de `ARBITER_ENABLED` y T-5 sigue recibiendo el `403`
del gate de prefijo — que es exactamente lo que afirman. Mueren con el mutante
**contrario**, y M-4 lo demuestra para T-5. La expectativa "los 11 rojos" del
Story File mezcla dos familias de test.

Los 5 rojos extra de `tasks` bajo M-1 son señal buena: confirman que la
extracción quedó **cableada**, o sea que `tasks.ts` usa el predicado compartido y
no una copia.

---

## Gates

| Gate | Comando | Resultado |
|---|---|---|
| Tipos | `npx tsc --noEmit` | **limpio** (exit 0) |
| Lint | `biome check src/` | **limpio** — 476 archivos, 0 errores |
| Suite | `npm test` | **2 rojos**, los dos fuera del Scope IN |
| Ownership | `git diff --stat -- src/services/` | **vacío** |
| Un solo regex (AC-6) | `grep -rn "0-9a-f]{8}-" src/` | **1 sola ocurrencia de producción**: `src/lib/uuid.ts:51`. Las otras 5 son de test, con sus propios patrones más estrictos. |
| Censo de rutas | `grep -rl "\.params" src/routes/` | **16 archivos, conjunto idéntico** al de `2745bb2` (comparé los dos conjuntos, no sólo el total). Nada nuevo que evaluar. |

Sobre el gate de ownership: está vacío porque **no toqué ningún service**. El verde
de `test/ownership-filter-guard.test.ts` **no** es evidencia acá — verifica
presencia textual del filtro, no su valor, y deja los `supabase.rpc(...)` afuera,
que es justo la forma que usa `payments.ts`.

---

## Bloqueante — un 6º archivo con fixtures de W1, fuera del Scope IN

`src/services/arbiter.test.ts` inyecta 4 veces contra rutas de `payments.ts` con
`:id = 'i1'`, que no tiene forma de UUID. El censo de §5 no lo lista: enumera 20
sitios en 5 archivos, todos bajo `src/routes/`, y éste vive en `src/services/`.

| Sitio | Qué pide | Estado con el guard | Por qué |
|---|---|---|---|
| `:935` | `POST` dispute, flag **OFF**, espera `404` | **verde** | El gate del flag corre antes del guard. Es un testigo independiente de D-3 y de T-4e. |
| `:949` | `GET` dispute, flag OFF, espera `404` | **verde** | `GET` no lleva guard (P-5). |
| `:991` | `POST` dispute, flag **ON**, espera `200` | **ROJO** — recibe `422` | `'i1'` es un fixture de clase W1. |
| `:1010` | `POST` dispute, flag ON, espera `409 INTENT_NOT_OPEN` | **ROJO** — recibe `422` | ídem. |

**No lo arreglé**, y es deliberado: §2 dice "cualquier otro archivo está fuera; si
creés que hace falta tocar uno más, parás y escalás; no lo agregás de paso".

El arreglo es el mismo de W1 —`'i1'` → un id con forma de UUID en `:991` y
`:1010`— y son 2 líneas. Dos cosas que quien decida necesita saber:

1. Es **exactamente** el hallazgo de §5 ("el camino feliz viajaba por el mismo
   agujero"), una tercera vez y en un archivo que el censo no cubría.
2. Tocarlo hace que **`git diff --stat -- src/services/` deje de estar vacío**, o
   sea rompe el paso 4 de §9 tal como está redactado. La *intención* de ese paso
   es "no cambiaste lógica de propiedad", y un `url:` de fixture no es eso — pero
   el paso está escrito como un check mecánico, así que la excepción hay que
   declararla, no asumirla.

---

## Residuos

- **R-2 sigue ABIERTO** (P-6). `if (error || !data)` colapsa **todo** error de
  Postgres en `404`, no sólo el de forma: estaba en `payments.ts:387` en
  `2745bb2` y ahora está en **`:409`** (se corrió +22 por los guards de arriba).
  No lo toqué y no está arreglado.
- **R-3**: los 5 regex de UUID que quedan en `src/` son todos de test y ninguno es
  el guard de borde. Cuatro de ellos (`schema-preflight.test.ts:95`,
  `request-id.test.ts:33` y `:50`, `e2e.test.ts:30`) **sí** validan v4 sobre ids
  generados por el servicio, y unificarlos hacia el patrón laxo debilitaría
  asertos legítimos. `refund-idem.test.ts:81` usa el laxo. Ninguno se unifica.
- El `:id` de `GET /payments/session/:id/dispute` sigue **sin guard** (P-5).
- `src/routes/registries.ts`, `auth/identity.ts`, `inbound.ts`,
  `auth/require-signature.ts` y `auth/spend-policy.ts`: **no tocados**.
- `src/routes/dashboard.ts` sigue con el mismo bug estructural en sus 4
  `:intentId`, tras `requireAdminTokenStrict`. Scope OUT (P-7), fast-follow.
