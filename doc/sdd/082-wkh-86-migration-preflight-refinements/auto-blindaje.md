# Auto-Blindaje — WKH-86 Migration Pre-flight Refinements

## Sesión 2026-05-03 — F3 (nexus-dev)

### [2026-05-03 01:50] Wave 0 — Test mock obsoleto al ampliar EXPECTED_A2A_TABLES

- **Error**: tras agregar `a2a_events` al manifest (`EXPECTED_A2A_TABLES`),
  el test `runPostApplyCheck() — AC-4 > passes when a2a_* tables present and no INVALID FKs`
  empezó a fallar porque el mock devolvía solo dos tablas (`a2a_agent_keys`,
  `a2a_protocol_fees`) y la default del manifest ahora exige tres.
- **Causa raíz**: ampliar la default expone tests cuyos mocks no se rebuildearon.
  Los mocks compartidos para post-apply enumeran tablas explícitas, así que
  cualquier cambio al manifest les rompe en cascada si no usan
  `expectedA2aTables` override.
- **Fix**: actualicé el mock del test para incluir `a2a_events`. Para tests
  que sí necesitan probar el "missing table" path, usar `expectedA2aTables`
  override sigue siendo la mejor estrategia.
- **Aplicar en**: cualquier futura HU que agregue una tabla al baseline manifest.
  Antes de modificar `EXPECTED_A2A_TABLES`, hacer un grep por tests que mocken
  `runPostApplyCheck` y verificar que sus stdout enumeran todas las tablas
  del nuevo manifest, o pasen `expectedA2aTables` explícito.

### [2026-05-03 01:50] Wave 0 — AC-4 dedup colapsa el finding más específico

- **Error**: tras introducir `dedupeByLineAndLevel()`, el test
  `analyze() — BLQ-ALTO-1: ALTER DEFAULT PRIVILEGES > flags ALTER DEFAULT PRIVILEGES as MEDIUM`
  empezó a fallar. La SQL `ALTER DEFAULT PRIVILEGES … GRANT SELECT …`
  matcheaba dos patterns MEDIUM (`GRANT/REVOKE` y `ALTER DEFAULT PRIVILEGES`)
  en la misma línea con el mismo nivel. El dedup colapsaba ambos al primer
  match en orden de pattern → quedaba `GRANT/REVOKE` y se perdía el más
  específico.
- **Causa raíz**: el dedup por `(line, level)` no tiene noción de "más
  específico" cuando los niveles son iguales — toma el primer pattern del
  array `RISK_PATTERNS`. Si el pattern más general (GRANT/REVOKE) precede al
  más específico (ALTER DEFAULT PRIVILEGES), el genérico gana.
- **Fix**: reordené `RISK_PATTERNS` para que `ALTER DEFAULT PRIVILEGES`
  preceda a `GRANT/REVOKE`. Comentario en el código explica el motivo.
- **Aplicar en**: cualquier nuevo pattern de la misma severidad que sea un
  caso especial de otro existente. La regla es: pattern MÁS específico
  PRIMERO en el array. Si el order matters por semántica, documentar in-line
  con `// listed BEFORE <pattern>` para que el lector entienda la dependencia.
