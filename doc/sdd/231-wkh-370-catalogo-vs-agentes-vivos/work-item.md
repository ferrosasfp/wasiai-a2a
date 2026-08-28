# Work Item — [WKH-370] Nada compara el catálogo con los agentes vivos: ni la deriva de schema ni la completitud de la fila

> **Issue de origen**: github.com/ferrosasfp/wasiai-a2a/issues/186
> **Fecha F1**: 2026-08-27 · **Rol**: nexus-analyst · **Fase**: F0 + F1

---

## ⚠️ Cómo leer las citas de este documento

Este F1 corrió **SIN SHELL**: las únicas herramientas disponibles fueron `Read`, `Write` y
`Glob`. No hubo `git`, `grep`, `curl`, `gh` ni acceso a la base. En consecuencia:

| Marca | Significado |
|---|---|
| `[MEDIDO-F1]` | Abrí el archivo y leí esa línea en esta corrida. La cita es mía. |
| `[HEREDADO]` | Viene del encargo, del issue o de otra fila de `_INDEX.md`. **No lo re-medí.** |
| `[NO MEDIDO]` | Nadie lo verificó en esta corrida. Es trabajo de F2. |

⛔ **No pude leer el issue #186 ni sus dos comentarios** (sin red, sin `gh`). Todo lo que este
documento dice del issue es `[HEREDADO]` del encargo. **Primera tarea de F2: abrir el issue y
contrastar**, porque el encargo ya avisa que el segundo comentario trae la medición completa y
este work-item no la pudo leer de la fuente.

⚠️ **El nombre de rama propuesto abajo es una propuesta sin verificar**: no pude correr
`git rev-parse --abbrev-ref HEAD` ni `git branch`. Se declara sin medir en vez de afirmarlo.

---

## Resumen

La ficha de cada agente en el catálogo (`a2a_agents`) es una **copia a mano** del manifiesto que
el agente sirve, y **nada las compara nunca**. Esta HU construye el vigilante — no corrige datos.

El hallazgo que gobierna el diseño es que **son dos defectos de familias distintas, y el chequeo
obvio sólo caza uno**:

1. **DERIVA** — el catálogo y el manifiesto vivo dicen cosas distintas.
2. **FILA MAL NACIDA** — la fila está **incompleta**, no desincronizada: nació sin `metadata` y
   sin `payout_wallet`, así que no *difiere* del manifiesto, simplemente **no tiene nada que
   comparar**. Un chequeo de deriva la reporta como conforme.

La consecuencia de (2) es de dinero, y es la razón por la que esta HU no es cosmética.

---

## El hecho que hace que esto valga una HU (verificado en esta corrida)

Con `payout_wallet` nulo, la pata de creador del split **no existe**:

```ts
// src/services/agent-split-context.ts:50-52   [MEDIDO-F1 — cita del encargo VERIFICADA, es exacta]
const creator: SplitPartyRef | null = row?.payoutWallet
  ? { wallet: row.payoutWallet, ownerRef: row.ownerRef }
  : null;
```

`row?.payoutWallet` falsy ⇒ `creator: null` ⇒ el reparto del fee del 1 % se queda sin pata de
creador y se re-rutea a plataforma. `[MEDIDO-F1]` para el ternario;
`[HEREDADO]` que ya se perdieron **0,24 y 0,06 USDC** por esta causa — **no lo pude medir**.

Y el modo de falla es **silencioso por diseño**, lo cual explica por qué sobrevivió:

- `resolveAgentSplitContext` es **best-effort por CD-10**: *"Cualquier error → log + `{null,null}`.
  NUNCA propaga"* (`src/services/agent-split-context.ts:8-10`) `[MEDIDO-F1]`. Pero el caso de
  `payout_wallet` nulo **ni siquiera es un error**: es la rama normal del ternario. No loguea nada.
- `payout_wallet` **existe como columna** y se escribe por PATCH:
  `updateRow.payout_wallet = updates.payoutWallet` (`src/services/agent.ts:713`) `[MEDIDO-F1]`.
  Un POST que lo omite deja la columna nula y **nada se queja**.
- Lo mismo con el schema: `metadata.inputSchema` se mergea sólo si viene
  (`src/services/agent.ts:735-736`) `[MEDIDO-F1]`. Omitirlo deja `metadata` vacío, sin error.

