# Smoke prep — WKH-67 mainnet $0.061 USDC (W6 / F4 / orquestador)

> Este doc lo lee el orquestador POST-MERGE. F3 NO ejecuta el smoke real.
> CD-24: one-shot, ≤ $0.10 USDC, autorización humana explícita por re-run.

## Pre-requisitos

- Branch mergeado a `main`, deploy Vercel `wasiai-x402-mcp.vercel.app/api/mcp`
  activo (NO el rolled-back `wasiai-x402-ah0gufv0p`).
- Cron-job.org jobs DISABLED hasta que el smoke pase (AC-13 los re-habilita
  después).
- Operator wallet con balance > $0.55 USDC mainnet (threshold 0.5 + smoke
  0.05 + buffer).
- Bearer token `MCP_BEARER_TOKEN` válido (rotated WKH-66 si aplica).

## Body JSON-RPC del smoke

`POST https://wasiai-x402-mcp.vercel.app/api/mcp` con headers:

- `Authorization: Bearer <MCP_BEARER_TOKEN>`
- `Content-Type: application/json`
- `Accept: application/json, text/event-stream`

Body:

```json
{
  "jsonrpc": "2.0",
  "id": "smoke-wkh-67",
  "method": "tools/call",
  "params": {
    "name": "pay_x402",
    "arguments": {
      "endpoint": "/api/v1/orchestrate",
      "payload": { "maxBudget": 0.05, "task": "smoke-test-wkh-67" }
    }
  }
}
```

Notas:

- `payload.maxBudget` (USDC OUTBOUND) ahora es OBLIGATORIO — sin él el
  balance-gate rechaza con `stage:'balance-gate'`.
- `args.maxAmountWei` (PYUSD INBOUND) es opcional — para este smoke se
  omite y se acepta el challenge default del gateway.

## Resultado esperado

- HTTP 200, body con `result.content[0].text` parseado a:
  ```json
  { "ok": true, "stage": "settled", "kiteTxHash": "0x...", "latencyMs": <int> }
  ```
- Tx hash visible en Avalanche explorer:
  https://snowtrace.io/tx/0x...
- Balance pre/post snapshot: documentar en `done-report.md` (delta
  ≤ $0.061 USDC).

## Post-smoke

1. Re-enable cron-job.org via `node scripts/setup-cronjob.mjs` (AC-13).
2. Escribir `done-report.md` con tx hash + balance pre/post + deploy URL +
   PR URL (AC-15).
3. Escribir `auto-blindaje.md` con la lección "decimals separation" (AC-14,
   CD-25).

## NO HACER en F3

- NO ejecutar este smoke en F3.
- NO incluir el smoke en CI.
- NO re-correr sin autorización humana explícita (cada run cuesta plata
  real).
