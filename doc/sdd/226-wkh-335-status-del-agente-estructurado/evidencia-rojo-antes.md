# Evidencia AC-5 / CD-4 — ROJO ANTES del cableado

**HU**: WKH-335 · Wave 1 · `wasiai-a2a`
**Worktree**: `/home/ferdev/.openclaw/workspace/a2a-wkh362`
**Rama**: `feat/wkh-335-status-estructurado`
**Fecha**: 2026-08-25

## Estado del árbol en el momento de esta corrida

W1.0 hecho (el TIPO existe), W1.2 **NO cableado** (nada lo puebla):

- `src/types/index.ts` — `AgentFailureKind` + `ComposeResult.agentFailure?` ✅
- `src/lib/agent-http-error.ts` — creado ✅
- `src/lib/agent-http-error.test.ts` — creado ✅
- `src/services/compose.test.ts` — los 7 `it` de §9.1 escritos ✅
- `src/services/compose.ts` — **SIN TOCAR** ⛔ (ni el import, ni el `throw`, ni
  `agentFailureResult`, ni los dos `return`)

Por eso el rojo es la **ASERCIÓN** y no un error de import ni de compilación.
`npx tsc -p tsconfig.json --noEmit` daba **exit 0** en este mismo estado.

## Comando

```bash
cd /home/ferdev/.openclaw/workspace/a2a-wkh362
rtk proxy npx vitest run src/services/compose.test.ts
```

(`rtk proxy` = ejecución cruda, sin el filtro de tokens del hook, para que la
salida quede LITERAL y citable.)

## Salida literal

```
 RUN  v4.1.9 /home/ferdev/.openclaw/workspace/a2a-wkh362

 ❯ src/services/compose.test.ts (112 tests | 5 failed) 8381ms
     × T-335-DIRECT-4XX: 400 sin field-errors → agentFailure INPUT_REJECTED, error intacto 87ms
     × T-335-DIRECT-5XX: 500 → AGENT_ERROR, y NO es el mismo valor que el 400 152ms
     × T-335-RETRY: 422+fields → regen → 400 → INPUT_REJECTED por el return del RETRY 119ms
     × T-335-RETRY-5XX: 422+fields → regen → 500 → AGENT_ERROR (el 422 inicial no manda) 262ms
     × T-335-NOLEAK: body con URL y secreto → el campo no ecoa nada de eso 91ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 5 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/services/compose.test.ts > composeService.compose — WKH-130 adaptive input-retry > T-335-DIRECT-4XX: 400 sin field-errors → agentFailure INPUT_REJECTED, error intacto
AssertionError: expected undefined to be 'INPUT_REJECTED' // Object.is equality

- Expected:
"INPUT_REJECTED"

+ Received:
undefined

 ❯ src/services/compose.test.ts:3129:33
    3127|
    3128|     expect(result.success).toBe(false);
    3129|     expect(result.agentFailure).toBe('INPUT_REJECTED');
       |                                 ^
    3130|     expect(mockRegen).not.toHaveBeenCalled(); // salió por el return D…
    3131|     // AC-4 / CD-3: el campo `error` sigue byte-compatible — el status…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/5]⎯

 FAIL  src/services/compose.test.ts > composeService.compose — WKH-130 adaptive input-retry > T-335-DIRECT-5XX: 500 → AGENT_ERROR, y NO es el mismo valor que el 400
AssertionError: expected undefined to be 'AGENT_ERROR' // Object.is equality

- Expected:
"AGENT_ERROR"

+ Received:
undefined

 ❯ src/services/compose.test.ts:3149:40
    3147|     const cuatrocientos = await composeTwoSteps();
    3148|
    3149|     expect(cincuecientos.agentFailure).toBe('AGENT_ERROR');
       |                                        ^
    3150|     expect(cuatrocientos.agentFailure).toBe('INPUT_REJECTED');
    3151|     expect(cincuecientos.agentFailure).not.toBe(cuatrocientos.agentFai…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/5]⎯

 FAIL  src/services/compose.test.ts > composeService.compose — WKH-130 adaptive input-retry > T-335-RETRY: 422+fields → regen → 400 → INPUT_REJECTED por el return del RETRY
AssertionError: expected undefined to be 'INPUT_REJECTED' // Object.is equality

- Expected:
"INPUT_REJECTED"

+ Received:
undefined

 ❯ src/services/compose.test.ts:3167:33
    3165|     const result = await composeTwoSteps();
    3166|
    3167|     expect(result.agentFailure).toBe('INPUT_REJECTED');
       |                                 ^
    3168|     // `after retry` prueba que salió por el return del RETRY y no por…
    3169|     expect(result.error).toContain('after retry');

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/5]⎯

 FAIL  src/services/compose.test.ts > composeService.compose — WKH-130 adaptive input-retry > T-335-RETRY-5XX: 422+fields → regen → 500 → AGENT_ERROR (el 422 inicial no manda)
AssertionError: expected undefined to be 'AGENT_ERROR' // Object.is equality

- Expected:
"AGENT_ERROR"

+ Received:
undefined

 ❯ src/services/compose.test.ts:3189:37
    3187|
    3188|     expect(conCincoXX.error).toContain('after retry');
    3189|     expect(conCincoXX.agentFailure).toBe('AGENT_ERROR');
       |                                     ^
    3190|     expect(conCuatroXX.agentFailure).toBe('INPUT_REJECTED');
    3191|     expect(conCincoXX.agentFailure).not.toBe(conCuatroXX.agentFailure);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/5]⎯

 FAIL  src/services/compose.test.ts > composeService.compose — WKH-130 adaptive input-retry > T-335-NOLEAK: body con URL y secreto → el campo no ecoa nada de eso
AssertionError: expected undefined to be 'INPUT_REJECTED' // Object.is equality

- Expected:
"INPUT_REJECTED"

+ Received:
undefined

 ❯ src/services/compose.test.ts:3222:33
    3220|
    3221|     const campo = JSON.stringify(result.agentFailure);
    3222|     expect(result.agentFailure).toBe('INPUT_REJECTED');
       |                                 ^
    3223|     expect(campo).not.toContain('https://example.com/invoke'); // el i…
    3224|     expect(campo).not.toContain('example.com'); // el host del agente

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/5]⎯


 Test Files  1 failed (1)
      Tests  5 failed | 107 passed (112)
   Start at  05:58:23
   Duration  9.22s (transform 298ms, setup 0ms, import 892ms, tests 8.24s, environment 0ms)
```

