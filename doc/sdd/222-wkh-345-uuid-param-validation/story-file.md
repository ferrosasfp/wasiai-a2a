# Story File — [WKH-345] Un `:id` mal formado devuelve 500 en vez de 400/422

> **Contrato autocontenido para el Dev (F3).** Producto de F2.5 (nexus-architect),
> sobre `sdd.md` aprobado con `SPEC_APPROVED` el 2026-08-10.
>
> **Si algo no está acá, no está en el alcance.** No hace falta leer el work-item
> ni el SDD para implementar; están al lado si querés el porqué largo.
>
> Todo `archivo:línea` de este documento se verificó con `python3` sobre el árbol
> al commit **`2745bb2`**. **Verificá vos también con `python3` o `Read` — nunca
> con `cat -n`**: el proxy de CLI de este entorno trunca la salida redirigida y ya
> le corrió cuatro citas a otro architect.

---

## 1. Qué se construye y por qué

Un `:id` mal formado (`abc`, `sess-1`, `i1`) viaja sin validar hasta una columna
`uuid` de Postgres, que responde `22P02 invalid input syntax for type uuid`.
Ninguna de las cuatro superficies traduce ese error, así que el caller recibe un
**500** donde corresponde un 4xx.

Se agrega un guard de **forma** en el borde HTTP de 5 archivos de ruta, reusando el
predicado que `src/routes/tasks.ts:91-95` ya tiene y que hoy es privado de ese
módulo — extraído a `src/lib/uuid.ts`.

**No digas que esto "elimina" el 500.** La línea que lo restaura, en las cinco
superficies a la vez, es una sola: en `src/lib/uuid.ts`,
`return UUID_RE.test(id)` → `return true`. Por eso hay tests unitarios **además**
de los de ruta. Si escribís una frase con "elimina" / "cierra" / "ya no puede
pasar", nombrá al lado el mutante de una línea que la restauraría; si podés
nombrarlo, la frase no puede decir "elimina".

**Contexto**: David, mentor de la incubadora Solana LATAM Labs, revisa este repo y
su API pública. Esto es lo primero que toca un integrador que se equivoca al
tipear.

**Sin migración. Sin cambio de esquema. Sin variable de entorno nueva.**

---

## 2. Scope IN — lista exhaustiva de archivos

### Producción (6)

| # | Archivo | Acción |
|---|---|---|
| 1 | `src/lib/uuid.ts` | **NUEVO** — el predicado compartido |
| 2 | `src/routes/tasks.ts` | Borrar el helper local, importar el compartido |
| 3 | `src/routes/receipts.ts` | Guard ×2 → `400 { error_code: 'INVALID_INPUT' }` |
| 4 | `src/routes/auth/key-session.ts` | Guard ×2 → `400 { error_code: 'INVALID_INPUT' }` |
| 5 | `src/routes/auth/delegation.ts` | Guard ×1 → `400 { error_code: 'INVALID_INPUT' }` |
| 6 | `src/routes/payments.ts` | Guard ×4 → `422 { error_code: 'INVALID_INPUT' }` |

### Tests (8)

| # | Archivo | Acción |
|---|---|---|
| 7 | `src/lib/uuid.test.ts` | **NUEVO** — T-U1..T-U4 |
| 8 | `src/routes/payments.uuid-param.test.ts` | **NUEVO** — T-4a..T-4e (por qué archivo nuevo: §6, W2e) |
| 9 | `src/routes/receipts.test.ts` | Fixtures (W1) + T-1a, T-1b (W2) |
| 10 | `src/routes/auth.key-session.test.ts` | Fixtures (W1) + T-2a (W2) |
| 11 | `src/routes/auth.signed-auth.test.ts` | Fixtures (W1) + T-2b (W2) |
| 12 | `src/routes/auth.delegation.test.ts` | Fixtures (W1) + T-3 (W2) |
| 13 | `src/routes/payments.test.ts` | **Sólo fixtures** (W1). No se le agregan tests. |
| 14 | `src/routes/tasks.no-charge-before-validating.test.ts` | **NO SE TOCA.** Es el pin de byte-identidad de `tasks.ts`. |

### Documentos (2)

| # | Archivo | Acción |
|---|---|---|
| 15 | `doc/sdd/222-.../auto-blindaje.md` | **NUEVO, obligatorio** — tus propios errores de F3. Las dos HUs más recientes lo tienen (`221-…` y `219-wkh-342-…`, `2745bb2`). |
| 16 | `doc/sdd/222-.../implementation-log.md` | **NUEVO** — el registro de las waves, con los DOS resultados de suite (W1 y W3) y sus commits. El nombre varía entre HUs (`219-…` usa `implementation-log.md`, `221-…` usa `_INDEX-row.md` + `mutation-log.md`); usá `implementation-log.md` salvo que el orquestador pida otro. |

⚠️ La fila 222 de `doc/sdd/_INDEX.md` **ya la insertó el orquestador**. No la
re-escribas ni reconstruyas el archivo (125 KB, con líneas de >3000 caracteres).

**Cualquier otro archivo está fuera.** Si creés que hace falta tocar uno más,
**parás y escalás**; no lo agregás de paso.

---

## 3. Anti-Hallucination Checklist — específico de esta HU

Antes de escribir una línea, confirmá con `Read`/`python3` que estas 12
afirmaciones siguen siendo ciertas. Si alguna falló, **pará y escalá**: alguien
movió el árbol y el plan hay que revisarlo, no adaptarlo sobre la marcha.

