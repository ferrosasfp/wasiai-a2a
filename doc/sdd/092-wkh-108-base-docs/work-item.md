# Work Item — [WKH-108] BASE-05 · Docs README "Base support" + integration guide para devs Base

## Resumen

Agrega visibilidad explícita de Base (Sepolia + Mainnet) al README.md existente y crea
`doc/integration-base.md` como guía standalone de 5 minutos para devs del ecosistema Base.
El README recibe una sección nueva `## Base Support` y una fila en la tabla Production Status.
La integration guide cubre: quick start (env vars + curl), patrones de integración (Base-only y
multi-chain), matriz de decisión CDP Facilitator vs wasiai-facilitator, y cómo aparecer en
Agentic.Market vía Bazaar. Todo el contenido refleja ÚNICAMENTE lo que fue implementado y
verificado en BASE-01..04 — ningún claim sin evidencia onchain.

Esta HU es la última del Epic WKH-103 (BASE port). Es pura documentación: no toca código de
producción ni bases de datos. Está bloqueada por BASE-01 (adapter), BASE-02 (facilitator),
BASE-03 (Bazaar discovery), BASE-04 (evidencia onchain) — sus outputs son prerequisito de
contenido.

## Sizing

- **SDD_MODE**: mini
- **Pipeline**: FAST
- **Estimación**: S (~3h: sección README 1h, integration guide 1.5h, actualizaciones índices 0.5h)
- **Branch sugerido**: `feat/wkh-base-port-v1` (branch compartida con BASE-01..04)

### Justificación FAST

Scope es exclusivamente docs — ningún archivo `src/` tocado. No hay lógica, adapters, ni
middleware involucrado. El riesgo principal es un README diff grande que genere conflicto al
mergear en `feat/wkh-base-port-v1`; se mitiga con diff mínimo (CD-3). No requiere AR ni CR
de código.

## Skills Router

- **skill-technical-writing**: estructura de docs, EARS, formato bilingüe, decision matrices
- **skill-blockchain-evm**: contexto de Base Sepolia/Mainnet, USDC, Basescan, CDP vs
  wasiai-facilitator

## Acceptance Criteria (EARS)

- **AC-1**: WHEN un dev Base abre `README.md` en GitHub sin hacer scroll horizontal ni vertical
  más de 2 pantallas desde el top, the system SHALL mostrar la sección `## Base Support`
  visible y con subsecciones Quick Start, Network Config, Facilitator Options y Bazaar
  Discovery.

- **AC-2**: WHEN un dev sigue los pasos del Quick Start en `doc/integration-base.md` (máximo
  5 pasos: clonar .env, setear 3 vars, registrar key, 1 curl a /compose en Base Sepolia),
  the system SHALL permitir que el dev reciba un HTTP 200 o 402 del gateway con `network:
  eip155:84532` sin ningún otro prerequisito de conocimiento.

- **AC-3**: WHEN un lector consulta la sección Base Support en README.md, the system SHALL
  presentar un link a `doc/BASE-EVIDENCE.md` (producido por BASE-04) que apunte a al menos
  1 tx hash verificable en Basescan Sepolia.

- **AC-4**: WHEN un dev consulta `doc/integration-base.md`, the system SHALL presentar una
  tabla de decisión "CDP Facilitator vs wasiai-facilitator" con al menos 4 criterios
  objetivos (latencia, self-custody, mainnet readiness, costo por tx) y sin lenguaje de
  marketing ni claims no verificables.

- **AC-5**: WHEN `doc/_INDEX.md` (el SDD index) es consultado, the system SHALL incluir la
  entrada `092` apuntando a esta HU con status DONE y branch `feat/wkh-base-port-v1`.

- **AC-6**: WHEN la tabla "Production Status" en README.md es consultada, the system SHALL
  incluir filas para `Base Sepolia` y `Base Mainnet` con el URL del gateway, estado real
  (testnet active / mainnet staged), y el explorer link a Basescan.

- **AC-7**: IF `doc/BASE-EVIDENCE.md` no existe todavía (BASE-04 no completado), THEN el Dev
  SHALL insertar un placeholder `[PENDING BASE-04]` en el link de evidencia de AC-3 y NO
  inventar tx hashes — el placeholder es la única alternativa válida.

## Scope IN

