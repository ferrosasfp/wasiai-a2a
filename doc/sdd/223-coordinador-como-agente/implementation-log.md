# Implementation Log — WKH-360 / `223-coordinador-como-agente` (F3)

> Rama `feat/223-wkh-360-coordinador-agente`, base `3823580`. Un commit por wave.
>
> **Todo número de este documento fue MEDIDO, con el comando y el sha al lado.**
> Lo que no se pudo medir está marcado `[NO VERIFICADO]` y no se suaviza.

---

## 1 · Los seis commits

| Wave | sha | Qué entró |
|---|---|---|
| W0 | `23a27dd` | leaf `contracting-chain.ts` + tipos + las 2 envs |
| W1 | `879faa7` | el bucle DIRECTO en los CUATRO sitios de capa 1 |
| W2 | `6f252ad` | capa 2 (traza entrante), techo y propagación (AC-7) |
| W3 | `af9ef5a` | la carta + `well-known.test.ts` + doc de DT-1/DT-2 |
| W4 | `1015f90` | el fee en cascada (AC-10/AC-11/AC-12) + CD-21 |
| W5 | *(este commit)* | barrido de citas, batería completa, auto-blindaje, log |

---

## 2 · Criterio de salida por wave, con el número corrido

| Wave | `tsc` | `biome` | Suite (`Tests`) | Δ | ownership |
|---|---|---|---|---|---|
| base `3823580` | 0 | — | `5441 passed \| 19 skipped` · exit 0 | — | 13/13 |
| W0 | 0 | 0 (479) | `5497 passed \| 19 skipped` · exit 0 | +56 | 13/13 |
| W1 | 0 | 0 (482) | `5526 passed \| 19 skipped` · exit 0 | +29 | 13/13 |
| W2 | 0 | 0 (484) | `5561 passed \| 19 skipped` · exit 0 | +35 | 13/13 |
| W3 | 0 | 0 (485) | `5579 passed \| 19 skipped` · exit 0 | +18 | 13/13 |
| W4 | 0 | 0 (485) | `5594 passed \| 19 skipped` · exit 0 | +15 | 13/13 |

**+153 tests netos sobre el baseline. Cero tests preexistentes movidos sin
explicación**; los TRES que cambiaron de aserción están documentados abajo (§5).

Comandos (sin pipes para adjudicar, CD-13):

```bash
./node_modules/.bin/tsc --noEmit; echo "tsc_exit=$?"
node ./node_modules/vitest/vitest.mjs run > /tmp/x.txt 2>&1; echo "suite_exit=$?"
node ./node_modules/vitest/vitest.mjs run test/ownership-filter-guard.test.ts
```

---

## 3 · La batería de mutación: 18 corridos, 18 muertos

**Protocolo**: suite COMPLETA por mutante, aguja verificada `== 1`, sustitución
verificada por **texto resultante**, respaldo por copia + restauración verificada con
`md5sum`, `git status --short` completo al final de cada uno. El harness **aborta sin
emitir veredicto si `tsc` no da 0** (ver §6, error de W1).

### 3.1 · Calibración (corridos PRIMERO, contra el árbol base)

| ID | Mutación | Esperado | Medido |
|---|---|---|---|
| `CAL-MUERE` | `PLACEHOLDER_FEE_USD` `1.0`→`2.0` | tiene que MORIR | **MUERE** (MEDIDO: exit=1, 51 rojos, en `3823580`) |
| `CAL-VIVE` | comentario al final de `compose-limits.ts` | tiene que VIVIR | **VIVE** (MEDIDO: exit=0, 0 rojos, en `3823580`) |

⇒ el instrumento distingue, así que los veredictos de abajo valen.

### 3.2 · Los 16 obligatorios