**Nada en el camino de escritura exige completitud, y nada en el camino de lectura la extraña.**

---

## Sizing

- **SDD_MODE: `full`**
- **Modo NexusAgil: `QUALITY`** (el tablero lo tenía como `FAST+AR` — **subido**, razón abajo)
- **Estimación: M** (tirando a L si F2 elige la opción de credencial de base)
- **Branch sugerido**: `feat/231-wkh-370-catalogo-vs-agentes-vivos` `[NO MEDIDO]`

### Razón escrita del sizing

`CLAUDE.md` declara que este repo es **siempre QUALITY**, y el tablero decía `FAST+AR`. La regla
del encargo es *nunca bajar de FAST+AR*. Resuelvo **QUALITY**, y no por deferencia a `CLAUDE.md`
sino por tres razones propias medidas en esta corrida:

1. **La mitad de completitud necesita una credencial que hoy no existe en ningún workflow, y la
   candidata obvia es una llave que bypassea RLS.** `SUPABASE_SERVICE_KEY` está documentada como
   *"bypassea RLS → el ownership guard es app-layer"* (`.nexus/project-context.md:557`)
   `[MEDIDO-F1]`. Meter esa credencial en las Actions de un **repo PÚBLICO** es una decisión de
   superficie de seguridad, no una tarea de scripting. Eso solo ya saca la HU de FAST.
2. **El entregable es un guard, y este repo tiene historial medido de guards que mienten.** Fila
   224 de `_INDEX.md` cierra una HU entera sobre controles que se leen a sí mismos, e inventaría
   *"16 archivos de `test/` + 31 `src/**/*.test.ts`"* con **1 defectuoso con nombre** que **sigue
   vacuo en `main`** `[HEREDADO]`. Un guard nuevo acá necesita AR, no una revisión rápida.
3. **Precedente directo e inmediato**: la fila 230 (WKH-369, cerrada **hoy**) hizo exactamente
   esta misma corrección — *"Sizing subido de FAST+AR a QUALITY con razón escrita"* — y el criterio
   que usó aplica igual acá: *lo que decide el modo es la ubicación del arreglo, no la severidad
   del defecto* `[MEDIDO-F1, leído en `_INDEX.md:222`]`.

Contra-argumento considerado y rechazado: *"es sólo un script de lectura, no toca producción"*.
Es cierto que el chequeo **observa** (CD-11), pero el riesgo no está en lo que el script escribe:
está en la credencial que hay que darle y en que un guard falso es peor que ningún guard, porque
apaga la investigación.

---

## Acceptance Criteria (EARS)

### El corazón de la HU: deriva ≠ completitud

- **AC-1** (Event-driven — deriva): WHEN el chequeo corre, the system SHALL comparar, para cada
  agente **elegible**, el schema publicado en el catálogo contra el que declara el manifiesto vivo
  del agente, y SHALL reportar cada divergencia nombrando el slug, el campo y las dos huellas.

- **AC-2** (Ubiquitous — completitud): the system SHALL evaluar la **completitud de la fila** —
  presencia de `metadata.inputSchema`, `metadata.outputSchema`, `payout_wallet` y `owner_ref` —
  como una comprobación **separada e independiente** de la de deriva, y SHALL reportar las dos
  clases con etiquetas distintas y códigos de salida distintos.

- **AC-3** (Unwanted — **la tesis de la HU**): IF una fila del catálogo tiene `payout_wallet` nulo
  o `metadata` vacío, THEN the system SHALL clasificarla como **INCOMPLETA** aunque su comparación
  de deriva dé **cero** diferencias, y SHALL NOT reportarla como conforme.
  > Ésta es la razón de existir de la HU: `remit-kyc-session` y `remit-kyc-decision` se registraron
  > con `metadata` vacío y sin `payout_wallet` `[HEREDADO]`, y **un chequeo de deriva no las habría
  > cazado**. Una fila mal nacida se ve idéntica a una sana desde el catálogo.

