> 🔴 **PENDIENTE DE INSERTAR — esta fila NO está en `doc/sdd/_INDEX.md` todavía.**
> Consecuencia **mecánica**, no cosmética: `test/sdd-index-matches-folders.test.ts` deriva las
> carpetas de **`git ls-files -- doc/sdd`** (`:152`) y su control **G-A2** (`:268`) exige
> **exactamente una fila por carpeta de HU**, así que **el primer commit que trackee
> `doc/sdd/225-paso-suspendible-y-reanudable/` pone `npm test` en ROJO** hasta que esta fila
> exista. Hoy la carpeta está untracked y por eso el guardián sigue verde: **el rojo llega con el
> `git add`, no con la creación.**

<!--
FILA LISTA PARA PEGAR EN doc/sdd/_INDEX.md.

DÓNDE: al FINAL de la tabla principal — inmediatamente DESPUÉS de la fila `224` y ANTES de la
línea en blanco y del `---` de cierre.

⛔ AL FINAL DE LA TABLA, Y NO ES ESTILO.
El control `G-F1` (`test/sdd-index-matches-folders.test.ts:398`) verifica que las líneas del
_INDEX.md citadas desde `src/` sigan diciendo lo que el código afirma. En particular
`src/lib/capability-risk.ts:81-82` cita `doc/sdd/_INDEX.md:144` para los nombres de capacidad
publicados en bdwv (`remit.corridor-discovery`, `kyc-check`), y esa cita está declarada con su
`mustContain` en `test/sdd-index-matches-folders.exceptions.ts`. Insertar CUALQUIER línea por
encima de la 144 corre la tabla y rompe una cita de código del camino del dinero. Insertar al
final no mueve la 144. El propio índice lo explica en "Por qué la fila `023` está fuera de orden
numérico".

NÚMERO `225` VERIFICADO LIBRE antes de elegirlo: el número más alto ocupado en `doc/sdd/` es el
`224` (`224-citas-archivo-linea-sin-testigo/`), medido con Glob sobre `doc/sdd/2[2-9]*/*` y
`doc/sdd/2[3-9]*/*` (este último dio CERO, que es el control positivo de que no hay nada por
encima de 229).