| # | Mutación | Medido | Testigos |
|---|---|---|---|
| `MUT-01` | mover el guard del **Sitio 3** debajo del débito per-step | **MATA** (exit=1, **2** rojos, en `879faa7`) | `T-L1-2`, `T-L1-2b` — mueren por el **conteo de débitos**, no por el status |
| `MUT-02` | mover el guard del **Sitio 1** al route handler (post-débito) | **MATA** (exit=1, **6** rojos, en `879faa7`) | los 6 `it` de orden del Sitio 1. ⚠️ **el 400 sale igual bajo el mutante**: un test de status habría sobrevivido |
| `MUT-03` | mover el guard del **Sitio 2** después del `debitRes` | **MATA** (exit=1, **2** rojos, en `879faa7`) | `T-L1-3`, `T-L1-3b` |
| `MUT-04` | `Number.parseInt` en lugar del regex de profundidad | **MATA** (exit=1, **9** rojos, en `6f252ad`) | `T-U-DEPTH-3/4/5/6`, `T-U-MAX-7`, `T-DEPTH-2/3/4`, `T-CHAIN-1-ORDEN` |
| `MUT-05` | `Number()` en lugar del regex | **MATA** (exit=1, **9** rojos, en `6f252ad`) | los mismos 9 |
| `MUT-06` | borrar el strip del punto final (paso 7) | **MATA** (exit=1, **9** rojos, en `879faa7`) | testigos en las TRES capas: leaf, Sitio 1 y Sitio 2 |
| `MUT-07` | comparar `url.host` (con puerto) en vez de `url.hostname` | **MATA** (exit=1, **2** rojos, en `879faa7`) | `T-U-SELF-1`, `T-L1-5` |
| `MUT-08` | `?? Number.POSITIVE_INFINITY` en el techo | **MATA** (exit=1, **6** rojos, en `6f252ad`) | `T-U-MAX-1`, `T-ENV-2b/3`, `T-DEPTH-1/6`, `T-DEPTH-1-ORDEN` |
| `MUT-09` | chequeo de largo **después** del `split` | **MATA** (exit=1, **1** rojo, en `6f252ad`) | ⚠️ **TESTIGO ÚNICO**: `T-CHAIN-1-SPY`. Anotado en el testigo |
| `MUT-10` | `>` en lugar de `>=` en el techo | **MATA** (exit=1, **6** rojos, en `6f252ad`) | `T-U-CEIL-1`, `T-U-MAX-6`, `T-DEPTH-1/5/6`, `T-DEPTH-1-ORDEN` |
| `MUT-11` | invertir el predicado de identidad (**control negativo**) | **MATA** (exit=1, **25** rojos, en `879faa7`) | rompe hasta el e2e del camino feliz ⇒ los gemelos positivos son load-bearing |
| `MUT-12` | leer el sobre del fee **después** del colapso `data.result ?? data` | **MATA** (exit=1, **2** rojos, en `1015f90`) | `T-FEE-4`, `T-FEE-5`. ⚠️ la 1ª versión daba 178 rojos **por un TypeError**: mutante corregido (§6) |
| `MUT-13` | `usdc: 0` cuando el coordinador no declara | **MATA** (exit=1, **3** rojos, en `1015f90`) | `T-U-FEE-3`, `T-U-FEE-4`, `T-FEE-5` |
| `MUT-14` | reportar `feeUsdc` en la rama `skipped` | **MATA** (exit=1, **1** rojo, en `1015f90`) | ⚠️ **TESTIGO ÚNICO**: `T-FEE-2wkh`. Anotado en el testigo |
| `MUT-15` | headers de la traza **después** del spread de credenciales | **MATA** (exit=1, **1** rojo, en `6f252ad`) | ⚠️ **TESTIGO ÚNICO**: `T-PROP-3`. Anotado en el testigo |
| `MUT-16` | emitir la cadena sin `canonicalId` | **MATA** (exit=1, **2** rojos, en `6f252ad`) | `T-U-OUT-3`, `T-PROP-2` |

**Los TRES mutantes de testigo único (`MUT-09`, `MUT-14`, `MUT-15`) llevan la
anotación EN EL TESTIGO** (no sólo acá), con el número medido y el aviso de que
refixturear su input lo apaga igual que borrarlo (CD-22 / §11.1 regla 7).

---

## 4 · CD-11 · Barrido de citas, re-medido por CONTENIDO

Corrido después de la última edición, comparando `HOY[n]` contra `BASE[n]` por el
**texto de la línea**, no por aritmética.

**Resultado principal: TODA cita del Story File hacia un archivo que esta HU NO tocó
sigue siendo exacta.** Verificado uno por uno:

