# AR — WKH-366 · Adversarial Review

**Veredicto global: RECHAZADO — 1 BLOQUEANTE-ALTO activo.**

> Materializado por el orquestador desde el reporte inline del `nexus-adversary` (el harness le
> prohibía escribir `.md`). Contenido íntegro, sin edición de juicio.

De los siete ataques pedidos, **seis los aguanta**. El que no aguanta es el número 1, y falla en el
punto exacto donde el Dev escribió que no podía fallar.

| Ataque | Resultado |
|---|---|
| 1. El impostor (N1/N2/N3) | **BLQ-ALTO-1** — N3 es forjable; N1 y N2 no lo cubren |
| 2. Fail-closed | **OK** — no hay rama que autorice |
| 3. `decisionToken` | **OK** + `MNR-1` (riesgo latente acotado) |
| 4. "Cero cambio con `direct`" | **OK** — verificado por diff, no por el test |
| 5. Tests que no miden | **OK** — no hay tercer caso |
| 6. P-1..P-7 | **OK** |
| 7. Presupuesto (check 7) | **MNR-2** |

---

## 🔴 BLQ-ALTO-1 — El pin es forjable

**Categoría**: Security (auth bypass / suplantación en el money-path) · **AC roto**: AC-6 / CD-1, y **AC-10** por consecuencia.

### La afirmación que rompe

`chaski-v3/src/infrastructure/kyc/gateway-kyc-client.ts:131-135`:

```ts
const ref = r.agents[0] ?? null;
if (ref === null || ref.slug !== slug || ref.registry !== EXPECTED_REGISTRY) {
```

con `EXPECTED_REGISTRY = "self-published"` (`:52`). El docblock de `:44-51` justifica el par
diciendo que *"no es forjable desde el card de un candidato federado"*.

**Es falso.** `registry` no es un atributo del deploy: es un string que elige el publicador.

### Vector (a) — Slug squatting. Es una carrera abierta.

Las dos filas del catálogo **todavía no están registradas**. El slug de `a2a_agents` es **PK global,
primero-que-llega, sin scoping por owner**:

- `wasiai-a2a/src/routes/agents.ts:153-157` — `POST /agents` es **auth-only**: sin fee, sin rol, sin allowlist
- `wasiai-a2a/src/services/agent.ts:443` — `const slug = input.name.toLowerCase().replace(/\s+/g,'-')`
- `:447` — pre-check de colisión *"(cualquier owner)"*
- `:150` — `registry: SELF_PUBLISHED_REGISTRY_NAME` **hardcodeado**
- `:578-591` — `getBySlugAsAgent` filtra `.eq('slug').eq('enabled', true)`: **sin `owner_ref`, sin
  `verified`, sin `discoverable`**

⇒ Un atacante publica un agente llamado `Remit Kyc Decision` apuntando a su host. `getAgent(slug)` es
local-first (`discovery.ts:1391-1397`) y devuelve **la fila del atacante**, con
`registry:"self-published"` y el slug esperado. **N1** pinea al slug, que es del atacante. **N2** no
corre: sólo mira `step.capability`, y un step pinado hace `continue`. **N3** pasa: el par es exacto.

### Vector (b) — Un registry federado llamado literalmente `self-published`

- `wasiai-a2a/src/types/index.ts:208-214` — `self-published` **no existe como fila en `registries`**
- `wasiai-a2a/src/routes/registries.ts:67-76` — `validateRegisterBody` **no tiene blocklist de nombres**
- `wasiai-a2a/src/services/registry.ts:262` — el id sale del nombre ⇒ **`self-published` está libre**

Y el propio `compose.ts:1809-1817` ya lo dice textual: *"el `registry_id` **NO es un guard de
seguridad**… cualquier caller autenticado puede `POST /registries` con ese nombre"*. Esa advertencia
estaba escrita para el reparto de credenciales outbound; WKH-366 la convirtió, sin querer, en el
guard del desembolso.

**(b2) — el disparador no necesita al atacante.** `discovery.ts:1394-1396` degrada en silencio: un
hipo de Supabase, o nuestra fila en `enabled:false` un rato, y el fanout federado corre **en el
momento del desembolso**. Nada se pone rojo.

### Reproducción

```
POST /agents     name="Remit Kyc Decision"  -> a2a_agents.slug = "remit-kyc-decision"
POST /registries name="self-published"      -> registries.id   = "self-published"
N3 (gateway-kyc-client): rechaza? false
```

Y el desenlace es **el propio control positivo del Dev**, T-C5 (`authority.gateway.test.ts:154-165`):
ese par con `payoutAllowed:true` ⇒ `{authorized:true}`. Es exactamente lo que el atacante controla.

