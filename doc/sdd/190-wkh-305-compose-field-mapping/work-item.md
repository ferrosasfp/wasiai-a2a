# Work Item — [WKH-305] Mapeo de un campo puntual entre steps de un pipeline compose

## Resumen

Hoy `composeService.compose` (`src/services/compose.ts:339-342`) solo sabe encadenar
steps de una forma: si `step.passOutput === true`, inyecta la **salida completa** del
step anterior bajo `input.previousOutput`. No existe manera de decir "tomá el campo
`quoteId` de la salida del step 1 y ponelo en el campo `quoteId` del input del step 2".
Esto bloquea el pipeline de remesa (identidad → cotización → desembolso): el paso de
desembolso necesita el `quoteId` que produce el paso de cotización, y ese valor no
existe hasta que ese paso corre — el llamador no puede mandarlo por adelantado.

Esta HU agrega al gateway la capacidad de resolver un mapeo de campo puntual
(clave→clave, plano, sin anidamiento) desde la salida del step inmediatamente
anterior hacia el input del step siguiente, ANTES de invocar y ANTES de cobrar ese
step. Es infraestructura de pipeline (plumbing), no inteligencia: no decide qué
mapear, solo ejecuta el mapeo que el llamador (o el planner de `/orchestrate`)
declara.

## Sizing

- SDD_MODE: full
- Estimación: L
- Branch sugerido: `feat/305-wkh-305-compose-field-mapping`

Justificación del tamaño: el cambio toca el loop de `composeService.compose`, que es
el hot path de dinero más denso y más comentado del repo (débito per-step, refund
best-effort, retry adaptativo con re-débito, HU-203 settle-withholding, WKH-234
ledger Solana). No es un cambio aislado: mover la construcción del `input` del step
ANTES del bloque de débito per-step (hoy está DESPUÉS, ver "Qué hay que cuidar" más
abajo) interactúa con el retry adaptativo (que regenera `input` vía LLM y re-debita)
y con las 3+ waves de guardas de reembolso ya existentes. Se estima QUALITY con AR
enfocado en el money-path, no FAST.

**Skills Router** (máx. 2, ver `references/skills_router.md`):
- `money-path-review` (débito/refund/idempotencia — el cambio reordena cobro vs.
  construcción de input)
- `api-contract-design` (nuevo campo en `ComposeStep`, retrocompatibilidad)

## Acceptance Criteria (EARS)

- AC-1: WHEN un step declara un mapeo de un campo cuyo nombre existe como clave de
  primer nivel en el objeto de salida del step inmediatamente anterior, the system
  SHALL poblar ese campo en el input del step con el valor leído de esa clave, antes
  de invocar al agente de ese step.

- AC-2: IF un step declara un mapeo cuyo campo de origen NO existe en el objeto de
  salida del step inmediatamente anterior (incluye el caso en que esa salida no es un
  objeto plano — p. ej. es un `A2AMessage`, un array, o `null`/`undefined`), THEN the
  system SHALL fallar el pipeline para ese step con un error distinguible ANTES de
  ejecutar el débito per-step de ese step y ANTES de invocar a su agente.

- AC-3: WHILE resuelve el mapeo de un step, the system SHALL restringir la
  resolución a un lookup de una sola clave de primer nivel por entrada de mapeo (sin
  dot-paths, sin JSONPath, sin expresiones, sin valores por defecto, sin acceso a
  steps distintos del inmediatamente anterior).

- AC-4: WHEN un pipeline no declara ningún mapeo de campos en ninguno de sus steps,
  the system SHALL comportarse de forma byte-idéntica al comportamiento actual de
  `passOutput`/`step.input` (retrocompatibilidad total, cero regresión para todo
  llamador existente).

- AC-5: IF el mapeo de un step falla (AC-2) y ese step tiene débito per-step activo
  (steps 2..N del path master, `i > 0`), THEN the system SHALL dejar los steps
  0..i-1 con su cobro intacto (ya entregaron valor y se ejecutaron legítimamente) y
  el pipeline SHALL responder con el mismo tipo de error que hoy usan los demás
  fallos de step (`success:false`, `error`, sin cobrar el step i).

## Scope IN

- `src/types/index.ts` — nuevo campo opcional en `ComposeStep` para declarar el
  mapeo (nombre exacto del campo y su shape final: decisión de F2/Architect).