| # | Afirmación (medida en `2745bb2`) | Cómo la confirmás |
|---|---|---|
| 1 | `src/routes/tasks.ts:90-95` es exactamente el bloque a extraer: `:90` comentario, `:91-92` el regex, `:93-95` la función | `Read` `tasks.ts` 88-96 |
| 2 | `UUID_RE` en `tasks.ts:91-92` es `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` — **sin** `4` de versión, **sin** `[89ab]` de variant, flags `i` solamente | ídem |
| 3 | `src/routes/tasks.ts:130` es `return { error: 'Invalid UUID format' };` — el body que **no** se toca | `Read` |
| 4 | `tasks.no-charge-before-validating.test.ts:519` y `:536` afirman ese string exacto | `Read` |
| 5 | `src/lib/` existe, es plano, con tests colocados; **no existe** `src/utils/` | `ls src/lib/ \| head`, `ls src/` |
| 6 | `src/lib/url-validator.ts` + `url-validator.test.ts` existen (el precedente de validador puro) | `ls` |
| 7 | `src/lib/` no importa nada de `src/routes/` (es hoja) | `command grep -rn "from '\.\./routes" src/lib/` → **vacío** |
| 8 | `key-session.ts:59` y `:177` ya responden `400 { error_code: 'INVALID_INPUT' }` | `Read` |
| 9 | `delegation.ts:74`, `:78`, `:81`, `:87` ya responden `400 { error_code: 'INVALID_INPUT' }` | `Read` |
| 10 | `payments.ts:204`, `:259`, `:430`, `:488` responden `422 { error_code: 'INVALID_INPUT' }` | `Read` |
| 11 | `receipts.ts` **no tiene ningún 400** hoy: sus 4xx son `403` (`:57`, `:75`, `:101`) y `404 RECEIPT_NOT_FOUND` (`:83`, `:111`) | `Read` |
| 12 | Los 20 fixtures de la tabla de §5 siguen teniendo esos valores en esas líneas | `command grep -n` sobre los 5 archivos |

**Y tres cosas que NO existen y no hay que buscar:**

- No hay `ajv-formats` en `package.json` → `schema: { params: { format: 'uuid' } }`
  de Fastify **no valida nada**, Ajv ignora `format` sin ese plugin. Prohibido usar
  esa vía (CD-14).
- No hay script `npm run typecheck`. El tipado de tests se hace con
  `npx tsc --noEmit` (usa `tsconfig.json`, que **sí** incluye `src/**/*.test.ts`);
  `npm run build` usa `tsconfig.build.json`, que los **excluye**.
- No hay una tabla `uuid_params` ni nada por el estilo. Esta HU no toca la base.

---

## 4. Las cuatro decisiones que ya están tomadas — no las re-abras

### D-1 · El helper va en `src/lib/uuid.ts`

```ts
export const UUID_RE: RegExp;              // idéntico a tasks.ts:91-92
export function isValidUUID(id: string): boolean;
```

Se descartó `src/routes/auth/parsers.ts` (donde vive hoy lo compartido entre
rutas): obligaría a `receipts.ts`, `payments.ts` y `tasks.ts` a importar desde
`src/routes/auth/`, o sea `routes → routes/auth`, dirección equivocada para tres
archivos que no tienen nada que ver con auth. Se descartó `src/utils/` porque no
existe, y `src/types/` porque ahí no vive lógica.

Imports (ESM NodeNext, con extensión `.js`): `../lib/uuid.js` desde
`src/routes/*.ts`; `../../lib/uuid.js` desde `src/routes/auth/*.ts`.

### D-2 · Cada archivo emite el código que YA emite. El resultado NO es uniforme, a propósito.

| Archivo | Respuesta al `:id` malformado | De dónde sale |
|---|---|---|
| `tasks.ts` | **`400 { error: 'Invalid UUID format' }` — SIN CAMBIO** | Contrato con dos testigos (`:519`, `:536`) |
| `auth/key-session.ts` | `400 { error_code: 'INVALID_INPUT' }` | El que el archivo ya emite (`:59`, `:177`) |
| `auth/delegation.ts` | `400 { error_code: 'INVALID_INPUT' }` | El que el archivo ya emite (`:74`, `:78`, `:81`, `:87`) |
| `payments.ts` | `422 { error_code: 'INVALID_INPUT' }` | El que el archivo ya emite (`:204`, `:259`, `:430`, `:488`) |
| `receipts.ts` | `400 { error_code: 'INVALID_INPUT' }` | El único que elige de cero. `error_code: 'INVALID_INPUT'` aparece 37 veces en 10 archivos de ruta contra 4 de `'Invalid UUID format'` en uno solo (`2745bb2`), y los rechazos no-auth de `receipts.ts` ya usan `error_code` |

⚠️ **La trampa**: uniformar los cuatro a un mismo código se lee mejor en un
documento y **es un cambio de contrato** en superficies que hoy responden distinto.
Quedan tres shapes (`400 {error}`, `400 {error_code}`, `422 {error_code}`) y eso es
la decisión, no la deuda. **PROHIBIDO uniformar.**

### D-3 · El guard va DESPUÉS de todo gate existente, no antes

El SDD del work-item decía "antes de auth", copiando el lugar de `tasks.ts`. En
`tasks.ts` ese lugar es correcto porque ahí el guard tiene que estar antes del
**cobro** (`:166`, cadena pre-cobro): su razón es el dinero. Ninguna de estas cinco
superficies cobra en el handler, así que la razón no se transfiere.

**Regla**: después del último gate que ya existe (flag de feature → prefijo de
autenticador prohibido → auth), y antes de la primera expresión que pasa el `:id`
a un service, RPC o query.

