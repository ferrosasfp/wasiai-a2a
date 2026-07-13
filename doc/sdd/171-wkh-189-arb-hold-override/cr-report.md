# CR Report — WKH-189 · Override admin de `arb_hold` (Adversary / Code Review de calidad)

> Fase: CR (calidad/patrones). Reviewer: nexus-adversary.
> Fecha: 2026-07-12. Branch de trabajo: cambios sin commitear sobre `main`.
> Input: `sdd.md` + `story-HU-189.md` + `git diff`.
> Gates ejecutados: `tsc --noEmit` OK · suite completa **2849 passed / 10 skipped / 0 failed** (161 files) · `biome check` OK en los 5 archivos TS tocados.

## Veredicto global: APROBADO con 1 MENOR

Cero BLOQUEANTES. La HU es fiel al SDD/Story File en lo sustancial: la migración
preserva el money-path byte-idéntico (solo ensancha el predicado), `resolveHold`
reusa el seam (`executeArbitration`) sin clonar money-path, las rutas siguen el
patrón de `dashboard.ts` y el panel el de `dashboard.html`. Los 21 tests nuevos
(T-1..T-11) son significativos, no tautológicos. Un único MENOR de calidad
(defensa de money-path por typo de admin en `splitPct` vía API directa).

---

## 1. Fidelidad al SDD / Story File — OK

- **Migración** (`supabase/migrations/20260712000000_wkh189_arb_hold_override.sql`):
  RPC `close_payment_intent_for_arbitration` con las ramas de dinero
  byte-idénticas al original WKH-139 (clamp `GREATEST(0, LEAST(v_auth, COALESCE(p_arb_amount,0)))`
  L77, `UPDATE ... SET status='arb_closing'` L84-85, rama recovery `arb_closing`
  L87-89). Único cambio: predicado `IF v_status IN ('disputed','arb_hold')` (L81).
  `SECURITY DEFINER` (L107) con `SET search_path = public, pg_temp` (L110) + `REVOKE`
  a PUBLIC/anon/authenticated + `GRANT` solo `service_role` (L111-113). CHECK
  ensanchado (`admin_override`) y 3 columnas nullable additive. Down reversible.
  **Fiel.**
- **`resolveHold`** (`src/services/arbiter.ts:904-1008`): reusa
  `executeArbitration` (CD-1, L1007), sin cap (CD-9, no llama `getArbiterAutoCapUsd()`),
  testnet-guard fail-closed (AC-6, L957-959), `owner_ref` del row real (CD-4, L961),
  `allowStaleRecovery=false` por default (CD-10, no pasa el 5º arg), sin `UPDATE` de
  status en app (CD-3). Firma = la diseñada. **Fiel.**
- **`listHolds`** (`arbiter.ts:879-895`): cross-tenant deliberado, documentado como
  alto privilegio (CD-5, comentario L871-878). Shape `AdminHoldItem` = el del SDD.
- **2 rutas** (`dashboard.ts:176-250`) y **panel** (`dashboard.html:129-141,282-395`):
  como el Story File.
- **Desviación reportada por el dev (splitPct)**: la resolución (clamp en vez de
  rechazo) es **money-safe** y **la exige T-7** (el propio test del Story File).
  Ver MNR-1: correcta en el resultado, débilmente citada (CD-9 gobierna el auto-cap,
  no el rango de `splitPct`; el driver real es T-7). No bloquea.

## 2. Calidad de los 21 tests (T-1..T-11) — OK

- **No tautológicos.** T-2 verifica el money-path real (settle al seller, `residual=0`,
  recibo `arbitration_release`, `db.row.status==='settled'`). T-3 verifica el upsert
  con `method='admin_override'` + auditoría **preservando** `ambiguity_reason`/`llm_reasoning`
  del hold original (arbiter.test.ts:977-986). T-4 cubre inexistente→404 y no-hold→409
  con **cero** settle. T-6 mainnet→`CHAIN_NOT_SUPPORTED` sin mover fondos. T-8
  (idempotencia) wirea el RPC a la rama recovery `arb_closing`+`settle_outcome=NULL`
  y prueba **no-op in-flight** (`mockSettle` no llamado, refunds vacíos) — re-ejercita
  el guard real de `applyRecovery` (arbiter.ts:662). T-10(a) es un grep anti-substring
  sobre `payment-intent.ts` que blinda CD-8 (arb_hold nunca barrido); T-10(b) fuerza
  `recoverArbClosing` sobre un `arb_hold` y prueba que el guard `prev_status!=='arb_closing'`
  corta antes del refund. T-6 clamp: `splitPct=150→settleUsd=deposit`, `residual=0`.
- **"Doble faithfulness"**: el DB in-memory (arbiter.test.ts:~206) replica el predicado
  ensanchado (`status==='disputed' || status==='arb_hold'`) y el mismo clamp
  `Math.max(0, Math.min(authorized_usd, p_arb_amount))` del RPC real. Fiel.
- **T-11** cuenta sentencias completas (`.split(...).length-1`), no substrings, up y down.

## 3. Legibilidad / mantenibilidad — OK

