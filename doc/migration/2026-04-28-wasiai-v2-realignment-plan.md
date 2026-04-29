# wasiai-v2 ↔ wasiai-a2a Realignment Plan

**Status:** PROD CUTOVER COMPLETO (2026-04-28)
**Tracker:** WKH-65 + WKH-66 (cross-repo)
**Pointer:** ver `HACKATHON-FINAL.md` (placeholder — escrito por nexus-docs en cierre del hackathon)

## Objetivo

Mover la lógica canónica de `compose`, `orchestrate`, `capabilities` y `mcp` del marketplace `wasiai-v2` al servicio standalone `wasiai-a2a` (Railway), dejando v2 como thin-proxy.

## Estado actual (post-cutover)

| Endpoint v2 | Modo | Comportamiento |
|---|---|---|
| `POST /api/v1/compose` | proxy (`V2_DELEGATE_TO_A2A=compose`) | reenvía a `wasiai-a2a/compose` |
| `POST /api/v1/orchestrate` | proxy (`V2_DELEGATE_TO_A2A=orchestrate`) | reenvía a `wasiai-a2a/orchestrate` |
| `GET /api/v1/capabilities` | proxy con loop-break | reenvía a `wasiai-a2a/discover` salvo cuando a2a llama back (TD-002) |
| `MCP server` | legacy (no proxy aún) | flag `mcp` deshabilitado en `V2_DELEGATE_TO_A2A` |

## Wins del cutover

1. **Single source of truth multi-chain** — la tabla `registries` y los handlers de compose/orchestrate ahora viven en a2a; v2 sólo reenvía.
2. **x402 downstream** — pagos a agentes de v2 firmados desde a2a usando `WASIAI_KEYPAIR` y settled vía Avalanche Fuji.
3. **Forward-key middleware** (WKH-65) — v2 inyecta `x-wasiai-forward-key` y a2a valida; sin esa key el forward devuelve 401 inmediato.
4. **Smoke E2E** — `scripts/smoke-prod-via-app-wasiai.mjs` verifica `compose+pago` end-to-end contra prod (Avalanche mainnet hash trail en logs).

## TD pendiente (post-hackathon)

1. **WKH-SEC-02** — RLS Postgres-level para `a2a_agent_keys` (hoy app-layer únicamente).
2. **WKH-54 Fase B** — `owner_ref` en `tasks` + RPC update.
3. **TD-002 fix definitivo** — reapuntar `discoveryEndpoint` del registry `WasiAI` a `/api/v1/agents` legacy en vez del mitigation patch actual.
4. **MCP delegation** — diseñar shape adapter antes de habilitar `V2_DELEGATE_TO_A2A=mcp`.
5. **Cleanup `mock-community` registry** — migration `20260428233000_remove_mock_community_registry` aplicada — verificar en prod después del próximo deploy.

## Verificación post-deploy

```bash
# 1. v2 thin-proxy
curl -X POST "https://app.wasiai.io/api/v1/compose" \
  -H "content-type: application/json" \
  -d '{"steps":[{"agent_slug":"agent-defi-risk-monitor"}]}'
# → 402 con x402 quote

# 2. a2a directo
curl -X POST "https://wasiai-a2a-production.up.railway.app/compose" \
  -H "content-type: application/json" \
  -d '{"steps":[{"agent_slug":"agent-defi-risk-monitor"}]}'
# → 402 idéntico (mismo backend)

# 3. capabilities (con loop-break)
curl "https://app.wasiai.io/api/v1/capabilities?limit=20"
# → debería listar 22 agents (v2 Supabase, no 0)
```

## Pointer al final report

Cuando el hackathon cierre, `HACKATHON-FINAL.md` (escrito por nexus-docs) consolidará:

- Lista completa de HUs cerradas (WKH-55, WKH-56, WKH-57, WKH-65, WKH-66, ...).
- Métricas de coverage / smoke / latency.
- TD acumulada con priorización post-hackathon.
- Lessons learned + retros del pipeline NexusAgil.