| Archivo | Acción |
|---------|--------|
| `README.md` | Agregar sección `## Base Support` después de `## Kite Hackathon 2026 submission`; agregar 2 filas Base a tabla Production Status; agregar link a `doc/integration-base.md` en tabla Documentation |
| `doc/integration-base.md` | Crear nuevo — guía completa (ver estructura en DT-1) |
| `doc/sdd/_INDEX.md` | Agregar fila 092 para esta HU |

## Scope OUT

- NO tocar `src/` — ningún archivo de código de producción
- NO traducir el README completo — mantener patrón bilingüe existente (ES/EN mixto)
- NO crear blog post, video, pitch deck (scope de marketing separado)
- NO crear `doc/BASE-EVIDENCE.md` — ese es el output de BASE-04 (WKH-107)
- NO modificar `doc/INTEGRATION.md` (la guía general de marketplaces) — referenciarlo desde la
  nueva guide, no reescribirlo
- NO agregar sección Base a `doc/architecture/CHAIN-ADAPTIVE.md` (ya fue documentado en 086/087)
- NO activar mainnet Base en producción — solo documentar el path existente

## Decisiones técnicas (DT-N)

- **DT-1 — Estructura de `doc/integration-base.md`**: La guide sigue el esquema de
  `doc/INTEGRATION.md` como exemplar pero es más corta y Base-específica. Secciones:
  `## 1. Quick Start (5 min)`, `## 2. Network Config`, `## 3. Integration Patterns`,
  `## 4. Facilitator Selection Guide`, `## 5. Appear on Agentic.Market`. Cada sección tiene
  máximo 40 líneas. Total estimado: 180-220 líneas incluyendo tablas y código.

- **DT-2 — Posición de la sección Base en README.md**: Insertar `## Base Support` DESPUÉS
  de la sección `## Kite Hackathon 2026 submission` (línea ~39 actual) y ANTES de
  `## Production Status`. Justificación: el hackathon section es prominente y context-setting;
  Base Support amplía la narrativa cross-chain antes de entrar a la tabla de status. Diff
  mínimo: solo se insertan las nuevas líneas, no se modifica el contenido existente.

- **DT-3 — Formato tabla de decisión facilitator**: Tabla markdown con 5 columnas:
  `| Criterio | CDP Facilitator | wasiai-facilitator (self-hosted) | Cuándo usar CDP | Cuándo usar wasiai |`.
  Criterios objetivos: self-custody del settlement, dependencia de Coinbase API, costo por tx
  (USDC gas), latencia típica (mainnet), mainnet readiness hoy. Sin columnas "mejor/peor" —
  solo datos objetivos y el patrón de decisión.

- **DT-4 — Manejo de BASE-EVIDENCE.md ausente**: Si BASE-04 no completó cuando se implementa
  esta HU, usar `[PENDING BASE-04]` como placeholder explícito. AC-7 lo cubre. El Dev DEBE
  verificar si `doc/BASE-EVIDENCE.md` existe antes de linkear — si existe, usar el path real
  y los tx hashes del archivo; si no existe, usar el placeholder. No inventar hashes.

- **DT-5 — Indexación de la guide**: `doc/integration-base.md` NO es un SDD sino una doc
  operativa. Se lista en la tabla Documentation del README.md (como ya se hace con
  `doc/INTEGRATION.md` y `doc/architecture/CHAIN-ADAPTIVE.md`). La entrada en
  `doc/sdd/_INDEX.md` cubre el artefacto SDD (work-item, done-report), no la guide misma.
  No se crea un `doc/_DOCS_INDEX.md` separado — queda como [NEEDS CLARIFICATION] si el
  humano prefiere un índice separado para docs operativas, pero el default es README table.

- **DT-6 — Patrón bilingüe**: El README actual mezcla ES/EN orgánicamente — comentarios y
  descripción general en inglés, detalles de proceso en español. La nueva sección `Base
  Support` va en inglés (target audience son devs Base del ecosistema Coinbase). La
  integration guide `doc/integration-base.md` va en inglés completo (misma audiencia). Los
  encabezados del work-item y artefactos NexusAgil siguen en español (audiencia interna).

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO referencias a contratos no deployados ni tx hashes inventados — solo
  links verificables en Basescan. Si BASE-04 no existe, usar `[PENDING BASE-04]`.
- **CD-2**: OBLIGATORIO seguir el patrón bilingüe del README actual — no reescribir secciones
  existentes, no cambiar el tono o el formato de las partes que no se tocan.