- **AC-4** (Unwanted — anti-vacuidad, ejecutable) — ⚠️ **TEXTO AMENDADO EN DONE (2026-08-27). El
  original queda abajo, a la vista**: IF el chequeo termina sin haber comparado **ningún** par
  catálogo↔manifiesto, THEN the system SHALL salir con una clase **NO conforme** —**`CONFIG(3)` por
  defecto**, y otra clase no conforme cuando ésta **atribuya mejor la causa**: `INALCANZABLE(2)` si
  ningún manifiesto contestó, `UNRESOLVED(6)` si ninguno resolvió su clave de unión— y **SHALL NOT**
  salir **jamás** con clase conforme.
  > Un chequeo que sólo verifica una AUSENCIA pasa igual cuando no ejecutó nada. Este AC lo cierra.
  >
  > **Texto original del F1**, conservado a propósito: *"…THEN the system SHALL salir con clase
  > **CONFIG** y SHALL NOT salir con clase conforme."*
  >
  > **Por qué se amendó, y quién lo midió** — `qa-validation.md` §8.2. El AC tiene **dos** cláusulas
  > y sólo la primera quedó **más fuerte que la implementación**:
  >
  > - **(ii) "jamás conforme" se cumple SIEMPRE**, y está **medido, no supuesto**: **0 violaciones
  >   sobre las 8.748 combinaciones** que el QA barrió, con **control positivo** que probó que el
  >   barrido puede dar rojo (`qa-validation.md` §5). Ésa es la garantía por la que este AC existe.
  > - **(i) "clase CONFIG" NO es literal**: con `comparados === 0` el chequeo puede salir
  >   `UNRESOLVED(6)` (escenarios D y E, ejecutados) o `INALCANZABLE(2)` (manifiesto caído).
  >
  > Y el desvío es **una mejora de atribución, no un incumplimiento**: la cláusula (i) **choca de
  > frente con AC-8**. `CONFIG` afirma por contrato que *acusa al INSTRUMENTO* y *no implica a
  > producción*, así que con la escalera literal *"los cinco manifiestos están caídos"* se reportaba
  > como *"yo no estoy en condiciones de preguntar"* — **mala atribución**, que es justo lo que las
  > siete clases existen para evitar. El contrato del F1 no pudo verlo porque **el conflicto sólo
  > aparece con un único elegible**: con más de uno basta que uno compare.
  >
  > ⛔ **El original NO se borra**: que un AC afirme de más **es el hallazgo**, no una errata — en la
  > HU que existe justamente para sacar prosa que afirma de más. Ver `done-report.md` §10.

### El universo y la clave de unión

- **AC-5** (State-driven — universo): WHILE un agente del catálogo no sea `self-published`, the
  system SHALL excluirlo de la comparación de manifiesto y SHALL emitir su exclusión **con el
  motivo escrito**, y SHALL NOT excluirlo en silencio.

- **AC-6** (Event-driven — clave de unión verificada): WHEN el chequeo une una fila del catálogo
  con un manifiesto, the system SHALL derivar la ruta del `invokeUrl` de la fila y SHALL verificar
  que el manifiesto **se autodeclara** con el slug del catálogo; IF la autodeclaración no coincide,
  THEN SHALL reportar **UNRESOLVED** y SHALL NOT comparar los schemas.

### Que el rojo signifique algo

- **AC-7** (Unwanted — el cero uniforme acusa al instrumento): IF el chequeo observa que **cero**
  de los agentes elegibles publican schema, THEN the system SHALL salir con clase **CONFIG** y
  SHALL NOT reportarlo como deriva del catálogo.

- **AC-8** (Ubiquitous — atribución por código de salida): the system SHALL emitir un código de
  salida distinto por clase, de modo que el código **solo** ya atribuya la causa, siguiendo el
  patrón ya vigente en `scripts/probe-money-path.mjs:6-10` `[MEDIDO-F1]`
  (`0` conforme · `2` inalcanzable · `3` config del propio chequeo · `4` deriva · `5` fila
  incompleta). El reparto exacto lo fija F2.

- **AC-9** (Event-driven — el aviso, con su contracara): WHEN la corrida programada falla, the
  system SHALL abrir o comentar un issue **con título propio**; WHEN la corrida programada vuelve
  a pasar, the system SHALL cerrarlo.
  > El patrón exacto ya existe dos veces y se copia, no se inventa:
  > `.github/workflows/smoke-downstream.yml:52-94` y
  > `.github/workflows/probe-money-path.yml:112-178` `[MEDIDO-F1]`.

### Que el guard sea falsable