**End-to-end**: el atacante squattea los dos slugs. Chaski crea la sesión contra el impostor,
persiste su `decisionToken` inventado atado a la dirección real del usuario, y en `prepare` la
autoridad le pregunta al impostor, que contesta `payoutAllowed:true`. **KYC/AML del money-path
eludido para cualquier dirección.** De yapa, el `decisionToken` le llega al atacante y su
`payout_wallet` cobra el step.

### Por qué no es teórico

Es literalmente el agujero que la HU existe para cerrar. La HU cambió el **mecanismo** del ataque
(de "ganar el ranking" a "publicar la fila con el slug esperado") pero no el **resultado**. Y le
**bajó el costo** al atacante: ya no necesita ganar ningún ranking.

### Qué cambiar

1. **Registrar las dos filas del catálogo antes de mergear.** Mientras el slug esté libre es una
   carrera y gana el primero. Es **precondición del merge**, no el paso 2 del orden.
2. **N3 tiene que comparar algo que no elija un publicador.** El dato ya viaja:
   `StepResult.agent` va **entero** en la respuesta (`wasiai-a2a/src/types/index.ts:1431`,
   `src/routes/compose.ts:1437`), o sea que `agent.invokeUrl` está disponible. Cruzar el **host** del
   ejecutor contra el host de `KYC_AGENT_BASE_URL` —que vive en una env del deploy y ningún
   publicador puede tocar— cierra los dos vectores. `readAgentRef` (`gateway-client.ts:247-269`) hoy
   descarta `invokeUrl`; hay que transportarlo.
3. **Coordinador, defensa en profundidad**: reservar el nombre/id `self-published` en
   `validateRegisterBody`/`registryService.register`. Hoy un tercero puede apropiarse del namespace
   sintético del propio gateway.
4. La sonda de AC-13 hereda el defecto: su **exit 6 (SUPLANTACIÓN)** no puede dispararse nunca ante
   el ataque real. Actualizar con el mismo criterio que (2).

---

## MNR-1 — El `decisionToken` puede llegar a un LLM de terceros si un step de KYC deja de ser índice 0

`wasiai-a2a/src/services/compose.ts:999-1084`: ante un 4xx con `fieldErrors`, el Coordinador manda el
**input completo del step** a un LLM para regenerarlo. El 400 del endpoint nuevo usa
`parsed.error.flatten()` (`remit-kyc-decision/invoke/route.ts:95-99`), que emite `fieldErrors` ⇒
`parseFieldErrors` (`lib/field-error-parser.ts:63-67`) **matchea**.

Hoy es inalcanzable porque `isMasterPath` exige `stepDebitedUsd > 0` (`compose.ts:849`) y el débito
per-step está gateado en `if (i > 0 …)` (`compose.ts:634`); `invocarPineado` manda siempre un solo
step. **Sugerencia**: anotar en el docblock que el "exactamente un step" es *también* lo único que
mantiene la credencial fuera del retry adaptativo, y evaluar excluir `AUTHORIZATION_CAPABILITIES` del
camino `willRetry` del lado del Coordinador.

---

## MNR-2 — Check 7: el 2.0x del repo C está justificado; no recortar

Código de producción nuevo en repo C: **~412 líneas** — dentro de banda, sin una línea que alguien
que ya conoce el patrón fuera a borrar. El 2747 se explica por la sonda de AC-13 (**1075 líneas**, ya
declarada "deliberadamente grande" en el work-item) y ~473 de prosa normativa, que es convención del
repo. Restados los dos: **~1200 ⇒ dentro de 800-1400**.

Lo que faltó fue que la banda del SDD contara el test del helper del smoke (329 líneas), previsible.

**Sobre recortar T-B9 (propuesta del Dev)**: repo B es el menor de los tres (1.37x) y T-B9 no es
duplicado — además de la mayúscula ejercita el **whitespace** atravesando la ruta entera hasta el 400
pre-débito. **No recortarlo.**

---

## Las 11 categorías