**Las dos consecuencias verificables de hacerlo al revés** — están acá para que no
lo "arregles" de vuelta:

1. **Antes del gate de sub-sesión**: `auth.key-session.test.ts:161` (T-SUBSESSION)
   inyecta `DELETE /auth/key-session/sess-1` con un token de sesión y espera
   `403 SESSION_NOT_ALLOWED` + `expect(mockLookupByHash).not.toHaveBeenCalled()`
   (`:172`). Con el guard primero **ese test se pone rojo**, y el fondo es peor que
   el test: darías feedback de forma a un autenticador explícitamente prohibido.
2. **Antes del gate de flag en `POST /payments/session/:id/dispute`**: hoy con
   `ARBITER_ENABLED` apagado la ruta responde `404 { error_code: 'NOT_FOUND' }`, y
   el comentario `payments.ts:322-324` dice que el gate es lo PRIMERO a propósito,
   byte-idéntico a "no existe". Con el guard antes, un `:id` malformado con el flag
   apagado devolvería `422` y **anunciaría que la ruta existe**. Eso es una
   regresión de disclosure, no un detalle de orden. **T-4e lo fija.**

### D-4 · Se comparte el PREDICADO, nunca el respondedor

`src/lib/uuid.ts` exporta `isValidUUID` y `UUID_RE`, y **nada que toque `reply`**.
Un helper `rejectInvalidUUID(reply, id)` necesitaría parámetros de status y body, y
el próximo que lo lea va a "simplificar" los parámetros: ése es el mecanismo exacto
por el que los cuatro contratos de D-2 derivan hacia uno solo. Tres líneas repetidas
cinco veces es más barato que un contrato uniformado por accidente.

Forma canónica del guard (adaptá el status/body según D-2):

```ts
// WKH-345: forma del `:id` ANTES de la capa de datos. Sin esto el valor llega a
// una columna `uuid` y Postgres responde 22P02 → 500.
if (!isValidUUID(req.params.id)) {
  return reply.status(400).send({ error_code: 'INVALID_INPUT' });
}
```

---

## 5. El hallazgo que ordena las waves — 20 fixtures viajaban por el agujero

Medido en `2745bb2`. **Ninguno de estos 20 valores tiene forma de UUID**, y todos
están en rutas que reciben el guard:

| Archivo | Líneas de `url:` | Valor |
|---|---|---|
| `src/routes/receipts.test.ts` | `:152`, `:173` | `rcpt-1` |
| `src/routes/receipts.test.ts` | `:189`, `:203` | `other-owner-rcpt` |
| `src/routes/auth.key-session.test.ts` | `:122`, `:152`, `:164` | `sess-1` |
| `src/routes/auth.key-session.test.ts` | `:137` | `sess-999` |
| `src/routes/auth.signed-auth.test.ts` | `:236`, `:267`, `:281` | `sess-1` |
| `src/routes/auth.signed-auth.test.ts` | `:252` | `sess-x` |
| `src/routes/auth.delegation.test.ts` | `:310` | `del-1` |
| `src/routes/auth.delegation.test.ts` | `:325` | `del-999` |
| `src/routes/payments.test.ts` | `:153`, `:169`, `:203`, `:281`, `:304`, `:342` | `i1` |

**Aserciones que repiten el mismo string y también hay que cambiar** (`2745bb2`):

- `auth.key-session.test.ts:128` y `:158` — `expect(mockRevoke).toHaveBeenCalledWith('sess-1', 'user-1')`
- `auth.delegation.test.ts:316` — `expect(mockRevoke).toHaveBeenCalledWith('del-1', 'user-1')`
- `auth.signed-auth.test.ts:243` — `expect(mockSessionSetReqSig).toHaveBeenCalledWith('sess-1', 'user-1', true)`
- `payments.test.ts` — las que nombren `'i1'`; buscalas con `grep`, no de memoria.

⚠️ **NO hagas un find/replace ciego de `'sess-1'`.** En
`auth.signed-auth.test.ts:296` y `:352` ese mismo string es un **campo de body**
(`session_id: 'sess-1'`), no un path param: el guard no lo alcanza y cambiarlo sólo
agrega ruido al diff. Sitio por sitio, mirando si el string está en una `url:` o en
un payload.

### Esto es un PATRÓN del proyecto, no una anécdota

El camino "feliz" de esas cinco suites **viajaba por el mismo agujero que esta HU
arregla**, y hoy ninguna de ellas prueba la ruta con un id que la base aceptaría.
Es la **segunda vez** que aparece: la anterior fue un fixture del caso positivo que
omitía justo el campo que el guard comparaba
(`doc/sdd/219-wkh-342-supported-payout-route-probe/auto-blindaje.md`, Wave 2: el
test afirmaba sobre un mecanismo que su propio input desactivaba, y daba verde).

La regla que se sigue de ahí, y que aplica a **todos** los tests que escribas en
esta HU: un test que afirma una **ausencia** (`not.toHaveBeenCalled`) sólo mide algo
si en ese mismo fixture el mock **sí se llama** en el caso positivo. Un candado
sobre un conjunto vacío aplaude cualquier implementación.

---

## 6. Waves

### W0 — serial. Bloquea todo lo demás.

**Antes de tocar nada: medí la línea base.**

```bash
npm test          # NO `npx vitest run`: colapsa la salida y se pierden skipped/Test Files
git rev-parse --short HEAD
```

Anotá el resultado **con ese commit en la misma línea**. ⚠️ **No copies ningún
número de otra HU ni del SDD**: el SDD de esta HU **a propósito no tiene línea
base** medida, justamente para que no la copies. El `5330 passed | 19 skipped`
que anda dando vueltas es de `b7fa4e7`, no de hoy.

