# Re-engineering Plan — wasiai-v2 → delegate to wasiai-a2a + wasiai-facilitator

**Status**: DRAFT — pending human GO
**Author**: orquestador NexusAgil + audit Explore agent
**Fecha**: 2026-04-28
**Decisor**: Fernando

---

## TL;DR (3 líneas)

1. wasiai-v2 hoy duplica **~1,727 LOC** de orchestration que ya vive en wasiai-a2a (compose, orchestrate, x402 envelope build, agent-discovery, step-transform, scope-check). Eso es lo que hay que vaciar.
2. Estrategia: **proxy thin** — `/api/v1/compose` y `/api/v1/orchestrate` en v2 se vuelven proxies HTTP a `wasiai-a2a-production.up.railway.app`. El marketplace (agents/, contracts/, payments/, settlement/, admin/, creator/) se queda intacto en v2.
3. Producción tocada en 4 puntos: (a) Vercel project `wasiai-prod` (todos los aliases `app.wasiai.io` + `wasiai-v2` + `wasiai-prod`), (b) prod DB `caldzjhjgctpgodldqav` (12 migrations a aplicar, idempotentes), (c) Railway prod env (1 var nueva: `WASIAI_V2_FORWARD_KEY`), (d) wasiai-facilitator URL canonical fijada en v2 env.

**Riesgo principal**: `app.wasiai.io` sirve UI + API juntas en mismo Next.js project → no podemos hacer canary easy. Mitigación: feature flag `V2_DELEGATE_TO_A2A=false` por default, encender per-endpoint, observar 24h, rollback con un toggle.

---

## §1 Estado actual (verificable)

### §1.1 wasiai-v2 — qué tiene hoy

```
src/app/api/v1/
├── compose/route.ts            954 LOC ⚠ DUPLICATED
├── orchestrate/route.ts        250 LOC ⚠ DUPLICATED
├── auth/agent-signup/          marketplace-only (KEEP)
├── creator/                    marketplace-only (KEEP)
├── escrow/                     marketplace-only (KEEP)
├── jobs/                       marketplace-only (KEEP)
├── mcp/                        client-facing (PROXY candidate)
├── models/[slug]/invoke        marketplace-specific (KEEP)
├── webhooks/                   marketplace-only (KEEP)
└── ...

src/lib/
├── agent-discovery.ts           76 LOC ⚠ DUPLICATED → DELETE
├── step-transform.ts            78 LOC ⚠ DUPLICATED → DELETE
├── scope-check.ts               20 LOC ⚠ DUPLICATED → DELETE
├── x402/buildRequirements.ts    66 LOC ⚠ DUPLICATED → DELETE
├── schema-validator.ts          76 LOC ⚠ DUPLICATED → DELETE
├── ratelimit.ts                207 LOC ⚠ PARTIAL (compose-specific delete; admin-specific keep)
├── settlement/                 marketplace-batch model — KEEP
├── payments/                   v2 batch settlement model — KEEP
├── agent-wallets/              KEEP (marketplace state)
├── contracts/                  KEEP (escrow/SettlementVault on-chain)
├── pricing/                    KEEP (LLM pricing for v2 chat — different from a2a llm/pricing)
├── webhooks/                   KEEP (marketplace creator notifs)
├── circuit-breaker/            KEEP (per-agent breaker, distinto a a2a facilitator CB)
├── chain.ts, env.ts, logger.ts, constants.ts → EXTRACT a wasiai-common (Phase B)
└── supabase/                   KEEP (v2 tables source-of-truth)
```

**Total deletable**: 523 LOC lib + ~600 LOC de las routes (compose route deja de hacer pricing+x402+settle+invoke en v2 y queda thin proxy ~150 LOC) = ~1,727 → ~1,030 deletable.

### §1.2 wasiai-a2a — qué cubre

```
endpoints servidos hoy (Railway prod, ya con cross-chain proven):
- POST /compose            ← canónico
- POST /orchestrate        ← canónico
- POST /discover           ← canónico
- POST /tasks              ← canónico
- /agent-card.json         ← discovery
- POST /registries (REST admin)

protocolos:
- x402 v2 inbound (PYUSD Kite via wasiai-facilitator, mode=x402)
- x402 downstream (USDC Fuji via wasiai-facilitator, EIP-3009)
- A2A JSON-RPC 2.0 (message/send, tasks/get, tasks/cancel)

dependencias prod:
- Supabase: bdwvrwzvsldephfibmuu (DEV) o caldzjhjgctpgodldqav (PROD)
- Railway: wasiai-a2a-production.up.railway.app
- wasiai-facilitator: wasiai-facilitator-production.up.railway.app
```

