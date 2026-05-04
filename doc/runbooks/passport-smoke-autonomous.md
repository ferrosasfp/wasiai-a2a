# Runbook — Autonomous Passport x402 Smoke Runner (WKH-92)

## 1. Overview

`scripts/smoke-passport-autonomous.mjs` ejecuta el flujo Passport→x402 punta-a-punta
contra un servicio configurable (default: Parallel `https://parallelmpp.dev/api/search`)
sin intervención humana en runtime. Reutiliza una sesión Passport activa creada
previamente por un humano (passkey, ~1 vez por 24h). Si no hay sesión activa o el
balance USDC está por debajo del mínimo, el script termina con código 1 y JSON
estructurado indicando el "human gate" requerido — ideal para CI / cron.

Evidencia base: `doc/sdd/084-wkh-69-passport-hybrid-inbound/wire-evidence/parallel-200-evidence.json`
(HTTP 200, $0.01 USDC spend, x402 payment confirmado en mainnet).

## 2. Prerrequisitos

- Node.js >= 20 (built-ins `child_process`, `crypto`, `fs`)
- `kpass` CLI instalado y en `PATH` (Kite Passport CLI)
- Wallet Passport con saldo USDC >= `MIN_BALANCE_USDC` (default 0.05)
- Sesión Passport activa creada con scopes adecuados

## 3. Bootstrap (1 vez cada ~24h, requiere passkey)

```bash
kpass agent:session create \
  --ttl 24h \
  --max-amount-per-tx 0.10 \
  --max-total-amount 5.00 \
  --assets USDC \
  --payment-approach x402
# Salida → click en approval URL → aprobar con passkey en el browser
```

Validar que la sesión quedó activa:

```bash
kpass agent:session list --status active --output json
```

## 4. Invocación autónoma (CI / cron)

```bash
node scripts/smoke-passport-autonomous.mjs
```

### Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `SMOKE_TARGET_URL` | `https://parallelmpp.dev/api/search` | URL del servicio x402 a probar |
| `SMOKE_TARGET_BODY` | `{"objective":"latest news on crypto"}` | Body JSON para el POST |
| `SMOKE_TARGET_METHOD` | `POST` | Método HTTP |
| `EXPECTED_COST_USDC` | `0.01` | Costo esperado (USDC) por llamada |
| `MIN_BALANCE_USDC` | `0.05` | Si pre-balance < min → exit 1 |
| `BALANCE_TOLERANCE_PCT` | `1` | Tolerancia (% del costo esperado) |
| `SMOKE_KPASS_BIN` | `kpass` | Override del binario kpass |
| `SMOKE_KPASS_MOCK_FILE` | (unset) | Test hook: fixture JSON para subprocess stub (solo tests) |

## 5. Output

- **stdout**: solo objetos JSON (eventos intermedios + verdict final)
- **stderr**: mensajes de progreso humanos (sin secretos)

### Códigos de salida (DT-4)

| Code | Significado | Acción |
|---|---|---|
| `0` | Smoke PASS — HTTP 200 + balance diff dentro de tolerancia | Verde en CI |
| `1` | Human gate required — no hay sesión activa o balance insuficiente | Página al humano |
| `2` | Smoke assertion failure — execute no devolvió `success` o diff fuera de tolerancia | Investigar drift |
| `3` | Runtime error — kpass no encontrado, JSON inválido, etc. | Revisar infra |

### Estructura del verdict final (exit 0)

```json
{
  "status": "success",
  "target": "https://parallelmpp.dev/api/search",
  "pre_balance_usdc": 0.50,
  "post_balance_usdc": 0.49,
  "balance_diff_usdc": 0.01,
  "expected_cost_usdc": 0.01,
  "tolerance_usdc": 0.0001,
  "diff_within_tolerance": true,
  "http_status": 200,
  "session_id_hash": "a3f9c12b",
  "timestamp": "2026-05-03T12:34:56.789Z"
}
```

### Estructura cuando hay human gate (exit 1)

```json
{
  "status": "human_gate_required",
  "reason": "no_active_session",
  "next_step": "Run: kpass agent:session create ..."
}
```