| Archivo | Qué hacer |
|---|---|
| `src/lib/uuid.ts` | **NUEVO.** Exporta `UUID_RE` (copiado byte a byte de `tasks.ts:91-92`) e `isValidUUID`. Docblock obligatorio: qué valida (**forma** de UUID, 8-4-4-4-12 hex, case-insensitive), **qué NO valida** (versión y variant — ver M-2), de dónde salió (WKH-345, extraído de `tasks.ts`), por qué no lleva flag `g` (M-3) y por qué no exporta un respondedor (D-4). |
| `src/lib/uuid.test.ts` | **NUEVO.** T-U1..T-U4 de §7. |

⛔ **PROHIBIDO** describir el regex como "valida UUID v4" en el docblock, en un
comentario o en el reporte. No valida versión ni variant.

### W1 — serial. **Es una MEDICIÓN, no una tarea.**

Esto es lo que más se erosiona y es lo que hace que AC-5 tenga evidencia en vez de
promesa. **Leelo dos veces:**

> En W1 se cambian **SÓLO los fixtures de test**. **Cero líneas de
> `src/routes/*.ts`.** Después se corre la suite completa. **Ese verde ES la
> evidencia de AC-5**: prueba que las cuatro superficies se comportan igual con un
> id que la base aceptaría, **con el código de producción de antes**.
>
> Si mezclás W1 y W2 en un solo paso, el verde final **no distingue** "no cambié el
> camino válido" de "moví el fixture hasta que pasó". Son dos conclusiones opuestas
> con la misma salida.

| Archivo | Qué |
|---|---|
| `src/routes/receipts.test.ts` | `url:` en `:152`, `:173`, `:189`, `:203` |
| `src/routes/auth.key-session.test.ts` | `url:` en `:122`, `:137`, `:152`, `:164` + aserciones `:128`, `:158` |
| `src/routes/auth.signed-auth.test.ts` | `url:` en `:236`, `:252`, `:267`, `:281` + aserción `:243`. **NO tocar `:296` ni `:352`** (body, §5) |
| `src/routes/auth.delegation.test.ts` | `url:` en `:310`, `:325` + aserción `:316` |
| `src/routes/payments.test.ts` | `url:` en `:153`, `:169`, `:203`, `:281`, `:304`, `:342` + las aserciones con `'i1'` |

Usá ids con forma de UUID y **legibles**, del estilo del que ya usa el repo
(`tasks.no-charge-before-validating.test.ts:322` = `'11111111-2222-4333-8444-555555555555'`).
Sugerencia: `'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'` para el "1",
`'99999999-9999-4999-8999-999999999999'` para el "999".

**Cierre de W1, obligatorio:**

```bash
git diff --stat -- src/          # tiene que listar SÓLO archivos *.test.ts
npm test                         # VERDE. Anotar conteo + commit.
```

Si `git diff --stat -- src/` lista un archivo que no termina en `.test.ts`, W1 está
contaminada: revertí ese archivo y volvé a correr. Si `npm test` sale **rojo** en
W1, hay un supuesto equivocado en algún mock y **AC-5 no está probado** — parás y
lo resolvés; **no adaptás el fixture hasta que pase**.

### W2 — paralelizable. 5 archivos de producción independientes.

#### W2a · `src/routes/tasks.ts`

- Borrar `:90-95` (el comentario `// ── UUID validation helper ──`, `UUID_RE` y
  `isValidUUID`).
- Agregar `import { isValidUUID } from '../lib/uuid.js';` en el bloque de imports
  (biome ordena; dejalo correr).
- **NO tocar** `validateTaskId` (`:127-133`) ni sus 4 call-sites (`:166`, `:307`,
  `:344`, `:412`). **NO tocar** el body `{ error: 'Invalid UUID format' }`.
- **NO tocar** `tasks.no-charge-before-validating.test.ts`: es el pin.

⚠️ Ese borrado quita 6 líneas (más quizás una línea en blanco que quede duplicada).
**Todas las citas a `tasks.ts` por debajo de `:95` se corren hacia arriba.** Medí el
desplazamiento real con `git diff` — no asumas −6 — y aplicalo en el cierre (§9,
paso 5).

#### W2b · `src/routes/receipts.ts` — 2 guards, `400 { error_code: 'INVALID_INPUT' }`

| Handler | Va DESPUÉS de | Va ANTES de |
|---|---|---|
| `GET /:id` | el `403` de auth, `:74-76` | `receiptService.getById` en `:78` |
| `GET /:id/verify` | el `403` de auth, `:100-102` | `receiptService.getById` en `:106` |

#### W2c · `src/routes/auth/key-session.ts` — 2 guards, `400 { error_code: 'INVALID_INPUT' }`

| Handler | Va DESPUÉS de | Va ANTES de |
|---|---|---|
| `DELETE /key-session/:id` | el `403` de auth, `:126-128` | el `try` de `:130` / `revoke` en `:131` |
| `PATCH /key-session/:id/require-signature` | la validación de body, `:175-178` | el `try` de `:181` / `setRequireSignature` en `:182-183` |

> Por qué en el `PATCH` va **después** del body y no antes: ese handler responde
> `400 INVALID_INPUT` al body (`:177`) y más abajo `400 FUNDING_WALLET_NOT_BOUND`.
> Mantener el body primero preserva el orden actual sin tener que decidir cuál gana.

#### W2d · `src/routes/auth/delegation.ts` — 1 guard, `400 { error_code: 'INVALID_INPUT' }`

