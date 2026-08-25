# Work Item — [WKH-364] Sonda periódica del camino del dinero (Corte A: cotización)

## Resumen

Una sonda programada que ejercite `GET /discover` + `POST /compose` (sólo el paso de
cotización FX, `remit-corridor-fx-solana`) contra los servicios vivos de producción, con
el input **derivado en runtime del `inputSchema` publicado**, nunca inventado. Existe
para que "¿el camino del dinero anda?" deje de depender de un `curl` armado a mano —
que ya mintió en las dos direcciones (rojo sobre algo sano, verde sobre algo roto) — y
para cerrar el agujero estructural de que un cambio de config en otro repo no pone en
rojo ninguna suite local.

## Sizing

- SDD_MODE: full (QUALITY — heredado del proyecto, `CLAUDE.md`: "WasiAI A2A es siempre
  modo QUALITY")
- Estimación: M (workflow nuevo + script nuevo + tests unitarios del script + demostrar
  el rojo con evidencia archivada, sin tocar `src/`)
- Branch sugerido: `feat/227-sonda-money-path` (ya existe como rama del worktree,
  creada desde `origin/main`)

## Historia y por qué esta versión del argumento es la que vale

⚠️ Existió una versión anterior de este issue (`ferrosasfp/wasiai-a2a#174`) que decía
que la cotización llevaba 13 días caída en prod. **Era falsa**: la producía una sonda
mal formada del propio orquestador mandando `payoutMethod: "bank"` fuera del enum
(`yape`, `plin`, `bank_cci`), medido y cerrado en la fila `226` (WKH-335) de
`doc/sdd/_INDEX.md`. La cotización nunca estuvo caída. Esta HU no reabre esa
investigación: construye el instrumento para que la próxima vez la pregunta "¿está
caído?" no dependa de que alguien vuelva a armar un `curl` de memoria.

El argumento que sí sostiene esta HU tiene dos mitades independientes:

1. **No hay con qué mirar** — hoy sólo existe un `curl` manual, que puede dar rojo
   sobre algo sano (el propio caso de origen) o verde sobre algo roto (si no ejercita
   la rama rota).
2. **El agujero es estructural** — los tests de cada repo doblan a los servicios
   vecinos con dobles que devuelven 200 siempre; un cambio de configuración en otro
   repo, otro día, no mueve el diff de ninguno y no pone nada en rojo. Es invisible
   por construcción.

Precedente medido y no discutido: WKH-335 se desplegó el 2026-08-25 y la única forma de
confirmar que el servidor servía el código nuevo fue una sonda a mano — `/health` dio
200 antes y después, doce sondeos seguidos (fila `226`).

## Acceptance Criteria (EARS)

- AC-1: WHEN la sonda arma el cuerpo de la llamada a `remit-corridor-fx-solana`, the
  system SHALL derivar `amountUsd`, `payoutMethod` (tomado del `enum` publicado) y
  `destCountry` a partir del `inputSchema` que devuelve `GET /discover` **en esa misma
  corrida**, y SHALL NOT usar un body literal hardcodeado ni copiado de un ejemplo de
  documentación.

- AC-2: WHILE corre la sonda programada (cron), the system SHALL invocar
  `POST /compose` contra el gateway de producción
  (`https://wasiai-a2a-production.up.railway.app`) usando una credencial dedicada de
  sonda (no compartida con ningún otro caller), ejercitando únicamente el paso de
  cotización de `remit-corridor-fx-solana` — sin paso de depósito ni de settle.

- AC-3: WHEN `/compose` responde a una llamada con body válido (schema-conformant), IF
  la respuesta es `5xx` o el campo estructurado `agentFailure` (WKH-335) está ausente
  en una respuesta no-2xx, THEN the system SHALL marcar la corrida como FAILED y
  tratarla como candidata a caída real; IF la respuesta es `4xx` con `agentFailure`
  presente, THEN the system SHALL marcar la corrida como FAILED por drift del propio
  esquema/sonda, distinguiendo explícitamente esta causa de una caída de producción en
  el mensaje que emite.

- AC-4: WHEN la sonda se ejecuta contra un objetivo deliberadamente roto — credencial
  de sonda inválida/revocada, o un body que viola a propósito el `inputSchema`
  publicado (p.ej. sin `amountUsd`) — the system SHALL terminar con código de salida
  distinto de cero y el paso de CI correspondiente SHALL reportarse en rojo. Esta
  corrida SHALL quedar demostrada una vez, con su log archivado, antes de dar la HU por
  DONE (un control verde que nunca se vio fallar no cuenta como entregado).

- AC-5: WHEN una corrida programada (evento `schedule`, no `pull_request`) falla, the
  system SHALL abrir un issue de GitHub con título fijo y buscable si no hay uno
  abierto, o comentar en el ya abierto en vez de crear un duplicado; WHEN una corrida
  programada posterior pasa en verde, the system SHALL cerrar automáticamente ese
  issue.

- AC-6: WHILE el workflow de la sonda se dispara por un evento `pull_request`, the
  system SHALL correr en modo informativo (no bloqueante) y SHALL NOT abrir ni comentar
  ningún issue de GitHub.

- AC-7: the system SHALL NOT alterar el comportamiento de `/compose`, `/discover`,
  Chaski, ni de ningún agente — la sonda es de sólo observación; ubiquitous, sin
  excepción por ambiente.

- AC-8: IF la credencial dedicada de la sonda no está provista en el secret de GitHub
  Actions esperado, THEN the system SHALL fallar rápido con un mensaje explícito de
  "credencial de sonda ausente", distinguible en el log del mensaje de caída real de
  producción — para no repetir el propio defecto que motiva esta HU (un error de
  configuración leído como corte de servicio).

## Scope IN

- `.github/workflows/<nombre-a-definir-en-F2>.yml` — workflow nuevo, cron programado,
  reutilizando el patrón ya probado de `.github/workflows/smoke-downstream.yml`
  (`continue-on-error` en `pull_request`, hard-fail + issue open/close-dedup en
  `schedule`).
- `scripts/<nombre-a-definir-en-F2>.mjs` — script de la sonda: `GET /discover` →
  deriva body del `inputSchema` → `POST /compose` (sólo cotización) → clasifica
  PASS/FAIL/DRIFT usando el campo `agentFailure`.
- Entrada nueva en `package.json#scripts` (patrón `smoke:*` / `probe:*` ya usado).
- Tests unitarios del script de la sonda (clasificación PASS/FAIL/DRIFT, derivación del
  body desde un `inputSchema` de prueba) — sin llamadas de red reales en `npm test`.

## Scope OUT

1. **El paso de depósito/payout** (mover USDC de devnet). Corte B — HU de seguimiento
   separada, porque mover dinero real requiere que el founder decida tope y dueño de
   reposición (punto que esta HU no resuelve por diseño, ver DT-1).
2. **Arreglar el defecto de `destCountry`** en `remit-corridor-fx-solana` (el agente
   ignora el país y cotiza Perú siempre) — tiene su propio issue,
   `ferrosasfp/wasiai-remittance-agents#2`.
3. **Desplegar, setear variables o crear la credencial de sonda** — del founder
   (Missing Input bloqueante, abajo).
4. **Cambiar el comportamiento de `/compose`, Chaski o cualquier agente** — esta HU
   observa, no modifica el camino del dinero (CD-2).
5. Monitoreo de `chaski-v2.vercel.app` (frontend) o de cualquier otra UI.
6. **Afirmar corrección de corredor** para destinos distintos de Perú — bloqueado por
   el defecto (2) de arriba; la sonda sólo puede afirmar "responde 200 con una tasa
   plausible", no "cotiza el país correcto".
7. Chequeos a nivel RLS/DB, pruebas de carga/performance, o sondas de cualquier
   endpoint fuera de los dos declarados en el perímetro.
8. Canales de alerta adicionales a GitHub Issues (Discord vía `alerts.mjs`, PagerDuty,
   etc.) — no asumido, ver Missing Inputs.

**Perímetro cubierto, declarado con su número**: 2 endpoints ejercitados
(`GET /discover`, `POST /compose` — sólo el paso de cotización), 1 agente
(`remit-corridor-fx-solana`), 0 movimiento de dinero.

## Decisiones técnicas (DT-N)

- **DT-1: Corte A = sólo cotización, sin depósito.** El depósito/payout queda en una
  HU futura (Corte B). Justificación: los dos ejemplos medidos del propio issue (el
  falso rojo de `payoutMethod: "bank"` y el agujero estructural de dobles que
  contestan 200 siempre) ocurrieron sobre el endpoint de cotización, no sobre el de
  depósito — el argumento de existencia de esta HU queda completo sin mover dinero.
  Mover dinero real (aunque sea devnet) exige que el founder fije tope y dueño de
  reposición, que es una decisión de negocio y no de instrumento.

- **DT-2: Reusar el patrón de `smoke-downstream.yml`** (workflow programado + issue de
  GitHub con dedup open/comment/close) en vez de un servicio propio o infraestructura
  nueva. Justificación: cero infraestructura nueva, el patrón ya está en producción en
  este mismo repo y ya resuelve el punto "un control que avisa de más se apaga solo":
  las corridas de `pull_request` son informativas (no abren issue) y las de `schedule`
  dedupean contra el mismo issue en vez de acumular ruido.

- **DT-3: Cadencia cron = cada 30 minutos**, sin debounce adicional a nivel de
  workflow (igual que el patrón heredado). Justificación explícita del costo
  asimétrico pedido por la HU: el costo de un falso negativo (una caída real de días,
  como el escenario que motivó la versión anterior de este issue) es mucho mayor que
  el de un falso positivo (un comentario en un issue que se cierra solo 30 minutos
  después). El falso positivo que sí ocurrió en este repo (WKH-335/fila 226) no era
  ruido de red: era un bug de la propia sonda (body mal formado), y ese lo cierran
  AC-1 + AC-3, no un debounce de cadencia.

- **DT-4: Un solo reintento corto dentro del propio script** antes de declarar FAILED
  por causa de red (no a nivel de workflow/cron). Justificación: absorbe un blip de
  red de una sola request sin degradar la latencia de detección de 30 min, y es una
  clase de falla distinta de la que arregla AC-1/AC-3 (drift de esquema, no red).

- **DT-5: El input se deriva del `inputSchema` publicado en `/discover`, no de un
  mirror del tipo TypeScript de `chaski-v3/src/infrastructure/a2a/gateways.ts`**
  [HEREDADO DEL ISSUE — no verificable desde este worktree, `chaski-v3` no está
  presente en este disco]. Justificación: mantiene la sonda autocontenida en
  `wasiai-a2a` sin una dependencia cross-repo que pueda driftear en silencio (que es
  exactamente la Mitad 2 del argumento de esta HU), y si el propio `/discover` queda
  inalcanzable o devuelve un schema malformado, eso también es señal útil y falla
  ruidoso, no callado.

- **DT-6: Credencial dedicada de sonda**, con budget mínimo y scope propio, nunca
  reusada de otra key (ni la de Chaski ni ninguna existente). Justificación: reusar
  una key ya emitida acoplaría el radio de explosión de la sonda al de su dueño
  original y rompería el aislamiento por `owner_ref` que exige la convención de
  seguridad del repo (`CLAUDE.md`, sección Ownership Guard).

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO hardcodear el body de la llamada a `/compose` en el script de la
  sonda. El body SHALL derivarse en runtime del `inputSchema` que devuelve
  `GET /discover` en esa misma corrida (campos `required` y valores de cualquier
  `enum` publicado). Ningún campo se copia de memoria, de un ejemplo de documentación,
  ni de una versión anterior del schema. Este es el requisito que esta HU existe para
  no repetir: una sonda con input inventado reproduce exactamente el defecto que la
  motiva, con la autoridad extra de parecer un control automático.

- **CD-2**: PROHIBIDO que esta HU modifique el comportamiento de `/compose`,
  `/discover`, Chaski o cualquier agente. OBLIGATORIO que el diff sobre `src/` sea
  vacío; los artefactos nuevos viven en `scripts/`, `.github/workflows/` y
  `package.json#scripts`.

- **CD-3**: OBLIGATORIO demostrar, con evidencia archivo:línea + log de corrida, que
  la sonda PUEDE ponerse roja contra un objetivo deliberadamente roto (credencial
  inválida o input que viola el schema publicado) antes de dar la HU por DONE (AC-4).
  Un control verde que nunca se vio fallar no cuenta como entregado.

- **CD-4**: PROHIBIDO que esta HU ejercite el depósito/payout (mover USDC de devnet).
  Sólo la cotización. Cualquier extensión al camino de depósito es una HU nueva (Corte
  B) con su propio tope y dueño de reposición, decididos por el founder.

- **CD-5**: OBLIGATORIO que la clasificación PASS/FAIL distinga `4xx` (rechazo válido
  o drift de la propia sonda) de `5xx` (candidata a caída real), usando el campo
  estructurado `agentFailure` que ya expone `/compose` en producción desde WKH-335
  (`doc/sdd/226-wkh-335-status-del-agente-estructurado/work-item.md`, verificado en
  prod el 2026-08-25: `POST /compose` con input inválido devuelve
  `agentFailure: 'INPUT_REJECTED'`). PROHIBIDO reintroducir el patrón que WKH-335 ya
  cerró — re-parsear el string de `error` con una regex para recuperar el status.

## Missing Inputs

- **[bloqueante]** Provisión de la credencial dedicada de la sonda (A2A key con budget
  mínimo, scope propio) para llamar `/compose` autenticado. Es una precondición del
  founder, no algo que resuelva un agente (`CLAUDE.md`: "eso es una precondición del
  founder, no algo que resuelva un agente"). Sin ella, F1/F2/F2.5 pueden avanzar (el
  diseño no depende de tenerla), pero la implementación de F3 contra `/compose`
  autenticado y la demostración de AC-4/CD-3 no pueden cerrarse.
- **[bloqueante]** Nombre y alcance exacto del secret en GitHub Actions (repo secret
  vs. environment secret) donde vivirá esa credencial — a fijar en F2 junto con el
  founder, siguiendo la convención de secrets ya usada por `smoke-downstream.yml`
  (`secrets.GITHUB_TOKEN` para el issue; la credencial de sonda es un secret nuevo,
  sin convención previa en el repo para este tipo).
- **[resuelto en F2, propuesto en DT-3]** Cadencia exacta del cron (propuesta: cada 30
  minutos) — el Architect puede ajustarla si hay presupuesto de minutos de GitHub
  Actions a considerar, dejando la justificación de costo asimétrico escrita arriba.
- **[NEEDS CLARIFICATION]** Si el founder quiere un canal de alerta adicional a GitHub
  Issues (el repo ya tiene un formateador de alertas para Discord, `alerts.mjs`,
  WKH-90/91) — no asumido, queda fuera de alcance (Scope OUT #8) hasta que se pida
  explícitamente.
- **[NEEDS CLARIFICATION]** Nombre final del workflow/script (se dejó
  `<nombre-a-definir-en-F2>` en Scope IN a propósito, para no inventar un nombre que
  después haya que renombrar).

## Análisis de paralelismo

- **No bloquea ninguna HU en curso.** Sólo agrega archivos nuevos (`scripts/`,
  `.github/workflows/`, entrada de `package.json#scripts`); no toca `src/` (CD-2), así
  que no compite por los mismos archivos que ninguna HU en progreso del índice (p.ej.
  `225 — paso suspendible`, que sí toca `src/services/compose.ts`).
- **Depende de WKH-335 (fila `226`), ya DONE y desplegada en prod** (merge `62fd9c7`
  en `wasiai-a2a`, verificado el 2026-08-25): el campo `agentFailure` que usan AC-3 y
  CD-5 ya existe en producción, así que esta HU puede diseñarse y construirse contra
  el contrato real, sin esperar nada.
- Puede correr en paralelo con cualquier otra HU del backlog: no depende de ellas ni
  ellas dependen de esta.
- **Bloqueada para llegar a DONE**, no para avanzar F1-F2.5, por el Missing Input
  bloqueante de la credencial de sonda (ver arriba) — es un prerequisito de founder,
  no de otro agente ni de otra HU.