### §1.3 wasiai-facilitator — qué cubre

```
GET /supported  → ["eip155:2368" Kite, "eip155:43113" Fuji]
POST /verify    → x402 envelope canonical (NO Pieverse-style)
POST /settle    → onchain settle, retorna txHash
```

### §1.4 BD — divergencia

| Tabla | wasiai-v2 (caldzjhjgctpgodldqav) | wasiai-a2a (bdwvrwzvsldephfibmuu) |
|-------|----------------------------------|------------------------------------|
| **agents** | ✅ source of truth | — |
| **collections** | ✅ marketplace | — |
| **calls** | ✅ batch settlement model | — |
| **escrow_records** | ✅ on-chain SettlementVault | — |
| **agent_keys** (v2) | ✅ marketplace API keys | — |
| **a2a_agent_keys** | — | ✅ a2a-only keys con `owner_ref` |
| **a2a_events** | — | ✅ telemetry |
| **registries** | — | ✅ con `owner_ref` (post WKH-63) |
| **kite_schema_transforms** | — | ✅ HMAC-signed cache |
| **schema_hash** | — | ✅ |
| **identities** | (parcial) | ✅ canonical |
| **tasks** | — | ✅ a2a JSON-RPC tasks |

**Conclusión**: NO collisiones. v2 y a2a tienen tablas con prefijos distintos (`agents` vs `a2a_*`). La migración consiste en aplicar **12 migrations de a2a** sobre la BD prod **`caldzjhjgctpgodldqav`** sin tocar las tablas de v2.

---

## §2 Decisión arquitectónica

### §2.1 Modelo elegido: **THIN PROXY**

```
┌─────────────────────────────────────────────────────────┐
│ app.wasiai.io (Vercel project: wasiai-prod)             │
│  ├── UI Next.js (KEEP)                                  │
│  ├── /api/v1/compose      → PROXY → wasiai-a2a /compose│
│  ├── /api/v1/orchestrate  → PROXY → wasiai-a2a         │
│  ├── /api/v1/agents/*     → KEEP (marketplace)          │
│  ├── /api/v1/escrow/*     → KEEP (marketplace)          │
│  ├── /api/v1/creator/*    → KEEP (marketplace)          │
│  └── /api/v1/admin/*      → KEEP (admin)                │
└─────────────────────────────────────────────────────────┘
              ↓ HTTPS internal call con WASIAI_V2_FORWARD_KEY
┌─────────────────────────────────────────────────────────┐
│ wasiai-a2a-production.up.railway.app                    │
│  ├── /compose, /orchestrate, /discover (CANONICAL)      │
│  └── delega settle a wasiai-facilitator                 │
└─────────────────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────────────┐
│ wasiai-facilitator-production.up.railway.app            │
│  └── /verify, /settle, /supported                       │
└─────────────────────────────────────────────────────────┘
```

**Por qué proxy y no redirect 308**:
- El cliente ya espera `app.wasiai.io/api/v1/compose` — un 308 cambia la URL en el browser address bar (mal UX para clientes server-side que no sigan redirects).
- Proxy permite shaping del request (rewrite headers, normalizar `x-a2a-key`, agregar tracing).
- Proxy permite **feature flag** (per-endpoint kill switch).

### §2.2 Qué se elimina vs proxy vs queda