| Handler | Va DESPUÉS de | Va ANTES de |
|---|---|---|
| `DELETE /delegation/:id` | el `403` de auth, `:135-137` | el `try` de `:139` / `revoke` en `:140` |

#### W2e · `src/routes/payments.ts` — 4 guards, `422 { error_code: 'INVALID_INPUT' }`

| Handler | Va DESPUÉS de | Va ANTES de |
|---|---|---|
| `POST /session/:id/voucher` | el `403` de auth, `:253-255` | la validación de body, `:258` |
| `POST /session/:id/close` | el `403` de auth, `:290-292` | `extractDebitCapture`, `:295` |
| `POST /session/:id/dispute` | el `403` de auth, `:335-337` — que a su vez va **después** del gate `isArbiterEnabled()` de `:331-333` | el `try` de `:338` / `openDispute` en `:339-340` |
| `POST /upto/:id/settle` | el `403` de auth, `:482-484` | la validación de body, `:487` |

En los tres donde el guard queda antes de la validación de body, el orden entre los
dos es **inobservable**: ambos responden el mismo `422 { error_code: 'INVALID_INPUT' }`.
No hay una decisión de contrato escondida ahí.

⛔ **`GET /session/:id/dispute` (`:364-409`) NO lleva guard.** Hoy un id malformado
sale por `404` (`:387-388`), no por 500: no hay bug, ninguna AC lo cubre, y
agregarlo cambiaría `404 → 422` en un endpoint que funciona. **No lo toques.**

**El archivo de test de W2e es NUEVO: `src/routes/payments.uuid-param.test.ts`.**
Motivo: `payments.test.ts` mockea `paymentIntentService` (`:13-21`) pero **no**
`arbiterService`, y T-4c/T-4e necesitan espiar `openDispute` y manejar
`ARBITER_ENABLED`. Agregar un `vi.mock` nuevo a `payments.test.ts` perturbaría el
grafo de mocks de 20+ tests que ya andan. Un archivo dedicado por HU es la
convención acá (`payments.dispute-ownership.test.ts`,
`tasks.no-charge-before-validating.test.ts`). `vitest.config.ts:5` ya incluye
`src/**/*.test.ts`, así que no hay config que tocar y
`test/test-files-are-run-in-ci.test.ts` no necesita excepción.

### W3 — serial. Cierre.

Ver §9.

---

## 7. Tests requeridos — cada uno con el mutante que lo pone rojo

Un test que no puede nombrar el mutante de una línea que lo mata no está midiendo
nada. La columna "mutante" no es decorativa: la vas a usar en §8.

### Unitarios — `src/lib/uuid.test.ts` (W0)

| ID | Afirma | Mutante de UNA línea que lo pone rojo | AC |
|---|---|---|---|
| **T-U1** | `isValidUUID('not-a-uuid')`, `isValidUUID('')`, `isValidUUID('sess-1')`, `isValidUUID('i1')` → `false`. Y un UUID con forma válida → `true` (control positivo) | `return UUID_RE.test(id)` → `return true` | AC-6 |
| **T-U2** | `isValidUUID('00000000-0000-0000-0000-000000000000')` → **`true`**. El nil UUID pasa: el predicado es de FORMA, no de versión | endurecer el patrón a v4: `[0-9a-f]{4}-[0-9a-f]{4}-` → `4[0-9a-f]{3}-[89ab][0-9a-f]{3}-` | AC-6 |
| **T-U3** | `expect(UUID_RE.flags).toBe('i')` | agregar `g` a los flags | — |
| **T-U4** | `isValidUUID('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')` → `true` (case-insensitive) | borrar el flag `i` | AC-1..AC-4 |

### De ruta (W2)

Patrón: Fastify in-process + `vi.mock` del service, como
`src/routes/receipts.test.ts:26-49`. **Los dos asertos son obligatorios**: el
**status** y `expect(mockX).not.toHaveBeenCalled()`. El segundo es lo único que mata
el mutante "mover el guard adentro del `try`".

| ID | Archivo | Petición | Espera | AC |
|---|---|---|---|---|
| **T-1a** | `receipts.test.ts` | `GET /receipts/not-a-uuid` | `400 { error_code: 'INVALID_INPUT' }` **y** `mockGetById` (`:48`) no llamado | AC-1 |
| **T-1b** | `receipts.test.ts` | `GET /receipts/not-a-uuid/verify` | idem **y** `mockGetById` + `mockVerify` (`:49`) no llamados | AC-1 |
| **T-2a** | `auth.key-session.test.ts` | `DELETE /auth/key-session/not-a-uuid` | `400 { error_code: 'INVALID_INPUT' }` **y** `mockRevoke` (`:68`) no llamado | AC-2 |
| **T-2b** | `auth.signed-auth.test.ts` | `PATCH /auth/key-session/not-a-uuid/require-signature` con `{ require_signature: true }` | `400 { error_code: 'INVALID_INPUT' }` **y** `mockSessionSetReqSig` (`:80`) no llamado | AC-2 |
| **T-3** | `auth.delegation.test.ts` | `DELETE /auth/delegation/not-a-uuid` | `400 { error_code: 'INVALID_INPUT' }` **y** `mockRevoke` (`:69`) no llamado | AC-3 |
| **T-4a** | `payments.uuid-param.test.ts` | `POST /payments/session/not-a-uuid/voucher`, body válido | `422 { error_code: 'INVALID_INPUT' }` **y** `addVoucher` no llamado | AC-4 |
| **T-4b** | `payments.uuid-param.test.ts` | `POST /payments/session/not-a-uuid/close` | `422` **y** `closeSession` no llamado | AC-4 |
| **T-4c** | `payments.uuid-param.test.ts` | `POST /payments/session/not-a-uuid/dispute`, `ARBITER_ENABLED='true'` | `422` **y** `openDispute` no llamado | AC-4 |
| **T-4d** | `payments.uuid-param.test.ts` | `POST /payments/upto/not-a-uuid/settle`, body válido | `422` **y** `settleUpto` no llamado | AC-4 |
| **T-4e** | `payments.uuid-param.test.ts` | `POST /payments/session/not-a-uuid/dispute` con `ARBITER_ENABLED` **apagado** | **`404 { error_code: 'NOT_FOUND' }`**, NO `422`. Mutante que lo mata: mover el guard antes de `isArbiterEnabled()` (`:331`) | D-3 |
| **T-5** | `auth.key-session.test.ts` | `DELETE /auth/key-session/<uuid-válido>` con `SESSION_TOKEN` (`:71`) como autenticador | `403 SESSION_NOT_ALLOWED` **y** `mockLookupByHash` (`:67`) no llamado. Mutante: mover el guard antes del gate de prefijo | D-3 |