## Lo que esta corrida certifica (paso 2 y paso 3 del protocolo)

- **El rojo es la ASERCIÓN, no un import roto.** Los 5 fallos son todos
  `AssertionError: expected undefined to be '<valor>'`. Cero `Cannot find module`,
  cero `SyntaxError`, cero error de tipos: `tsc --noEmit` daba exit 0.
- **Conteo de tests RECOLECTADOS: `112`.** Es el número que tiene que repetirse
  en la corrida verde. Si baja, algo dejó de recolectarse y el verde sería falso.
- **Los 5 rojos son exactamente los `it` que dependen del cableado.**
  `T-335-ABSENT` y `T-335-BACKCOMPAT` pasan en rojo Y en verde **a propósito**:
  son los invariantes de AUSENCIA (CD-10 / AC-4), y lo que prueban es que el
  cableado NO los rompió. Los que certifican AC-1/AC-2/AC-3 son los 5 de arriba.

## Los dos sitios, medidos por separado

| `it` | Sale por | `return` |
|---|---|---|
| `T-335-DIRECT-4XX` / `T-335-DIRECT-5XX` / `T-335-NOLEAK` | camino DIRECTO (`mockRegen` no se llama, `error` sin `after retry`) | `compose.ts:1189` |
| `T-335-RETRY` / `T-335-RETRY-5XX` | camino CON RETRY (`error` contiene `after retry`) | `compose.ts:1158` |

Los dos sitios están en rojo ⇒ ninguno de los dos estaba cubierto antes del fix
(CD-6). Un solo `return` cableado dejaría la mitad de esta tabla en rojo.