- `src/services/compose.ts` — resolución del mapeo ANTES del bloque de débito
  per-step (`i > 0 && scopingKeyRow && chainId !== undefined`, hoy en
  `compose.ts:274-338`) y ANTES de `this.invokeAgent` (hoy en `compose.ts:386`). Esto
  implica reordenar la construcción de `input` (hoy `compose.ts:339-342`, DESPUÉS
  del débito) para que ocurra antes del débito cuando el step declara mapeo.
- `src/lib/compose-step-shape.ts` (o módulo leaf equivalente) — validación de FORMA
  del mapeo declarado en el body (tipos de clave/valor, cardinalidad acotada), en el
  mismo punto pre-débito donde ya vive `validateComposeStepShape` (route-level,
  `src/routes/compose.ts` `validateComposeBodyHandler`, que corre ANTES del
  middleware de pago).
- Tests unitarios de `composeService.compose` cubriendo: mapeo exitoso, campo
  ausente, salida previa no-objeto (A2A message / array / null), pipeline sin
  mapeo (regresión), interacción con el retry adaptativo existente (WKH-130).
- Documentación mínima del nuevo campo en el contrato de `/compose` (si existe un
  README/INTEGRATION.md de referencia para callers — no crear uno nuevo si no
  existe ya).

## Scope OUT

- Lenguaje de expresiones, JSONPath, dot-notation anidada (`a.b.c`), templates,
  transformaciones/funciones sobre el valor mapeado. Se resuelve el caso real
  (`quoteId` es un campo de primer nivel); nada más.
- Mapeo desde un step distinto del inmediatamente anterior (steps N-2, N-3, …). El
  alcance es el mismo que hoy tiene `lastOutput`.
- Cambios al planner LLM de `/orchestrate` para que GENERE mapeos automáticamente.
  Esta HU es la plomería que el planner (o un caller humano/programático) puede usar
  después; enseñarle al LLM a declararlos es una HU aparte.
- Congelamiento de precio / price-drift (`reportComposePriceDrift`,
  `src/routes/compose.ts:243-272`) — tema relacionado pero independiente, ya
  trackeado como instrumentación interina.
- Cambios de UI/dashboard.
- El caso `passOutput:true` + A2A fast-path / `maybeTransform` (bridge automático
  entre steps, WKH-56/WKH-14) no se toca: sigue corriendo igual que hoy para los
  steps que NO declaran mapeo explícito.

## Decisiones técnicas (DT-N)