**Cómo construir `payments.uuid-param.test.ts`** (verificado en `2745bb2`):

- `buildApp()` registra con `prefix: '/payments'`, igual que `payments.test.ts:65-70`.
- Mockear `../services/payment-intent.js` con el patrón de `payments.test.ts:13-28`
  (`vi.hoisted` + `importActual` + reemplazar `paymentIntentService`), quedándote con
  los spies de `addVoucher`, `closeSession`, `settleUpto`.
- Mockear `./auth/parsers.js` para `resolveCallerKey` (patrón `payments.test.ts:30-33`),
  devolviendo `{ is_active: true, owner_ref: 'tenant-A', funding_wallet: … }`.
- Mockear `../services/arbiter.js` **sólo el `arbiterService`**, manteniendo el
  `isArbiterEnabled` REAL vía `importActual`. `payments.ts:24` importa los dos de ahí.
  ⚠️ Si mockeás también `isArbiterEnabled`, **T-4e pasa a testear tu mock en vez del
  gate real** y deja de medir nada.
- Manejar `ARBITER_ENABLED` por env con backup/restore, como
  `payments.dispute-ownership.test.ts:108`, `:125-128` y `:145-148`.

**AC-5 no lleva test nuevo: lo prueba el verde de W1** (§6). Un test escrito
*después* del cambio que afirme "el id válido se comporta igual" sería un guard que
se compara consigo mismo: sólo puede confirmar lo que el cambio hizo.

**AC-6** lo cubren T-U1..T-U4 más esta verificación mecánica en W3:

```bash
command grep -rn "0-9a-f]{8}-" src/
```

Tiene que devolver **una sola** ocurrencia de producción, en `src/lib/uuid.ts`.
`src/__tests__/e2e/e2e.test.ts:30` tiene su **propio** regex, distinto y más
estricto (ése **sí** valida v4), y afirma sobre un `request-id` que el servicio
genera (`:93`). **No es una duplicación del guard de borde y NO se unifica** —
unificarlo hacia el regex laxo debilitaría un aserto legítimo. Está declarado como
residuo R-3 justamente para que no lo leas como violación de "un solo regex".

### El control positivo obligatorio

Los 11 tests de ruta afirman **ausencias**. Antes de darlos por buenos: cada archivo
tiene que conservar (o tener) su caso **positivo**, con un id de forma válida que
**sí** llegue al mock. Los tests refixtureados en W1 son exactamente ese control.
Verificación barata: al aplicar el mutante de M-1, el test negativo **y** el positivo
tienen que moverse. Si **ninguno** se mueve, el fixture está vacío y el candado no
mide nada (§5, el patrón).

---

## 8. Protocolo de mutación — cómo NO engañarte solo

Vas a aplicar al menos el mutante M-1 para probar que los candados existen. Tres
reglas, y las tres nacieron de errores reales de este repo:

### R-1 · Antes de correr la suite sobre un mutante, exigí que el archivo HAYA CAMBIADO

> Un mutante **no aplicado** y un mutante que **sobrevive** dan exactamente la misma
> salida verde, y la conclusión de cada uno es la opuesta. Ya nos pasó.

```bash
# ANTES de editar
sha256sum src/lib/uuid.ts
# ... aplicás el mutante ...
# DESPUÉS de editar — el hash TIENE que ser distinto
sha256sum src/lib/uuid.ts
```

Si el hash es el mismo, **no corras la suite**: el mutante no se aplicó y cualquier
lectura del resultado es falsa.

### R-2 · La restauración se prueba con `git diff` contra HEAD, no con un respaldo

```bash
git diff -- src/lib/uuid.ts     # vacío ⇒ restaurado
```

⛔ **No uses un respaldo en el scratchpad** para restaurar ni para verificar: ese
directorio puede desaparecer entre dos comandos y te deja sin original y sin señal.

### R-3 · Un mutante se juzga contra TU línea base, no contra la de otra HU

El baseline es el que mediste en W0, con su commit. Si el conteo de la corrida
mutada se compara contra un número de otra HU, la clasificación sale al revés
(sobrevivió/murió invertidos).

### El mutante mínimo obligatorio