- Nombres claros (`toAdminHoldItem`, `HoldIntentRow`, `HoldArbEmbed`, `sendArbiterAdminError`).
- Sin dead code. Comentarios trazan CD-N/AC-N. Sin magic numbers sueltos
  (`/1_000_000` es la convención micro del módulo).
- Mapper `sendArbiterAdminError` (dashboard.ts:28-49): espejo local de `payments.ts`
  sin importar el privado. Correcto.
- Panel: `esc()` en todo dato de servidor en contexto texto; `token` en `localStorage`
  (mandado por §8.2); no se agrega a `refreshAll()`; `confirm()` antes de mover fondos.

## 4. Manejo de errores — OK

- Rutas disclosure-safe: nunca exponen el mensaje crudo; loguean `detail`/`errorClass`
  a `request.log.error`. `INTERNAL` cae al default→500 `ARBITER_FAILED` (no filtra).
- Fail-closed: testnet-guard lanza antes de tocar fondos; `INVALID_INPUT` para
  `decision`/`splitPct` no-numérico; flag OFF→404 byte-idéntico ANTES de cualquier
  lógica (dashboard.ts:180-182, 206-208).
- `upsertArbitrationRow` best-effort (no aborta el money-path) — consistente con WKH-139.

## 5. Consistencia — OK

- `resolveHold` sigue el estilo de `executeArbitration`/`openDispute` (read money-free,
  guard app-layer, delega al RPC). Rutas siguen `{ config:{rateLimit:false},
  preHandler: requireAdminToken }` como las existentes. Panel sigue el estilo Pico
  (`section-title` + `div id`). Convención `T | null` explícito respetada.

## 6. Seguridad app-layer — OK

- **XSS**: `esc()` (dashboard.html:151-156) neutraliza `<>&` en contexto texto (TD).
  El único dato que entra a contexto atributo/JS-string (`onclick`) es `h.intentId`,
  que es un UUID de columna `uuid` (no atacante-controlable). `esc()` no escapa
  comillas, pero como solo fluyen UUIDs/enums/números, no hay superficie práctica.
  Observación de hardening, no finding.
- **Admin token**: `requireAdminToken` (timingSafeEqual, fail-closed prod). El GET es
  cross-tenant pero solo tras el token (CD-5, documentado). `localStorage` es tradeoff
  conocido y spec-mandado.
- **Migración RPC**: `SECURITY DEFINER` + `search_path` fijado + GRANT restringido a
  `service_role`. Sin SQL dinámico. Sin hijacking.

---

## Hallazgos

### MNR-1 — `splitPct` fuera de [0,100] no se rechaza en el servicio (clamp silencioso)
- **Categoría**: Data Integrity / Type Safety (money-path UX rail).
- **Archivo:línea**: `src/services/arbiter.ts:921-930` (validación) + `:982-989` (clamp).
- **Descripción**: §6.4 del SDD pedía rechazar `splitPct` fuera de `[0,100]` con
  `INVALID_INPUT`; T-7 pide **clampear** (`splitPct>100 → deposit`). El dev resolvió
  hacia T-7 (money-safe: clamp app-layer + re-clamp del RPC ⇒ nunca crea plata).
  El comentario (L921-924) cita CD-9 como autoridad, pero CD-9 gobierna el auto-cap,
  no el rango de `splitPct`; el driver real y correcto es **T-7**.
- **Reproducción**: `POST /dashboard/api/arbitrations/:id/resolve` con
  `{decision:'split', splitPct:500}` (llamada API directa, sin pasar por el panel) →
  `settleUsd` se clampa a `deposit` → **se libera el 100% del depósito al seller** en
  lugar de un parcial. El panel lo previene (dashboard.html:359 valida `>100`), pero un
  caller admin directo lo evita.
- **Impacto**: un typo de admin (`500` por `50`) via API sobre-libera al seller de
  forma silenciosa. No hay creación de dinero ni escalada (el admin ya puede liberar
  100% deliberadamente con `release`), y AC-7 se cumple; por eso es MENOR, no bloqueante.
- **Sugerencia**: rechazar `splitPct` fuera de `[0,100]` en `resolveHold` con
  `INVALID_INPUT` (restaura la intención de §6.4; ajustar T-7 para el caso `>100`→422),
  o dejar explícito en el comentario que el sobre-rango = liberación total intencional.
  No lo corrijas vos — es decisión del Dev en el fix-pack.

---

## Categorías sin hallazgos (revisadas)

| Check CR | Resultado |
|---|---|
| Fidelidad SDD/Story File | OK |
| Calidad de tests (T-1..T-11) | OK — significativos, no tautológicos |
| Legibilidad/mantenibilidad | OK |
| Manejo de errores | OK — disclosure-safe, fail-closed |
| Consistencia de patrones | OK |
| Seguridad app-layer (XSS/token/RPC) | OK |

## Gates
- `npx tsc --noEmit`: **verde**.
- `vitest run`: **2849 passed / 10 skipped / 0 failed** (161 files).
- `biome check` (5 archivos TS tocados): **verde**.
