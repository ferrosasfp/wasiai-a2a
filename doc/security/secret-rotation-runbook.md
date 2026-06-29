# Secret Rotation Runbook — WasiAI

Repeatable procedure for rotating every long-lived secret. These are the exact
steps validated on 2026-06-28 (Groq + INTERNAL_API_SECRET rotations).

> **Note on "automation":** true automated rotation needs a secrets manager
> (Vault / Doppler / Infisical) which we do not run yet. For MVP this runbook is
> the rotation mechanism. The facilitator API key already supports zero-downtime
> rotation via versioning (see below). Adopt a secrets manager when scaling.

## Golden rules
1. **Rotate -> deploy everywhere -> verify -> THEN revoke the old.** Never revoke
   before the new value is live in every consumer, or you cause downtime.
2. **Shared secrets must match across all services** (same value everywhere) or
   internal calls break.
3. **Never print a secret value.** Pass values via stdin / env, never argv or logs.
4. After rotation, remove any temp copy from local `.env.local`.

---

## Where each secret lives

| Secret | Type | Consumers (must all get the new value) |
|--------|------|----------------------------------------|
| `GROQ_API_KEY` | vendor (groq.com) | Vercel: wasiai-v2, wasiai-prod, wasiai-agents |
| `INTERNAL_API_SECRET` | self-generated, shared | Vercel: wasiai-v2, wasiai-prod, wasiai-agents |
| `FACILITATOR_API_KEY` / `FACILITATOR_API_KEYS` | self-generated | Railway: wasiai-facilitator (verifier) + any caller (a2a/agents) |
| `OPERATOR_PRIVATE_KEY` | signing key | Railway: wasiai-a2a + wasiai-facilitator |
| `SUPABASE_SERVICE_KEY` | vendor (Supabase) | Railway a2a + Vercel v2/prod |

Vercel team: `team_TULy0a3V6xlsEkKA2MXzALzf` (scope `ferrosasfp-1287s-projects`).
Railway tokens (in `wasiai-a2a/.env.local`): `RAILWAY_TOKEN` -> wasiai-a2a,
`RAILWAY_TOKEN_F` -> wasiai-facilitator (service `wasiai-facilitator`).

---

## A. Vercel-hosted secret (GROQ_API_KEY, INTERNAL_API_SECRET)

Set the SAME new value in all consumer projects via the API (value via stdin,
never printed), then redeploy each.

```bash
set -a && . ./.env.local && set +a   # VERCEL_TOKEN
TEAM="team_TULy0a3V6xlsEkKA2MXzALzf"
export NEW="$(openssl rand -hex 32)"   # for INTERNAL_API_SECRET; for GROQ paste the new gsk_ into $NEW
for P in wasiai-v2 wasiai-prod wasiai-agents; do
  ID=$(curl -s "https://api.vercel.com/v9/projects/$P/env?teamId=$TEAM" -H "Authorization: Bearer $VERCEL_TOKEN" \
       | python3 -c "import sys,json;d=json.load(sys.stdin);print(next((e['id'] for e in d.get('envs',[]) if e.get('key')=='INTERNAL_API_SECRET'),''))")
  python3 -c "import os,json;print(json.dumps({'value':os.environ['NEW']}))" \
    | curl -s -X PATCH "https://api.vercel.com/v9/projects/$P/env/$ID?teamId=$TEAM" \
        -H "Authorization: Bearer $VERCEL_TOKEN" -H "content-type: application/json" -d @- >/dev/null
  echo "$P updated"
done
unset NEW
# Redeploy the NON-mainnet ones (testnet + agents):
vercel redeploy wasiai-v2.vercel.app --token "$VERCEL_TOKEN" --scope "$VERCEL_SCOPE" --no-wait
vercel redeploy wasiai-agents.vercel.app --token "$VERCEL_TOKEN" --scope "$VERCEL_SCOPE" --no-wait
# MAINNET (wasiai-prod) redeploy: do it from the Vercel dashboard (Deployments ->
# latest -> Redeploy). The classifier blocks agent-initiated mainnet deploys.
```
Verify each deploy READY + the consumer works (e.g. Groq: `curl https://api.groq.com/openai/v1/models -H "Authorization: Bearer $NEW"` returns 200; an agent endpoint that uses it succeeds). **Only then** revoke the old (Groq console for GROQ; for INTERNAL the old dies once all 3 run the new value).

## B. Facilitator API key (zero-downtime, versioned)

The facilitator accepts the legacy `FACILITATOR_API_KEY` OR any entry in
`FACILITATOR_API_KEYS` (CSV). Rotate with a grace period:
1. Generate new key: `openssl rand -hex 32`.
2. Railway: set `FACILITATOR_API_KEYS="<old>,<new>"` (both valid) on service
   `wasiai-facilitator` (token `RAILWAY_TOKEN_F`). Redeploys automatically.
3. Update every CALLER (a2a / agents) to send the NEW key as its bearer; redeploy.
4. Once all callers use the new key, set `FACILITATOR_API_KEYS="<new>"` (drop old).
   Old key is now invalid. Zero downtime throughout.

```bash
RAILWAY_TOKEN="$RAILWAY_TOKEN_F" railway variables --set "FACILITATOR_API_KEYS=<old>,<new>" --service wasiai-facilitator
```

## C. OPERATOR_PRIVATE_KEY (signing key — highest care)

This wallet holds testnet funds and is bound to on-chain escrow deposits.
Rotation is NOT just an env swap:
1. Generate a new wallet; fund it with gas + USDC on each chain.
2. Migrate any operator-held balances / pending obligations from the old wallet.
3. Update `OPERATOR_PRIVATE_KEY` on Railway wasiai-a2a AND wasiai-facilitator
   (same key, both services sign with it). Redeploy both.
4. Verify a settlement end-to-end before retiring the old wallet.
Treat as a planned maintenance window. Consider per-chain operator keys + a
multisig fee wallet before mainnet.

## D. Supabase service key

Rotate in the Supabase dashboard (Project Settings -> API -> roll the
service_role key), then set `SUPABASE_SERVICE_KEY` on Railway wasiai-a2a + Vercel
v2/prod, redeploy, verify DB access. RLS is the second line of defense if the key
leaks (deny-by-default on the money tables).

---

## Cadence (recommendation for MVP)
- Rotate on **suspected exposure** (the trigger this session: a key committed to git).
- Otherwise: rotate `FACILITATOR_API_KEYS` + `INTERNAL_API_SECRET` ~quarterly once
  there is real traffic; `OPERATOR_PRIVATE_KEY` only on a planned migration.
- When a secrets manager is adopted (post-revenue), wire scheduled rotation + the
  facilitator versioning grace-period into it. See [[redis-ha-activation-trigger]]
  for the similar "do it when there's real volume" framing.