| v2 endpoint | Acción | Justificación |
|-------------|--------|---------------|
| `POST /api/v1/compose` | **PROXY** a a2a `/compose` | 954 LOC duplicados con bugs ya fixed en a2a |
| `POST /api/v1/orchestrate` | **PROXY** a a2a `/orchestrate` | 250 LOC, LLM planner ya canónico en a2a |
| `GET  /api/v1/capabilities` | **PROXY** a a2a `/discover` | discovery canónico vive en a2a |
| `GET  /api/v1/mcp` | **PROXY** a a2a (ruta MCP) | spec MCP canónica en a2a |
| `POST /api/v1/models/[slug]/invoke` | **KEEP** | marketplace-specific: LLM bridge con pricing v2 |
| `POST /api/v1/auth/agent-signup` | **KEEP** | onboarding agent → marketplace-specific |
| `GET  /api/v1/creator/agents` | **KEEP** | dashboard creador |
| `POST /api/v1/escrow/*` | **KEEP** | SettlementVault on-chain (v2-only) |
| `POST /api/v1/jobs/*` | **KEEP** | Inngest worker queue |
| `POST /api/v1/payments/check-allowance` | **KEEP** | v2 batch payments |
| `POST /api/v1/sandbox/*` | **KEEP** | demo onboarding sin pago |
| `GET  /api/v1/me/key-balance` | **KEEP** | v2 agent_keys table |
| `POST /api/v1/webhooks/*` | **KEEP** | creator notifs |
| `POST /api/v1/admin/*` | **KEEP** | admin marketplace (~12 endpoints) |
| `POST /api/v1/onboard/*` | **KEEP** | wizard onboarding |
| `POST /api/v1/calls/[id]/dispute` | **KEEP** | dispute resolution v2 |
| `POST /api/v1/internal/escrow/release-expired` | **KEEP** | cron interno v2 |

### §2.3 Lib code a eliminar — REVISADO post-audit (2026-04-28)

| Archivo | LOC | Acción | Razón |
|---------|-----|--------|-------|
| `src/lib/agent-discovery.ts` | 76 | **DELETE** | Solo importado por compose route |
| `src/lib/step-transform.ts` | 78 | **DELETE** | Solo importado por compose route + 1 test |
| `src/lib/scope-check.ts` | 20 | **KEEP** ⚠️ | Importado por `models/[slug]/invoke` (marketplace LLM) |
| `src/lib/x402/buildRequirements.ts` | 66 | **KEEP** ⚠️ | Importado por `models/[slug]/invoke` + `agents/[slug]/introspect` |
| `src/lib/schema-validator.ts` | 76 | **KEEP** ⚠️ | Importado por 5 rutas marketplace: agents/register, creator/agents/[slug], sandbox/invoke, onboard/step, agents/[slug] |
| `src/lib/ratelimit.ts` (parcial) | ~24 LOC compose-specific | **DELETE PARCIAL** | Borrar solo `getComposeLimit()`. KEEP `getKeysLimit`, `getUploadLimit`, etc. |

**Total deletable real (lib)**: ~178 LOC (no 366 como dije al principio).
**Total deletable routes**: ~1,128 LOC (954 compose - 43 thin proxy + 250 orchestrate - 33 thin proxy).
**Total deletable**: **~1,306 LOC** (vs original estimate 1,066 — más alto por las routes).

> Audit completo en memoria engram (`WKH-66 audit findings`). Findings críticos: scope-check + schema-validator + x402/buildRequirements son **dual-use** (compose + marketplace), no se pueden borrar sin romper marketplace. Se quedan en v2 hasta Phase B (extracción a `wasiai-common`).

### §2.4 Phase B (opcional, post-MVP) — `wasiai-common` package

Extraer a un paquete npm publicado privadamente (o git submodule):
- `logger.ts` (pino factory)
- `env.ts` (validación)
- `chain.ts` (eip155:N normalization)
- `constants.ts`
- `supabase/client.ts` (factory)
- `security/url-validator.ts` (SSRF guard)

**Recomendación**: posponer Phase B. Hoy no bloquea producción. Hacerlo cuando v2 + a2a tengan ≥3 fixes paralelos en mismo módulo (señal de drift).

---

## §3 Plan de ejecución por fases

### Fase 0 — Pre-flight (NO TOCA PROD)

**Objetivo**: validar que el plan corre en clean state.

- [ ] **0.1** Crear branch `feat/realignment-v2-proxy` en `wasiai-v2`.
- [ ] **0.2** Verificar prod DB `caldzjhjgctpgodldqav` actual: ¿qué migrations a2a faltan?
  ```bash
  # Listar las migrations a2a
  ls /home/ferdev/.openclaw/workspace/wasiai-a2a/supabase/migrations/
  # Conectar a prod (read-only) vía Management API y diff
  ```
- [ ] **0.3** Snapshot config Vercel `wasiai-prod` actual:
  ```bash
  vercel env ls --environment=production --project=wasiai-prod
  ```