- **AC-10** (Ubiquitous — el rojo se confirma por su MOTIVO): the system SHALL demostrar, para
  cada una de las dos clases (deriva y completitud), que el chequeo **se pone rojo por el motivo
  correcto** cuando se lo rompe a propósito, y SHALL acompañar cada rojo de un **control positivo**
  que pruebe que el chequeo efectivamente ejecutó.
  > El entregable no es que el chequeo dé verde hoy: es que **se ponga rojo cuando corresponda**.

---

## Scope IN

- **Un chequeo nuevo**, probablemente `scripts/` + su suite en `test/`.
  Nombre `[NO MEDIDO]` — lo fija F2 siguiendo la convención de `probe-money-path`.
- **Su disparador**: un workflow en `.github/workflows/` (cuál, ver DT-1).
- **Su suite de verificación**, incluidos los casos rotos a propósito de AC-10.
- La fila de esta HU en `doc/sdd/_INDEX.md` (ver "Entrega del índice" al pie).

## Scope OUT (explícito)

- ⛔ **Corregir filas del catálogo.** Los 5 `remit-*` ya se arreglaron a mano esta semana
  (schema, `owner_ref=web-demo`, `payout_wallet`, deriva 0/5) `[HEREDADO]`. Esta HU es el
  **vigilante**, no la corrección.
- ⛔ **El camino del dinero.** Ni `src/services/agent-split-context.ts`, ni `compose.ts`, ni el
  settle. El defecto se *observa* desde ahí; no se arregla ahí.
- ⛔ **El pin de seguridad del KYC.**
- ⛔ **`src/services/discovery.ts`** — explícitamente fuera. Nombrado en el encargo, y además es
  el choke-point que la HU de ayer (WKH-369) acaba de tocar.
- ⛔ **Los 24 agentes federados de `wasiai-v2`.** Si su manifiesto no es alcanzable se **declaran
  y se excluyen con razón escrita** (AC-5), nunca en silencio. Cerrar esa mitad es otra HU, y
  **en el otro repo** — hay precedente exacto: la fila 223 dejó "HU de seguimiento en el OTRO
  repo" por esta misma topología `[MEDIDO-F1, `_INDEX.md:215`]`.
- ⛔ **Cualquier método que no sea GET/SELECT.** Ver CD-11.

---

## Decisiones técnicas (DT-N)

### DT-1 — Dónde corre: F1 **plantea**, F2 decide

El issue pide *"en CI o en la sonda horaria, **no a demanda**"* `[HEREDADO]`. Medí las tres
opciones contra los workflows reales:

| Opción | Qué medí | Veredicto |
|---|---|---|
| **A. Dentro de `npm test` / `ci.yml`** | `ci.yml:4-6` dice literalmente que el workflow *"Runs **WITHOUT secrets or a live database**"* `[MEDIDO-F1]` | ⛔ **Descartada, y no por flakiness.** El CI es secret-free **por diseño declarado**. Meter red contra producción + una credencial de base ahí no es un ajuste: es revertir una decisión de arquitectura del gate. |
| **B. Colgado de `probe-money-path.yml`** | Pasa **un solo** secreto: `A2A_PROBE_KEY` (`:100`) `[MEDIDO-F1]`. **No tiene ninguna credencial de Supabase.** | ⚠️ **La premisa del encargo se cae acá.** "Ya tiene credenciales" es cierto para *gastar*, falso para *leer la base*. Y hay un segundo problema medido: su aviso usa el título `'probe-money-path: la corrida por reloj esta fallando'` (`:116`) y **se cierra solo en la próxima corrida verde** (`:161-178`) `[MEDIDO-F1]` ⇒ una deriva de catálogo se reportaría bajo un título que acusa al camino del dinero, y se cerraría sola cuando el *pago* vuelva al verde aunque la deriva siga. Misatribución en las dos direcciones. |
| **C. Workflow propio programado** | `smoke-downstream.yml` es el exemplar estructural: secret-free, `cron: '0 7 * * *'`, título de issue propio, patrón abrir/cerrar completo (`:52-94`) `[MEDIDO-F1]` | ✅ **Recomendada.** Separa la señal, no contamina el título de nadie, y permite dar credencial **sólo al job que la necesita**. |

