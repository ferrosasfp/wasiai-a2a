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

## Comandos NexusAgil

| Situación | Acción |
|---|---|
| HU nueva | Actúa como Analyst+Architect. Lee `.agent/skills/nexus-agile/SKILL.md`. Genera Work Item F1. |
| SDD | Actúa como Architect. Codebase Grounding. Genera SDD con template `references/sdd_template.md` |
| Story file | Actúa como Architect. Genera story con template `references/story_file_template.md` |
| Implementar | Actúa como Dev. Lee story file. Anti-Hallucination Protocol. |
| Adversarial Review | Actúa como Adversary. Usa `references/adversarial_review_checklist.md` |
| QA | Actúa como QA. Usa `references/validation_report_template.md`. Evidencia archivo:línea. |

---

## Reglas de proceso — NexusAgil QUALITY

> Estas reglas son INVIOLABLES. Cualquier violación se documenta en la Retro.

1. **Dev no empieza sin SPEC_APPROVED** — sin excepciones, sin importar la urgencia
2. **Story File se genera DESPUÉS de SPEC_APPROVED** — nunca antes
3. **CR siempre cita archivo:línea** — "APPROVED" sin evidencia no es CR
4. **F4 QA cita archivo:línea por cada AC** — sin evidencia el AC no cuenta como PASS
5. **Sub-agentes son OBLIGATORIOS** — el orquestador NUNCA ejecuta ni evalúa roles de Requirements, Spec, Logic, Security, QA directamente
