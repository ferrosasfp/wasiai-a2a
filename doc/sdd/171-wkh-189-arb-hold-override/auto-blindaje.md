# Auto-Blindaje — WKH-189 (Panel + endpoint de override de arb_hold)

Registro de errores cometidos durante F3 y su fix, para blindar futuras HUs.

### [2026-07-12 21:40] Wave 1 — Cast de embed PostgREST rechazado por tsc
- **Error**: `TS2352` en `listHolds`: `data as HoldIntentRow[]` — "Conversion of type 'GenericStringError[]' to type 'HoldIntentRow[]' may be a mistake".
- **Causa raíz**: cuando el `.select()` de supabase-js incluye un embed anidado (`a2a_arbitrations(...)`), el type-inferido del `data` no solapa lo suficiente con el shape manual, y el cast directo falla.
- **Fix**: doble cast `data as unknown as HoldIntentRow[] | null`.
- **Aplicar en**: cualquier query supabase con embed anidado (`from().select('col, other_table(...)')`) donde se tipa el resultado a mano. Usar `as unknown as T[]`.

### [2026-07-12 21:45] Wave 2 — Route generic en el handler, no en la llamada
- **Error**: `TS2345` en `fastify.post`: `request.params` era `unknown`, no `{ intentId: string }`.
- **Causa raíz**: tipar el generic en el parámetro del handler (`request: FastifyRequest<{ Params: ... }>`) NO informa a Fastify; el plugin infiere `RouteGenericInterface` vacío y choca.
- **Fix**: mover el generic a la llamada de ruta: `fastify.post<{ Params: { intentId: string } }>(...)` (mismo patrón que `fastify.get<{ Querystring: ... }>` en `dashboard.ts:150`).
- **Aplicar en**: toda ruta Fastify con Params/Querystring/Body tipados. El generic va en `.get<>()`/`.post<>()`, nunca en el tipo del `request`.

### [2026-07-12 21:53] Wave 0-2 — biome format sobre archivos nuevos
- **Error**: `biome check` marcó 3 archivos con formato no canónico (multi-línea de objetos de log, encadenado de ternario largo, split de expresión larga en test).
- **Causa raíz**: el código escrito a mano no coincidía byte-a-byte con el formatter de biome (line-width, wrapping de ternarios/objetos).
- **Fix**: `biome format --write` sobre los archivos tocados antes de cerrar cada wave (CD-12). No reescribir a mano.
- **Aplicar en**: correr `biome format --write` sobre cada archivo nuevo/tocado antes del `biome check` de cierre de wave.

### [2026-07-12 21:48] Wave 1 — Contradicción interna §6.4 vs T-7 sobre splitPct
- **Error**: §6.4 pide validar `splitPct ∈ [0,100] → INVALID_INPUT`, pero T-7 exige `splitPct>100 → clamp a deposit` (input aceptado). Directivas mutuamente excluyentes.
- **Causa raíz**: contradicción interna en el Story File entre la guía de implementación (§6.4) y el test requerido (T-7) + CD-9.
- **Fix**: resolví a favor de **CD-9** (Constraint Directive inviolable: "el único límite es el clamp [0, deposit]") y de T-7. `resolveHold` rechaza sólo input no-numérico (`undefined`/`NaN`/`Infinity`) para `split`; un `splitPct` fuera de `[0,100]` NO se rechaza — el clamp de `settleUsd` a `[0, deposit]` lo acota (money-safe, no crea plata). Documentado inline en `arbiter.ts`.
- **Aplicar en**: ante conflicto Story-interno, gana la Constraint Directive (§4) sobre la prosa de implementación (§6). Reportar la desviación al orquestador.

### [2026-07-12 22:05] FIX-PACK (post AR+CR) — resolución del conflicto §6.4/T-7 revertida
- **Error**: la resolución previa (clamp silencioso de `splitPct>100`) dejaba un footgun money-path de admin: un `splitPct=500` por typo via API directa (sin el panel) libera el 100% del depósito al seller en silencio. AR+CR lo marcaron MENOR; el founder pidió cerrarlo por ser money-path admin.
- **Causa raíz**: se interpretó que CD-9 gobernaba el rango de `splitPct`. CD-9 gobierna SÓLO el auto-cap (`getArbiterAutoCapUsd()`), no el rango de entrada. La autoridad correcta del rango `[0,100]` es T-7/AC-7 (§6.4). El clamp `[0,deposit]` de `settleUsd` es defensa en profundidad, no validación primaria.
- **Fix**: en `resolveHold` (arbiter.ts), para `decision='split'` se valida ahora `splitPct` finito y ∈ `[0,100]` inclusive; fuera de rango o no-numérico → `ArbiterError('INVALID_INPUT')` ANTES de tocar fondos. El clamp de `settleUsd` se mantiene como 2da baranda. Comentario corregido: cita T-7/AC-7, no CD-9. T-7 ajustado (`splitPct>100`/`<0` → INVALID_INPUT sin mover fondos; borde 0/100 válido; clamp de `settleUsd` sigue confirmado). Panel: botones de la fila se deshabilitan durante el POST in-flight (anti doble-submit).
- **Aplicar en**: validar RANGO de inputs de admin ANTES del clamp money-path; el clamp es defensa en profundidad, no la primera baranda. Al citar autoridad en comentarios, distinguir auto-cap (CD-9) de rango de input (T-7/AC-7). Deshabilitar botones que mueven fondos mientras el request está en vuelo.