| Archivo (no tocado) | Citas verificadas | Estado |
|---|---|---|
| `src/adapters/registry.ts` | `:522`, `:532` | **sin mover** |
| `src/lib/self-published-auth.ts` | `:82`, `:89`, `:105`, `:115` | **sin mover** |
| `src/lib/compose-limits.ts` | `:38` | **sin mover** |
| `src/lib/pricing-constants.ts` | `:16` | **sin mover** |
| `src/services/fee-charge.ts` | `:106`, `:133`, `:428`, `:432` | **sin mover** |
| `src/middleware/a2a-key.ts` | `:187`, `:1222`, `:1231` | **sin mover** |
| `src/routes/capabilities.ts` | `:33`, `:65`, `:70` | **sin mover** |

**Seis citas apuntan a contenido que YA NO EXISTE, y las seis son exactamente las
líneas que la HU tenía que reescribir** (o sea que es confirmación, no daño):

| Cita del Story File | Qué le pasó |
|---|---|
| `src/services/compose.ts:617`, `:968` | los dos call-sites de `invokeAgent`, ahora con el 6.º argumento (AC-7) |
| `src/routes/compose.ts:1050`, `:1053` | la prosa *"ningún campo de fee se serializa"* — **reescrita por CD-21** |
| `src/routes/compose.ts:1127` | el `reply.send({kiteTxHash, ...result})`, ahora con los campos de fee (AC-10) |
| `src/services/agent-price.ts:114` | el `return` de `resolveAgentDestination`, ahora con `invokeUrl` |

**Mapa de desplazamiento** de los archivos tocados (para navegar el Story File):

| Archivo | Citas del rango bajo | Citas del rango alto |
|---|---|---|
| `src/types/index.ts` | `:374`, `:989`, `:1027` sin mover | `:1091`→`:1128-1133`, `:1144`→`:1186`, `:1398`→`:1463`, `:1673`→`:1738`, `:1679`→`:1773` |
| `src/services/compose.ts` | `:334`→`:360`, `:376`→`:402` (+26) | `:1424`→`:1542`, `:1516`→`:1702`, `:1538`→`:1724` (+118…+194) |
| `src/routes/compose.ts` | `:688`→`:696`, `:735`→`:743` (+8) | `:867`→`:928` (+61), `:1132`→`:1249` (+117) |
| `src/services/orchestrate.ts` | `:1061`→`:1071`, `:1115`→`:1125` (+10) | `:1149`→`:1251`, `:1213`→`:1315` (+102) |
| `src/routes/orchestrate.ts` | `:137`→`:139` (+2) | `:806`→`:856` (+50) |
| `src/index.ts` | `:173`→`:218` (+45) | `:271`→`:347` (+76) |

⚠️ **Advertencia sobre este mapa**: para líneas de contenido genérico (`};`, `);`) el
"match más cercano" puede apuntar a otra línea idéntica. Las filas de arriba son las
de contenido distintivo. **No es una fuente autoritativa: es una ayuda de
navegación.** Lo autoritativo es el texto.

---

## 5 · Tests preexistentes cuya ASERCIÓN cambió (los tres, con su motivo)

Ninguno se borró. Los tres se **re-apuntaron**, y en los tres la inversión **es el
objeto de un AC**, no daño colateral:

| Test | Afirmaba | Por qué cambió |
|---|---|---|
| `agent-card.test.ts` → *"sets empty auth schemes"* | `schemes` `toEqual([])` | **AC-1b** exige que la carta declare con qué se le paga. Re-apuntado a "`bearer` SIEMPRE y el conjunto DERIVADO" |
| `routes/agent-card.test.ts` → *"returns 200 with gateway self AgentCard"* | `schemes` `toEqual([])` | ídem |
| `routes/compose.fee.test.ts` → `T-FEE-8` | `not.toHaveProperty('protocolFeeUsdc')` | **AC-10** exige que el fee sea visible; era el hueco #3 de la HU. ⚠️ **sus otras dos aserciones se conservaron**, y la del `feeChargeTxHash` es load-bearing (el hash del fee NO se serializa nunca) |

Además se editaron **4 fixtures** que devuelven `resolveAgentDestination`
(CD-22, re-contado: `MUT-02` da **6** rojos post-edición, sin caso de testigo único).
El Story File listaba 3; **el cuarto** (`src/services/agent-price.test.ts`,
`T-DEST-1/2/3`) **no estaba** porque rompe en RUNTIME (`toEqual` exacto) y no en
`tsc` — ver §6.

---

## 6 · Desviaciones y hallazgos que AR/CR tienen que juzgar