| # | Categoría | Veredicto |
|---|---|---|
| 1 | Security | **BLQ-ALTO-1**. Lo demás limpio: cero secretos en los diffs; 401 byte-idéntico sin oráculo de enumeración; `guardInvokeAuth` antes de leer el body (M9 lo canda por CONTADOR, no por status); el `decisionToken` viaja en body, no en query |
| 2 | Error Handling | **OK**. Barrido rama por rama: sin `default: ok`, sin `??`/`\|\|` que rellene un veredicto; el gate es `payoutAllowed !== true` estricto; `identityMatches` se preserva **ausente**; `bridged` mide presencia y es fail-CLOSED ante un `bridgeType` nuevo |
| 3 | Data Integrity | **OK**. `kyc_session_tokens` sin cambios — 0 archivos `.sql` en los tres diffs. El doble del store aplica el filtro de verdad |
| 4 | Performance | **OK**. Un step por llamada, cero queries nuevas |
| 5 | Integration | **OK**. AC-3 medido: 0 rutas de `remit-kyc-validator/` en el diff. Una capacidad por fila, las dos guardadas. Los 3 call sites cambian sólo el especificador del import |
| 6 | Type Safety | **OK**. Cero `any` nuevo; la unión discriminada impide que `agent`+`capability` compilen juntos |
| 7 | Test Coverage | **OK**. 330 tests corridos, 0 fallos. Los controles positivos son genuinos. **Busqué el tercer test mal apuntado y no lo encontré** |
| 8 | Scope Drift | **OK**. Los tres cambios laterales están forzados por candados existentes y declarados |
| 9 | Destructive Migrations | **N/A** — cero migraciones |
| 10 | RPC `SECURITY DEFINER` | **N/A** |
| 11 | Cache Invalidation | **N/A** — el L2 del bridge es inalcanzable con un step |

---

## Verificado y limpio (para no re-auditar)

- **N2 corre pre-débito y pre-discovery**: `routes/compose.ts:1197-1203`, `validateComposeBodyHandler`
  antes de resolver capacidades, precio y pago. Candado con contadores en 0, no por status.
- **N2 sin bypass por forma**: `normalize` es `.trim().toLowerCase()` (`capability-risk.ts:176-178`),
  **más agresivo** que el filtro de discovery. Pipeline mixto cubierto. `inputFromPrevious`/`passOutput`
  no participan.
- **`decisionToken`**: no se loguea (Fastify sin serializador de body), no viaja en URL, no se
  persiste (`remainingSteps` con un step es `[]`), `StepResult` no tiene campo de input, y del lado de
  Chaski se descarta el `message` del fallo.
- **AC-8**: no me apoyé en T-C2 — el diff de `agent-kyc-client.ts` son **dos líneas**, las dos
  renames de firma; los cuerpos no cambiaron un byte ⇒ el snapshot es cierto por construcción.
- **P-1..P-7**: los siete viven en las rutas, aguas arriba del transporte. `session/route.ts` y
  `decision/route.ts` cambian 4 líneas cada uno; `authority.ts`, una. P-3 y P-7 intactos y medidos.
- **No hay camino al veredicto que esquive N3**: los tres call sites entran por `kyc-transport.ts`.
- **El smoke en exit 4 (DRIFT)** es el desenlace correcto, no un hallazgo.

---

## Orden del fix-pack

1. **BLQ-ALTO-1**, en este orden: (1) registrar las filas para cerrar la carrera del slug;
   (2) N3 compara el **host del `invokeUrl`** contra la env del deploy; (3) actualizar el exit 6 del
   smoke al mismo criterio; (4) reservar `self-published` en `POST /registries`.
2. `MNR-1` y `MNR-2` no bloquean.

⛔ **Hasta que BLQ-ALTO-1 esté cerrado, `KYC_TRANSPORT` no pasa a `gateway` en ningún entorno**, ni
siquiera preview. Nada de esto toca `KYC_DECISION_TOKEN_SECRET`.

---

# AR — RONDA 2 · verificación del fix-pack

**Veredicto: APROBADO con MENORes. `BLQ-ALTO-1` está CERRADO.**

El Adversary corrió los tres gates él mismo antes de creer un número, y coinciden:
chaski `qa` 0 · **3268/160** · build 0 — coordinador tsc 0 · lint 516 · **6289 passed** — agente sin tocar.

## ¿Está cerrado? SÍ, y no por lo que dice el docblock

El guard: `chaski-v3/src/infrastructure/kyc/gateway-kyc-client.ts:235` —
`if (!sameOrigin(r.invokeUrls[0], expectedAgentBaseUrl()))`.

- **El ataque original reconstruido**: el impostor con el par perfecto (`slug` exacto + `registry:"self-published"`
  regalado por el Coordinador + `payoutAllowed:true`) ⇒ `{authorized:false, kyc_reauth_failed, 502}`.
- **El mutante lo aplicó el Adversary**, no el Dev: borrar las 4 líneas del bloque ⇒ **17 rojos**, de los
  cuales **6 en el test del desembolso**. El mutante **autoriza plata**.