o

```json
{
  "status": "insufficient_balance",
  "reason": "pre_balance_below_min",
  "pre_balance_usdc": 0.01,
  "min_required_usdc": 0.05,
  "next_step": "Top up USDC in Passport wallet before running smoke"
}
```

## 6. Patrones de integración

### 6.1 cron-job.org / cron clásico

```cron
# Cada hora, en horario laboral
0 9-18 * * 1-5 cd /opt/wasiai-a2a && node scripts/smoke-passport-autonomous.mjs >> /var/log/passport-smoke.log 2>&1
```

Si exit code es 1 (human gate) → enviar alerta a Slack vía wrapper:

```bash
#!/usr/bin/env bash
set -uo pipefail
out=$(node scripts/smoke-passport-autonomous.mjs)
code=$?
case "$code" in
  0) echo "$out" | jq -r '"Smoke OK — diff=\(.balance_diff_usdc)"' ;;
  1) curl -s -X POST "$SLACK_WEBHOOK" -d "{\"text\": \"Passport smoke needs human: $out\"}" ;;
  2) curl -s -X POST "$PAGER_WEBHOOK" -d "{\"text\": \"Smoke FAIL: $out\"}" ;;
  3) curl -s -X POST "$PAGER_WEBHOOK" -d "{\"text\": \"Runtime error: $out\"}" ;;
esac
```

### 6.2 GitHub Actions (CI)

```yaml
name: passport-smoke
on:
  schedule:
    - cron: '0 */6 * * *'  # cada 6h
  workflow_dispatch:
jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - name: Install kpass
        run: curl -sL https://kite.dev/install-kpass.sh | bash
      - name: Restore Passport session
        run: kpass session restore --token "${{ secrets.PASSPORT_SESSION_TOKEN }}"
      - name: Run smoke
        env:
          SMOKE_TARGET_URL: https://parallelmpp.dev/api/search
          EXPECTED_COST_USDC: '0.01'
        run: node scripts/smoke-passport-autonomous.mjs
```

## 7. Troubleshooting

| Síntoma | Exit code | Diagnóstico | Fix |
|---|---|---|---|
| `status=human_gate_required, reason=no_active_session` | 1 | Sesión expiró o nunca se creó | Re-bootstrap (sección 3) |
| `status=insufficient_balance` | 1 | Balance USDC < `MIN_BALANCE_USDC` | Top-up USDC en wallet Passport |
| `status=test_failure, stage=execute` | 2 | `kpass agent:session execute` devolvió error | Revisar `kpass_error_code` en JSON; servicio target caído o auth issue |
| `status=test_failure, diff_within_tolerance=false` | 2 | Cobro diferente al esperado | Revisar `EXPECTED_COST_USDC` vs precio actual del target |
| `status=runtime_error, stage=session_list` | 3 | `kpass` no instalado o no en PATH | Instalar `kpass`, verificar `which kpass` |
| `status=runtime_error, stage=pre_balance` | 3 | `wallet balance` devolvió shape inesperado | Verificar versión de `kpass`; revisar fixture esperada |

## 8. Seguridad y secretos

El script respeta los siguientes invariantes (Constraint Directives):

- **CD-WKH69-5 / CD-WKH92-2**: nunca loguea valores literales de `jwt`, `agent_token`,
  `session_id`, `authorization` o `x-passport-session`. Si necesita exponer un
  identificador de sesión para trazabilidad, emite `session_id_hash` (sha256 truncado
  a 8 hex chars).
- **CD-WKH92-1**: no reimplementa lógica de Passport — todo va a través del binario
  `kpass`.
- **CD-WKH92-3**: idempotente — N invocaciones producen N smokes independientes,
  cada uno consumiendo `EXPECTED_COST_USDC` (efecto colateral externo: balance del
  wallet decrece).
- **CD-WKH92-4**: la suite de tests usa subprocess stub (`SMOKE_KPASS_MOCK_FILE`),
  por lo que CI puede correr sin `kpass` instalado y sin red.
