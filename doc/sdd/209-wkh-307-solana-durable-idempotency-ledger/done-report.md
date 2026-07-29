# Done Report — WKH-307 Idempotencia durable del settle en Solana

**Status**: DONE (mergeada)
**Fecha del reporte**: 2026-07-29
**Merge**: `c92330a`
**Tests al cierre**: 4142 · 21 mutantes, 21 muertos · 23 tests viejos retirados, 2 invertidos
**Estado de `main` al escribir este reporte**: `c92330a`, 4254 tests, tipos limpios

> **Nota de proceso.** Este reporte se escribió **después** del merge. La metodología pide
> cierre y después merge, y acá se hizo al revés. El contenido sale del mensaje de merge,
> de los artefactos en disco y de lo que verificó QA, y cada afirmación se re-verificó
> contra el código ya en `main` (las anclas archivo:línea son de `c92330a`). El documento
> no existía cuando la HU entró; queda registrado acá en vez de disimularse.

---

## Qué reemplaza, y por qué importa tanto

La deduplicación de pagos estaba **en memoria**, y **se perdía en cada reinicio del
proceso**. Un settle que ya había pagado, tras un restart, no tenía cómo saberse pagado.

Y acá está lo que hace que esto no sea un detalle de robustez: **en Solana no hay respaldo
on-chain**. No existe una capa por debajo que atrape un doble pago. **Este seam es la
única defensa contra pagar dos veces.** Un mecanismo que se evapora con cada reinicio no
es una defensa: es una defensa mientras el proceso siga vivo.

Esta HU lo reemplaza por un **ledger durable** en Postgres.

---

## El bloqueante: `null` no quiere decir "no pasó"

Se le preguntaba a la cadena si una transacción existe, y **ante un `null` se concluía "no
aterrizó" y se re-transmitía un pago real**.

Pero un `null` puede significar por lo menos tres cosas distintas:

- **no existe** (la tx nunca aterrizó),
- **ese nodo no tiene ese pedazo de historia** (la pidió fuera de su ventana de retención),
- **el nodo va atrasado**.

Solo la primera autoriza volver a pagar. Las otras dos, tratadas como la primera,
**producen un segundo pago irreversible**.

### El arreglo vive en el tipo

No se arregló con un `if` más: se arregló haciendo que **el compilador obligue a agotar
los casos**. `SettlementPresence` (`src/adapters/types.ts:158-175`) es una unión de
**cinco estados**, con "no está" y "no pude preguntar" **por fin separados**:

| Estado | Qué significa | ¿Re-transmitir? |
|---|---|---|
| `landed_ok` | Aterrizó y cumple los términos (monto/mint/destino) | **No** |
| `landed_failed` | Aterrizó y falló on-chain; esa firma es terminal (una tx fallida ya está grabada y nunca puede volver a ejecutarse) | Sí, con firma nueva — es correcto |
| `landed_mismatch` | Aterrizó pero **no** cumple los términos: algo se movió con esa firma | **No** — fail-closed, requiere mirada humana |
| `absent` | El nodo **respondió, buscando en el histórico**, y no la conoce. Prueba de ausencia | Sí |
| `unknown` | **No se pudo preguntar** | **Nunca** |

La determinación negativa ya no se infiere de un `null` cualquiera: usa
`getSignatureStatuses` con `searchTransactionHistory: true`
(`src/adapters/solana/payment.ts:548-549`), que **obliga al nodo a buscar en el histórico
largo** antes de decir que no la conoce.

---

## La decisión de fail-closed en la retención del RPC

Poder afirmar "esta tx no existe" **depende de cuánta historia retiene el nodo**. Por eso
el arranque la **mide** (`src/adapters/solana/schema-preflight.ts`,
`probeRpcHistoryRetention`). Las cuatro situaciones:

| Situación | Qué hace | Por qué |
|---|---|---|
| **Medida y suficiente** | Arranca | Se puede distinguir "no existe" de "no la tengo" |
| **Medida e insuficiente** | **Corta SIEMPRE** | Evidencia positiva de falla |
| **No medible, sin declaración** | **Corta** | No poder medir no autoriza suponer |
| **No medible, con declaración explícita del operador** | Arranca, con `warn` que nombra el riesgo | La salida existe para que "no puedo medir" no se castigue como "está roto" |

**El matiz que hace correcta a esta tabla, y que es lo que hay que entender**: una
**medición negativa es evidencia positiva de falla, y la declaración del operador no la
anula**. La salida cubre **únicamente** el caso de *no poder medir*.

Eso no es una interpretación: está en la estructura del código. El chequeo
`process.env[HISTORY_DECLARED_ENV] === 'true'` vive **dentro del `catch`** —la rama de "no
se pudo medir"— (`schema-preflight.ts:179`), y **no aparece** en la rama
`retained <= BLOCKHASH_VALIDITY_SLOTS`, que devuelve `rpc_history_insufficient` sin
consultar ninguna env. Quien declara no puede pisar una medición.

**Sin default permisivo**: solo el string `'true'` exacto abre.

