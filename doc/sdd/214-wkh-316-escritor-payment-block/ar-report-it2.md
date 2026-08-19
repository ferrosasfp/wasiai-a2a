# AR — WKH-316 · iteración 2 (RE-AR del fix-pack)

> `nexus-adversary` · 2026-08-19 · rama `feat/214-wkh-316-payment-block` · HEAD `d546e29`
> Fix-pack auditado: **`e57af46`** (`d546e29` es sólo el commit del `ar-report.md` de la it-1, sin `src/`).
> Alcance: **el fix-pack y lo que el fix-pack movió**. Los 6 frentes que la it-1 resolvió a favor de la
> implementación NO se re-litigan.

## VEREDICTO: **RECHAZADO** — 1 `BLQ-BAJO` + 2 `MENOR`

El fix-pack es correcto en todo lo que arregla, y lo verifiqué mutante por mutante. Lo que falla es la
**completitud del inventario** que el propio fix-pack publicó como corregido: hay **4 anclas más** de esta
HU sin declarar, **en el mismo archivo** que su tabla ya nombra, y dos de ellas son **nombres de test**.

| ID | Sev | Categoría | Una línea |
|---|---|---|---|
| `BLQ-BAJO-1` | BLOQUEANTE-BAJO | Test Coverage / Documentación | El inventario de citas desplazadas declara 4 y son 8: faltan `agent.ownership.test.ts:20,:36,:112,:124` |
| `MNR-1` | MENOR | Documentación | `agent.payment.test.ts:303` cita `downstream-payment.ts:132` para `settleSolanaLeg`, que está en `:247`. **PRE-EXISTENTE** (idéntica en `main:240`), pero el archivo SÍ es Scope IN |
| `MNR-2` | MENOR | Arquitectura | **Ningún mecanismo de este repo puede cazar un `archivo.ts:N` falso ni un docblock que afirma un candado inexistente.** El patrón para hacerlo YA existe acá y cubre un solo destino |

Orden del fix-pack: `BLQ-BAJO-1` (una tabla, cero `src/`) → `MNR-1` (una línea de comentario) → `MNR-2` (HU nueva, no fix-pack).

---

# 1. Las puertas, re-medidas por mí (no heredadas)

| Puerta | Declarado por el Dev | Medido acá | ¿Coincide? |
|---|---|---|---|
| `vitest run` | 289 passed \| 6 skipped (295) · 5750 passed \| 19 skipped (5769) · exit 0 | **idéntico**, exit 0 | ✅ |
| `tsc --noEmit` | exit 0 | exit 0 (binario directo, sin pipe) | ✅ |
| `biome check src/` | 489 archivos, exit 0 | `Checked 489 files`, **exit code medido sin pipe** = 0 | ✅ |
| baseline 5746 → 5750 | +4 tests, cero archivos nuevos | 295 test-files (igual que la it-1) y `+4` tests. El diff del fix-pack no crea archivos | ✅ |
| md5 de restauración | `fdb1fd726b17aa17d4296705738f7e62` | `src/routes/agents.ts` en HEAD = **`fdb1fd726b17aa17d4296705738f7e62`** | ✅ |

Árbol limpio antes y después de cada mutación: `git status --porcelain` sólo muestra el `story-file.md`
**untracked del otro agente**, que no toqué (md5 `7904ef74a1c46d7880e0ca5d38e3eed4` al abrir y al cerrar).

---

# 2. 🔴 El frente principal — el fix-pack repitió el bug que arreglaba. **Las tres cosas, verificadas**

## 2.1 Los valores nuevos apuntan a la función contenedora correcta — ✅ los cuatro

Medido por `awk` de firma-a-firma, no por texto (el texto no discrimina: el propio fix-pack midió que
`.eq('owner_ref', ownerRef)` aparece 6 veces y `const { data, error } = await supabase` 9 veces en
`src/services/agent.ts`).

| Cita | Valor del Dev | Qué hay ahí | Función contenedora | Firma / siguiente firma | ¿OK? |
|---|---|---|---|---|---|
| `agent.ownership.test.ts:6` (`main:549`) | **`:602`** | `.eq('owner_ref', ownerRef)` | `listMine` | `:598` / `update` en `:619` | ✅ |
| `agent.ownership.test.ts:6` (`main:715`) | **`:822`** | `.eq('owner_ref', ownerRef)` | `delete` | `:798` / fin del objeto `:830` | ✅ |
| `orchestrate.ts:1160` (`main:526`) | **`:579`** | `const { data, error } = await supabase` | `getBySlugAsAgent` | `:578` / `listMine` en `:598` | ✅ |
| `self-published-auth.ts:29` (`main:265`) | **`:338`** | `keyRow.owner_ref,` en la llamada a `publishedAgentService.publish(` | POST `/agents` | llamada en `:336-339` | ✅ |

