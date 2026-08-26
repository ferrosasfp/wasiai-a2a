# Work Item — [WKH-365] Tablero de las tres preguntas

Issue de referencia: `ferrosasfp/wasiai-a2a#179`. Alcance ya decidido por el founder — no se reabre.

## Resumen

Un tablero de solo-lectura que contesta tres preguntas que hoy exigen trabajo manual:
(1) cuánto le queda de saldo a la key de la sonda de WKH-364, (2) qué reputación tiene
cada agente, (3) cuánta plata sigue trabada en escrows de Solana devnet. No cotiza, no
compra, no reemplaza el aviso de la sonda — sólo lee tres fuentes ya gratuitas y las
muestra en un solo lugar.

## Sizing

- SDD_MODE: full (QUALITY, siempre en este repo)
- Estimación: M (tres integraciones read-only + UI mínima; dos de las tres fuentes ya
  tienen servicio/pattern hecho — `reputationService`, `requireAdminTokenForTrace`)
- Branch sugerido: `feat/228-tablero-tres-preguntas` (ya checked out en este worktree)

## Decisiones (tomadas acá, no reabrir en F2 sin motivo nuevo)

**DT-1 — Dónde vive: ruta nueva del propio gateway (`/dashboard/tres-preguntas`), NO
`wasiai.io`.** La pregunta #1 es un saldo (`budget`, `daily_spent_usd`, `daily_limit_usd`
de la key de la sonda): un endpoint público sin gate lo expondría. `src/routes/dashboard.ts`
ya resuelve esta tensión para un caso idéntico —`/dashboard/api/trace` es cross-tenant y
usa `requireAdminTokenForTrace` (fail-closed en dev y prod, `dashboard.ts:314-331`),
mientras el shell HTML (`GET /dashboard/trace`) es público porque no lleva datos de
tenant. Mismo patrón acá: `GET /dashboard/tres-preguntas` sirve un HTML sin datos, y
`GET /dashboard/api/tres-preguntas` (o tres endpoints, uno por pregunta) exige el token.
`wasiai.io` queda descartado: es la landing pública y no tiene forma de guardar un secret
de servidor sin acoplarse al gateway igual.

**DT-2 — Refresco: cache en memoria del proceso, TTL corto, sin polling agresivo del
cliente.** Ninguna de las tres fuentes cuesta dinero on-chain (`GET /auth/me`, `/discover`
y una lectura RPC son gratis), pero SÍ tienen rate-limit (el RPC público de devnet ya está
dando 429 sostenido; el dedicado de Alchemy tiene cuota). Patrón: TTL server-side de 60s
(mismo criterio que `STATS_CACHE_TTL_MS`, `dashboard.ts:420`) + el cliente pide al abrir la
pantalla y con un botón "actualizar", no con un `setInterval` corto. Que siga siendo
gratis es un requisito duro: si el sizing en F2 encuentra que una fuente no lo es tal como
está armada, se corta esa tarjeta, no se agrega gasto.

**DT-3 — Reputación: cero lógica nueva.** Se usa `reputationService.computeStandingBatch`
tal como existe (`src/services/reputation.ts:336-397`), que ya expone `degraded: true`
quando no pudo leer `a2a_events` — es exactamente el "sin dato" que este tablero necesita,
ya resuelto por WKH-313. Contra **bdwv**, nunca `caldz`.