1. **El canal de corte del Sitio 2 NO es el que el Story File prescribe.** §4.2 pedía
   el patrón `__quoteStale` (miembro nuevo en la unión de retorno). Medido, eso fuerza
   narrowing en **6 call-sites de producción en 5 archivos, y 3 de esos archivos no
   están en el Scope IN** (`services/agent-link.ts`, `services/inbound-task.ts`,
   `mcp/tools/orchestrate.ts`). Se usó `pipeline.errorCode` + mapeo a **400** en las
   dos rutas de ejecución: **1 archivo, dentro del Scope IN**, y reusa el mecanismo que
   el repo ya tiene (`pipeline.errorCode === 'SCOPE_DENIED' → 403`). **El ORDEN no
   cambia** y `MUT-03` lo confirma. §16.15 del Story File deja esta forma abierta.
2. **Un 5.º sitio de mock que el Story File no lista** (§3.6 lista 3 + 1 factory):
   `src/services/agent-price.test.ts` `T-DEST-1/2/3` hacen `toEqual` **exacto** sobre
   el retorno, así que rompen en runtime con `tsc` en verde.
3. **`readContractingGuardHealth()` y `rollUpCascadedFee()` son exports del leaf que
   §3.1 no enumera.** Se agregaron porque `/health` está **duplicado** (prod + e2e) y
   el rollup tiene **tres** call-sites: en los dos casos, dos expresiones a mano
   divergen. Ningún export de §3.1 fue renombrado ni removido.
4. ~~**`A2A_CONTRACTING_DEPTH_MAX=0` es legible y cierra el servicio**~~ — **RESUELTO
   en el fix-pack (§9, Grupo 3). El AR lo RECHAZÓ y su veredicto prevalece sobre el
   del CR, que lo había ratificado.** Se había implementado el rango `[0,64]` que
   especifica el Story File, con la consecuencia sólo DOCUMENTADA. Hoy `0` **cae al
   default y avisa**; rango aceptado `[1,64]`. Ver §9.
5. **Asimetría deliberada en el parseo de la profundidad**: la ENV se `trim`ea y el
   HEADER no. CD-14 aplica al header (lo controla un tercero); la env la escribe el
   operador. Fijada con `T-U-MAX-7` para que nadie las "unifique por consistencia".

---

## 7 · Lo que esta HU NO cierra

⛔ **Ninguna de estas líneas puede leerse como cerrada, ni acá ni en ningún otro
texto de la HU.**

- **El bucle transitivo contra un adversario que borra los headers.** La capa 2 es
  **best-effort por construcción**, y eso está escrito en el código, en el body del
  error (`CONTRACTING_LAYER2_BEST_EFFORT_NOTE`) y en la Agent Card. Contra ese caso lo
  que queda en pie es la capa 1 (que **no consulta ningún header del caller**) y el
  techo de profundidad.
- **El bypass por IP literal.** La comparación de identidad es **por NOMBRE**. R-3 /
  TD-360-2, residual declarado.
- **Que hoy haya drenaje de fondos en curso.** Lo medido es que **el guard no
  existía** y que la ruta al bucle estaba abierta. Lo que frena hoy el caso directo es
  **accidental** (el bearer sólo se reenvía a registries system-trusted), no un guard.
- **El bucle de DISCOVERY** (registrar el propio `/discover` como registry). Vector
  real y contiguo, **no cubierto acá**. Candidato a WKH-361.

---

## 8 · `[NO VERIFICADO]`

- **`BASE_URL` en el Railway de prod** (NC-1). No se puede distinguir desde afuera.
  El diseño no depende de la respuesta (conjunto vacío ⇒ `warn`, no `throw`), y
  `GET /health` → `contractingGuard.selfHostCount` lo resuelve **después del deploy**.
- **`TRUST_PROXY` en prod** (NC-2). Afecta la narrativa del DoS colateral, no el
  diseño.
- **El comportamiento en PRODUCCIÓN de todo lo de esta HU.** Nada se ejecutó contra
  prod salvo `POST /discover` (gratis y read-only) y `GET /.well-known/agent.json`.
  ⛔ No se invocó `/compose` ni `/orchestrate` contra prod: mueven plata.
- **Los catálogos externos de NC-4.** Ninguna fila verificada, ninguna aprobada.