- **CD-3**: PROHIBIDO hacer diff grande en README.md — solo agregar la sección nueva y las 2
  filas en la tabla. No refactorizar, no reordenar secciones existentes.
- **CD-4**: PROHIBIDO mencionar features de BASE-06 (Smart Wallet / OnchainKit) o BASE-07 —
  esas HUs no están en este epic MVP. Solo documentar lo implementado en BASE-01..04.
- **CD-5**: OBLIGATORIO que todos los env vars mencionados en la guide existan realmente en
  `.env.example` (output de BASE-01). Si alguna var aún no está, marcarla `[PENDING BASE-01]`.
- **CD-6**: PROHIBIDO afirmar "Base Mainnet live" sin evidencia — la tabla debe reflejar el
  estado real (staged/env-gated) con la misma honestidad que la tabla de adapter bundles en
  el README actual.
- **CD-7**: OBLIGATORIO que el documento `doc/integration-base.md` incluya la nota de
  dependencia explícita: "Requires BASE-01..04 to be deployed — check Production Status table
  before running the quick start."

## Missing Inputs

- **[NEEDS CLARIFICATION — BLOQUEANTE de contenido]** `doc/BASE-EVIDENCE.md` no existe aún
  (depende de BASE-04 / WKH-107). El Dev debe verificar si existe en el momento de
  implementar. Si no existe, AC-7 habilita el placeholder. Si existe, los tx hashes son
  inmutables una vez incluidos (CD-1).
- **[NEEDS CLARIFICATION — BLOQUEANTE de contenido]** Estado real de Base Mainnet al momento
  de implementar: ¿staged/env-gated o activo? El Dev debe consultar el done-report de BASE-01
  (088-wkh-104-base-adapter) para el estado final. No asumir.
- **[RESUELTO]** Estructura del README.md actual: leída. La sección `Base Support` va después
  de la línea ~39 (`---` tras Kite Hackathon section).
- **[RESUELTO]** Exemplar de integration guide: `doc/INTEGRATION.md` — mismo tono y formato.
- **[RESUELTO]** Posición en _INDEX.md: NNN 092, fila nueva al final de la tabla.
- **[RESUELTO]** USDC addresses Base: Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e`,
  Mainnet `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (de WKH-104 work-item).
- **[RESUELTO]** ChainIds: Base Sepolia 84532, Base Mainnet 8453.
- **[RESUELTO]** Basescan URLs: Sepolia `https://sepolia.basescan.org`, Mainnet `https://basescan.org`.

## Riesgos identificados

| Riesgo | Severidad | Mitigación |
|--------|-----------|------------|
| Conflicto de merge en README.md si BASE-01..04 también lo tocaron | MEDIA | CD-3: diff mínimo. El Dev hace `git pull origin feat/wkh-base-port-v1` antes de editar README. |
| `doc/BASE-EVIDENCE.md` no existe cuando se implementa esta HU | BAJA | AC-7 + CD-1 + DT-4: placeholder explícito `[PENDING BASE-04]`. |
| Tx hashes desactualizados si BASE-04 se re-corre | BAJA | CD-1: los hashes en docs son inmutables una vez escritos. Se documenta el hash de la primera corrida exitosa. |
| Overclaiming de Base Mainnet (no activo) | MEDIA | CD-6: el Dev revisa estado real en done-report de BASE-01 antes de escribir la tabla. |
| Feature creep — devs piden agregar OnchainKit / Smart Wallet | BAJA | CD-4: PROHIBIDO en scope. Marcado explícitamente como Scope OUT. |

## Análisis de paralelismo

- **BLOQUEADA POR**: BASE-01 (WKH-104 / 088), BASE-02 (WKH-105 / 089), BASE-03 (WKH-106 /
  090), BASE-04 (WKH-107 / 091). Esta HU es la última del Epic. No puede iniciarse hasta que
  al menos BASE-01 y BASE-03 estén DONE (para documentar el adapter y el Bazaar discovery con
  datos reales). BASE-04 es deseable pero no bloqueante gracias a DT-4/AC-7.
- **BLOQUEA**: postulación efectiva a Base Builder Grants (README claro = discovery), y
  presentación al Onchain Summer Buildathon (jueces leen README primero).
- **Paralelismo posible**: ninguno dentro del Epic. Es la HU final. Sí puede correrse en
  paralelo con HUs de otros Epics que no toquen README.md.