POR QUÉ ESTÁ ACÁ Y NO YA EN EL ÍNDICE: instrucción explícita del orquestador ("NO toques
`_INDEX.md` — escribí tu fila en `index-row.md` y la aplico yo"). Y además el agente que escribió
esta HU corrió SIN SHELL y sin tool de edición incremental (sólo Read/Write/Glob): reescribir el
`_INDEX.md` completo para agregar una fila exige transcribirlo entero desde lecturas parciales, y
un solo error de transcripción por encima de la línea 144 rompe en silencio la cita verificada por
G-F1. Mismo motivo declarado en `doc/sdd/224-.../_INDEX-row.md` y en
`doc/sdd/212-wkh-314-x402-inbound-solana/_INDEX-row.md`.

⚠️ SIN `|` LITERAL DENTRO DE LA FILA, a propósito: un `|` sin escapar dentro de un span de código
le cuenta columnas de más a la tabla y el control `G-D2` se pone rojo (es el bug de la fila `155`,
declarado en la fila `221`). Esta fila no usa ninguno.

⚠️ EL IDENTIFICADOR DE LA HU ES PROVISORIO: el founder todavía no asignó el número `WKH-`, y el
encargo del F1 lo prohibió explícitamente. Si se asigna, se corrige ESTA celda.

⚠️ LA RAMA DE LA ÚLTIMA COLUMNA NO ESTÁ VERIFICADA: este F1 corrió sin shell, así que no se pudo
correr `git rev-parse --abbrev-ref HEAD`. Se declara sin medir en vez de afirmarlo.
-->

| 225 | 2026-08-19 | [WKH-PENDIENTE] El Coordinador orquesta un paso que espera a una persona: **suspender y reanudar**. Que un paso del pipeline pueda devolver un enlace y quedar esperando a una persona, en vez de tener que terminar dentro del mismo pedido HTTP. **Por qué existe, y es arquitectura del founder, no una mejora técnica**: hoy Chaski le habla DIRECTO al agente de identidad salteándose al Coordinador, porque el agente publica `kyc-hosted-redirect` (redirección del navegador + una persona en el medio) y el modelo pedido-respuesta de `/compose` no lo expresa — con la consecuencia de negocio de que **ese agente se consume GRATIS, fuera del carril de pago**, y la frase del pitch ("descubre, orquesta **y paga**") lleva un asterisco. ⛔ **Lo que NO se puede escribir**: que "ya funciona porque el pipeline existe". Existe todo MENOS el estado suspendido, y ése es el trabajo. **Lo que sí existe y abarata**: `/orchestrate` ya es de dos fases con cotización firmada que el cliente reenvía (`routes/orchestrate.ts:46-65`, `services/orchestrate-quote.ts`), y —hallazgo del F1— ya hay un exemplar EN PRODUCCIÓN de estado durable con token hasheado, `owner_ref`, `expires_at`, máquina de estados y **claim atómico por RPC**: `a2a_agent_links` / `claim_agent_link` (`types/index.ts:1610-1627`, `:1671-1679`). **DÓNDE VIVE HOY EL ESTADO, medido**: entero en variables locales de `executePipeline` durante UN request — `composeRunId` (`compose.ts:216`), `results` (`:227`), `totalCost`/`totalLatency` (`:368-369`), `lastOutput` (`:370`), `discoverCache` (`:372`). Nada durable, y este servicio **no tiene Redis** (`project-context.md:86-87`, `:597`) ⇒ tabla nueva en **bdwv**, ⛔ NUNCA caldz. **DOS HALLAZGOS QUE CAMBIAN EL DISEÑO, no el sizing**: (1) 🔴 modelar la suspensión como `success:false` hace que **cada suspensión emita `compose_stranded_payment`** (`compose.ts:230`), que `stranded-alert.ts:229-259` acumula y publica en `/health` como `degradedPath` ⇒ **un KYC funcionando normal haría sonar la alerta de plata varada** ⇒ CD-2 protege una alerta de producción, no un estilo; (2) 🔴 **el TTL de la suspensión NO es libre**: `compose-limits.ts:11-27` documenta que `MAX_COMPOSE_STEPS` alimenta `ESTIMATED_MAX_RUN_WALL_CLOCK_MS` como `MAX × 300 s` = **25 min**, y de ahí salen la ventana protegida y el TTL del dedup de settles Solana, cuyo modo de falla escrito es *"una entrada de idempotencia podía expirar mientras su run seguía vivo"* — **una persona escaneando un documento tarda más que eso** ⇒ MI-3 es bloqueante del corte A y se resuelve MIDIENDO, no eligiendo. **VEREDICTO DE LOS 8 ÍTEMS**: chicos 1, 2, 4 y 6-código; medianos y corazón 3 y 5; grandes 7 y 8. **El ítem 7 NO es una llamada, son TRES momentos** (`POST /session`, `GET /decision`, y `resolvePayoutAuthority` EN EL MOMENTO DEL DINERO, `chaski-v3/src/infrastructure/payout/authority.ts:73-208`) y sólo los dos primeros son un paso de pipeline. **BLOQUEANTE DEL CORTE B, medido**: `resolvePayoutAuthority` Guard 3 exige una fila de `kyc_session_tokens` que **sólo** puebla Chaski al crear la sesión contra el agente ⇒ si el `POST /session` pasa al Coordinador, el `decisionToken` no llega a Chaski ⇒ `kyc_ownership_mismatch` ⇒ **403 en TODOS los desembolsos**, y su propia migración dice textual *"No hay rescate automatico. Hay que re-verificarse."* ⇒ hay que decidir (a) el token transita por el Coordinador y `authority.ts` queda con CERO diff, o (b) el Coordinador expone la re-autorización — que es el momento 3, **Scope OUT**. **El ítem 8 está bloqueado por algo concreto**: el único endpoint del agente alcanzable por `/compose` es el `POST /invoke` **DEPRECADO**, que *"MANDA EL DOCUMENTO (legalId) POR LA RED en cada llamada"* (`wasiai-remittance-agents/src/manifest/registry.ts:61-64`) ⇒ CD-10 lo prohíbe. **Y el ítem 6 tiene una acción de OPS que se olvida sola**: la ficha del catálogo del gateway es una **COPIA MANUAL** del manifiesto y **nada la sincroniza** (`registry.ts:36-42`) — sin republicar en bdwv, `/discover` no ve la capacidad; y republicarla **cambia sola** la clasificación de riesgo del agente de KYC a `unclassified` (`capability-risk.ts:89-99`, `:166-170`), que es la dirección segura pero aparece sin que nadie la pida (AC-10). ⛔ **7 controles de WKH-233 declarados intocables** (token sólo en cabecera, HMAC de sesión separado, `getForOwner` jamás `readForVerifiedSession`, `owner_address` NULLABLE que refuerza el guard, `payoutAllowed === true` estricto, `identityMatches` preservado AUSENTE, logs value-free): si el diseño no puede preservarlos todos, el veredicto correcto es **no hacer el ítem 7 todavía**, no aflojar uno. **PARTIDA en dos cortes**: A = ítems 1-5 (+6 código) sólo en `wasiai-a2a`; B = 6-ops + 7 + 8, cross-repo. **Modo evaluado y no heredado**: QUALITY, por tres señales propias del trabajo (toca el bucle del débito per-step a milímetros del guard `i > 0`; estrena estado durable en una base que también sirve prod; estrena una credencial reanudable), con **variante**: dos focos de AR obligatorios declarados desde ya — replay del token de reanudación y el reloj de DT-6. ⚠️ **Este F1 corrió SIN SHELL** (sólo Read/Write/Glob): cada cita está marcada `[MEDIDO]`, `[HEREDADO]` o `[NO MEDIDO]`, **todo conteo exhaustivo es [NO MEDIDO]** (sin `grep` no hay barrido: los 6 consumidores del desenlace son una cota inferior medida uno por uno, no un total — MI-5 lo deja como pre-requisito del F3), y **el nombre de la rama es una propuesta sin verificar**. | feature | QUALITY | in progress (F1 escrito — esperando `HU_APPROVED`) | feat/225-paso-suspendible-y-reanudable `[rama NO verificada: sin shell en el F1, hay que crearla y confirmarla en F2/F3]` ([work-item.md](225-paso-suspendible-y-reanudable/work-item.md)) |