- **La premisa verificada del lado del Coordinador**: el objeto de `StepResult.agent` es **el mismo** que se
  usó para el fetch (`compose.ts:1997` → `finishSuccessfulStep` `:775`/`:1149` → `routes/compose.ts:1622`).
  ⇒ `invokeUrl` **no es una etiqueta del catálogo: es la URL que se fetcheó.** Ésa es la razón por la que
  el guard vale.
- **Ningún otro camino al veredicto**: los tres call sites importan sólo `kyc-transport`, único importador de
  los dos clientes. Un impostor que sirva el `POST /session` es rechazado **antes** de que la ruta persista
  el `decisionToken`.

## La comparación de origen: 43 entradas construidas y EJECUTADAS

Buscó el caso letal —un `invokeUrl` cuyo origen coincida y cuyo fetch real vaya a otro host— y **no existe**.
Los casos que más enseñan:

| Entrada | Resultado | Por qué |
|---|---|---|
| `https://agentes.test./x` (trailing dot) | **reject** | fail-closed, dirección correcta |
| `https://аgentes.test/x` (cirílico) | reject | punycode ⇒ otro origen |
| `https://ａｇｅｎｔｅｓ.test/x` (fullwidth) | **pass, y es CORRECTO** | undici normaliza igual ⇒ el fetch va a nuestro host |
| `https://evil.example@agentes.test/x` | pass | el host **es** el nuestro |
| `https://agentes.test@evil.example/x` | reject | el que engaña a un lector humano |
| `data:` `file:` `blob:` `javascript:` relativa `""` `null` `123` | reject | `originOf` devuelve `null` |
| env ausente / vacía / no-URL / `ftp://` | **reject** | falla CERRADO |

No hay diferencial de parser: los dos lados son WHATWG-URL de Node.

## El cableado, verificado con un mutante propio

`sameOrigin → return true` ⇒ **8 + 8 + 5 rojos**, incluido el test del desembolso. Antes del arreglo del Dev
mataba **sólo el primero**. El autohallazgo era real y el arreglo también.

Buscó el mismo patrón (función con test propio que producción no invoca) en el resto del fix: **no lo hay**.

## Regresión sobre lo que la ronda 1 dio OK — todo OK

Cero cambio con `direct` (el diff de `agent-kyc-client.ts` son **2 hunks**, ambos renames de firma; cero bytes
de cuerpo) · el `decisionToken` sin fugas nuevas · P-1..P-7 intactos (4+4+1 líneas de import) · AC-3 · sin
migraciones.

## MENORes

- **MNR-3 · cita fantasma**: `registry.ownership.test.ts:231` apunta a `routes/registries.reserved-namespace.test.ts`,
  **que no existe**. El contenido de la afirmación es cierto (vive en `registries.no-charge-before-validating.test.ts`,
  T-NCR-19) pero el puntero manda a la nada, y `cited-lines-guard` no lo caza porque sólo verifica entradas
  dadas de alta.
- **MNR-4 · la sonda ecoa lo que su propio comentario prohíbe ecoar**: `smoke-kyc-helpers.ts:201-202` declara que
  no ecoa la `invokeUrl` observada *"porque ese string lo controla el publicador"*; dos ramas más arriba (`:192`,
  `:197`) ecoa `slug` y `registry`, **igual de controlados y por la misma vía**. La regla se enuncia y no se aplica.
- **MNR-5 · los dos slugs siguen libres** (`/discover` da 404 en los dos). **Ya no es un bypass** —el guard de
  origen degradó el ataque de "eludir KYC" a "denegación + drenaje"— pero el residuo es real y está medido:
  `compose.ts:1997` fetchea y el settle downstream ocurre **después**, en `:2047` ⇒ un squatter que conteste 2xx
  **cobra el step** (precio y `payTo` los pone él) mientras Chaski rechaza por origen. Y el slug es **PK global,
  primero-que-llega**: perdida la carrera, el nombre no se recupera nunca.
  ⇒ **Registrar las dos filas es precondición del flip a `gateway`**, no un paso posterior.

## Las 11 categorías

Security **OK** · Error Handling **OK** · Data Integrity **OK** · Performance **OK** · Integration **OK**
(observación: `doc/INTEGRATION.md` documenta el 400 de capacidad sin pin pero no el de namespace reservado) ·
Type Safety **OK** · Test Coverage **OK** · Scope Drift **OK** · Migraciones / RPC / Cache **N/A**.

⛔ Se mantiene el candado: **`KYC_TRANSPORT` no pasa a `gateway`** hasta que las dos filas estén registradas y
la sonda salga distinto de 4.
