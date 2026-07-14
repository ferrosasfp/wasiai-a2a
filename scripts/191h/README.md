# WKH-191h — Ejecución del upgrade del escrow del demo (0x149D → v191f)

Trae el rol **árbitro + disputa + consentimiento** al contrato que usa el demo.

## Estado (2026-07-14)
- `proposeUpgrade` YA enviado — tx `0x83a8673b5cd44343b57fb3a7a22c8bde13c75ba6fb33d682812cb662d4e7c704`.
- **Ventana de ejecución:** `2026-07-16 19:43 UTC` → `2026-07-23 19:43 UTC` (timelock 2 días + grace 7 días).
- Storage-layout ya verificado compatible (append-into-gap; slots 0-8 idénticos).
- newImpl v191f = `0x82b5f3180b4ff1a2097d8afa6b876cf363e60b74` (validado en el arbiter E2E, detrás de `0x85b7aA8FD69199F158666866F845dDA0C9FA7CC2`).
- owner=operator = `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba`.
- **El demo sigue en la impl vieja y funciona igual hasta el paso 1.** Reversible antes de ejecutar con `cancelUpgrade`.

## Pre-flight
```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
export OPERATOR_PRIVATE_KEY=$(grep -hE '^OPERATOR_PRIVATE_KEY=' .env .env.local 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
# verificar que el operador 0xf432 tiene KITE gas (>0.01) para las 3 txs
```

## Paso 1 — upgrade UUPS (dentro de la ventana)
```bash
node scripts/191h/1-execute-upgrade.cjs
```
Simula primero; si el timelock no transcurrió, revierte `TimelockNotElapsed` y no envía nada. Deja `impl = v191f`.

## Paso 2 — provisionar la wallet del árbitro
```bash
node scripts/191h/2-provision-arbiter.cjs
```
Genera la wallet, guarda la key en `.env.arbiter` (gitignored), imprime la address + el comando Railway. Luego:
- Setear `ARBITER_PRIVATE_KEY` en Railway (comando que imprime el script).
- **Fondear** la address del árbitro con un poco de KITE gas (para firmar `resolveDispute`).

## Paso 3 — activar el árbitro on-chain
```bash
node scripts/191h/3-set-arbiter.cjs        # lee la addr de .env.arbiter
```
Llama `setArbiter(...)`; verifica `arbiter()` on-chain al final.

## Post-ejecución — smoke
```bash
# demo intacto (fast-path custodial):
curl -s -o /dev/null -w "%{http_code}\n" https://wasiai-a2a-production.up.railway.app/discover
# arbiter configurado:
#   arbiter() debe devolver la address del paso 2 (el script 3 ya lo verifica).
```

## Abortar (antes de ejecutar)
```bash
# cancelUpgrade(0x82b5f3180b4ff1a2097d8afa6b876cf363e60b74) desde el owner — ver contracts/src/WasiAIEscrow.sol:300
```