- [ ] **0.4** Validar que wasiai-a2a Railway expone los 4 endpoints públicamente (`/compose`, `/orchestrate`, `/discover`, `/agent-card.json`) — ya verificado en CROSS-CHAIN-E2E-PROVEN-2026-04-28.md.

**Gate**: ✅ todos los checkpoints verdes → pasar a Fase 1.

---

### Fase 1 — DB migration prod (TOCA PROD, REVERSIBLE)

**Objetivo**: aplicar 12 migrations de a2a sobre prod DB sin colisión con tablas v2.

#### 1.1 Diff de migrations a aplicar

Migrations en `wasiai-a2a/supabase/migrations/` que no están en prod (a verificar con Management API):

```sql
-- Las que sé que existen (verificar en Fase 0.2):
20260101_initial_a2a_schema.sql
20260201_add_a2a_agent_keys.sql
20260301_kite_schema_transforms.sql
20260401_kite_schema_transforms_hmac.sql
20260420_registries_owner_ref.sql       (WKH-63)
20260421_a2a_agent_keys_owner_ref.sql   (WKH-53)
20260422_schema_hash_table.sql
20260425_rpc_search_path_security.sql   (post AR)
... y todas las que existan al momento del corte
```

#### 1.2 Estrategia de aplicación

```bash
# Backup ANTES de migrar (mandatory)
SUPABASE_ACCESS_TOKEN=$PROD_PAT npx supabase db dump \
  --project-ref caldzjhjgctpgodldqav \
  --schema public \
  > backups/prod-pre-realignment-$(date -I).sql

# Aplicar migrations en TRANSACTION envuelta (BEGIN; ... COMMIT;)
SUPABASE_ACCESS_TOKEN=$PROD_PAT npx supabase db push \
  --project-ref caldzjhjgctpgodldqav \
  --include-all
```