- DT-1: **Se recomienda la opción "el gateway aprende a mapear campos"** (no
  "los agentes leen `previousOutput.*`"). Motivo: el founder fue explícito en que
  los agentes tienen que poder consumirse de forma independiente — un agente de
  desembolso que lee `previousOutput.quoteId` codifica dentro de sí mismo el
  conocimiento de que es "el segundo paso de un pipeline de remesa", lo cual lo hace
  inútil si alguien lo quiere invocar solo, o en un pipeline distinto donde el
  quoteId venga en otro shape. Además, esta decisión es consistente con el
  precedente arquitectónico YA existente en el repo: el gateway ya hace de mediador
  activo entre steps (A2A fast-path passthrough WKH-56, transform LLM cacheado
  WKH-14/WKH-57) — el mapeo de campos es la misma responsabilidad ("el gateway
  adapta la salida de A al input de B"), solo que determinístico y sin LLM en el
  caso trivial de un campo con nombre conocido.

- DT-2: el mapeo se mantiene deliberadamente NO expresivo (guardrail explícito del
  founder: "que no se vuelva un lenguaje"). Se modela como lookup de clave plana
  exacta, no como un motor de plantillas. Si en el futuro aparece un caso real que
  necesite más (anidamiento, transformación), debe ser una HU nueva con su propio
  análisis de superficie de ataque — no una extensión silenciosa de esta.

- DT-3: el orden de operaciones dentro de `compose()` cambia. Hoy (compose.ts):
  `resolveAgent` → scoping check → gas overhead → budget check → **débito
  per-step** (i>0) → **construcción de `input`** (`passOutput` ? previousOutput) →
  `invokeAgent`. Con mapeo, la construcción/resolución del `input` mapeado debe
  moverse ANTES del débito per-step, porque el mapeo puede fallar (AC-2) y un fallo
  de mapeo no puede haber cobrado el step al que pertenece. Esto es un cambio de
  orden real en el hot path de dinero, no aditivo — el Architect debe diseñarlo
  explícitamente en el SDD (F2), no asumir que es un `if` más.

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO implementar cualquier forma de expresión, función, dot-path
  anidado, JSONPath o valor por defecto dentro de una entrada de mapeo. El mapeo es
  EXCLUSIVAMENTE un lookup de una clave de primer nivel contra el objeto de salida
  del step inmediatamente anterior. Cualquier propuesta de F2 que agregue sintaxis
  más allá de esto debe volver a F1/founder antes de especificarse.

- CD-2: OBLIGATORIO resolver y validar el mapeo de un step ANTES de ejecutar su
  débito per-step (`compose.ts`, bloque `i > 0 && scopingKeyRow && chainId !==
  undefined`) y ANTES de invocar a `invokeAgent` para ese step. Un mapeo roto
  (AC-2) NUNCA debe generar un cobro por el step al que pertenece — ni el
  débito per-step normal, ni el re-débito del retry adaptativo (WKH-130) si el
  mapeo también se usa para reconstruir el `input` regenerado por LLM.

- CD-3: OBLIGATORIO que un pipeline SIN mapeos declarados en ningún step sea
  byte-idéntico (mismo `ComposeResult`, mismo costo, mismos hooks de refund) al
  comportamiento actual. El campo nuevo en `ComposeStep` debe ser opcional y su
  ausencia no debe activar ningún branch nuevo de lógica.

- CD-4: PROHIBIDO que la resolución de mapeo lea de un step distinto del
  inmediatamente anterior (mismo alcance que `lastOutput` hoy — sin acceso a
  `results[i-2]` ni anteriores).

## Missing Inputs

- [NEEDS CLARIFICATION resuelto en F2] Shape exacto del campo de mapeo dentro de
  `ComposeStep` (nombre de la propiedad JSON, si es objeto clave-destino→clave-origen
  o un array de pares) — decisión de diseño de API, la resuelve el Architect en el
  SDD respetando CD-1.
- [NEEDS CLARIFICATION resuelto en F2] Nombre/forma del `errorCode` público para el
  fallo de mapeo (AC-2) — debe ser distinguible de otros fallos de step (paralelo a
  `SCOPE_DENIED`/`DEST_CAP_EXCEEDED` en `ComposeResult.errorCode`), el nombre exacto
  lo define el Architect.
- [NEEDS CLARIFICATION resuelto en F2] Si `inputMapping` (o como se llame) y
  `passOutput:true` pueden coexistir en el mismo step. Recomendación de este work-item:
  SÍ coexisten (el mapeo puebla campos puntuales, `passOutput` sigue inyectando el
  objeto completo bajo `previousOutput` si además se pide) — a confirmar en F2.
- [NEEDS CLARIFICATION resuelto en F2] Si el mapeo aplica también al `input`
  regenerado por el retry adaptativo (`regenerateInputFromErrors`, WKH-130) o solo
  al intento inicial — impacta si el re-débito del retry también necesita el guard
  de CD-2.
- No hay bloqueantes de negocio pendientes del founder: la orientación
  (gateway-side, no agente-side) ya fue decidida explícitamente en la HU.

## Análisis de paralelismo

- **No bloquea HUs nuevas**: el cambio es aditivo por diseño (CD-3), así que no
  impide que otras HUs arranquen en paralelo mientras esta está en F2/F3.
- **Riesgo de conflicto de merge**: `src/services/compose.ts` es el archivo más
  activo del repo en las últimas semanas (WKH-191b/191c/191h escrow non-custodial,
  WKH-234 Solana PaymentAdapter, WKH-195 decimals-aware, WKH-196 uint256 precision,
  P1-FIX-PACK fila 189 con AR pendiente de re-review). Cualquiera de esos
  fix-packs que también toque el bloque de débito per-step (líneas ~262-338) puede
  generar conflictos de rebase no triviales. Recomendación: coordinar con el
  founder el orden de merge respecto al fix-pack fila 189 (AR it2, aún sin re-AR/CR/F4
  cerrado) antes de arrancar F3 de esta HU.
- **Desbloquea** (no formalmente parte de esta HU, pero es el caso real que la
  motivó): el pipeline de remesa identidad→cotización→desembolso (agentes
  `remit-kyc-validator`/`remit-corridor-fx`/`remit-cashout-payout`, WKH-170/171/172)
  podría usar este mecanismo para propagar `quoteId` sin que `remit-cashout-payout`
  tenga que saber que es "el paso 3 de un pipeline". Verificar en F2 si esos 3
  agentes ya declaran su `outputSchema`/`inputSchema` de forma compatible con un
  lookup por clave (`quoteId` como clave de primer nivel), o si necesitan un ajuste
  de shape aparte (fuera de esta HU si así fuera).