**Recomendación de F1: opción C, con el workflow partido en dos jobs**, porque las dos mitades
tienen necesidades de credencial **distintas**:

- **job `deriva`** → sólo `GET /discover` público. **Cero secretos.** Puede correr siempre.
- **job `completitud`** → necesita leer `payout_wallet`. Ver DT-3.

Partirlo así tiene una propiedad que ninguna otra opción da: **si la credencial de la mitad de
completitud no está o se vence, la mitad de deriva sigue corriendo**, y el job que no corrió sale
por AC-4 como CONFIG en vez de fingir un verde.

⚠️ **Costo**: la opción C no gasta USDC (todo GET + SELECT, CD-11), a diferencia de
`probe-money-path`, que cuesta ~0,0303 USDC **por corrida** (`probe-money-path.yml:8-27`)
`[MEDIDO-F1]`. Esto también argumenta contra la opción B: colgarse de ese workflow ata la
frecuencia del chequeo de catálogo a una cadencia que se eligió por **presupuesto de dinero**
(bajó de 48 a 24 corridas/día el 2026-08-25 `[MEDIDO-F1, `:34-38`]`), que no tiene nada que ver
con cada cuánto conviene mirar el catálogo.

### DT-2 — La vista autoritativa del catálogo es la **LISTA**, no el detalle

Se hereda de DT-1 de WKH-369 (fila 230, cerrada hoy) `[MEDIDO-F1, `_INDEX.md:222`]`, y hay una
razón operativa nueva que la refuerza: esa misma HU midió que `GET /discover/:slug` pasó a costar
**hasta 201 `supabase.from()` por request** (contra 1 de línea base) y **perdió su exención de
rate limit**, así que ahora hereda `RATE_LIMIT_MAX` (default 60/min por IP).

⇒ Un chequeo que itere `GET /discover/<slug>` sobre 29 agentes es caro y **puede empezar a comerse
429s**. Ver CD-8.

### DT-3 — La credencial de la mitad de completitud: **no existe hoy ningún camino de lectura**

Esto es el hallazgo de arquitectura de este F1 y es lo que más condiciona a F2.

`payout_wallet` **está deliberadamente fuera de todo shape público**. Verificado en tres puntos:

- El `AgentRow` interno lo tiene… **no**: `src/services/agent.ts:54-65` `[MEDIDO-F1]` lista
  `slug, name, description, capabilities, agent_url, price_usdc, metadata, enabled, owner_ref,
  created_at`. **`payout_wallet` no está.**
- `mapRowToRecord` — el shape de `publish`/`update`/`listMine` — tampoco lo emite
  (`src/services/agent.ts:174-198`) `[MEDIDO-F1]`.
- Y es **una regla escrita, no un olvido**: *"CD-5: self-published lee `payout_wallet`/`owner_ref`
  **SOLO** vía `getSplitContextRow` (nunca por un shape público)"*
  (`src/services/agent-split-context.ts:13-14`) `[MEDIDO-F1]`.

**Conclusión: la mitad de completitud NO se puede construir sobre ningún endpoint existente.**
Necesita una de estas tres, y F2 elige:

| Opción | Qué cuesta | Riesgo |
|---|---|---|
| **3a.** `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` como secretos del repo | 2 secretos nuevos | 🔴 **Alto.** Es una credencial **BYPASSRLS** (`.nexus/project-context.md:557`) `[MEDIDO-F1]` en las Actions de un repo **PÚBLICO**. Radio de explosión = la base entera, incluido `caldz`… no, incluido todo `bdwv`, que **es la que sirve producción** (`project-context.md:97`) `[MEDIDO-F1]`. |
| **3b.** Exponer un **booleano** de completitud en una ruta ya autenticada | Toca `src/` (sale del "sólo tests") | 🟡 Medio. **No viola CD-5**: un `hasPayoutWallet: boolean` no es la billetera. Reusa la clase de credencial de `A2A_PROBE_KEY`. Pero agrega superficie de API. |
| **3c.** Una credencial Supabase **de sólo lectura y alcance mínimo** (no la service key) | 1 secreto + trabajo de política | 🟢 El más chico, si es factible. **`[NO MEDIDO]`** si el proyecto bdwv admite emitir una llave así. |