**Salvaguardas**:
- Cada migration ya está envuelta en `BEGIN; ... COMMIT;` (verificable con grep).
- Cada migration es idempotente (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`).
- Tablas a2a llevan prefijo `a2a_*` o nombres exclusivos (`registries`, `kite_schema_transforms`) que **no existen en v2** (verificar con `\dt` antes).

**Rollback path**: el dump pre-migration permite `psql < backups/...sql` con `DROP TABLE` previo de las nuevas tablas.

#### 1.3 Test post-migration

```bash
# Smoke contra prod a2a apuntando a prod DB
DATABASE_URL=$PROD_DB_URL node scripts/smoke-e2e-cross-chain.mjs
# Esperado: misma performance que dev (p50 ~27s, 4 txs onchain)
```

**Gate Fase 1**: ✅ smoke OK + 0 regresiones en v2 endpoints existentes (run `curl` contra los 5 más importantes).

---

### Fase 2 — wasiai-a2a deploy update (TOCA PROD a2a, NO TOCA v2 todavía)

**Objetivo**: garantizar que a2a está al 100% antes de que v2 empiece a delegar.

#### 2.1 Cambios necesarios en a2a

- [ ] **2.1** Agregar middleware `requireForwardKey` (auth para llamadas internas v2 → a2a):
  ```ts
  // src/middleware/forward-key.ts
  export async function requireForwardKey(req, reply) {
    const key = req.headers['x-wasiai-forward-key'];
    if (!key || !timingSafeEqual(key, env.WASIAI_V2_FORWARD_KEY)) {
      return reply.status(401).send({error: 'INVALID_FORWARD_KEY'});
    }
  }
  ```
  Aplicar en `/compose`, `/orchestrate` (en paralelo a `requirePaymentOrA2AKey`).
- [ ] **2.2** Agregar header tracing `x-wasiai-source: v2-proxy` para distinguir tráfico v2 vs externo en logs.
- [ ] **2.3** Bumpear `TIMEOUT_COMPOSE_MS` a 180s (proxy adds ~5s overhead p50).
- [ ] **2.4** Configurar Railway env nuevo:
  ```
  WASIAI_V2_FORWARD_KEY=<32-byte random hex>
  ```

#### 2.2 Pipeline NexusAgil para este cambio

Pipeline FAST+AR (toca auth surface):

```
F1 Analyst → work-item con ACs EARS para auth bidireccional v2↔a2a
F3 Dev     → impl middleware + tests
AR + CR paralelo → especial foco timing-safe + replay attack
F4 QA      → evidencia archivo:línea
DONE       → push + PR a a2a main
```

**Gate Fase 2**: ✅ a2a deployment Railway green + smoke E2E proven con `x-wasiai-forward-key` header.

---

### Fase 3 — wasiai-v2 refactor (TOCA v2 EN BRANCH, NO PROD)

**Objetivo**: implementar proxy thin + delete duplicates en branch isolated.

#### 3.1 Branch + estructura

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-v2
git checkout -b feat/realignment-v2-proxy
```

#### 3.2 Wave 1 — proxy compose

```ts
// src/app/api/v1/compose/route.ts (NUEVO contenido — ~120 LOC, era 954)
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';

const A2A_URL = env.WASIAI_A2A_URL ?? 'https://wasiai-a2a-production.up.railway.app';
const FORWARD_KEY = env.WASIAI_V2_FORWARD_KEY;

export async function POST(req: NextRequest) {
  // 1. Forward feature flag check
  if (env.V2_DELEGATE_TO_A2A !== 'true') {
    return NextResponse.json({error: 'FEATURE_DISABLED', detail: 'compose delegation off'}, {status: 503});
  }

  // 2. Forward request as-is
  const body = await req.text();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-wasiai-forward-key': FORWARD_KEY,
    'x-wasiai-source': 'v2-proxy',
  };
  // Pass-through caller headers
  for (const h of ['x-payment', 'payment-signature', 'x-a2a-key', 'authorization']) {
    const v = req.headers.get(h);
    if (v) headers[h] = v;
  }

  // 3. Proxy with timeout
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 180_000);
  try {
    const upstream = await fetch(`${A2A_URL}/compose`, {
      method: 'POST',
      headers,
      body,
      signal: ac.signal,
    });
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: {'content-type': upstream.headers.get('content-type') ?? 'application/json'},
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      return NextResponse.json({error: 'UPSTREAM_TIMEOUT'}, {status: 504});
    }
    return NextResponse.json({error: 'UPSTREAM_ERROR', detail: e.message}, {status: 502});
  } finally {
    clearTimeout(timer);
  }
}
```

#### 3.3 Wave 2 — proxy orchestrate (mismo patrón)

#### 3.4 Wave 3 — proxy capabilities + mcp (mismo patrón, GET)

#### 3.5 Wave 4 — DELETE duplicates (REVISADO post-audit)

```bash
cd src/lib
rm agent-discovery.ts step-transform.ts
# NOT delete: scope-check.ts (used by models/[slug]/invoke)
# NOT delete: schema-validator.ts (used by 5 marketplace routes)
# NOT delete: x402/buildRequirements.ts (used by models invoke + agents introspect)
```

Update import roto en compose tests (`pipeline-v2.test.ts`). Borrar también `getComposeLimit()` en ratelimit.ts manteniendo el resto del archivo.

#### 3.5.b Wave 4b — handle pipeline retry mode

`compose/route.ts` actualmente acepta `start_from_step` en body para retry mode (RPC `get_pipeline_for_retry` lee de v2 `pipeline_executions`). El proxy thin NO puede soportarlo porque la state vive en v2 BD, no en a2a. Decisión:

```ts
// proxy compose handler
if (body?.start_from_step !== undefined) {
  return NextResponse.json({
    error: 'RETRY_MODE_NOT_SUPPORTED',
    detail: 'pipeline retry not available in proxy mode'
  }, { status: 422 });
}
```

#### 3.5.c Wave 4c — receipt signatures breaking change

`compose/route.ts:605` firmaba receipts con `WASIAI_V2_KEYPAIR`. Ahora a2a firma con `WASIAI_A2A_KEYPAIR`. Clientes que validen signatures contra public key v2 verán mismatch. Documentar en CHANGELOG como breaking change. Mitigation: exponer `GET /api/v1/keys/public` con la public key de a2a (proxieada).

#### 3.6 Wave 5 — tests v2

- [ ] Unit tests del proxy (mock fetch a a2a, verificar header propagation).
- [ ] Integration test: fire `POST /api/v1/compose` con body real, mock a2a response 200, verificar passthrough.
- [ ] Integration test: a2a returns 402 → proxy returns 402 con misma estructura.
- [ ] Smoke test: `POST /api/v1/compose` con `V2_DELEGATE_TO_A2A=false` → 503 explicito.

**Gate Fase 3**: ✅ branch green en CI v2, todos los tests existentes (~300+) siguen pasando + nuevos tests del proxy.

---

### Fase 4 — Deploy v2 staging branch (TOCA Vercel preview, NO PROD)

**Objetivo**: validar el proxy en preview deployment Vercel antes de promote a main.

#### 4.1 Preview deployment

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-v2
git push origin feat/realignment-v2-proxy
# Vercel auto-genera URL preview, ej: wasiai-prod-feat-realignment-v2-proxy.vercel.app
```

#### 4.2 Tests en preview

- [ ] Smoke E2E real-tx contra preview URL: ejecutar los 4 scripts de a2a apuntando a preview proxy:
  ```bash
  A2A_URL=https://<preview>.vercel.app/api/v1 node scripts/smoke-e2e-cross-chain.mjs
  ```
  Esperado: 4 txs onchain (1 Kite + 3 Fuji), latencia +5-10s vs directo (overhead proxy).
- [ ] Test marketplace endpoints en preview (no deben haberse roto): `/api/v1/agents`, `/api/v1/creator/agents`, `/api/v1/escrow/[id]`.
- [ ] Test feature flag toggle: `V2_DELEGATE_TO_A2A=false` → 503; `=true` → 200.

#### 4.3 Validar que `app.wasiai.io` SIGUE EN MAIN sin cambios

(porque preview branch no afecta el alias de prod hasta el promote).

**Gate Fase 4**: ✅ todos los smokes verdes en preview + 0 regresiones marketplace.

---

### Fase 5 — Promote a producción (TOCA PROD)

**Objetivo**: merge a main → Vercel auto-deploys → `app.wasiai.io` activo con proxy.

#### 5.1 Pre-flight prod env Vercel

```bash
# Setear vars en Vercel project wasiai-prod (production environment)
vercel env add WASIAI_A2A_URL production
# valor: https://wasiai-a2a-production.up.railway.app

vercel env add WASIAI_V2_FORWARD_KEY production
# valor: el mismo que pusimos en Railway en Fase 2.4

vercel env add V2_DELEGATE_TO_A2A production
# valor: false  ← arrancamos OFF
```

#### 5.2 Merge

```bash
gh pr create --base main --title "feat(realignment): v2 delegates compose/orchestrate to wasiai-a2a"
# Gate humano: review + approve
gh pr merge <PR#> --squash
```

Vercel auto-deploys. `app.wasiai.io` ahora tiene proxy con flag OFF (compose/orchestrate retornan 503).

#### 5.3 Canary toggle

```bash
# 1. Encender solo /capabilities (read-only, riesgo bajo)
vercel env rm V2_DELEGATE_TO_A2A production
vercel env add V2_DELEGATE_TO_A2A production
# valor: capabilities-only
# (require code: parse comma-separated list of enabled endpoints)

# 2. Observar 1h: logs Vercel + Railway a2a
# 3. Encender compose
vercel env add V2_DELEGATE_TO_A2A production --value="capabilities,compose"

# 4. Observar 4h con tráfico real
# 5. Encender orchestrate
vercel env add V2_DELEGATE_TO_A2A production --value="capabilities,compose,orchestrate"
```

#### 5.4 Post-promote smoke prod (real-tx)

```bash
# Real txs contra prod app.wasiai.io
A2A_URL=https://app.wasiai.io/api/v1 node scripts/smoke-e2e-cross-chain.mjs
# Esperado: 4 txs onchain testnet, todo green
```

**Gate Fase 5**: ✅ canary 24h sin paging, p95 <40s (proxy overhead +9s aceptable), 0 errores 5xx attribuibles a proxy.

---

### Fase 6 — Cleanup post-prod (NO TOCA PROD)

- [ ] **6.1** Removar feature flag `V2_DELEGATE_TO_A2A` (forzar siempre on) — release v2 v1.x.
- [ ] **6.2** Borrar archivos lib duplicados (Wave 4 ya hizo esto en branch — confirmar que main quedó limpio).
- [ ] **6.3** Update `wasiai-v2/CLAUDE.md` documentando que compose/orchestrate viven en a2a.
- [ ] **6.4** Issue tracker: archivar tickets v2 que ya no apliquen (compose-related debt en backlog v2).
- [ ] **6.5** Schedule Phase B (`wasiai-common`) como SDD futuro si aparecen >2 fixes paralelos en chain.ts/env.ts/logger.ts en próximos 30 días.

---

## §4 Estrategia de testing

### §4.1 Unit tests (Wave 5, en branch)

**Cobertura mínima por proxy endpoint:**
- ✅ Forward header propagation (x-payment, x-a2a-key, authorization).
- ✅ Forward key inyección.
- ✅ Feature flag OFF → 503.
- ✅ Upstream timeout → 504 con cleanup `clearTimeout`.
- ✅ Upstream 402 → passthrough con body intacto.
- ✅ Upstream 500 → 502 con `UPSTREAM_ERROR`.
- ✅ AbortSignal cleanup en error paths.

**Framework**: vitest (ya en uso en v2). Mock con `msw` o `vi.spyOn(global, 'fetch')`.

### §4.2 Integration tests

**Stack mínimo:**
- v2 dev server local (`pnpm dev`) en :3000.
- a2a dev server local (`pnpm dev`) en :3001.
- Mock wasiai-facilitator local en :3002 (o usar real testnet).
- Mock Supabase con `@supabase/test-helpers` o usar dev DB `bdwvrwzvsldephfibmuu`.

**Casos:**
1. POST v2/api/v1/compose → 402 challenge → con header → 200 con tx hashes.
2. POST v2/api/v1/orchestrate → LLM planner → pipeline → 200.
3. GET v2/api/v1/capabilities → discovery → array agentes.
4. POST v2/api/v1/admin/agents → marketplace endpoint NO afectado, 200.
5. POST v2/api/v1/escrow/*  → marketplace endpoint NO afectado, 200.

### §4.3 Deep production tests (Fase 5)

**Real-tx tests con USDC limitado** (~$0.50 budget total para validation):

| Test | Path | Costo | Esperado |
|------|------|-------|----------|
| smoke-3-agents | v2 → a2a → fac → Kite + Fuji | $0.06 | 4 txs onchain |
| smoke-5-agents | v2 → a2a (cap) | $0.11 | 6 txs onchain |
| smoke-orchestrate | v2 → a2a LLM planner | $0.10 | LLM + 3 Fuji txs |
| perf-bench 5x | v2 → a2a 5 runs | $0.30 | p50<35s, p95<45s |

**Métricas alarming**:
- Latencia p95 > 50s → rollback canary.
- Error rate > 2% → rollback canary.
- Cualquier 5xx attribuible a proxy → rollback inmediato.

### §4.4 Rollback path

```bash
# Toggle flag off (instantáneo, sin redeploy)
vercel env rm V2_DELEGATE_TO_A2A production
# v2 vuelve a 503 en compose/orchestrate

# Si el branch ya hizo merge a main y eliminó código:
# Plan de contingencia: revertir el PR en GitHub
gh pr revert <PR#> --merge
# Vercel redeploya el código previo en ~3min
```

**Rollback DB** (si Fase 1 explota):
```bash
psql $PROD_DB_URL < backups/prod-pre-realignment-2026-04-28.sql
# pero antes drop de las tablas a2a nuevas
```

---

## §5 Riesgos y mitigaciones

| Riesgo | P | I | Mitigación |
|--------|---|---|------------|
| Proxy adds 5-10s latency p50 | Alta | Media | Bumpear TIMEOUT_COMPOSE_MS, monitorear p95, accept overhead |
| WASIAI_V2_FORWARD_KEY leak | Baja | Alta | timingSafeEqual + rotation manual cada 90 días + nunca log |
| Vercel preview ≠ prod env config | Media | Alta | Snapshot diff Fase 0.3, replicar en preview |
| BD migration colisión con tabla v2 | Baja | Crítica | Diff Fase 0.2, dump backup Fase 1.2 |
| Marketplace endpoint regression | Baja | Alta | Tests 4.2 case 4-5, smoke real Fase 4 |
| 308 redirects rompen clients sin follow | N/A | — | NO usamos 308, solo proxy interno |
| Cliente externo cachea ruta v2 | Baja | Baja | Proxy mantiene path v2, no cambia URL pública |
| Auth header `x-payment` no se propaga | Media | Alta | Test 4.1 explícito + canary 24h |

---

## §6 Cronograma estimado

| Fase | Esfuerzo | Bloqueante de | Notas |
|------|----------|---------------|-------|
| 0 — Pre-flight | 1h | 1, 2 | Diff DB + snapshot config |
| 1 — DB migration | 30min | 2 | Backup + apply + verify |
| 2 — a2a forward-key | 2h | 3 | Pipeline NexusAgil FAST+AR |
| 3 — v2 refactor | 4h | 4 | 5 waves, branch isolated |
| 4 — preview deploy | 1h | 5 | Smokes + integration |
| 5 — promote prod | 3h con canary | 6 | Toggle gradual + observación |
| 6 — cleanup | 1h | — | Remove flag + docs |
| **Total** | **~12h** | | Recomendado spread 2-3 días |

---

## §7 Gates humanos requeridos

Por CLAUDE.md security rules + auto-mode rule #5 (modificar prod):

1. ✅ **GATE 1 — Plan approval** (este documento). El humano dice "GO" o "STOP" antes de ejecutar Fase 0.
2. ✅ **GATE 2 — DB migration** (Fase 1.2). Antes de `supabase db push` contra prod.
3. ✅ **GATE 3 — a2a deploy con forward-key** (Fase 2 PR). Review + merge manual.
4. ✅ **GATE 4 — v2 PR merge** (Fase 5.2). Review + merge manual.
5. ✅ **GATE 5 — feature flag toggle to ON** (Fase 5.3). Cada step del canary.

**El orquestador NO ejecuta ninguno de estos gates en autonomía.** Cada uno es decisión humana explícita.

---

## §8 Outputs esperados

Al cierre de Fase 6:

- [ ] `app.wasiai.io/api/v1/compose` → proxy thin (~120 LOC) → wasiai-a2a (canónico, cross-chain proven).
- [ ] `app.wasiai.io/api/v1/orchestrate` → proxy thin → a2a LLM planner.
- [ ] ~1,066 LOC eliminados de wasiai-v2.
- [ ] Prod DB `caldzjhjgctpgodldqav` con 12 migrations a2a aplicadas, 0 colisiones.
- [ ] Marketplace endpoints intactos (agents, escrow, creator, admin, jobs, webhooks).
- [ ] Single source of truth para compose/orchestrate logic = wasiai-a2a.
- [ ] Tests: unit + integration + 4 smoke E2E real-tx en prod verificables on-chain.

---

## §9 Pendientes para decisión humana ANTES de empezar

Tres decisiones de diseño que el plan deja explícitamente abiertas:

### Q1 — Estrategia de canary
- (a) **Recomendado**: feature flag `V2_DELEGATE_TO_A2A=capabilities,compose,orchestrate` (comma-separated) con toggle gradual 1h/4h/24h.
- (b) Big-bang: toggle ON todo de una en Fase 5.

### Q2 — Eliminación lib en Wave 4
- (a) **Recomendado**: hard delete de los 5 archivos. Si TS rompe imports de marketplace endpoints, eso es señal de que el endpoint NO era marketplace-only. Revisar caso por caso.
- (b) Mover a `src/lib/_legacy/` por 30 días, borrar después.

### Q3 — Phase B `wasiai-common`
- (a) **Recomendado**: posponer. No hacer hoy.
- (b) Hacer ahora junto al refactor (suma ~6h).

### Q4 — Auth proxy
- (a) **Recomendado**: `WASIAI_V2_FORWARD_KEY` (shared secret) timingSafeEqual.
- (b) mTLS entre Vercel y Railway (más complejo, sin valor adicional para shared infra).

---

## §10 Referencias

- `CROSS-CHAIN-E2E-PROVEN-2026-04-28.md` — proof de que a2a + facilitator están listos.
- `doc/sdd/063-cross-chain-e2e-retro/` — retro del cross-chain.
- `wasiai-v2/CLAUDE.md` — convenciones v2.
- `wasiai-a2a/CLAUDE.md` — convenciones a2a.
- Recon report (no persistido — disponible vía Explore agent re-run).

---

**Estado**: ⏸ AWAITING HUMAN GO

**Próximo paso si GO**: Fase 0.1 — crear branch + Fase 0.2 diff DB migrations.

**Próximo paso si STOP**: archivar este doc en `doc/migration/_archive/` con razón.