| ID | Mutante | Esperado |
|---|---|---|
| **M-1** | `src/lib/uuid.ts`: `return UUID_RE.test(id)` → `return true` | **T-U1 rojo + los 11 tests de ruta rojos.** Si algún grupo queda verde, ese grupo no estaba midiendo el guard — arreglá el test, no el mutante. |
| **M-2** (recomendado) | `src/lib/uuid.ts`: endurecer el patrón a v4 | **Sólo T-U2 rojo.** Si T-U2 también queda verde, T-U2 no está midiendo nada: el resto de la suite **no ve** este mutante (todos los ids del repo salen de `gen_random_uuid()`, que es v4), y ése es justamente el punto. |
| **M-3** (recomendado) | `src/lib/uuid.ts`: flags `i` → `gi` | **T-U3 rojo.** |

---

## 9. Cierre (W3) — pasos, no notas al pie

Los seis son **pasos ejecutables**, en este orden:

1. **Suite completa.** `npm test` → verde. Anotar conteo **+ commit en la misma
   línea**. Éste es el **Paso B** del protocolo de dos pasos; el Paso A fue W1.
   Los dos resultados van al reporte, no sólo el último.
2. **Tipos.** `npx tsc --noEmit` — usa `tsconfig.json`, que **sí** incluye los
   `src/**/*.test.ts`. `npm run build` **no** los tipa; no lo uses como sustituto.
3. **Lint.** `npm run lint` (`biome check src/`).
4. **El diff de services tiene que estar VACÍO.**
   ```bash
   git diff --stat -- src/services/     # sin salida
   ```
   **Ésta es la evidencia de que no rompiste nada de propiedad**, y es un paso, no
   una nota. ⚠️ El verde de `test/ownership-filter-guard.test.ts` **NO** es la
   evidencia acá: ese guardián verifica **presencia textual** del filtro, no su
   **valor**, y deja los `supabase.rpc(...)` **enteros afuera** — que es justamente
   la forma que usa `payments.ts`. Su verde dice "no agregaste una cadena sin
   filtro"; no dice nada sobre esta HU.
5. **Re-verificar TODA cita `archivo:línea`** a los archivos que esta HU modificó,
   con `python3` o `Read`, **después de la última edición**. Es error reincidente
   del repo: `doc/sdd/220-.../auto-blindaje.md:25-34` y
   `doc/sdd/221-.../auto-blindaje.md:36-59`, donde el fix se equivocó **una segunda
   vez dentro de su propia corrección**. Agravante de esta HU: `tasks.ts` **pierde**
   líneas en `:90-95`, así que todas sus citas por debajo se corren. Medí el
   desplazamiento real con `git diff`.
6. **Re-correr el censo de rutas** y comparar contra los 16 archivos de `2745bb2`:
   ```bash
   command grep -rl "\.params" src/routes/ | sort | wc -l
   ```
   Si aparece un archivo nuevo (otra HU en vuelo), evaluá con el criterio de §10 y
   **declará el veredicto aunque sea "no es bug"**.
7. **`auto-blindaje.md`** con tus propios errores de F3: qué hiciste mal, la causa
   raíz, el fix y dónde más aplica. No es la lista de hallazgos sobre el código: es
   la lista de veces que te equivocaste vos.

---

## 10. Prohibiciones — lo que NO se toca

| # | Prohibición | Por qué |
|---|---|---|
| **P-1** | PROHIBIDO cambiar el comportamiento para un `:id` con **forma** válida — exista o no, sea de otro owner o no. Mismo status, mismo body, mismo `error_code`. | AC-5. Evidencia: W1. |
| **P-2** | PROHIBIDO duplicar el patrón de UUID, y PROHIBIDO **modificarlo** al extraerlo — en particular endurecerlo a v4. | Ese mutante **deja la suite verde**: estrecharía el contrato sin ningún testigo. T-U2 es el único que lo ve. |
| **P-3** | PROHIBIDO tocar `src/routes/registries.ts`. | Sus 3 `:id` (`:134`, `:307`, `:399`) son slugs TEXT: un valor malformado no matchea y `maybeSingle()` da `null`, sin error de Postgres (`src/services/registry.ts:211-214`). No comparte el bug. |
| **P-4** | PROHIBIDO tocar `src/routes/auth/identity.ts`, `src/routes/inbound.ts`, `src/routes/auth/require-signature.ts` y `src/routes/auth/spend-policy.ts`. | Los cuatro se revisaron en F2 y **ninguno es bug** — el detalle en §11. En particular `auth/identity.ts` **ya hace lo que esta HU viene a hacer**; "mejorarlo" es agregar riesgo a cambio de nada. Y PROHIBIDO relajar, mover o reescribir cualquier filtro por dueño de esos archivos. |
| **P-5** | PROHIBIDO tocar `GET /payments/session/:id/dispute` (`payments.ts:364-411`). | No hay bug: un id malformado sale por `404` (`:387-388`). |
| **P-6** | PROHIBIDO arreglar —**y prohibido describir como arreglado**— que `payments.ts:387` colapse **todo** error de Postgres en `404` y no sólo el de forma. | Es preexistente (residuo R-2). Esta HU no lo toca ni lo empeora. Si lo mencionás en el reporte, es para decir que **sigue abierto**. |
| **P-7** | PROHIBIDO tocar `src/routes/dashboard.ts`. | Sus 4 `:intentId` tienen el mismo bug estructural pero están tras `requireAdminTokenStrict` (fail-closed, declarado en `:151`). Scope OUT, fast-follow. |
| **P-8** | PROHIBIDO uniformar los códigos de error de D-2. | Es un cambio de contrato sin AC que lo pida. |
| **P-9** | PROHIBIDO agregar `ajv-formats` o un `schema.params` de Fastify. | Sin ese plugin Ajv **ignora** `format` en silencio: el guard se leería presente y no validaría nada. Y su error sale con otro shape. |
| **P-10** | PROHIBIDO agregar un respondedor compartido de error. | D-4. |
| **P-11** | PROHIBIDO describir el regex como "valida UUID v4". | No valida versión ni variant. Decí "forma de UUID (8-4-4-4-12 hex, case-insensitive)". |
| **P-12** | PROHIBIDO que el guard introduzca o modifique cualquier cobro, débito, settle o refund. | Money-path. Sólo adelanta el rechazo de forma a antes del primer `await` que toca `supabase`/`adapter`. Falsador: cualquier diferencia en un test de `payments.test.ts` que **no** sea un `:id` malformado. |
| **P-13** | ⛔ La base **`caldz` es PROHIBIDA** (es mainnet). ⛔ `m5-keys/` es carpeta PROHIBIDA. ⛔ Nunca imprimas el valor de un secreto. ⛔ No ejecutes transacciones on-chain ni despliegues. | — |
| **P-14** | PROHIBIDO copiar un número de este documento, del SDD o de otra HU como si lo hubieras medido vos. | Los de acá son de `2745bb2`. Si los repetís, los re-medís y ponés **tu** commit. |