⚠️ **Recomendación de F1: NO cerrar esto acá.** Es exactamente el tipo de decisión que el
encargo pide *plantear* y que AR debe atacar. Mi inclinación es **3b**, porque mantiene la
credencial BYPASSRLS fuera de un repo público y porque el chequeo **no necesita el valor de la
billetera, sólo su presencia** — pero 3b toca `src/`, y eso cambia el perfil de la HU.

### DT-4 — El manifiesto es **remoto**: no hay ninguno en el repo

`Glob **/*manifest*` da **cero archivos** `[MEDIDO-F1]`. El manifiesto lo sirve cada agente en su
propia URL; el catálogo guarda esa URL en `agent_url` y la publica como `invokeUrl`
(`src/services/agent.ts:152`) `[MEDIDO-F1]`.

⇒ La ruta exacta del manifiesto (`/manifest`? `/.well-known/agent.json`? otra) es **`[NO MEDIDO]`**
y es tarea de F2 medirla contra un agente vivo. **No la asumas**: el encargo ya avisa que el
`pathSlug` no es el slug en 2 de 5, así que la forma de la URL no es adivinable.

### DT-5 — El exemplar a copiar

`scripts/probe-money-path.mjs` es el arte previo directo y conviene seguirlo de cerca. Lo que
tiene y sirve, todo `[MEDIDO-F1]`:

- Clasificación en clases con exit code por clase (`:6-10`).
- **La regla central, que es la misma que necesita esta HU**: *"cuando no puede derivar un valor,
  la sonda falla ruidosamente en vez de inventarlo"* (`:13-16`).
- Huella de schema para contestar *"¿cambió hoy?"* sin arqueología (`schemaFingerprint`, `:201-212`)
  — **directamente reutilizable para la mitad de deriva**.
- Una escalera pura y testeable (`ladder`, `:269-346`), con un default que **no es PASS**:
  *"la única clase que jamás debe alcanzarse por omisión no puede ser la que dice que todo anda"*
  (`:343-345`). Ese principio es AC-4.
- ⛔ *"Nunca imprime la credencial, ni entera ni truncada: el repo es PÚBLICO"* (`:19`).

---

## Constraint Directives (CD-N)

### Las tres trampas medidas (obligatorias, del encargo)

- **CD-1** — ⛔ **PROHIBIDO buscar `inputSchema` en la raíz de la respuesta de `/discover`.**
  Vive en **`metadata.inputSchema`**. **Verificado en código en esta corrida**, y la razón es que
  hay **dos mappers distintos para la misma fila**:
  - `mapRowToAgent` (alimenta `/discover`) emite `metadata` **entero** y **ningún `inputSchema` de
    raíz** (`src/services/agent.ts:138-171`, el `metadata,` de `:165`) `[MEDIDO-F1]`.
  - `mapRowToRecord` (shape de `publish`/`update`/`listMine`) **sí lo iza a la raíz**
    (`src/services/agent.ts:190`) `[MEDIDO-F1]`.

  ⇒ Un barrido que mire la raíz de `/discover` devuelve *"0 de 29 agentes publican schema"*, que es
  **falso**. **Un cero uniforme sobre los 29 acusa a la consulta, no al catálogo** — por eso esto
  además es AC-7, ejecutable, y no sólo una advertencia en prosa.

- **CD-2** — ⛔ **PROHIBIDO asumir `slug == pathSlug`.** Es falso en **2 de 5** `[HEREDADO]`:
  `remit-corridor-fx-solana` se sirve en el path `remit-corridor-fx`. La clave de unión sale del
  `invokeUrl` **y el manifiesto se autodeclara** con el slug del catálogo ⇒ la unión **se verifica,
  no se confía** (AC-6). Un comparador que asuma la igualdad compara el agente equivocado — o no
  encuentra el manifiesto y reporta una deriva que no existe.

