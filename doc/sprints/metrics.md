# Sprint Metrics — WasiAI A2A

> Tabla acumulada actualizada al cerrar cada sprint.
> Fuente de datos: Engram (`engram search "sprint"`) + _INDEX.md

## Métricas por Sprint

| Sprint | Período | HUs | Velocidad | AR Bloqueantes | Auto-Blindajes | Gates respetados |
|--------|---------|-----|-----------|---------------|----------------|-----------------|
| 1 | 2026-04-01 → 2026-04-02 | 5 | 5/día | 2 | 4 | 4/5 (80%) |

## Tendencias

- **Velocidad:** Sprint 1: 5 HUs/día (baseline)
- **Calidad AR:** 2 bloqueantes resueltos antes de merge ✅
- **Proceso:** Gate SPEC_APPROVED saltado 1 vez → mejora implementada

## Cómo actualizar

Al cerrar cada sprint, ejecutar:
```bash
engram search "sprint:N" --limit 20
```
Y añadir fila a la tabla con los datos del sprint.

## Objetivo a largo plazo

- AR Bloqueantes → 0 por sprint (calidad de SDDs mejora)
- Auto-Blindajes → decrecientes (errores no se repiten)
- Gates respetados → 100%
