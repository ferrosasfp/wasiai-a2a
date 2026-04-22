# WasiAI A2A Protocol — CLAUDE.md

Servicio de discovery, composición y orquestación de agentes autónomos siguiendo Google A2A Protocol.

## ⚠️ ESTE ES UN PROYECTO NUEVO — NO CONFUNDIR CON wasiai-v2

| Proyecto | Qué es | Repo |
|----------|--------|------|
| **wasiai-a2a** (este) | Protocolo/servicio A2A | github.com/ferrosasfp/wasiai-a2a |
| wasiai-v2 | Marketplace de agentes | github.com/ferrosasfp/wasiai-v2 |

### Relación
- wasiai-a2a es un servicio **standalone**
- wasiai-v2 (el marketplace) **consume** wasiai-a2a
- Otros marketplaces también pueden consumir wasiai-a2a

---

## Antes de cualquier tarea

Lee siempre:
1. `.nexus/project-context.md` — contexto completo del proyecto, stack, reglas, patrones
2. `BACKLOG.md` — épicas y prioridades (cuando exista)
3. `.agent/skills/nexus-agile/SKILL.md` — metodología activa

---

## Metodología

Ver detalle completo: `.agent/skills/nexus-agile/SKILL.md`

WasiAI A2A es siempre modo **QUALITY**. Flujo obligatorio:

```
[Analyst+Architect] F0 Codebase Grounding
[Analyst+Architect] F1 Work Item + ACs EARS
⛔ HU_APPROVED
[Architect+Adversary] F2 SDD + Constraint Directives
⛔ SPEC_APPROVED
[Architect] F2.5 story-HU-X.X.md  ← SIN ESTO NO SE CODEA
[Dev] F3 Anti-Hallucination + Waves
[Adversary] AR → BLOQUEANTE/MENOR/OK
[Adversary+QA] Code Review
[QA] F4 Drift Detection + evidencia archivo:línea
[Docs] DONE → _INDEX.md
git push origin main
```

Gates — texto exacto:
- `HU_APPROVED` — "ok"/"dale"/"go" NO cuentan
- `SPEC_APPROVED` — "implementa"/"empieza" NO cuentan

---

## Golden Path (inmutable)

**Reglas absolutas:**
- Sin hardcodes (contratos, URLs, keys, endpoints)
- Sin datos simulados en producción
- Sin secrets en código — todo desde env vars
- Puerto por defecto: 3001 (no 3000 para evitar conflicto con Next.js)
- JSON-RPC 2.0 para A2A protocol methods
- REST para endpoints administrativos
- TypeScript strict — sin `any` explícito

---

## ⚠️ REGLAS DE ORQUESTACIÓN — CRÍTICO

**Vos sos el ORQUESTADOR. NO hacés trabajo real.**

- ❌ NO escribís SDDs vos mismo → lanzá `nexus-architect`
- ❌ NO implementás código vos mismo → lanzá `nexus-dev`
- ❌ NO revisás vos mismo → lanzá `nexus-adversary`
- ❌ NO validás ACs vos mismo → lanzá `nexus-qa`
- ❌ NO escribís el report final → lanzá `nexus-docs`

Si te encontrás haciendo `Edit`/`Write` sobre `src/`, escribiendo análisis profundos en sesión principal, o decidiendo veredictos AR/CR/QA → **STOP**. Es error de proceso. Lanzá el sub-agente correcto vía Task tool.

**Tu único trabajo**: lanzar sub-agentes, recibir artefactos en `doc/sdd/NNN-titulo/`, presentar resúmenes al humano en los gates, pasar el artefacto al siguiente sub-agente.

---

## Sub-Agentes Custom (instalados en `~/.claude/agents/`)

| Agente | Fase | Cuándo usarlo |
|--------|------|---------------|
| `nexus-analyst` | F0, F1 | Bootstrap context + work-item.md desde una HU nueva |
| `nexus-architect` | F2, F2.5, CR | SDD + Story File + revisión arquitectónica |
| `nexus-dev` | F3 | Implementación wave por wave desde Story File |
| `nexus-adversary` | AR, CR | Adversarial Review (ataque) + Code Review (calidad) |
| `nexus-qa` | F4 | Validación de ACs con evidencia + Quality Gates |
| `nexus-docs` | DONE | Reporte final + _INDEX.md + cierre del pipeline |

Cada agente tiene su bloque `⛔ PROHIBIDO EN ESTA FASE` integrado en su system prompt. No podés saltearlo.

## Slash Commands NexusAgil (instalados en `~/.claude/commands/`)

| Paso | Comando | Lanza | Cuándo |
|------|---------|-------|--------|
| p1 | `/nexus-p1-f0-f1 WKH-XX` | `nexus-analyst` | Empezar HU nueva |
| p2 | `/nexus-p2-f2 WKH-XX` | `nexus-architect` | Después de `HU_APPROVED` |
| p3 | `/nexus-p3-f2-5 WKH-XX` | `nexus-architect` | Después de `SPEC_APPROVED` |
| p4 | `/nexus-p4-f3 WKH-XX` | `nexus-dev` | Implementar |
| p5 | `/nexus-p5-ar WKH-XX` | `nexus-adversary` | Después de F3 |
| p6 | `/nexus-p6-cr WKH-XX` | `nexus-adversary` | Después de AR APROBADO |
| p7 | `/nexus-p7-f4 WKH-XX` | `nexus-qa` | Después de CR APROBADO |
| p8 | `/nexus-p8-done WKH-XX` | `nexus-docs` | Después de F4 APROBADO |

