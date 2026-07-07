# Report — HU [WKH-153] Planner LLM ignora input_schema por-agente

## Resumen ejecutivo

**Bug**: Chaski → `/orchestrate` plan con 3 agentes de remesa devolvía "$0 · $0 fee" sin ejecutar. El planner seleccionaba bien los agentes (`agentshop-corridor-discoverer`, `cashout-matcher`, `kyc-validator`) pero les mandaba un input genérico `{query:"..."}` en vez de sus `input_schema` reales (`{amountUSD, receiverCountry, senderName, ...}`). Los agentes respondían HTTP 400 → step-0 fallaba → fee se cobró como $0 por fallo en compose_step.

**Causa raíz**: El prompt de `llmPlan` en `orchestrate.ts:207` contenía UN solo ejemplo de output: `"input": { "query": "specific input" }` para todos los agentes. Con `thinking:disabled` (línea 226), el LLM copiaba literalmente ese ejemplo sin reconciliar contra la instrucción abstracta en línea 188 que decía "usa el input_schema de cada agente". El few-shot example prevaleció sobre la instrucción en prosa.

**Fix (texto del prompt únicamente)**:
1. Línea 188: Reforzar "OWN input_schema" + "never reuse" + "never default to {query}" + "only if that agent's schema defines it"
2. Línea 207: Reemplazar el ejemplo sesgado `{query}` por un placeholder schema-driven: `"<field-name>": "<value matching THIS agent's input_schema>"`
3. Líneas nuevas: Agregar NOTA explícita ("is a PLACEHOLDER, not a fixed shape") + warning ("Never output the literal placeholder tokens")

**Validación**: 
- T-INPUT-1 (AC-1/AC-3): test sobre STRING del prompt (determinístico) — verifica que NO está el ejemplo sesgado `{query}` y SÍ aparecen palabras clave ("PLACEHOLDER", "input_schema", "example_input", "Never output literal")
- T-INPUT-2 (AC-4): input estructurado mockeado (`{amountUSD, receiverCountry, senderName}`) se propaga intacto a través de `llmPlan` → `planOrchestration` → step, sin mutación a `{query}`
- T-INPUT-3 (AC-2): agentes que SÍ usan `{query}` (sin input_schema) siguen funcionando, input `{query}` fluye sin cambios

**Caveat crítico**: El comportamiento REAL del LLM (¿Sonnet 5 ahora manda input estructurado?) es **no determinístico y fuera de CI**. La validación post-deploy requiere un **smoke real** de Chaski: remesa "enviar $400 a mi mamá en Perú" → verificar que `compose_step` en bdwv devuelve `protocolFeeUsdc > 0` (no $0) y `agentCount:3` se ejecuta (no `compose_step: minimal`).

**Entregables**:
- `src/services/orchestrate.ts`: 7 líneas (refuerzo instrucción + nuevo placeholder + NOTAs)
- `src/services/orchestrate.test.ts`: +109 líneas (T-INPUT-1/T-INPUT-2/T-INPUT-3)
- Test suite: 2775 tests passing (2772 baseline + 3 nuevos de WKH-153)
- tsc 0, biome 0, sin warnings

---

## Pipeline ejecutado

- **F0**: project-context cargado; mecanismo confirmado leyendo `orchestrate.ts:152-280`
- **F1**: work-item.md (gate: HU_APPROVED el 2026-07-06)
- **F2**: NO — FAST+AR, mini-scope SDD
- **F2.5**: NO — story-file innecesario para 7 líneas de prompt
- **F3**: Implementación: líneas 185-211 de `orchestrate.ts`, +109 líneas en test
- **AR**: APROBADO — 0 bloqueantes. MNR-1 extraído: "placeholder-literal tokens en NOTA" (accepted as doc/clarity, no code change)
- **CR**: APROBADO — 0 bloqueantes. NIT foldeado en fix-pack: folding del archivo extra para claridad
- **F4**: N/A — smoke post-deploy es manual (fuera de CI, no determinístico)

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|----|----------|
| AC-1: Ejemplo incluye referencia a `input_schema` por-agente | PASS | `orchestrate.ts:207` reemplazado + líneas 207-210 NOTAs; test T-INPUT-1 afirma `"is a PLACEHOLDER"` + `"input_schema"` + `"example_input"` |
| AC-2: Agentes `{query}` NO se rompen | PASS | Test T-INPUT-3 verifica que `{ query: "..." }` sigue siendo válido para agentes sin input_schema; input fluye intacto |
| AC-3: String del prompt NO contiene ejemplo sesgado | PASS | Test T-INPUT-1 afirma `!prompt.toContain('"input": { "query": "specific input" }')` — determinístico, inspecciona el string real del prompt via mock |
| AC-4: Input estructurado mockeado se propaga intacto | PASS | Test T-INPUT-2: input `{amountUSD, receiverCountry, senderName}` devuelto por LLM mockeado fluye sin cambios a `plan.steps[0].input`; `plan.steps[0].input` NO tiene propiedad `query` |
| AC-5: Suite existente sin regresiones | PASS | 2775 tests passing (2772 baseline WKH-130/WKH-151 + 3 WKH-153). tsc 0, biome 0 |

