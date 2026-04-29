# RUNBOOK — Ejecución Prod Migration

**Para**: Fernando (gates humanos)
**Estado del trabajo autónomo (Claude)**: a2a code DONE (PR #55), v2 code en flight, todo lo prod-touching consolidado abajo
**Fecha**: 2026-04-28

Cada paso es idempotente, con rollback documentado. Ejecutá cuando estés listo.

---

## ⚡ Path rápido (TL;DR — ~25min total)

```bash
# 1. Mergear PR a2a #55 (Vercel/Railway auto-deploya a2a)
gh pr merge 55 --squash --delete-branch

# 2. Generar forward-key + setear en Railway prod (a2a service)
FORWARD_KEY=$(openssl rand -hex 32)
echo "FORWARD KEY: $FORWARD_KEY  ← guardá esto, lo usás también en step 5"
railway variables --service wasiai-a2a-production set WASIAI_V2_FORWARD_KEY="$FORWARD_KEY"

# 3. DB migration prod caldzjhjgctpgodldqav (backup + apply)
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
./scripts/migrate-prod-db.sh apply  # ← lo creo abajo

# 4. Mergear PR v2 #N (cuando WKH-66 esté listo, Vercel auto-deploya)
gh pr merge <PR#> --squash --delete-branch

# 5. Setear vars en Vercel project wasiai-prod (production env)
vercel env add WASIAI_A2A_BASE_URL production <<< "https://wasiai-a2a-production.up.railway.app"
vercel env add WASIAI_V2_FORWARD_KEY production <<< "$FORWARD_KEY"
vercel env add V2_DELEGATE_TO_A2A production <<< ""  # arranca vacío = OFF para todos los endpoints
vercel --prod  # redeploy con vars nuevas

# 6. Canary toggle gradual (1h cada paso, monitorear)
vercel env rm V2_DELEGATE_TO_A2A production
vercel env add V2_DELEGATE_TO_A2A production <<< "capabilities"
vercel --prod
# observar 1h logs Vercel + Railway, errores < 0.1%

vercel env rm V2_DELEGATE_TO_A2A production
vercel env add V2_DELEGATE_TO_A2A production <<< "capabilities,compose"
vercel --prod
# observar 4h, latencia p95 < 45s

vercel env rm V2_DELEGATE_TO_A2A production
vercel env add V2_DELEGATE_TO_A2A production <<< "capabilities,compose,orchestrate"
vercel --prod
# observar 24h

# 7. Smoke real-tx contra app.wasiai.io
A2A_URL=https://app.wasiai.io/api/v1 node scripts/smoke-e2e-cross-chain.mjs
A2A_URL=https://app.wasiai.io/api/v1 node scripts/smoke-orchestrate-cross-chain.mjs
```

**Rollback express** (si algo rompe en cualquier momento):

```bash
# Disable delegation instantáneo (sin redeploy)
vercel env rm V2_DELEGATE_TO_A2A production
# (Vercel propaga el cambio de env en ~30s al edge)
```

---

## §1 Gate 1 — Merge PR a2a #55

**Qué hace**: Activa el middleware `requireForwardKey` en wasiai-a2a Railway prod. Hasta que hagas el merge, la branch `feat/064-wkh-65-a2a-forward-key` solo tiene el código en GitHub, no está en prod.

**Precondiciones**:
- ✅ PR #55 en GitHub (https://github.com/ferrosasfp/wasiai-a2a/pull/55)
- ✅ 621/621 tests passing
- ✅ AR + CR + QA APROBADO

**Comando**:
```bash
gh pr merge 55 --squash --delete-branch
```

**Efecto en prod**: Railway auto-deploys con el nuevo código. Como `WASIAI_V2_FORWARD_KEY` no está seteada todavía, el middleware NO se monta — backward compat 100%.

**Verificación post-merge**:
```bash
curl -X POST https://wasiai-a2a-production.up.railway.app/health
# → 200 OK
```

**Rollback**: revert commit en main → Railway redeploy auto.

---

## §2 Gate 2 — Generar + setear `WASIAI_V2_FORWARD_KEY` en Railway

**Qué hace**: Activa la validación del header `x-wasiai-forward-key` en a2a. Si ANTES de setear esto v2 ya está delegando, romperías auth. Por eso este step va ANTES de habilitar canary en v2.

**Comando**:
```bash
# Generar key (32 bytes hex = 64 chars)
FORWARD_KEY=$(openssl rand -hex 32)
echo "Forward key: $FORWARD_KEY"
echo "GUARDÁ ESTO — lo necesitás también en Vercel"

# Setear en Railway service wasiai-a2a-production
railway link --project wasiai-a2a-production  # si no está linked
railway variables set WASIAI_V2_FORWARD_KEY="$FORWARD_KEY"
```

**Efecto**: Railway redeploys con env var nueva. El middleware `requireForwardKey` se monta. Clientes externos sin header siguen pasando (header opcional). Clientes con header inválido → 401.

**Verificación**:
```bash
# Test sin header — debería seguir funcionando (caller externo legítimo)
curl -X POST https://wasiai-a2a-production.up.railway.app/compose \
  -H "Content-Type: application/json" -d '{"steps":[]}'
# → 402 (challenge esperado, no 401)

# Test con header inválido — debería rechazar
curl -X POST https://wasiai-a2a-production.up.railway.app/compose \
  -H "Content-Type: application/json" \
  -H "x-wasiai-forward-key: invalid-secret-xxxxxxxxxxxxxxxxxxx" \
  -d '{"steps":[]}'
# → 401 INVALID_FORWARD_KEY

# Test con header válido (replazá $FORWARD_KEY)
curl -X POST https://wasiai-a2a-production.up.railway.app/compose \
  -H "Content-Type: application/json" \
  -H "x-wasiai-forward-key: $FORWARD_KEY" \
  -d '{"steps":[]}'
# → 402 (passthrough al payment middleware)
```

**Rollback**: `railway variables unset WASIAI_V2_FORWARD_KEY` → middleware no se monta.

---

## §3 Gate 3 — DB Migration prod `caldzjhjgctpgodldqav`

**Qué hace**: Aplica las 12 migrations de wasiai-a2a sobre la BD prod. Estas migrations crean tablas con prefijo `a2a_*` o nombres exclusivos (`registries`, `kite_schema_transforms`, etc.) que NO colisionan con tablas de v2 marketplace.

**Migrations a aplicar** (en orden, idempotentes):
```
20260401000000_kite_registries.sql
20260403180000_tasks.sql
20260404000000_mock_community_registry.sql
20260404200000_events.sql
20260406000000_a2a_agent_keys.sql
20260421015829_a2a_protocol_fees.sql
20260426120000_kite_schema_transforms_schema_hash.sql
20260427160000_secure_rpc_search_path.sql
20260427210000_registries_owner_ref.sql
20260427230000_kite_schema_transforms_owner.sql
kite_schema_transforms.sql
```
(11 archivos — `a2a_agent_keys_down.sql` es el rollback, no se aplica)

**Backup primero (mandatory)**:
```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
mkdir -p backups
PROD_REF=caldzjhjgctpgodldqav
SUPABASE_ACCESS_TOKEN=$(grep "^SUPABASE_ACCESS_TOKEN=" .env | cut -d'=' -f2-)

# Dump current state
npx supabase db dump --project-ref $PROD_REF --schema public \
  > backups/prod-pre-wkh65-$(date +%Y%m%d-%H%M).sql

# Verificar size > 0
ls -lh backups/prod-pre-wkh65-*.sql
```

**Diff (opcional pero recomendado, ver qué falta)**:
```bash
# Listar tablas a2a en prod
PAT=$SUPABASE_ACCESS_TOKEN curl -sf -H "Authorization: Bearer $PAT" \
  "https://api.supabase.com/v1/projects/$PROD_REF/database/query" \
  -X POST -H "Content-Type: application/json" \
  -d '{"query":"SELECT table_name FROM information_schema.tables WHERE table_schema='\''public'\'' AND (table_name LIKE '\''a2a_%'\'' OR table_name IN ('\''registries'\'','\''tasks'\'','\''kite_schema_transforms'\'','\''schema_hash'\'')) ORDER BY table_name;"}'
```

**Apply (idempotente — todas las migrations usan IF NOT EXISTS)**:
```bash
# Link al project si no está
npx supabase link --project-ref $PROD_REF

# Push migrations (Supabase CLI compara contra schema_migrations table)
npx supabase db push
```

**Verificación post-migration**:
```bash
# Test que las tablas nuevas estén
curl -sf -H "Authorization: Bearer $PAT" \
  "https://api.supabase.com/v1/projects/$PROD_REF/database/query" \
  -X POST -H "Content-Type: application/json" \
  -d '{"query":"SELECT count(*) FROM a2a_agent_keys; SELECT count(*) FROM registries; SELECT count(*) FROM kite_schema_transforms;"}'
# → 0, 0, 0 (tablas vacías pero existen — perfect)

# Smoke contra a2a apuntando a prod DB (si hay env override)
DATABASE_URL=$PROD_DB_URL node scripts/smoke-e2e-cross-chain.mjs
```

**Rollback** (si algo rompe):
```bash
psql "$PROD_DB_URL" < backups/prod-pre-wkh65-YYYYMMDD-HHMM.sql
# (require dropear tablas a2a creadas primero — el dump sobreescribe public schema)
```

---

## §4 Gate 4 — Merge PR v2 (cuando WKH-66 esté DONE)

**Estado**: pendiente — Claude está trabajando en WKH-66 ahora. Notificará cuando el PR esté abierto.

**Comando** (cuando PR esté listo):
```bash
cd /home/ferdev/.openclaw/workspace/wasiai-v2
gh pr merge <PR#> --squash --delete-branch
```

**Efecto**: Vercel auto-deploys `wasiai-prod` project. Como `V2_DELEGATE_TO_A2A` no está seteada todavía, los proxies retornan 503 FEATURE_DISABLED — sin impacto en prod hasta que actives el flag.

---

## §5 Gate 5 — Setear vars Vercel `wasiai-prod`

**Qué hace**: Configura los 3 env vars que el thin proxy necesita.

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-v2
vercel link --project wasiai-prod  # si no está

# Var 1: URL del a2a Railway
vercel env add WASIAI_A2A_BASE_URL production <<< "https://wasiai-a2a-production.up.railway.app"

# Var 2: forward-key (mismo valor que pusiste en Railway en §2)
vercel env add WASIAI_V2_FORWARD_KEY production <<< "$FORWARD_KEY"

# Var 3: feature flag — vacío = todos OFF
vercel env add V2_DELEGATE_TO_A2A production <<< ""

# Redeploy con vars nuevas
vercel --prod
```

**Verificación**:
```bash
curl https://app.wasiai.io/api/v1/compose -X POST \
  -H "Content-Type: application/json" -d '{}'
# → 503 FEATURE_DISABLED (flag vacío) o 401 si auth
```

---

## §6 Gate 6 — Canary toggle gradual

**Estrategia**: encender 1 endpoint a la vez, observar, escalar.

### Paso 1 — capabilities (1h obs)

`/api/v1/capabilities` es read-only (GET → /discover en a2a). Riesgo más bajo.

```bash
vercel env rm V2_DELEGATE_TO_A2A production
vercel env add V2_DELEGATE_TO_A2A production <<< "capabilities"
vercel --prod
```

Test:
```bash
curl https://app.wasiai.io/api/v1/capabilities
# → 200 con array de agents (proxieado a a2a /discover)
```

Métricas a observar (1h):
- Vercel logs: error rate del endpoint /capabilities
- Railway logs (a2a): incremento de tráfico en /discover
- Latencia p95 del endpoint < 1s

### Paso 2 — compose (4h obs)

```bash
vercel env rm V2_DELEGATE_TO_A2A production
vercel env add V2_DELEGATE_TO_A2A production <<< "capabilities,compose"
vercel --prod
```

Smoke real-tx:
```bash
A2A_URL=https://app.wasiai.io/api/v1 node scripts/smoke-e2e-cross-chain.mjs
# Esperado: 4 txs onchain (1 Kite + 3 Fuji)
# Latencia: +5-10s overhead vs directo
```

### Paso 3 — orchestrate (24h obs)

```bash
vercel env rm V2_DELEGATE_TO_A2A production
vercel env add V2_DELEGATE_TO_A2A production <<< "capabilities,compose,orchestrate"
vercel --prod
```

### Paso 4 — mcp (post 24h)

```bash
vercel env rm V2_DELEGATE_TO_A2A production
vercel env add V2_DELEGATE_TO_A2A production <<< "capabilities,compose,orchestrate,mcp"
vercel --prod
```

---

## §7 Smoke real-tx final

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a

# Smoke 1: 3 agents canónico
A2A_URL=https://app.wasiai.io/api/v1 node scripts/smoke-e2e-cross-chain.mjs

# Smoke 2: 5 agents (cap del pipeline)
A2A_URL=https://app.wasiai.io/api/v1 node scripts/smoke-cross-chain-5-agents.mjs

# Smoke 3: LLM planner orchestrate
A2A_URL=https://app.wasiai.io/api/v1 node scripts/smoke-orchestrate-cross-chain.mjs

# Smoke 4: perf bench 5x
A2A_URL=https://app.wasiai.io/api/v1 node scripts/perf-bench-cross-chain.mjs
```

**Costo total estimado**: ~$0.57 USDC (testnet)

**Métricas alarming** (rollback si):
- Cualquier smoke retorna 5xx
- Latencia p95 > 50s (proxy overhead aceptable hasta +10s del directo)
- Error rate > 2%

---

## §8 Métricas de éxito

| Métrica | Objetivo | Cómo medir |
|---------|----------|------------|
| Smoke E2E success | 5/5 (100%) | runs de scripts |
| Latencia p50 | < 35s | perf-bench output |
| Latencia p95 | < 45s | perf-bench output |
| Error rate prod | < 0.1% | Vercel logs `/api/v1/compose` |
| Marketplace regresión | 0 | regress test post-merge |
| LOC eliminadas v2 | ~1,300 | `git diff main..feat/072-* --stat` |

---

## §9 Contacto / escalation

Si algo se rompe:
1. **Toggle off instant**: `vercel env rm V2_DELEGATE_TO_A2A production` (sin redeploy, propaga en ~30s)
2. **Revert PR**: `gh pr revert <PR#> --merge`
3. **DB rollback**: `psql < backups/prod-pre-wkh65-*.sql` (después de drop tablas a2a nuevas)

Logs:
- Vercel: https://vercel.com/ferrosasfp/wasiai-prod/logs
- Railway a2a: `railway logs --service wasiai-a2a-production`
- Railway facilitator: `railway logs --service wasiai-facilitator`
- Supabase prod: https://app.supabase.com/project/caldzjhjgctpgodldqav/logs

---

**Status del autónomo Claude (al 2026-04-28)**:
- ✅ a2a forward-key: PR #55 listo merge
- 🔄 v2 thin-proxy: WKH-66 analyst en flight
- ⏸ Gates 1-7: esperando tu ejecución del runbook
