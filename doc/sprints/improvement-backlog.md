# Improvement Backlog — NexusAgile en WasiAI A2A

> Lista viva de mejoras al proceso. Se revisa en cada Sprint Planning.
> Estado: PENDIENTE | IMPLEMENTADO | DESCARTADO

## Mejoras implementadas

| # | Mejora | Sprint | Archivo actualizado |
|---|--------|--------|-------------------|
| M-P0-1 | Git fetch obligatorio en AR (Paso 0) | 1 | quality_pipeline.md |
| M-P0-2 | Grounding Check obligatorio en F2.5 | 1 | quality_pipeline.md |
| M-P1-1 | Environment Gate Wave -1 en Story File | 1 | story_file_template.md |
| M-P1-2 | Checklist pre-F3 en orquestador | 1 | subagent_protocol.md |
| M-P1-3 | Auto-Blindaje F3 paralelo en repo compartido | 1 | subagent_protocol.md |
| M-P1-4 | Engram para métricas en fase DONE | 1 | quality_pipeline.md |
| M-P2-1 | DONE obligatorio (no solo merge) | 1 | quality_pipeline.md |
| M-P2-2 | Dashboard métricas por sprint | 1 | doc/sprints/metrics.md |

## Pendientes para evaluar en próximo sprint

| # | Mejora | Prioridad | Notas |
|---|--------|-----------|-------|
| MP-1 | Orquestador delega operaciones git/DB a sub-agentes | P1 | Evita context overload en sesiones largas |
| MP-2 | Gate compliance tracking en sprint-status.yaml | P2 | Registrar si gates fueron respetados o saltados |
| MP-3 | Re-verificación automática de Story File post-merge de dependencias | P2 | Si WKH-X se mergea y cambia tipos, avisar a WKH-Y en progreso |

## Cómo usar este archivo

- **Sprint Planning:** revisar "Pendientes", decidir cuáles implementar
- **Retro:** añadir nuevas mejoras identificadas durante el sprint
- **Al implementar:** mover de "Pendientes" a "Implementadas" con el sprint y archivo