---

## Hallazgos finales

**BLOQUEANTEs**: Ninguno. AR+CR APROBARON.

**MENORs**:
- **AR MNR-1 (aceptado/cerrado)**: Nota en líneas 209-210 menciona "Never output the literal placeholder tokens (`<field-name>`, `<value ...>`)" — riesgo teórico de que el LLM copie los tokens literales. Mitigation: la palabra "placeholder" y el ejemplo `<field-name>` son lo suficientemente marcados (ángulos + descripción) como para que Sonnet 5 no los confunda con campos reales. Post-deploy smoke lo validará; si el LLM genera `<field-name>` literal, es un hallazgo post-smoke que se abre como HU de refinamiento de prompts (candidato para future: "prompt-parity tester" que verifique output LLM contra output schema).

**Deuda técnica**: Ninguna marcada. El diseño DT-1 (fix de prompt, no validación runtime) es intencional para mantener scope mínimo en FAST+AR.

---

## Auto-Blindaje consolidado

| # | Lección | Implicación | Aplicable a |
|----|---------|------------|-------------|
| 1 | Few-shot example en el prompt pesa MÁS que instrucción en prosa cuando `thinking:disabled` — el LLM copia el formato visible sin reconciliar | Prompt engineering: ejemplos concretos dominan las reglas; con `thinking` deshabilitado, no hay razonamiento que resuelva conflictos | Todos los prompts que usen LLM sin reasoning explícito (WKH-10, WKH-131, futuras features LLM-planner) |
| 2 | Validación de prompt = inspección del STRING (determinístico) + smoke real post-deploy (no determinístico en CI) — dos niveles ortogonales | Estrategia de testing: test string = regresión del código del prompt; smoke real = regresión del comportamiento LLM | Todos los cambios de prompt en la codebase |
| 3 | Placeholder en prompt + NOTA de "no copiar literal" NO garantiza que el LLM no lo copie — depende del modelo/versión; incluir la mitigation en post-deploy smoke | Mitigación: cuando se generan placeholders, incluir verificación en smoke (p.ej. detect `<placeholder>` en output) | Futuras HUs que agreguen placeholders/templates en prompts (WKH-139 árbitro, WKH-141 APP bridge, etc.) |
| 4 | Refactorizar la construcción del prompt: en vez de concatenar strings, usar un template con slots bien marcados ({{ }} o similar) + parser post-respuesta que rechace tokens literal de placeholder | Mejora de design: hoy la construcción es `.join('\n')` con `:188` y `:207` como inyecciones textuales; un template + parser haría la derivación de input_schema automática/determinística | HU sugerida: WKH-153-FOLLOW-UP (refactor prompt template de llmPlan) — blocker: ninguno, es improvement future |

---

## Archivos modificados

| Archivo | Cambios | Dominio |
|---------|---------|---------|
| `src/services/orchestrate.ts` | Líneas 185-211: refuerzo `:188`, nuevo placeholder `:207`, NOTAs `:209-210` | LLM planning, bug-fix |
| `src/services/orchestrate.test.ts` | +109 líneas: T-INPUT-1 (prompt-string assertion), T-INPUT-2 (structured input propagation), T-INPUT-3 (backward compat {query}) | Testing, regression |

**Resumen de cambios**:
```
 7 lines modified, 109 lines added
 tsc 0 errors, biome 0 errors
 2775 tests passing (2772 + 3 new)
```

---

## Decisiones diferidas a backlog