El razonamiento del trade-off, tal como quedó escrito en el módulo: los dos errores no
cuestan lo mismo. **Permitir de más produce un `absent` falso ⟹ segundo pago,
irreversible. Cortar de más produce un arranque fallido: ruidoso, inmediato y reversible
en un minuto.** Cuando los costos son asimétricos, el default va del lado del error
barato.

---

## Lo que se verificó contra la base real (lo más valioso del cierre)

No se verificó "contra el archivo `.sql`": se verificó **contra Postgres**.

1. **Migración aplicada a desarrollo (bdwv)**, con **8 chequeos leyendo del catálogo de la
   base**, no del exit code del applier.
2. **El SQL ejercitado de verdad: 27/27 casos.** Las 4 funciones, **dos reclamos en
   paralelo con un solo ganador**, el índice único parcial, y el archivado de firmas.
3. **Encontró una garantía escrita que la base NO cumple.** `T-LDG-10` usaba el máximo de
   un `uint64` sobre una columna `BIGINT` **con signo**: la garantía no era representable
   en el esquema real. Corregido a **2^53+1** (`settle-ledger.test.ts:314`,
   `hugeHeight = '9007199254740993'`), que **sigue matando una coerción con `Number()`**
   —que es la propiedad que el test protege— **y además entra en la columna**. Un test que
   afirma algo que la base no puede cumplir no protege nada: falla por el fixture, no por
   el código.
4. **El probe verificado por el canal que usa el código.** No alcanza con que Postgres
   levante la señal: hace falta que **el cliente la deposite donde el código la lee**. Se
   verificó por esa vía y no por otra.

---

## Pipeline

F3 (4122 tests) → **AR BLOQUEANTE** + CR aprobado → fix-pack → re-AR cerrado con **3
reservas** → fix + **decisión de fail-closed** → **F4 QA APROBADO**.
Cierre: **4142 tests, 21 mutantes, 21 muertos, 23 tests viejos retirados y 2 invertidos**.

El retiro de la batería anterior está documentado fila por fila en la cabecera de
`src/adapters/solana/intent-dedup.test.ts` (los tests retirados candaban una política de
`Map` en memoria que esta HU **elimina entera**; un test de una política borrada no puede
sobrevivir a la política).

---

## Qué queda abierto (con nombre)

1. **El gate de re-hidratación de la migración nunca corrió contra Postgres.** Es el único
   código **ejecutable** de la migración sin ejercitar. El guion está escrito y listo
   (`gate-rehydration-test.sql`), pero **necesita un entorno descartable** (Postgres local
   en docker o un proyecto Supabase de usar y tirar). **No se puede probar contra
   desarrollo**: el guion crea `a2a_solana_settle_intents_backup_wkh307`, y si esa tabla
   quedara en una base real el gate la detectaría y **abortaría todo apply futuro** — o
   sea, **probar el candado rompería el camino que el candado protege**.
2. **WKH-307b — aplicar la migración a producción (caldz).** Founder-gated, con su
   work-item ya escrito (`work-item-wkh-307b.md`). **Existe por diseño al menos una base
   sin la tabla**: caldz, la del dinero real. Impacto operativo hoy: **nulo**
   (`SOLANA_ADAPTER_ENABLED` default `false` y la cadena configurada es devnet). Mientras
   tanto un entorno que apunte a caldz con el adapter encendido **no settlea Solana**: el
   preflight da veredicto negativo y `settle()` rechaza ruidoso — **fail-closed deliberado
   y recuperable, no un doble pago**.
3. **El Story File de esta HU no está versionado.** `story-HU-307.md` es el **único**
   artefacto de `doc/sdd/209-…/` que sigue **untracked** en `main`, incluso después del
   merge (los otros seis sí están commiteados). Hoy existe **solo en este árbol de
   trabajo**: si se limpia, se pierde el contrato de F2.5 de una HU del money-path ya
   mergeada. No se agregó desde este cierre porque no es un artefacto de este reporte —
   queda señalado para que se decida qué hacer.
4. **La salida manual está documentada, y hay que saber que existe.** WKH-307 **eliminó a
   propósito** el self-heal que re-emitía sola: con un registro durable, "la firma
   registrada no cuadra con la cadena" tiene causas que **pagar de nuevo no arregla**.
   Pero una decisión de no auto-actuar **exige una salida manual**, o el estado es plata
   retenida en silencio. Esa salida es `runbook-destrabe.md`, y la regla que la gobierna
   es **"la cadena manda sobre la tabla"**: ninguna fila se toca sin evidencia on-chain
   citada, y si la evidencia no se puede obtener, **no se toca nada** (`unknown` no
   autoriza ni pagar ni marcar pagado).

---

## Sincronización pendiente a `wasiai-ecosystem-docs`

Este reporte vive en el `doc/` versionado de este repo, pero la documentación interna se
está migrando al repositorio privado **`wasiai-ecosystem-docs`**. **Este reporte necesita
sincronizarse ahí.** No se copió desde esta HU: la sincronización es un paso aparte, para
no duplicar la fuente de verdad mientras la migración está en curso.