---

## 11. Los cuatro archivos que ya se revisaron y NO son bug (para que no los re-abras)

F2 cerró esto. Está acá para que no gastes tiempo ni te tientes con "de paso".

| Archivo | Param | Veredicto y razón |
|---|---|---|
| `src/routes/inbound.ts` | `:source` | **NO es bug.** No es un id: es el nombre de una fuente, usado como sufijo de env var. Se sanea a `[A-Z0-9_]` (`src/services/inbound-task.ts:100-103`); un valor sin `INBOUND_SOURCE_SECRET_<S>` sale por `401` (`inbound.ts:84-86`). Sólo toca columnas TEXT. |
| `src/routes/auth/require-signature.ts` | `:id` | **NO es bug.** El param **no viaja a ninguna query**: se compara en memoria contra la key ya autenticada, `if (req.params.id !== callerKey.id)` → `403 OWNERSHIP_MISMATCH` (`:47-49`). Al service van `callerKey.id`/`callerKey.owner_ref` (`:65-69`). Guardarlo cambiaría `403 → 400` sin bug detrás, y daría feedback de forma a alguien que no probó ser el dueño. |
| `src/routes/auth/identity.ts` | `:token_id` | **NO es bug, y ya hace lo que esta HU viene a hacer**: `parseTokenId(req.params.token_id)` → `400 { error_code: 'INVALID_INPUT' }` (`:219-222`) **antes** del único acceso externo (`:224`). No es un UUID (es un token id numérico de ERC-8004), es ruta pública read-only (`:209-211`) y no toca Supabase. |
| `src/routes/auth/spend-policy.ts` | `:destination` | **NO es bug.** `a2a_key_spend_policies.destination` es TEXT (`src/types/database.types.ts:667`). Los dos uuid de la cadena (`key_id`, `owner_ref`) vienen de `callerKey`, no del path (`spend-policy.ts:124-128`). Un destino inexistente sale por `404` (`:134-138`). |

**Criterio, por si el censo de W3 encuentra un archivo nuevo**: es bug **sólo** si
el param llega a una **columna o RPC que espera un `uuid`** sin validar. "No valida"
no es "es bug". Si encontrás uno que sí califica, entra a **esta** HU (no se abre
otra) y lo declarás antes de F4.

---

## 12. Done Definition

La HU está lista cuando **todo** esto es cierto y está registrado con evidencia:

- [ ] Línea base de `npm test` medida en W0, **con su commit en la misma línea**, y sin copiar ningún número ajeno.
- [ ] W1 corrida y verde **con `git diff --stat -- src/` listando sólo `*.test.ts`**. Conteo + commit anotados. Ése es el registro de AC-5.
- [ ] `src/lib/uuid.ts` existe, exporta `isValidUUID` y `UUID_RE`, y **nada que toque `reply`**.
- [ ] `src/lib/uuid.test.ts` con T-U1..T-U4, los cuatro verdes.
- [ ] `tasks.ts` importa el helper y **no** declara el suyo. `tasks.no-charge-before-validating.test.ts` sin modificar y verde.
- [ ] Los 9 guards puestos, cada uno en el punto de inserción de §6 (2 receipts + 2 key-session + 1 delegation + 4 payments).
- [ ] Los 11 tests de ruta (T-1a, T-1b, T-2a, T-2b, T-3, T-4a..T-4e, T-5) verdes, **cada uno con su aserto de `not.toHaveBeenCalled()`**.
- [ ] M-1 aplicado con `sha256sum` distinto verificado ANTES de correr la suite, y el resultado registrado. Restauración probada con `git diff` vacío.
- [ ] `npm test` completo verde (Paso B), con conteo + commit.
- [ ] `npx tsc --noEmit` limpio. `npm run lint` limpio.
- [ ] `git diff --stat -- src/services/` **vacío**.
- [ ] `command grep -rn "0-9a-f]{8}-" src/` → una sola ocurrencia de producción, en `src/lib/uuid.ts`.
- [ ] Censo re-corrido y comparado contra los 16 archivos de `2745bb2`; veredicto declarado si apareció algo nuevo.
- [ ] Todas las citas `archivo:línea` re-verificadas con `python3`/`Read` DESPUÉS de la última edición.
- [ ] `auto-blindaje.md` escrito.
- [ ] Ninguna frase del reporte dice "elimina"/"cierra"/"ya no puede pasar" sin nombrar al lado el mutante de una línea que lo restauraría.
- [ ] R-2 (`payments.ts:387`) **no** tocado y **no** descrito como arreglado.