**WKH-153-FOLLOW-UP (candidato HU)**:
- Refactorizar `llmPlan` para usar un template de prompt (p.ej. Handlebars/Nunjucks) en lugar de string `.join()`, permitiendo que el mapeo de `input_schema` → `input` sea automático/determinístico en el lado del prompt.
- Agregar un parser post-respuesta LLM que rechace placeholders literales detectando patrones como `<field-name>`, devolviendo un error amable ("Invalid placeholder token in output").
- Beneficio: elimina el riesgo MNR-1 sin depender del LLM behavior.
- Costo: refactor de prompt moderate (50-100 LOC rewrite), cambio de deps (template engine).
- Prioridad: LOW (nice-to-have, hoy mitigado por smoke post-deploy).

---

## Verificación post-deploy (pendiente — fuera de CI)

El cambio REAL de comportamiento del LLM es **no determinístico** y debe validarse FUERA del CI:

### Smoke a ejecutar (manual, por operador):

1. **Acceso a bdwv**: tenant de desarrollo, agentes de remesa já funcionales
2. **Invocación Chaski**:
   ```
   Goal: "Send $400 to my mom in Peru"
   Expected: /orchestrate/plan returns agentCount:3, composition starts
   ```
3. **Verificación telemetría bdwv**:
   - `compose_step.agentCount == 3` (no 0)
   - `compose_step.protocolFeeUsdc > 0` (no $0)
   - `compose_step.status == 'minimal'` → FALSE (ejecuta step-0, no fallback)
4. **Verificación de input**:
   - Inspeccionar logs de bdwv para los 3 agentes
   - Verificar que `request.body.input` para cada agente contiene campos reales (`amountUSD`, `receiverCountry`, `senderName`) en lugar de `{query}`

### Resultado esperado:

- ✅ Chaski muestra "Send $400 to Peru" → cita correctamente el flow de remesa sin $0
- ✅ Telemetría bdwv: `agentCount:3`, `protocolFeeUsdc > 0`, `compose_step.status != 'minimal'`
- ✅ Logs de agentes: cada uno recibe su input estructurado, devuelve 200 (no 400)

### Roadmap del bug "$0" de Chaski:

| HU | Fix | Status | Síntoma residual |
|----|-----|--------|------------------|
| WKH-130 (fila 127) | Adaptive input-retry: si agente devuelve 400, aprende del error + reintenta 1 vez | DONE 2026-06-24 | Fallback: si ambos intentos fallan, fee sigue siendo $0 por fallo en compose_step |
| WKH-151 (fila 157) | Orchestrate discovery broaden-retry: si `preferCapabilities` del caller no matchea, retry sin filtro | DONE 2026-07-06 | Sub-caso: `agentCount=3` pero `input` es genérico {query} → 400 inaceptable |
| **WKH-153 (fila 158, ESTE)** | Refuerzo del prompt para que derive input de input_schema de cada agente | **DONE 2026-07-06** | Smoke post-deploy pendiente: verificar que el LLM ahora manda input estructurado realmente |

**Conclusión**: Los 3 bugs encadenados se han atackado. WKH-151 solvió "plan vacío". WKH-153 soluciona "plan con input sesgado". WKH-130 es la red de seguridad reactiva que sigue vigente.

---

## Lecciones para próximas HUs

1. **Prompt engineering es code**: cambios de prompt requieren test sobre el STRING (determinístico) + smoke real post-deploy (no determinístico). No es suficiente confiar en que "la instrucción clara" va a ser respetada sin examples que la respalden.

2. **Few-shot examples > reglas en prosa**: cuando el LLM opera sin reasoning explícito (`thinking:disabled`), un ejemplo visual concreto domina sobre instrucciones abstractas. Diseña prompts asumiendo esto.

3. **Placeholder + NOTA "no copies" NO es una mitigation válida en CI**: si el LLM necesita nunca copiar un placeholder, la única validación real es detectar placeholders en el output post-deploy. En CI, solo testea el string que primes el LLM (no el output).

4. **Refactorizar prompts a templates**: para reducir riesgo de ejemplos sesgados, considera migrar prompts largos (como `llmPlan`) a un template engine + automatic slot-filling, permitiendo que el mapeo agente→input_schema sea data-driven (no hardcodeado en el texto).

---

**Generado por nexus-docs (DONE phase) — 2026-07-06**