- **CD-3** — ⛔ **PROHIBIDO tratar a los 29 agentes por igual.** 24 de 29 apuntan a `wasiai-v2` y su
  manifiesto puede no estar servido `[HEREDADO; corroborado por dos filas del índice: la 223 midió
  "22 de 25 agentes en wasiai-v2" y la 230 midió "24 federados", `_INDEX.md:215,222`]` `[MEDIDO-F1]`.
  El universo real son los **5 self-published**. Tratarlos igual produce un chequeo **crónicamente
  rojo**, y un control crónicamente rojo **entrena a la gente a ignorarlo** — modo de falla que este
  ecosistema ya sufrió, y que los dos workflows existentes cierran a propósito con su patrón de
  cierre automático (`smoke-downstream.yml:81-82`: *"un issue que queda abierto para siempre es el
  control que la gente aprende a ignorar"*) `[MEDIDO-F1]`.

### Las que salen de mediciones de esta corrida

- **CD-4** — ⛔ **PROHIBIDO meter este chequeo dentro de `npm test` / `ci.yml`.** Ese workflow es
  secret-free y sin base viva **por decisión declarada** (`ci.yml:4-6`) `[MEDIDO-F1]`. Ver DT-1.

- **CD-5** — ⛔ **PROHIBIDO imprimir el valor de `payout_wallet`, de `owner_ref` o de cualquier
  credencial.** El repo es **PÚBLICO**. La mitad de completitud reporta **presencia/ausencia**,
  nunca el valor. Mismo estándar que `probe-money-path.mjs:19` `[MEDIDO-F1]`.

- **CD-6** — ⛔ **PROHIBIDO reusar el título de issue de `probe-money-path` o de
  `smoke-downstream`.** Los dos dedupean y cierran **por título exacto**
  (`probe-money-path.yml:116,165`; `smoke-downstream.yml:56,87`) `[MEDIDO-F1]` ⇒ compartir título
  hace que un chequeo cierre el aviso del otro.

- **CD-7** — ⛔ **PROHIBIDO que el guard se lea a sí mismo**, y prohibido un chequeo que sólo
  verifique una AUSENCIA sin control positivo. Todo test se rompe a propósito antes de darlo por
  bueno, y **el rojo se confirma por su MOTIVO, no por ser rojo** (AC-10). Arte previo en el repo:
  el `const SELF` de `src/__tests__/discover-callsites.test.ts:126` `[HEREDADO, `_INDEX.md:216`]`.

- **CD-8** — ⛔ **PROHIBIDO iterar `GET /discover/<slug>` agente por agente.** Ver DT-2: hasta 201
  queries por request y ahora sujeto a rate limit. Se lee la **lista**, una vez.

- **CD-9** — ⛔ **PROHIBIDO tocar `src/services/discovery.ts`, el camino del dinero y el pin del
  KYC.** Si F2 elige la opción 3b de DT-3, el único `src/` tocado es la ruta que expone el booleano,
  y eso se declara explícitamente en el SDD.

- **CD-10** — ⛔ **PROHIBIDO excluir un agente en silencio.** Toda exclusión lleva motivo escrito
  y sale en el reporte (AC-5). "No lo pude medir" **no es** "está bien".

- **CD-11** — ⛔ **Este chequeo OBSERVA.** Sólo GET y SELECT. Ningún POST, ningún PATCH, ningún
  `/compose`. `/compose` y `/orchestrate` **mueven plata** y un `/compose` rechazado **puede cobrar
  igual** (`.nexus/project-context.md:468-470`) `[MEDIDO-F1]`.

---

## Missing Inputs

| # | Qué falta | Estado |
|---|---|---|
| **MI-1** | **El issue #186 y sus dos comentarios.** No hay red ni `gh` en este F1. Todo lo del issue es `[HEREDADO]` del encargo. | 🔴 **Bloqueante para F2** — es su primera tarea. |
| **MI-2** | **La ruta del manifiesto** (`/manifest`? `/.well-known/agent.json`?) y **la forma de su cuerpo**. `Glob` da cero archivos en el repo (DT-4). | 🔴 **Bloqueante para F2.** No se puede diseñar el comparador sin esto. |
| **MI-3** | **Cuál de las tres opciones de credencial de DT-3.** Involucra una llave BYPASSRLS en un repo público. | 🟠 **Decisión de F2 + AR.** F1 recomienda 3b y NO la cierra. |
| **MI-4** | **Los 5 slugs self-published exactos** y cuáles 2 tienen `pathSlug ≠ slug`. Sé que `remit-corridor-fx-solana` es uno `[HEREDADO]`; el otro no. | 🟠 Resuelto en F2 con un GET a `/discover`. |
| **MI-5** | **El conteo 29 / 24 / 5.** Es `[HEREDADO]`. Las dos filas del índice que lo corroboran dan **25 y 29** en fechas distintas ⇒ **el número se mueve** y no debe hardcodearse. | 🟡 El chequeo lo **deriva**, no lo afirma. |
| **MI-6** | **Si `getSplitContextRow` lee además `payout_chain`.** Leí sus dos call-sites (`agent-split-context.ts:49,62`) pero **no su cuerpo**. | 🟡 F2. |
| **MI-7** | **El nombre de la rama actual.** Sin shell, no se pudo medir. | 🟡 Verificar antes de crear la rama. |

---

## Análisis de paralelismo

**¿Esta HU bloquea otras?** No. No entrega ninguna superficie de la que otro dependa.

**¿Puede ir en paralelo?**

- ✅ **Con casi todo.** Bajo la opción 3a o 3c de DT-3, la HU es **cero líneas de `src/`**: sólo
  `scripts/`, `test/` y `.github/workflows/`. Ese perfil (sólo tests + tooling) es el que las filas
  220, 221 y 224 usaron para correr en paralelo sin conflicto `[MEDIDO-F1, `_INDEX.md:213-216`]`.
  ⚠️ Bajo la **opción 3b** deja de ser cierto: toca `src/routes/` y necesita coordinación.

- ⚠️ **Conflicto de merge probable en `doc/sdd/_INDEX.md`**, que es un archivo de una sola tabla
  donde toda HU agrega una fila al final. Es un conflicto trivial pero seguro si otra HU cierra el
  mismo día.

- 🔴 **Dependencia blanda con WKH-369 (fila 230), cerrada y desplegada hoy** (`merge 85cc288`)
  `[MEDIDO-F1]`. No hay conflicto de código —`discovery.ts` está en Scope OUT— pero **sí de
  supuestos**: WKH-369 acaba de cambiar el comportamiento y el costo de `GET /discover/:slug`, y de
  ahí sale CD-8. Cualquier medición de `/discover` hecha **antes de hoy** ya no vale.

- 🟢 **Sinergia, no conflicto, con `probe-money-path`**: las dos sondas comparten el vocabulario de
  clases y exit codes (DT-5). Si F2 extrae ese vocabulario a un módulo común, es refactor y sale de
  esta HU.

---

## Entrega del índice — ⚠️ LEER ANTES DE COMMITEAR

**No tengo herramienta `Edit`.** La fila de esta HU quedó escrita en:

`doc/sdd/231-wkh-370-catalogo-vs-agentes-vivos/_INDEX-row.md`

Hay que **pegarla a mano** en `doc/sdd/_INDEX.md` **inmediatamente después de la línea 222**
(la fila `230`, que es la última de la tabla; la línea 223 ya es la línea en blanco que la cierra).

⛔ **NO se toca NADA por encima de la línea 144 de `_INDEX.md`**: `capability-risk.ts` cita ese
tramo `[HEREDADO del encargo, NO MEDIDO por mí]`.

🔴 **Y esto no es opcional**: el guardián `test/sdd-index-matches-folders.test.ts` exige que
**cada carpeta de HU tenga exactamente una fila** y deriva las carpetas de `git ls-files doc/sdd`
(`_INDEX.md:236-242`) `[MEDIDO-F1]`. Crear `doc/sdd/231-…/` y no escribir su fila **pone
`npm test` en rojo**.

⚠️ **Y ojo con el orden**, que es la lección que dejó la HU de ayer: el guardián lee el **índice de
git**, no el disco ⇒ **`git add -A` va ANTES del gate final**. Con el entregable untracked el
guardián no lo ve y **da verde en falso** — pasó exactamente así en WKH-369
(`_INDEX.md:222`) `[MEDIDO-F1]`. Si esta HU suma archivos, los 4 números de `README.md` y
`README.es.md` cambian y hay que actualizarlos (`test/readme-numbers.test.ts:83`) `[HEREDADO]`.

**Gate del repo, completo y en orden** (⛔ `npm run qa` **no existe acá**):

```bash
git add -A                            # ← ANTES del gate, no después
npx tsc -p tsconfig.json --noEmit     # 1
npm run lint                          # 2  ← el eslabón que nadie alcanza
npm test                              # 3
```

Verificado contra `.github/workflows/ci.yml:36-43` `[MEDIDO-F1]`.