**Prefijo `pN`**: indica el orden obligatorio de ejecución. Arrancá siempre por `p1` y avanzá secuencialmente — no te saltes pasos.

**Regla**: usá los slash commands en lugar de armar el Task tool a mano. Cada slash command ya tiene el bloque PROHIBIDO, los pre-requisitos y los outputs esperados.

---

## Reglas de proceso — NexusAgil QUALITY

> Estas reglas son INVIOLABLES. Cualquier violación se documenta en la Retro.

1. **Dev no empieza sin SPEC_APPROVED** — sin excepciones, sin importar la urgencia
2. **Story File se genera DESPUÉS de SPEC_APPROVED** — nunca antes
3. **CR siempre cita archivo:línea** — "APPROVED" sin evidencia no es CR
4. **F4 QA cita archivo:línea por cada AC** — sin evidencia el AC no cuenta como PASS
5. **Sub-agentes son OBLIGATORIOS** — el orquestador NUNCA ejecuta ni evalúa roles directamente. Usá los 6 agentes custom + 8 slash commands. Si no podés (sub-agente no disponible), parar y avisar al humano antes de improvisar.
6. **Un gate por lanzamiento** — NUNCA incluyas `HU_APPROVED → F2 → SPEC_APPROVED` en el mismo prompt. Los sub-agentes one-shot no pueden esperar gates. Lanzá `/nexus-f0-f1`, esperá HU_APPROVED, lanzá `/nexus-f2`, esperá SPEC_APPROVED, lanzá `/nexus-f2-5`, etc.
7. **Entre gates el pipeline corre solo** — F2.5 → F3 → AR → CR → F4 → DONE NO tiene gates humanos. NO preguntes "¿continuo?". Si tenés F2.5 listo, lanzá F3 inmediatamente.

---

## Security Conventions — Ownership Guard

**Regla obligatoria (WKH-53):** toda query o mutación sobre `a2a_agent_keys`
hecha desde `src/services/` DEBE filtrar por `owner_ref` además del `id`.

El cliente de Supabase usa `SUPABASE_SERVICE_ROLE_KEY`, que **bypassea RLS**.
Por eso el ownership check vive en la capa de aplicación: si un service hace
`.eq('id', keyId)` sin cruzar con `.eq('owner_ref', callerOwnerRef)`, cualquier
caller autenticado puede leer o modificar datos de otro owner (IDOR).

### Patrón obligatorio

```ts
// OK
async getBalance(keyId: string, chainId: number, ownerId: string): Promise<string> {
  const { data, error } = await supabase
    .from('a2a_agent_keys')
    .select('budget')
    .eq('id', keyId)
    .eq('owner_ref', ownerId)   // <- imprescindible
    .single();
  if (error?.code === 'PGRST116') throw new OwnershipMismatchError();
  // ...
}

// MAL — cross-tenant leak
async getBalance(keyId: string, chainId: number): Promise<string> {
  const { data } = await supabase
    .from('a2a_agent_keys')
    .select('budget')
    .eq('id', keyId)
    .single();
  // sin .eq('owner_ref', ...) → cualquier owner puede leer cualquier balance
}
```

### Cómo obtener el `ownerId`

En rutas autenticadas post-middleware `requirePaymentOrA2AKey`, el row del
caller está en `request.a2aKeyRow`. El `owner_ref` se pasa como argumento
al service:

```ts
const balance = await budgetService.getBalance(
  keyRow.id,
  chainId,
  keyRow.owner_ref,  // <- el owner_ref del caller autenticado
);
```

### Qué debe detectar Adversary Review (AR) / Code Review (CR)

En cualquier PR que modifique `src/services/*.ts` y toque queries sobre
`a2a_agent_keys`:

1. Buscar `.from('a2a_agent_keys')` y verificar que la cadena incluye
   `.eq('owner_ref', <value>)` antes del `.single()` / `.maybeSingle()` /
   resolución de la promise.
2. Si el service agrega una nueva función que recibe un `keyId`, su firma
   DEBE incluir un `ownerId: string` (no `string | undefined`).
3. Si detectás una violación, marcalo **BLOQUEANTE** en el AR. El bug es
   equivalente a un IDOR (Insecure Direct Object Reference).

### Tablas con ownership en app-layer (hoy)

| Tabla | Columna owner | Protegida en services |
|-------|--------------|----------------------|
| `a2a_agent_keys` | `owner_ref` | SI (WKH-53) |
| `tasks` | — (no tiene, pending WKH-54) | no |
| `a2a_events` | — (telemetría global) | N/A |
| `registries` | — (admin global) | N/A |

### RLS real (Postgres-level)

Hoy la defensa es **solo app-layer**. El plan de `ALTER TABLE a2a_agent_keys
ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` está trackeado en **WKH-SEC-02**
(TD-SEC-01). Hasta que se implemente, la app es la única línea de defensa.
La **Fase B** (WKH-54) agrega `owner_ref` a `tasks` + RPC update.