Control de discriminación, que es lo que hace no-vacía a esta verificación: **`:761` es el
`.eq('owner_ref')` del UPDATE de `update()`** y **`:599` es la misma línea de texto dentro de `listMine`** —
o sea, los dos números que el Dev había publicado mal contienen el ancla buscada y pasan cualquier
verificación por texto. Los valores nuevos caen en la función correcta; los viejos no.

## 2.2 Las dos correcciones de prosa son línea-neutras — ✅ y la neutralidad es **load-bearing**, no cosmética

- `src/lib/payment-spec-writer.ts`: hunk `@@ -90,8 +90,8 @@`, **2 insertions / 2 deletions**. Archivo con
  longitud sin cambio.
- `src/routes/agents.ts` docblock: hunk `@@ -108,8 +108,8 @@`, **2 insertions / 2 deletions**.

Y acá está lo que el Dev no dijo y yo medí: ese hunk está en **`:108-113`, ARRIBA de `:124`**, y
`test/payment-guards-live-in-one-place.test.ts:17-18` cita **`routes/agents.ts:66`** ("`x402` en un mensaje
de error de auth") y **`routes/agents.ts:124`** ("`getInitializedChainKeys()` en un comentario"). Verificado
contra `e57af46^` y contra HEAD: las dos líneas son **byte-idénticas** en los dos árboles.

> **Repro de la contrafactual**: si esa corrección hubiera sido `+1`, `routes/agents.ts:124` habría pasado a
> `:125` y el docblock del guardián estructural —el archivo que la HU creó para vigilar CD-9— habría quedado
> citando `if (rejection.code === 'PAYMENT_CHAIN_NOT_INITIALIZED')` en vez del comentario que nombra. Y
> ningún test lo habría visto (ver `MNR-2`). La decisión de hacerla línea-neutra evitó exactamente eso.

## 2.3 ¿`+9` es el ÚNICO desplazamiento? — barrido el diff completo: **la frase es imprecisa, el efecto es cierto**

El fix-pack cambia de largo **tres** archivos, no uno:

| Archivo | Δ largo | Dónde | Citas expuestas |
|---|---|---|---|
| `src/routes/agents.ts` | **+9** (+8 POST, +1 PATCH) | medio del archivo | 1 cita de código vivo: `self-published-auth.ts:29`. Actualizada a `:338` ✅ |
| `src/routes/agents.publish.test.ts` | **+149** | **EOF** (783 → 932 líneas) | ninguna: toda cita a ese archivo apunta a `:137-153`, `:154-187`, `:190-210`, `:252`, `:335-347`, `:349-378`, `:380-391` — todas `< 780`. Sólo se movió el `});` final ✅ |
| `doc/sdd/214-…/auto-blindaje.md` | **+224**, con **+4 en el MEDIO** (hunk `@@ -220,15 +220,19 @@`) | corre todo lo que está debajo de `:223` en ese doc | ninguna: `grep -rn "auto-blindaje\.md:[0-9]"` sobre `src/ test/ doc/ README*` no devuelve **ninguna** cita a este `214-…/auto-blindaje.md` ✅ |

Verificado también el barrido que el Dev declara: `grep -rn "routes/agents\.ts:[0-9]" src/ test/` devuelve
**una sola** línea (`self-published-auth.ts:29`), y **ampliándolo** a `agents\.ts:[0-9]` sin el prefijo
`routes/` —que es por donde se le escaparía una cita escrita corta— sigue devolviendo **la misma única**
línea. El barrido no tiene ese punto ciego.

**Conclusión**: *"el único desplazamiento del fix-pack es +9 en `src/routes/agents.ts`"* está escrito de más
(hay dos archivos más que cambiaron de largo), pero **no rompió ninguna cita**, que es la propiedad que
importa. No es finding: es una precisión, y la dejo medida acá para que nadie la re-derive.

---

# 3. Los dos números del BLOQUEANTE, re-medidos leyendo la firma — ✅ los dos

Ya en §2.1. Los transcribo con el contenido crudo porque el orquestador pidió no heredarlos:

```
598:   async listMine(ownerRef: string): Promise<PublishedAgentRecord[]> {
599:     const { data, error } = await supabase
600:       .from('a2a_agents')
601:       .select('*')
602:       .eq('owner_ref', ownerRef)        ← el ancla de agent.ownership.test.ts:6
603:       .order('created_at', { ascending: true });
...
619:   async update(                        ← firma siguiente: :602 cae DENTRO de listMine

578:   async getBySlugAsAgent(slug: string): Promise<Agent | null> {
579:     const { data, error } = await supabase   ← el ancla de orchestrate.ts:1160
580:       .from('a2a_agents')
...
598:   async listMine(...)                  ← firma siguiente: :579 cae DENTRO de getBySlugAsAgent
```

---

# 4. La brecha que el Dev declaró en su propia medición — **cerrada acá**

El Dev no re-corrió los mutantes de la it-1 sobre el árbol final. Los corrí yo, **suite completa**, con
backup a disco y restauración verificada por md5 en cada uno.

| Mutante | Mutación | it-1 | **it-2 (árbol final)** | Testigo |
|---|---|---|---|---|
| `M15` | `meta.payment = paymentBlock` → `= updates.payment` (`src/services/agent.ts:746`) | KILLED (1) | **KILLED (1)** | `T-316-25` |
| `D` | `isZeroPayTo` EVM sin `toLowerCase` (`payment-spec-writer.ts:141`) | SOBREVIVE (declarado) | **SOBREVIVE (0 rojos)** | — (declarado por el Dev) |
| `E` | whitelist de 4 keys → `{ ...obj, … }` (`payment-spec-writer.ts:285-289`) | KILLED (5 en 3 archivos) | **KILLED (5 en 3 archivos)** | `T-316-01`, `T-316-02`, `T-316-25` + 2 |
| `F` | `readStoredPaymentBlock` sin whitelist (`:324-328`) | KILLED (2) | **KILLED (2)** | "devuelve las 4 keys y NADA más" + asset no-string |

`M15` sigue matando **exactamente 1** test y por la razón correcta (`T-316-25 · CD-10 vía PATCH:
updates.payment CRUDO no se persiste`). `D` sigue sobreviviendo, igual que en la it-1 y como el Dev
declara — el `toLowerCase()` del paso 5 no es load-bearing (frente ya resuelto en la it-1, no se re-litiga).

Ningún mutante cambió de resultado por el fix-pack. **La brecha declarada queda cerrada.**

---

# 5. Mutantes NUEVOS, sobre el fix-pack mismo — los 5 matan

Ningún test del fix-pack se aceptó sin ponerlo rojo primero.

| Mutante | Mutación | Rojos | Qué prueba |
|---|---|---|---|
| `M-AR-1` | re-agregar `value: body.payment,` al log del **POST** (`:282-286`) | **1** — `T-316-27` | El testigo del POST existe y es único |
| `M-AR-2` | ídem en el **PATCH** (`:498-502`) | **1** — `T-316-28` | El testigo del PATCH es **independiente** del del POST (no hay un solo test tapando los dos sitios) |
| `M-AR-5` | `value: '[redacted]'` en el POST | **1** — `T-316-27` | 🔴 **La aserción es por AUSENCIA DE LA KEY, no por valor vacío.** Un "arreglo" con `slice()` o con `[redacted]` NO pasa. Es exactamente lo que el Dev declaró y es cierto |
| `M-AR-3` | alinear el POST con el PATCH (`&& body.payment !== null`) | **2** — `T-316-04/05/19` (pre-existente) + `T-316-29` | El lado POST de la desviación tenía **ya** un testigo a nivel route; el nuevo lo refuerza |
| `M-AR-4` | quitarle al PATCH el `!== null` (alinear el PATCH con el POST) | **1** — `T-316-29 (el otro lado del par)` | 🔴 **El par cubre las DOS direcciones**, y el lado PATCH **no tenía ningún otro testigo**: sin el test nuevo, esta mutación —que rompe el BORRADO del bloque (AC-8)— pasaba en verde |

`M-AR-4` es la que valida la decisión de escribir `T-316-29` como par: **es el único testigo de esa
dirección en todo el repo**. El dato del Dev ("el lado del PATCH no tenía ningún testigo a nivel route") es
correcto, medido.

---

# 6. Los cuatro hallazgos de la it-1, uno por uno

## `MNR-1` (log del 422) — ✅ **CERRADO**

- **Premisa verificada**: `grep -n bodyLimit src/index.ts` → **exit 1, cero coincidencias** ⇒ rige el default
  de 1 MiB. **Corroborado independientemente** por `src/lib/discovery-query.ts:219-223`, que documenta la
  misma premisa para otra deuda con nombre (`TD-322-4`): *"`src/index.ts` construye Fastify sin `bodyLimit`
  y el default son 1 MiB"*. Dos fuentes, misma conclusión.
- **El valor ya no sale**: `:282-288` (POST) y `:498-504` (PATCH) loguean `{ field, code }` y nada más.
- **Barrido de caminos residuales** (esto no lo declaró el Dev, lo medí yo): `body.payment` aparece en
  `src/` sólo en `:270/:271` y `:493/:494` —las dos veces como argumento de `validatePaymentBlock`— más dos
  comentarios. El **único** log que toca el bloque es el de auditoría, y pasa por
  `auditView` (`payment-spec-writer.ts:339-344`), que proyecta `{ chain, contract }` **del bloque ya
  validado** (chain ∈ slugs conocidos, contract con formato de wallet validado) ⇒ **longitud acotada**.
  No queda ningún camino por donde el JSON crudo del caller llegue a un log.
- **Los 5 guards hermanos que el fix-pack cita**, re-medidos en HEAD: `:220 { field: 'priceUsdc' }`,
  `:237 { field: 'payoutWallet' }`, `:252 { field: 'referrerRef' }`, `:459 { field: 'enabled' }`,
  `:475 { field: 'capabilities' }`. **Los 5 exactos.**
- **Las tres citas que el fix-pack rompió al arreglar esto**: las dos de prosa, corregidas y línea-neutras
  (§2.2); el número, actualizado a `:338` (§2.1). ✅

## `MNR-2` (`payment: null` → 422 en el ALTA) — ✅ **CERRADO, y declarado donde se lee**

- El par cubre las dos direcciones, con mutante por dirección (§5, `M-AR-3` / `M-AR-4`).
- **Declarado donde lo lee quien publica un agente**, que era el punto: `doc/INTEGRATION.md:269-270`, en
  inglés, en la sección `Declaring where your agent gets paid (payment)`:
  *"On `POST` there is nothing to delete, so `"payment": null` is rejected with `INVALID_PAYMENT_BLOCK`
  rather than being silently read as 'no payment block'."* Más el porqué en el route (`:265-268`), el
  docblock del test (`agents.publish.test.ts:373-385`) y la entrada de desviación en `auto-blindaje.md`.
  **No quedó sólo en el INTEGRATION.md, y tampoco sólo en el auto-blindaje.**

## `MNR-4` (`discovery.ts:255`) — ✅ **medido de nuevo por mí, los cuatro números exactos**

| Afirmación del Dev | Medido acá | ¿OK? |
|---|---|---|
| `main:429-436` = el INSERT de `publish()` | `429-430` = `row.referrer_ref = …`, `432-436` = `.from('a2a_agents').insert(row).select().single()` | ✅ |
| `HEAD:469-480` = lo mismo, desplazado | idem, `472-476` es el INSERT | ✅ |
| `HEAD:506-510` = el SELECT de `listAsAgents`, firma `:505`, siguiente `listPublisherAnchors` en `:537` | `505: async listAsAgents()`, `506-510` = `await supabase / .from / .select('*') / .eq('enabled', true) / .order`, `537: async listPublisherAnchors` | ✅ |
| equivalente en `main` = `:453-457` | idem sobre `git show 8242b16:src/services/agent.ts` | ✅ |

`discovery.ts` **no** se tocó (CD-6 respetado, y el archivo no está en el diff de la rama). El defecto queda
declarado como PRE-EXISTENTE con el ancla semánticamente correcto. Correcto.

## `MNR-3` → `TD-316-METADATA-LWW` — ✅ **el diferimiento está bien argumentado, y escrito como acotamiento**

Verifiqué el **mecanismo**, no la prosa:

- `update()` lee la fila en `:624` (`const existing = await this.getRow(slug)`), mergea en memoria en
  `:734-754` y escribe el objeto `metadata` **completo** en `:757-763`. Read-modify-write sin versión.
- La condición del merge (`:726-733`) **entra con `updates.discoverable !== undefined` solo**, así que el
  paso 2 del interleaving que el Dev describe es alcanzable tal como está escrito.
- El log de auditoría **es silencioso en ese paso**: `:781` es `if (updates.payment !== undefined)`, y en un
  PATCH de `discoverable` eso es `undefined` ⇒ el bloque desaparece sin ninguna señal. Confirmado.
- Está escrito como **acotamiento de probabilidad, no como cierre**, con esas palabras: *"Eso **acota la
  probabilidad, no cierra el camino**: no hay ningún guard que impida el interleaving, y no hay ninguna
  señal —ni en la respuesta HTTP ni en el log— de que ocurrió."* ✅
- La razón del diferimiento es verificable y verdadera: la variante con columna de versión **necesita DDL**
  y la HU es cero-DDL (CD-14/AC-9), y `jsonb_set` cambia el contrato de escritura de los 4 campos del
  `metadata`, no sólo de `payment`. Los 3 disparadores están escritos y son accionables.

**Sin objeción.** Es otra HU, y el argumento de por qué sube de severidad con WKH-316 —"la ventana no la
abrí yo; lo que puse adentro, sí"— es el criterio correcto.

---

# 7. El agujero que el Dev declaró y no pudo cerrar — **¿es cerrable? Sí, y el patrón ya existe acá**

## 7.1 `codeOnly` hace lo que el Dev dice — verificado

`test/payment-guards-live-in-one-place.test.ts:45-55`:

```js
function codeOnly(file: string): string {
  const raw = readFileSync(join(REPO_ROOT, file), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')                  // ← se come TODO bloque /* … */
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}
```

Los dos consumidores se escanean **sin comentarios**, y con razón (`:16-20`: si no los sacara, `x402` en
`routes/agents.ts:66` y `getInitializedChainKeys()` en `:124` darían falso positivo — **las dos citas
verificadas exactas**). Consecuencia inevitable: **este guardián no puede ponerse rojo por un comentario
falso.** El Dev lo declaró bien.

## 7.2 La pregunta que importa: ¿hay HOY algún mecanismo que cace un docblock que afirma un candado inexistente?

**NO.** Barrido de los 15 tests del repo que leen fuentes con `readFileSync`:

| Mecanismo | Qué verifica | ¿Cazaría una cita `archivo.ts:N` falsa? |
|---|---|---|
| `test/docs-referenced-by-code-exist.test.ts` | que un puntero de código a un **documento** resuelva — **existencia de archivo**, nivel path | ❌ no mira líneas, y no mira punteros a `.ts` |
| `test/payment-guards-live-in-one-place.test.ts` | estructura del código, **con los comentarios borrados** | ❌ por construcción |
| `test/ownership-filter-guard.test.ts` | presencia de `.eq('owner_ref', …)` en cadenas `supabase.from()` | ❌ no mira prosa (y ni el VALOR del filtro, ya declarado en su docblock) |
| `test/readme-numbers.test.ts` / `readme-parity.test.ts` | números y citas de los README | ❌ sólo README, y sólo lo declarado ahí |

**Y sin embargo el patrón que lo resolvería ya existe en este repo, funcionando, para UN destino**:
`test/sdd-index-matches-folders.exceptions.ts:160-192` define

```ts
export interface CitedIndexLine {
  readonly from: string;              // archivo de src/ que cita
  readonly line: number;              // el número citado
  readonly mustContain: readonly string[];  // lo que ESA línea tiene que seguir diciendo
}
```

con la propiedad exacta que falta —*"el universo de citas SÍ se deriva: el guardián grepea `src/` y exige
que toda cita que encuentre esté declarada acá (control G-F2). Una cita nueva sin declarar = rojo"*— y con
el razonamiento correcto escrito al lado (`mustContain` a mano, **nunca** derivado del contenido actual,
porque derivarlo daría verde siempre). **Sólo cubre citas a `doc/sdd/_INDEX.md:N`.**

## 7.3 Por qué esto es un hallazgo de arquitectura y no una nota al pie

Es la superficie por la que entró **todo** defecto de citas de esta HU. Contadas, en un solo blast radius:

1. `agent.ownership.test.ts:6` → `:761` (falso, era `:602`) — it-1 `BLQ-BAJO-1`
2. `orchestrate.ts:1160` → `:599` (falso, era `:579`) — it-1 `BLQ-BAJO-1`
3. `routes/agents.ts:112` — prosa cierta al escribirse, falsa por el propio fix-pack
4. `payment-spec-writer.ts:93` — ídem
5. `self-published-auth.ts:29` → `:330` movido a `:338` por el propio fix-pack
6. `discovery.ts:255` — falsa **en `main`**, y el valor nuevo la propagaba (it-1 `MNR-4`)
7. `types/index.ts:385` → `agent.ts:399`, línea **vacía** en `main` (pre-existente, declarada)
8-11. **Las cuatro nuevas de `BLQ-BAJO-1` de abajo**
12. `agent.payment.test.ts:303` → `downstream-payment.ts:132` (`MNR-1` de abajo)

**Doce citas defectuosas, cero cazables por cualquier test de este repo.** La tasa no baja escribiendo
prosa más cuidadosa: bajó cada vez que alguien la midió a mano, y sube en cuanto nadie la mide.

Severidad **MENOR** y no BLOQUEANTE, a propósito: es una brecha **pre-existente y del repo entero**, y
construir el guardián es otra HU — meterlo en un fix-pack de AR sería el scope-creep que el fix-pack no
puede tener. Pero es un MENOR con nombre y con diseño ya probado adentro del repo, no un "estaría bueno".

---

# 8. Hallazgos

## `BLQ-BAJO-1` · Test Coverage / Documentación · El inventario corregido declara 4 anclas y son 8

- **Archivo:línea**: `doc/sdd/214-…/auto-blindaje.md:232` (la fila del inventario) vs
  `src/services/agent.ownership.test.ts:20`, `:36`, `:112`, `:124`.
- **Qué está mal**: el fix-pack re-publicó el inventario con un encabezado que lo declara autoritativo
  (`auto-blindaje.md:9-11`: *"Los valores de abajo son los **corregidos y re-medidos por contenido**"*), y su
  fila para `src/services/agent.ownership.test.ts` nombra **sólo la línea `:6`**. Ese archivo tiene **cuatro
  anclas más** a `services/agent.ts` que **esta misma HU desplazó**, ninguna declarada en ningún artefacto
  (`auto-blindaje.md`, `ar-report.md` ni `story-file.md` las mencionan: verificado por `grep`).
- **Reproducción** — abrir cada una en HEAD y comparar con lo que la prosa afirma:

  | Cita | Lo que la prosa afirma | Qué hay en ese número en HEAD | Ancla real |
  |---|---|---|---|
  | `:112` (**nombre del test AG-01**) | `[agent.ts:549]` = el filtro `owner_ref` de `listMine` | `549: .in('slug', slugs)` — dentro de **`listPublisherAnchors`** (firma `:537`) | **`:602`** |
  | `:124` (**nombre del test AG-02**) | `[agent.ts:715]` = el DELETE | `715: updateRow.referrer_ref = updates.referrerRef.trim();` — dentro de **`update()`** | **`:822`** |
  | `:20` | *"`agentService.delete` hace `this.getRow(slug)` SIN filtro de dueño (`:692`)"* | `692: readMetadataObject(existing.metadata),` — la captura de `previousPaymentBlock` de **`update()`** | **`:799`** |
  | `:36` | *"(`agent.ts:721`: `return Array.isArray(data) && data.length > 0`)"* | `721:` es una **línea de comentario** del merge de `update()` | **`:828`** |

- **Impacto**: es la misma clase que `BLQ-BAJO-1` de la it-1, **en el mismo archivo que la tabla ya nombra**,
  y publicada bajo un encabezado que afirma completitud que no tiene. Dos de las cuatro son **nombres de
  test**, o sea que se imprimen en la salida de CI: el próximo que vea fallar `AG-01 [agent.ts:549]` va a
  abrir `:549` y encontrar **otra query en otra función**. Y `AG-01`/`AG-02` no son dos tests cualquiera:
  son los que sostienen la propiedad de aislamiento de WKH-SEC-03, o sea los punteros que alguien va a
  seguir primero cuando toque ownership.
- **Sugerencia**: agregar las 4 filas al inventario (o extender la fila `:232`) con los valores de la tabla
  de arriba y el mismo tratamiento `❌ NO — fuera de Scope IN` que las otras — `agent.ownership.test.ts`
  **no** está en el diff de la rama, así que no se puede ni se debe editar acá. **Cero cambios en `src/`,
  cero tests nuevos.** De paso, `auto-blindaje.md:306` sigue diciendo `routes/agents.ts:265 → :330`, número
  que la propia entrada corrige 9 líneas más abajo (`:353`, `:338`): si la tabla se toca, cuesta cero
  dejarlo consistente.
- **Por qué BLOQUEANTE-BAJO y no MENOR** (lo consideré): la it-1 clasificó **esta misma clase** como
  `BLQ-BAJO-1` y el fix-pack se produjo sobre esa base; bajarla ahora, para el mismo defecto y el mismo
  archivo, sería calibración inconsistente. No es MEDIO/ALTO: no cambia ningún camino de ejecución, no
  rompe ningún AC y no toca el camino del dinero.

## `MNR-1` · Documentación · Cita PRE-EXISTENTE falsa, en un archivo que **sí** es Scope IN

- **Archivo:línea**: `src/services/agent.payment.test.ts:303`.
- **Qué dice**: *"`settleSolanaLeg` (downstream-payment.ts:132) lo skipea con INVALID_PAY_TO_FORMAT sin
  mover fondos"*.
- **Medido**: `settleSolanaLeg` está declarada en `src/lib/downstream-payment.ts:247`
  (`async function settleSolanaLeg(`) y se llama en `:763`. La línea **`:132` es prosa de un docblock de
  campo de interfaz** (*"Monto REALMENTE settleado al agente, en USD…"*), sin relación. La afirmación de
  fondo —que el skip existe y no mueve fondos— **es cierta**; el número no.
- **Es PRE-EXISTENTE**: `git show 8242b16:src/services/agent.payment.test.ts` trae el **mismo texto** en
  `:240`. Esta HU no la escribió: la **desplazó** dentro de su propio archivo (+63) sin re-verificarla.
- **Impacto**: bajo y acotado a diagnóstico. Lo anoto porque, a diferencia de `discovery.ts:255`, **no hay
  ningún CD que prohíba tocar este archivo** (es Scope IN, +538/-2 en esta rama), así que es la única de las
  citas pre-existentes falsas que se puede cerrar sin abrir otra HU.
- **Sugerencia**: corregir a `downstream-payment.ts:247` (o dejarla sin número: *"`settleSolanaLeg` en
  `src/lib/downstream-payment.ts`"*, que no envejece). Si se decide no tocarla, declararla como
  pre-existente igual que las otras dos, para que el próximo corrija la semántica y no la aritmética.

## `MNR-2` · Arquitectura · Ninguna cita `archivo.ts:N` de este repo tiene testigo posible

Desarrollado en §7. Resumen accionable:

- **Estado**: `codeOnly` borra los comentarios antes de mirar (verificado, `:45-55`), y ninguno de los 15
  tests que leen fuentes verifica un `archivo.ts:N`. **12 citas defectuosas en el blast radius de esta sola
  HU, 0 cazables.**
- **El diseño ya existe adentro del repo**: `test/sdd-index-matches-folders.exceptions.ts:160-192`
  (`CITED_INDEX_LINES` = `{from, line, mustContain}` declarado a mano + universo derivado por `grep` +
  control G-F2 "cita nueva sin declarar = rojo"). Hoy cubre **un** destino: `doc/sdd/_INDEX.md:N`.
- **Sugerencia**: HU nueva que generalice ese guardián a citas `*.ts:N` hechas desde `src/` y `test/`,
  arrancando por el conjunto chico y medido de esta HU (9 sitios). **No es trabajo de este fix-pack.**

---

# 9. Categorías que NO aplican al fix-pack

Sólo se listan las que el fix-pack pudo mover. Las 11 completas están en `ar-report.md` (it-1).

| Categoría | Estado | Justificación |
|---|---|---|
| 1. Security | **OK** | El fix-pack **reduce** superficie: saca un valor controlado por el caller de dos líneas de log (§6/`MNR-1`). Cero `supabase.from()` nuevo, cero cambio de auth, cero cambio de respuesta HTTP. Barrido de caminos residuales del crudo hecho por mí: no queda ninguno |
| 2. Error Handling | **OK** | Ninguna rama de error cambió. El `try/catch` del POST (`:342-354`) y el mapeo `OwnershipMismatchError` → 404 están intactos |
| 3. Data Integrity | **OK** | Ninguna escritura cambió. La única deuda de integridad es `TD-316-METADATA-LWW`, verificada como bien diferida (§6) |
| 4. Performance | **OK** | El fix-pack **quita** trabajo (serializar hasta 1 MiB de JSON por 422). Cero queries nuevas |
| 5. Integration | **OK** | La única desviación de contrato (`POST` + `payment: null` → 422) está declarada en `doc/INTEGRATION.md:269-270`, en el route, en el test y en el auto-blindaje, con mutante por dirección |
| 6. Type Safety | **OK** | `tsc --noEmit` exit 0 sobre el árbol final. El fix-pack sólo **borra** una property de un objeto de log |
| 7. Test Coverage | 🔴 **`BLQ-BAJO-1`** | Los 4 tests nuevos son fuertes y los medí (§5: 5 mutantes, 5 muertes, incluido el que prueba "ausencia de key ≠ valor vacío"). Lo que falla es el inventario de citas, no los tests |
| 8. Scope Drift | **OK** | 4 archivos: 2 de `src/` los dos del Scope IN de la HU, 1 test del Scope IN, 1 artefacto del pipeline. El fix-pack **no** tocó `discovery.ts` (CD-6), ni `agent.ownership.test.ts`, ni los README, ni `package.json`, ni `_INDEX.md` |
| 9. Destructive Migrations | **N/A** | Cero SQL en el fix-pack y cero en la rama: la HU es explícitamente cero-DDL (CD-14) |
| 10. RPC `SECURITY DEFINER` | **N/A** | Cero `supabase.rpc(...)` y cero funciones Postgres en el diff |
| 11. Cache Invalidation | **N/A** | Cero capa de cache nueva. El único cache cercano (`services/agent-price.ts`) no se toca y ya está declarado como no-cubriente en `orchestrate.ts:1150-1155` |

---

# 10. Instrumentos: los que fallaron y los límites de lo que pude medir

**Instrumentos que fallaron o hubo que evitar** (todos confirmados en esta corrida):

- `git diff` / `git show` bajo el hook de `rtk` **trunca en el medio de los hunks**: usé `/usr/bin/git` para
  el 100% de las lecturas de git, con volcado a archivo y `wc -l` de control (463 líneas del fix-pack).
- `grep` bajo el hook devuelve **conteos en vez de rutas**: usé `command grep -n` en todos los barridos.
- Exit codes después de un pipe son del pipe: `biome` y `vitest` los medí **sin pipe**
  (`biome check src/ > /dev/null 2>&1; echo $?`).
- `npx` no resuelve los binarios: usé `./node_modules/.bin/{vitest,tsc,biome}`.
- `cat` corrompe salida redirigida bajo el hook: leí todo con `Read` o `awk 'NR>=a && NR<=b'`.
- `git log --oneline` borra los merges: usé `--format` explícito y `rev-parse`.
- Mi propio runner de mutantes: cada mutación se aplica con un script que **aborta si la cadena buscada no
  aparece exactamente 1 vez** (control anti-mutación-fantasma), y cada corrida imprime `md5 mutado` /
  `restaurado` / `original` — 9 mutantes, 9 restauraciones verificadas, `git status` limpio al final.

**Límites de lo que pude medir** — con esas palabras:

1. **No pude medir la prosa con un mutante**, igual que el Dev: es `MNR-2`, y no es una limitación mía sino
   del repo. Todo lo que digo sobre citas en este reporte está verificado **leyendo el archivo y la firma
   contenedora**, nunca con un test. Si me equivoqué en un número, **nada lo va a cazar** — y ya me
   equivoqué dos veces en esta HU, por eso re-medí desde cero los cuatro valores del `BLQ-BAJO-1` anterior
   en lugar de heredarlos.
2. **No corrí nada contra producción ni contra ninguna base.** Todo es suite local + lectura de fuentes.
   La propiedad de aislamiento por dueño a nivel Postgres (RLS) sigue siendo app-layer y sigue siendo
   `WKH-SEC-02`; no la toqué ni la medí.
3. **No re-corrí los mutantes `A/B/C/G` de la it-1** (`prev` antes del merge, `sameAddress` sin
   `toLowerCase`, merge sin la condición). Corrí `M15` y `D/E/F` porque son los que el orquestador pidió y
   los que viven en los dos archivos que el fix-pack tocó; los otros están en `src/services/agent.ts`, que
   el fix-pack **no** modificó (verificado: no está en el diff de `e57af46`). El verde de la suite completa
   cubre regresión, no cada mutante uno por uno.
4. **No auditré la it-1 completa de nuevo.** Los 6 frentes que salieron a favor de la implementación no se
   re-litigaron, por instrucción explícita. Si alguno de esos veredictos estaba mal, este reporte no lo
   corrige.
5. **`ar-report.md:249` (mi propio artefacto de la it-1) quedó viejo**: dice *"`:330` = `keyRow.owner_ref,`"*
   y el `+8` del fix-pack lo movió a `:338`. La it-1 es una **medición congelada del árbol `e57af46^`** y no
   la edito; el valor vigente es `:338`, medido en §2.1, y la tabla de `auto-blindaje.md:235` ya lo trae
   bien. Lo declaro acá en vez de dejarlo como un número más envejeciendo en silencio.
6. **El `story-file.md` untracked de la HU 212** no se tocó: md5 `7904ef74a1c46d7880e0ca5d38e3eed4` al abrir
   y al cerrar.

---

# 11. Qué queda como deuda declarada (si el `BLQ-BAJO-1` se cierra)

1. **`TD-316-METADATA-LWW`** — LWW del objeto `metadata` en `update()`. Diferida con razón (necesita DDL vs
   HU cero-DDL), con interleaving de 4 pasos y 3 disparadores escritos. **Es otra HU.**
2. **`MNR-2` de este reporte** — ningún testigo posible para citas `archivo.ts:N`. Diseño ya probado en el
   repo (`CITED_INDEX_LINES`). **Es otra HU.**
3. **Citas pre-existentes falsas, declaradas y no arregladas**: `discovery.ts:255` (CD-6 lo prohíbe; ancla
   real `:506-510`), `types/index.ts:385 → agent.ts:399` (línea vacía en `main`),
   `agent.payment.test.ts:303 → downstream-payment.ts:132` (real: `:247` — `MNR-1`, y ésta **sí** es
   tocable).
4. **Citas fuera de Scope IN que esta HU desplazó y no puede arreglar**: `agent.ownership.test.ts:6,20,36,112,124`
   y `orchestrate.ts:1160` y `self-published-auth.ts:29`. Todas con su valor real medido en este reporte y
   en el inventario de `auto-blindaje.md` — **es exactamente lo que `BLQ-BAJO-1` pide completar**.
5. **`D` sobrevive a propósito**: el `toLowerCase()` de `isZeroPayTo` no es load-bearing. Declarado por el
   Dev, confirmado en la it-1 y re-confirmado acá.

---

**Veredicto: RECHAZADO.** Un solo `BLQ-BAJO`, que se cierra editando **una tabla de un `.md`** — cero
`src/`, cero tests, cero riesgo de disparar una tercera ronda de desplazamientos. Todo lo demás del
fix-pack está verificado y **pasa**: los 5 mutantes nuevos matan, `M15`/`D`/`E`/`F` dan idéntico al árbol
anterior, los 4 números re-apuntados caen en la función correcta, las dos correcciones de prosa son
línea-neutras **y esa neutralidad salvó una cita real**, y las tres puertas dan exactamente lo declarado.
