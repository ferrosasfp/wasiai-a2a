# Fila para `doc/sdd/_INDEX.md`

**Dónde va**: en `doc/sdd/_INDEX.md`, dentro de la tabla que arranca en la línea 3
(`| # | Fecha | HU | Tipo | Mode | Status | Branch |`), **al final del cuerpo de la tabla**,
después de la última fila numerada y **antes** de la sección
`## ⚠️ Deuda de numeración de este índice (anotada, NO resuelta)` (línea 181).

**No la agregué yo**: reescribir `_INDEX.md` está prohibido en F1 y hay tres árboles de trabajo
activos sobre este repo.

```
| 214 | 2026-07-29 | [WKH-316] El escritor del bloque de pago de un agente — `payment` en POST/PATCH /agents | feature | QUALITY | IN PROGRESS | feat/214-wkh-316-payment-block-writer ([work-item.md](214-wkh-316-escritor-payment-block/work-item.md)) |
```

## Verificación del número

`214` está libre. Verificado listando los directorios de `doc/sdd/`: el prefijo numérico más alto
existente es `213` (`213-wkh-315-deposito-prepago-solana`). `210`, `211`, `212` y `213` están
tomados:

| Directorio | HU |
|---|---|
| `209-wkh-307-solana-durable-idempotency-ledger` | WKH-307 |
| `210-wkh-308-verify-tres-estados` | WKH-308 |
| `211-wkh-313-primer-trabajo-agentes-sin-historial` | WKH-313 |
| `212-wkh-314-x402-inbound-solana` | WKH-314 |
| `213-wkh-315-deposito-prepago-solana` | WKH-315 |
| **`214-wkh-316-escritor-payment-block`** | **WKH-316 (esta)** |

⚠️ El índice arrastra deuda de numeración conocida y documentada en `_INDEX.md:181-209`
(cuatro directorios comparten el `190`, y 18 directorios no tienen fila propia). Esta fila **no**
intenta resolver nada de eso.