**DT-4 — Escrows: RPC, mecanismo exacto para F2.** La fuente es el RPC de Solana devnet ya
configurado (`SOLANA_RPC_URL`, `src/adapters/solana/chain.ts:39-41`; en prod apunta al
endpoint dedicado, nunca al público). Este work item fija el COMPORTAMIENTO (contar
escrows vivos y sumar su balance bloqueado, derivado en cada corrida — el "8 vivos / 12
USDC" del 2026-08-19 es una foto vieja y no se copia); el Architect define en F2 la query
exacta (`getProgramAccounts` + filtro/discriminador) contra el programa de escrow real,
que este F1 no tiene localizado en el árbol.

**DT-5 — Saldo de la sonda: requiere que el gateway se llame a sí mismo.** `GET /auth/me`
exige la credencial de la key (`src/routes/auth/me.ts:16-19`). Para que el tablero la lea,
el proceso del gateway necesita esa misma credencial como env var propia (hoy
`A2A_PROBE_KEY` sólo existe como repo secret de GitHub Actions, para el workflow de la
sonda — `auto-blindaje.md` de WKH-364). Es un dato nuevo que falta, no un supuesto: va en
Missing Inputs como bloqueante, igual que el fondeo de la key lo fue para WKH-364.

## Acceptance Criteria (EARS)

- **AC-1**: WHEN un caller con `X-Admin-Token` válido pide `GET /dashboard/api/tres-preguntas`,
  el sistema SHALL responder con el saldo de la key de la sonda (`budget`,
  `daily_spent_usd`, `daily_limit_usd`) leído de `GET /auth/me` en esa misma corrida.
- **AC-2**: WHEN la lectura del saldo de la sonda falla (timeout, red inalcanzable, 403,
  credencial sin configurar), el sistema SHALL marcar esa tarjeta con un estado "sin dato"
  distinguible y SHALL NOT reportarla como saludable.
- **AC-3**: WHEN se pide la tarjeta de reputación, el sistema SHALL calcularla con
  `reputationService.computeStandingBatch` sobre `a2a_events` en `bdwv`, SIN emitir ningún
  `POST /compose`, `POST /orchestrate` ni llamada de cotización nueva.
- **AC-4**: IF `computeStandingBatch` devuelve `degraded: true`, THEN el sistema SHALL
  mostrar la tarjeta de reputación como "sin dato", nunca como "cero reputación".
- **AC-5**: WHEN se pide la tarjeta de escrows, el sistema SHALL consultar el RPC de Solana
  devnet configurado (`SOLANA_RPC_URL`) y reportar el conteo y balance bloqueado DERIVADOS
  de esa consulta — nunca un número hardcodeado ni copiado de una medición anterior.
- **AC-6**: IF la consulta al RPC de Solana falla o el RPC configurado da 429/timeout,
  THEN la tarjeta de escrows SHALL mostrarse como "sin dato", y el sistema SHALL NOT
  interpretar la ausencia de respuesta como "cero escrows vivos".
- **AC-7**: WHILE el tablero está siendo leído (cualquiera de las tres tarjetas), el
  sistema SHALL NOT disparar ninguna operación que gaste dinero — es de solo lectura.
- **AC-8**: IF el caller no presenta `X-Admin-Token` o `DASHBOARD_ADMIN_TOKEN` no está
  configurado en el proceso, THEN el sistema SHALL responder fail-closed (503/401, mismo
  contrato que `requireAdminTokenForTrace`) sin revelar saldo ni identificador de la key.
- **AC-9**: WHERE ninguna de las tres tarjetas pudo leer su fuente (los tres estados son
  "sin dato"), el sistema SHALL SHALL igual responder 200 con las tres marcadas "sin
  dato" — un fallo de una fuente NO tira las otras dos.

## Scope IN

- `src/routes/dashboard.ts` — nueva(s) ruta(s) bajo `/dashboard/tres-preguntas` (HTML
  shell público, sin datos de tenant) y `/dashboard/api/tres-preguntas` (JSON, gateado
  fail-closed con el patrón de `requireAdminTokenForTrace`).
- `src/static/dashboard-tres-preguntas.html` (nuevo, patrón de `dashboard-trace.html`).
- Un service o función nueva y chica para (a) leer `GET /auth/me` internamente con la
  credencial de la sonda, y (b) consultar el RPC de Solana para escrows — el diseño
  exacto de estos dos es del Architect en F2.
- Reuso de `src/services/reputation.ts` (`computeStandingBatch`) sin modificarlo.

## Scope OUT

- Cotizar, comprar o mover dinero desde el tablero (sólo observa).
- Modificar `scripts/probe-money-path.mjs` o `.github/workflows/probe-money-path.yml`.
- Reemplazar el aviso de la sonda (issue de GitHub) con el tablero — son cosas distintas.
- Tocar `chaski-v3`, `wasiai-facilitator`, `wasiai-remittance-agents`.
- Crear credenciales o setear variables de entorno en Railway — del founder.
- "¿el camino del dinero cotizó?" — eso ya lo contesta la sonda; si se agrega, es leyendo
  su resultado (GitHub Actions / issue), nunca cotizando de nuevo. **Fuera del corte #1.**
- Alertas/notificaciones del propio tablero (push, email, Discord) — es tablero, no aviso.
- Página pública sin gate en `wasiai.io` — descartada por DT-1.

## Decisiones técnicas (DT-N)

Ver sección "Decisiones" arriba (DT-1 a DT-5) — están numeradas ahí para no duplicar.

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO que el tablero dispare `POST /compose`, `POST /orchestrate` o
  cualquier operación que gaste — únicamente `GET /auth/me`, `GET/POST /discover` (lectura
  de catálogo) y lecturas RPC.
- **CD-2**: PROHIBIDO modificar la sonda de WKH-364 (script o workflow) — esta HU sólo lee
  su credencial y, si aplica, su resultado publicado.
- **CD-3**: PROHIBIDO consultar `caldz` — toda lectura de reputación va contra `bdwv`.
- **CD-4**: OBLIGATORIO que "sin dato" sea un estado visualmente distinto en las tres
  tarjetas, y que un estado sano (verde/PASS) sea inalcanzable por ausencia de respuesta —
  mismo principio que la escalera de la sonda (`227-sonda-del-money-path/auto-blindaje.md`,
  "El DEFAULT de una escalera de monitoreo era PASS").
- **CD-5**: PROHIBIDO exponer `key_id`, `key_id_hash` o cualquier identificador crudo de la
  credencial de la sonda en el HTML o el JSON — sólo los agregados de saldo.
- **CD-6**: OBLIGATORIO gatear el API nuevo con el patrón fail-closed de
  `requireAdminTokenForTrace` (dashboard.ts:314-331) — NUNCA el opt-in `requireAdminToken`
  (ese es grandfathered de WKH-54 para endpoints viejos; éste es nuevo).

## Missing Inputs

- **[BLOQUEANTE — founder]** `A2A_PROBE_KEY` (o una key de sólo-lectura equivalente) debe
  existir como env var del PROCESO del gateway en Railway, no sólo como repo secret de
  GitHub Actions. Sin esto, AC-1 no tiene con qué llamar a `/auth/me`. No bloquea F2-F2.5,
  bloquea el DONE (mismo patrón que el fondeo de WKH-364).
- **[NEEDS CLARIFICATION — Architect en F2]** Identificador del programa de escrow en
  Solana devnet y el layout de su cuenta, para poder filtrar "vivo" vs "cerrado/refunded"
  vía `getProgramAccounts`. No localizado en este F1 dentro de `src/adapters/solana/*`.
- **[resuelto en F2]** Si `requireAdminTokenForTrace` alcanza tal cual, o si el saldo de
  la sonda amerita un segundo secreto dedicado (patrón `RECONCILIATION_RELEASE_TOKEN`) —
  el Architect decide con el criterio de "quién ya tiene el token del panel hoy".
- **[resuelto en F2]** TTL exacto de la cache server-side (propuesto 60s en DT-2) y si el
  tablero es una sola respuesta con las tres tarjetas o tres endpoints independientes.

## Análisis de paralelismo

No bloquea ni es bloqueado por WKH-364 (ya en `main`, sólo se lee su credencial/patrón).
Toca `src/routes/dashboard.ts` (archivo compartido con endpoints de reconciliación/arbitraje
ya existentes) y `src/services/reputation.ts` (sólo lectura, sin tocarlo) — cualquier HU en
paralelo que también edite `dashboard.ts` tiene riesgo de conflicto de merge, ninguno de
lógica. No depende de WKH-225 (paso suspendible) ni de WKH-335 (status estructurado).

---

⚠️ **Nota de proceso para el orquestador**: este agente no tiene herramienta de edición
parcial (`Edit`) ni shell, y `doc/sdd/_INDEX.md` excede el presupuesto seguro de un
`Write` completo (~100k tokens, líneas de una sola fila con miles de caracteres). Insertar
la fila `228` ahí queda pendiente de quien tenga `Edit` disponible. Fila propuesta, lista
para pegar después de la fila `227` (línea 219 del índice al momento de este F1):

```
| 228 | 2026-08-26 | [WKH-365] Tablero de las tres preguntas (issue #179): saldo de la key de la sonda de WKH-364, reputación por agente (`a2a_events`/bdwv), y plata trabada en escrows de Solana devnet — las tres fuentes son gratis y de solo lectura, nunca cotiza. | feature/observabilidad | QUALITY | in progress (F1 escrito — esperando `HU_APPROVED`) | feat/228-tablero-tres-preguntas ([work-item.md](228-tablero-tres-preguntas/work-item.md)) |
```
