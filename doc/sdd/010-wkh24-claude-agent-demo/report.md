# Report — WKH-24: Claude Agent Demo Script
**Fecha:** 2026-04-04  
**Branch:** `feat/wkh-24-claude-agent-demo`  
**Pipeline:** F3 → AR → CR → F4 → DONE  
**Status:** ✅ DONE

---

## Resumen

Se implementó `src/demo.ts` — script CLI standalone que demuestra el protocolo WasiAI A2A:

1. Recibe un goal en lenguaje natural (`process.argv[2]`)
2. Llama `/discover` para encontrar agentes relevantes
3. Firma un único pago x402 EIP-712 dirigido al servidor A2A (`KITE_WALLET_ADDRESS`)
4. Llama `/compose` con el pago firmado y el pipeline de agentes
5. Imprime txHash, output, cost y latency

## Decisiones de Implementación

### Patrón async IIFE
Se usó un async IIFE `(async () => { ... })().catch(...)` para:
- Permitir `await` a nivel de módulo sin `"type": "module"` forzado
- Garantizar que cualquier promise rejection no capturada llegue al handler global
- Cumplir CD-2 (no unhandled promise rejections)

### MAX_AGENTS = 3
Limitamos a los primeros 3 agentes del discover para mantener el demo manejable y el budget bajo control.

### passOutput flag
Los pasos 2+ reciben `passOutput: true` para encadenar el output del paso anterior. El paso 0 siempre tiene `passOutput: false`.

### kiteTxHash como optional
El middleware de settlement puede fallar silenciosamente en edge cases de red. El demo loguea un warning pero no falla — el resultado del pipeline puede ser válido aunque no haya txHash inmediato.

## Nota sobre ComposeStep.input genérico

Los `ComposeStep` usan `input: { query: goal }` como input genérico. Esto está **cubierto por el Transform Layer del servidor A2A**, que mapea el input según el schema de cada agente en el registry. No es un bug ni una limitación del demo — es arquitectura intencional del servidor. No requiere modificación del lado cliente.

## CR — Code Review

| Aspecto | Evaluación |
|---------|-----------|
| Naming | ✅ Claro y consistente (camelCase, SCREAMING_SNAKE para env vars) |
| Tipos TypeScript | ✅ Explícitos, sin `any` |
| Manejo de errores | ✅ Completo — todos los paths de error tienen mensaje descriptivo + exit(1) |
| Logs | ✅ Emoji en cada paso, informativos sin exponer secretos |
| Estructura | ✅ Lineal, fácil de seguir wave por wave |
| Seguridad | ✅ CD-2 cumplido — ningún secreto en logs |

## Archivos

| Archivo | Acción |
|---------|--------|
| `src/demo.ts` | ✅ CREADO (142 líneas) |
| `doc/sdd/010-wkh24-claude-agent-demo/validation.md` | ✅ CREADO |
| `doc/sdd/010-wkh24-claude-agent-demo/report.md` | ✅ CREADO (este archivo) |

## Git

```
Branch: feat/wkh-24-claude-agent-demo
Commit: feat(demo): WKH-24 autonomous agent demo script
Push: origin feat/wkh-24-claude-agent-demo
```
