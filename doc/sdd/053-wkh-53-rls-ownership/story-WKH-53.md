# Story File — WKH-53 Supabase RLS + Ownership Checks en queries

> **⚠️ ESTA ES LA ÚNICA FUENTE DE VERDAD PARA EL DEV EN F3.**
> No abras el SDD ni el work-item. Todo lo que necesitás está acá.

---

## Header

| Campo | Valor |
|-------|-------|
| HU-ID | **WKH-53** |
| Title | Supabase RLS + ownership checks en queries (Fase A — app-layer only) |
| Branch | `feat/wkh-53-rls-ownership` |
| Base | `main` @ `87f0053` (WKH-52 PYUSD merged) |
| Tipo | security |
| Mode | QUALITY (AR + CR obligatorios) |
| Estimación F3 | **M (2.5–3h)** |
| Pipeline | F2.5 ✅ → **F3 Dev** → AR → CR → F4 QA → DONE |
| HU_APPROVED | 2026-04-22 (humano) |
| SPEC_APPROVED | 2026-04-22 (orquestador AUTO mode) |
| Story File approved | 2026-04-22 (Architect F2.5) |

---

## 1. Contexto condensado (leé esto primero)

### ¿Cuál es el bug?

El cliente de Supabase (`src/lib/supabase.ts:12`) usa `SUPABASE_SERVICE_KEY` que
**bypassea RLS**. Dos servicios hacen queries sobre `a2a_agent_keys` **sin
filtrar por owner**:

- `budgetService.getBalance(keyId, chainId)` — línea `src/services/budget.ts:15-26`. Cualquier caller autenticado con `x-a2a-key` puede leer el balance de **cualquier** `keyId` de otro owner si lo conoce.
- `identityService.deactivate(keyId)` — línea `src/services/identity.ts:78-86`. Mismo vector: puede desactivar key ajena.

### ¿Qué vector cerramos?

Cross-tenant data leak (IDOR — Insecure Direct Object Reference) a nivel
aplicación. Defensa-en-profundidad **mientras** no exista RLS real a nivel
Postgres (trackeado en WKH-SEC-02).

### ¿Qué hacemos concretamente?

1. Agregar `ownerId: string` al final de la firma de `getBalance` y `deactivate`.
2. Agregar `.eq('owner_ref', ownerId)` al chain de supabase en ambas queries.
3. Detectar cross-owner (0 rows) → lanzar `OwnershipMismatchError` tipado.
4. Loguear el intento con PII redacción (hash SHA-256 truncado).
5. Actualizar el único caller productivo: `src/middleware/a2a-key.ts:196`.
6. Crear suite de seguridad `src/services/security/ownership.test.ts`.
7. Documentar la regla en `CLAUDE.md`.

**NO tocamos**: migrations SQL, RPC `increment_a2a_key_spend`, tabla `tasks`,
tabla `a2a_events`, tabla `registries`, ni el auth model. Todo eso es WKH-54
(Fase B) o WKH-SEC-02.

---

## 2. Current state → Target state

### `src/services/budget.ts` — método `getBalance`

**Current (líneas 15-26):**
```ts
async getBalance(keyId: string, chainId: number): Promise<string> {
  const { data, error } = await supabase
    .from('a2a_agent_keys')
    .select('budget')
    .eq('id', keyId)
    .single();

  if (error) throw new Error(`Failed to get balance: ${error.message}`);

  const budget = (data as Pick<A2AAgentKeyRow, 'budget'>).budget;
  return budget[chainId.toString()] ?? '0';
},
```

**Target:**
```ts
async getBalance(keyId: string, chainId: number, ownerId: string): Promise<string> {
  const { data, error } = await supabase
    .from('a2a_agent_keys')
    .select('budget')
    .eq('id', keyId)
    .eq('owner_ref', ownerId)   // <- NEW (DD-5: id primero, owner_ref después)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      logOwnershipMismatch('getBalance', keyId, ownerId);
      throw new OwnershipMismatchError();
    }
    throw new Error(`Failed to get balance: ${error.message}`);
  }

  const budget = (data as Pick<A2AAgentKeyRow, 'budget'>).budget;
  return budget[chainId.toString()] ?? '0';
},
```

### `src/services/identity.ts` — método `deactivate`

**Current (líneas 78-86):**
```ts
async deactivate(keyId: string): Promise<void> {
  const { error } = await supabase
    .from('a2a_agent_keys')
    .update({ is_active: false })
    .eq('id', keyId);

  if (error)
    throw new Error(`Failed to deactivate agent key: ${error.message}`);
},
```

**Target:**
```ts
async deactivate(keyId: string, ownerId: string): Promise<void> {
  const { data, error } = await supabase
    .from('a2a_agent_keys')
    .update({ is_active: false })
    .eq('id', keyId)
    .eq('owner_ref', ownerId)   // <- NEW
    .select('id');               // <- NEW (DD-2: necesario para detectar 0 rows)

  if (error)
    throw new Error(`Failed to deactivate agent key: ${error.message}`);

  if (!data || data.length === 0) {
    logOwnershipMismatch('deactivate', keyId, ownerId);
    throw new OwnershipMismatchError();
  }
},
```

### `src/middleware/a2a-key.ts` — línea 196

**Current (líneas 196-199):**
```ts
const postDebitBalance = await budgetService.getBalance(
  keyRow.id,
  chainId,
);
```

**Target:**
```ts
const postDebitBalance = await budgetService.getBalance(
  keyRow.id,
  chainId,
  keyRow.owner_ref,   // <- NEW
);
```

### Archivos nuevos

- `src/services/security/errors.ts` (**crear**, ~35 líneas)
- `src/services/security/ownership.test.ts` (**crear**, 6 tests)

---

## 3. Constraint Directives compiladas (14 total)

Heredados del work-item (CD-1 a CD-7) y del SDD (CD-A1 a CD-A7). **No podés
violar ninguno. Citados literal.**

### Del work-item

- **CD-1**: PROHIBIDO cambiar el auth model — sigue siendo `x-a2a-key` + `identityService.lookupByHash`. NO introducir JWT ni sesiones Supabase.
- **CD-2**: PROHIBIDO refactorizar servicios completos — solo agregar `.eq('owner_ref', ownerId)` y ajustar las firmas de los métodos afectados. La lógica de negocio existente NO se toca.
- **CD-3**: OBLIGATORIO TypeScript strict — sin `any` explícito. El parámetro `ownerId` es `string` (no `string | undefined`). Si un caller no tiene `owner_ref`, es un error de programación, no un caso manejable silenciosamente.
- **CD-4**: OBLIGATORIO ≥1 test negativo por operación protegida en `ownership.test.ts`. "Negativo" = test que afirma que un owner ajeno recibe vacío/error, nunca data del otro owner.
- **CD-5**: PROHIBIDO tocar migrations SQL de RLS (fuera de scope — candidato a TD-SEC-01).
- **CD-6**: OBLIGATORIO actualizar todos los callers de `getBalance` e `deactivate` que no pasen `ownerId` — el compilador TypeScript (strict) detectará los callers rotos si la firma cambia correctamente.
- **CD-7**: El nuevo test suite DEBE vivir en `src/services/security/` (separado de los tests unitarios funcionales existentes) para que sea identificable como "security test suite" en el pipeline de CI.

### Del SDD (Architect F2)

- **CD-A1 (Test Mock Fidelity — Auto-Blindaje heredado)**: el mock del chain de supabase debe replicar **EXACTAMENTE** la cadena del impl. Si el impl hace `.select().eq().eq().single()`, el mock debe replicar esos 4 métodos, ni más ni menos. Si el impl hace `.update({...}).eq().eq().select('id')`, el mock debe replicar. Referencia: **AB-WKH-44 auto-blindaje#2** (`doc/sdd/044-wkh-44-protocol-fee/auto-blindaje.md:27–46`).
- **CD-A2 (Error de ownership es tipado)**: PROHIBIDO lanzar `new Error('...')` genérico cuando detectás cross-owner. OBLIGATORIO usar `new OwnershipMismatchError(...)` importado desde `src/services/security/errors.ts`.
- **CD-A3 (PII redaction en logs)**: PROHIBIDO loggear `keyId` completo o `ownerId` completo en claro cuando se detecta cross-owner. OBLIGATORIO hashear con `crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)` antes de loggear. Aplica solo al path de `OwnershipMismatchError` (los logs normales del flujo no cambian).
- **CD-A4 (No tocar tests fuera de scope)**: PROHIBIDO modificar tests de `createKey`, `lookupByHash`, `debit`, `registerDeposit` — esos tests NO deben romperse por este cambio. Si se rompen, es señal de un refactor fuera de scope (violación de CD-2).
- **CD-A5 (Firma exacta)**: la firma nueva DEBE ser:
  ```ts
  getBalance(keyId: string, chainId: number, ownerId: string): Promise<string>
  deactivate(keyId: string, ownerId: string): Promise<void>
  ```
  — no `ownerId?: string`, no genéricos, no overloads. Parámetro `ownerId` siempre al final (extensión aditiva).
- **CD-A6 (Mensaje de error estandarizado)**: cuando `OwnershipMismatchError` se lanza, el `message` debe ser literalmente `"Ownership mismatch"` (sin interpolación del keyId ni ownerId, que son PII). El `code` del error es `'OWNERSHIP_MISMATCH'`. Ambos valores son strings fijos, testeables por equality exacta.
- **CD-A7 (Baseline de tests — zero regression)**: al terminar cada wave, el comando `npm run test` DEBE pasar el 100% de los tests (incluyendo los no modificados). Es el primer filtro de regresión antes de cerrar cada wave.

---

## 4. Waves detalladas

### W0 — Baseline (serial, obligatoria)

**Objetivo**: confirmar baseline verde antes de tocar nada.

**Comandos**:
```bash
git checkout main
git pull origin main
git checkout -b feat/wkh-53-rls-ownership
npm ci
npm run lint
npx tsc --noEmit
npm test
```

**Criterio de éxito**: los 4 últimos comandos exit code 0.

**Archivos afectados**: ninguno.

**Commit**: ninguno (solo verificación).

**Si algo falla en W0 → STOP, escalar. No es problema de esta HU.**

---

### W1 — `budget.ts` + `a2a-key.ts` middleware + sus tests (serial)

**Objetivo**: extender `getBalance` con ownership guard + actualizar único caller productivo + tests.

**Archivos afectados** (orden recomendado de edición):

1. `src/services/security/errors.ts` — **crear** (ver §6 contenido exacto)
2. `src/services/budget.ts` — modificar `getBalance` (líneas 15-26). Importar `OwnershipMismatchError, logOwnershipMismatch` desde `./security/errors.js`.
3. `src/middleware/a2a-key.ts:196-199` — agregar 3er argumento `keyRow.owner_ref` a la llamada.
4. `src/services/budget.test.ts` — actualizar los 3 tests existentes de `describe('getBalance')` (líneas 48-91) + agregar 1 test negativo nuevo.
5. `src/middleware/a2a-key.test.ts` — ajustar asserts de `toHaveBeenCalledWith` donde tocan `mockGetBalance`.

**Cambios exactos**:

#### `src/services/security/errors.ts` (NUEVO)
Ver §6. Copiar tal cual.

#### `src/services/budget.ts`
- Agregar import arriba (después del `import type`):
  ```ts
  import { OwnershipMismatchError, logOwnershipMismatch } from './security/errors.js';
  ```
- Reemplazar método `getBalance` completo con el bloque de **Target state** (§2).

#### `src/middleware/a2a-key.ts:196`
- Reemplazar la llamada. Ver §2 Target state.

#### `src/services/budget.test.ts`
- Los 3 tests existentes de `describe('getBalance')`:
  - `'returns "0" for missing chain entry (AC-8)'` (línea 49)
  - `'returns correct balance for existing chain (AC-8)'` (línea 63)
  - `'throws on DB error'` (línea 77)

  → cambiar llamadas `budgetService.getBalance('key-1', 2368)` por `budgetService.getBalance('key-1', 2368, 'user-1')`.
  → cambiar `budgetService.getBalance('x', 1)` por `budgetService.getBalance('x', 1, 'user-1')`.
  (Los mocks del chain NO requieren cambios — `.eq()` ya devuelve `this` y soporta 2 llamadas.)

- Agregar test nuevo dentro de `describe('getBalance')`:
  ```ts
  it('throws OwnershipMismatchError when owner mismatch (AC-3)', async () => {
    const mock = chainMock();
    mock.single = vi.fn().mockResolvedValue({
      data: null,
      error: { code: 'PGRST116', message: 'no rows' },
    });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(
      budgetService.getBalance('key-of-other-owner', 2368, 'user-A'),
    ).rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' });

    expect(mock.eq).toHaveBeenCalledWith('owner_ref', 'user-A');
  });
  ```

#### `src/middleware/a2a-key.test.ts`
- Buscar `toHaveBeenCalledWith` con `mockGetBalance` o `getBalance`.
- Donde hoy verifique `toHaveBeenCalledWith(<keyId>, <chainId>)`, cambiar a `toHaveBeenCalledWith(<keyId>, <chainId>, 'user-1')` (el `owner_ref` del `TEST_KEY_ID` fixture hardcodeado en ese test — línea 90 del test file).
- **Sólo** los asserts que tocan `getBalance`. NO tocar asserts de `debit` ni de otros mocks.

**Tests de la wave (qué assertear)**:

| Test | Aserción clave |
|------|----------------|
| `'throws OwnershipMismatchError when owner mismatch (AC-3)'` (NUEVO en `budget.test.ts`) | `rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' })` + `mock.eq` llamado con `('owner_ref', 'user-A')` |
| 3 tests existentes de getBalance | que sigan pasando con el 3er arg `'user-1'` agregado |
| asserts de middleware a2a-key.test.ts | `mockGetBalance` fue llamado con 3 args incluyendo `'user-1'` |

**Criterio de éxito W1**:
```bash
npx tsc --noEmit                        # 0 errores
npm test -- src/services/budget.test.ts # PASS
npm test -- src/middleware/a2a-key.test.ts # PASS
npm test                                 # PASS 100% (zero regression — CD-A7)
grep -rn "getBalance(" src/ | grep -v test | grep -v "^\s*//"  # solo el caller del middleware con 3 args
```

**Commit sugerido (literal)**:
```
feat(WKH-53 W1): owner-ref guard en getBalance + caller middleware

- budgetService.getBalance recibe ownerId y filtra por owner_ref
- OwnershipMismatchError + logOwnershipMismatch (PII-safe) en security/errors.ts
- a2a-key middleware propaga keyRow.owner_ref
- tests de getBalance + a2a-key actualizados + test negativo cross-owner

Refs: WKH-53 CD-A1/A2/A3/A5/A6
```

---

### W2 — `identity.ts` `deactivate` + sus tests (serial)

**Objetivo**: extender `deactivate` con ownership guard + detectar 0-rows-updated → throw.

**Archivos afectados**:

1. `src/services/identity.ts` — modificar `deactivate` (líneas 78-86). Importar `OwnershipMismatchError, logOwnershipMismatch` desde `./security/errors.js` (agregar al top).
2. `src/services/identity.test.ts` — actualizar los 2 tests de `describe('deactivate')` (líneas 195-223) + agregar 1 negativo cross-owner.

**Cambios exactos**:

#### `src/services/identity.ts`
- Agregar import en el top del archivo (seguir el orden alfabético/convencional existente):
  ```ts
  import { OwnershipMismatchError, logOwnershipMismatch } from './security/errors.js';
  ```
- Reemplazar método `deactivate` completo con el bloque de **Target state** (§2).

#### `src/services/identity.test.ts`
- Los 2 tests existentes de `describe('deactivate')` (líneas 195-223) usan el chain `mock.update(...).eq(...) → promise`. Con `.select('id')` agregado, **la promesa se resuelve desde `.select()`**, no desde `.eq()`. Actualizar el setup del mock.

- Test 1 (positivo) reescrito:
  ```ts
  it('calls update with is_active = false AND owner_ref filter (AC-4)', async () => {
    const mock = chainMock();
    const mockUpdate = vi.fn().mockReturnValue(mock);
    mock.update = mockUpdate;
    mock.select = vi.fn().mockResolvedValue({
      data: [{ id: 'key-id-1' }],
      error: null,
    });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await identityService.deactivate('key-id-1', 'user-A');

    expect(mockUpdate).toHaveBeenCalledWith({ is_active: false });
    expect(mock.eq).toHaveBeenCalledWith('id', 'key-id-1');
    expect(mock.eq).toHaveBeenCalledWith('owner_ref', 'user-A');
  });
  ```

- Test 2 (negativo cross-owner, NUEVO):
  ```ts
  it('throws OwnershipMismatchError when owner mismatch (AC-4)', async () => {
    const mock = chainMock();
    mock.update = vi.fn().mockReturnValue(mock);
    mock.select = vi.fn().mockResolvedValue({ data: [], error: null });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(
      identityService.deactivate('other-key', 'user-A'),
    ).rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' });
  });
  ```

- Test 3 (error de DB, ajustado):
  ```ts
  it('throws on DB error', async () => {
    const mock = chainMock();
    mock.update = vi.fn().mockReturnValue(mock);
    mock.select = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'fail' },
    });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(identityService.deactivate('x', 'user-A')).rejects.toThrow(
      'Failed to deactivate agent key: fail',
    );
  });
  ```

**NO tocar** los tests de `createKey` ni `lookupByHash` (CD-A4).

**Criterio de éxito W2**:
```bash
npx tsc --noEmit                          # 0 errores
npm test -- src/services/identity.test.ts # PASS
npm test                                   # PASS 100% (CD-A7)
grep -rn "identityService.deactivate(" src/ | grep -v test  # 0 resultados (caller productivo no existe)
```

**Commit sugerido (literal)**:
```
feat(WKH-53 W2): owner-ref guard en identityService.deactivate

- deactivate recibe ownerId y filtra por owner_ref
- detección de 0-rows-updated via .select('id') → OwnershipMismatchError (DD-2)
- tests de deactivate actualizados + negativo cross-owner

Refs: WKH-53 CD-A1/A2/A5/A6
```

---

### W3 — Security test suite (serial, depende de W1+W2)

**Objetivo**: crear `src/services/security/ownership.test.ts` como suite
consolidado + auditable por AR (CD-7 del work-item).

**Archivo afectado**:
1. `src/services/security/ownership.test.ts` (**crear**)

**Contenido completo del archivo**:

```ts
/**
 * Security Suite — Ownership Guard (WKH-53)
 *
 * Verifica defensa contra cross-tenant access en a2a_agent_keys.
 * Estos tests DEBEN fallar si alguien quita el .eq('owner_ref', ...) de
 * los services modificados.
 *
 * Scope: getBalance + deactivate (ambos en a2a_agent_keys con owner_ref).
 * NOTA: debit/registerDeposit NO están aquí por DD-6 — la RPC PG no verifica
 * owner_ref, y agregar tests "verdes" acá sería engañoso. Residual risk
 * trackeado en WKH-54.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

import { supabase } from '../../lib/supabase.js';
import { budgetService } from '../budget.js';
import { identityService } from '../identity.js';

const mockFrom = vi.mocked(supabase.from);

// ── Helper — chainMock (fidelity CD-A1) ─────────────────────
function chainMock(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides,
  };
  for (const key of ['select', 'update', 'eq']) {
    if (!overrides[key]) {
      (chain[key] as ReturnType<typeof vi.fn>).mockReturnValue(chain);
    }
  }
  return chain;
}

const OWNER_A = 'owner-A-uuid';
const OWNER_B = 'owner-B-uuid';
const KEY_OF_A = 'key-belongs-to-A';
const KEY_OF_B = 'key-belongs-to-B';

// ── Suite 1: getBalance ─────────────────────────────────────
describe('Ownership Guard — budgetService.getBalance', () => {
  beforeEach(() => vi.clearAllMocks());

  it('owner A cannot read balance of owner B — rejects with OwnershipMismatchError (AC-1)', async () => {
    const mock = chainMock();
    // Supabase simula "no rows" cuando id=KEY_OF_B y owner_ref=OWNER_A no matchea.
    mock.single = vi.fn().mockResolvedValue({
      data: null,
      error: { code: 'PGRST116', message: 'no rows' },
    });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(
      budgetService.getBalance(KEY_OF_B, 2368, OWNER_A),
    ).rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' });
  });

  it('calls .eq("owner_ref", ownerId) on the query chain (AC-3)', async () => {
    const mock = chainMock();
    mock.single = vi.fn().mockResolvedValue({
      data: { budget: { '2368': '5.00' } },
      error: null,
    });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await budgetService.getBalance(KEY_OF_A, 2368, OWNER_A);

    expect(mock.eq).toHaveBeenCalledWith('id', KEY_OF_A);
    expect(mock.eq).toHaveBeenCalledWith('owner_ref', OWNER_A);
  });

  it('owner A reads own balance successfully (AC-6)', async () => {
    const mock = chainMock();
    mock.single = vi.fn().mockResolvedValue({
      data: { budget: { '2368': '42.00' } },
      error: null,
    });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    const balance = await budgetService.getBalance(KEY_OF_A, 2368, OWNER_A);
    expect(balance).toBe('42.00');
  });
});

// ── Suite 2: deactivate ─────────────────────────────────────
describe('Ownership Guard — identityService.deactivate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('owner A cannot deactivate key of owner B — rejects with OwnershipMismatchError (AC-2)', async () => {
    const mock = chainMock();
    mock.update = vi.fn().mockReturnValue(mock);
    // UPDATE cross-owner → afecta 0 rows, no error.
    mock.select = vi.fn().mockResolvedValue({ data: [], error: null });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(
      identityService.deactivate(KEY_OF_B, OWNER_A),
    ).rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' });
  });

  it('calls .eq("owner_ref", ownerId) on the UPDATE chain (AC-4)', async () => {
    const mock = chainMock();
    mock.update = vi.fn().mockReturnValue(mock);
    mock.select = vi.fn().mockResolvedValue({
      data: [{ id: KEY_OF_A }],
      error: null,
    });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await identityService.deactivate(KEY_OF_A, OWNER_A);

    expect(mock.eq).toHaveBeenCalledWith('id', KEY_OF_A);
    expect(mock.eq).toHaveBeenCalledWith('owner_ref', OWNER_A);
  });

  it('owner A deactivates own key successfully (AC-6)', async () => {
    const mock = chainMock();
    mock.update = vi.fn().mockReturnValue(mock);
    mock.select = vi.fn().mockResolvedValue({
      data: [{ id: KEY_OF_A }],
      error: null,
    });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(
      identityService.deactivate(KEY_OF_A, OWNER_A),
    ).resolves.toBeUndefined();
  });
});
```

**Criterio de éxito W3**:
```bash
npm test -- src/services/security/ownership.test.ts  # PASS 6/6
npm test                                               # PASS 100% (CD-A7)
```

**Commit sugerido (literal)**:
```
test(WKH-53 W3): security suite ownership.test.ts

- 6 tests: 2 negativos cross-owner + 2 chain assertions + 2 positivos
- vive en src/services/security/ (CD-7 del work-item)
- referencia obligatoria para AR + CR

Refs: WKH-53 AC-5, AC-6, CD-4, CD-7
```

---

### W4 — Documentación `CLAUDE.md` (serial o paralelizable con W3)

**Objetivo**: agregar sección **Security Conventions — Ownership Guard** a
`CLAUDE.md` como guardrail para PRs futuros (AC-8).

**Archivo afectado**:
1. `CLAUDE.md` (raíz del repo — agregar al final, después de la sección "Reglas de proceso — NexusAgil QUALITY")

**Contenido exacto a agregar**: ver §7 de este story file (copiar tal cual).

**Criterio de éxito W4**:
```bash
grep -F "Security Conventions — Ownership Guard" CLAUDE.md  # match
grep -F "owner_ref" CLAUDE.md                                # match múltiple
```

**Commit sugerido (literal)**:
```
docs(WKH-53 W4): CLAUDE.md — Security Conventions — Ownership Guard

- Regla obligatoria: toda query sobre a2a_agent_keys lleva owner_ref filter
- Ejemplo OK vs MAL
- Señal para AR / CR
- Tabla de tablas con ownership (fase A vs fase B)

Refs: WKH-53 AC-8
```

---

### Resumen de waves

| Wave | Duración | Archivos tocados | Tests nuevos | Tests modificados | Commits |
|------|---------:|-----------------:|-------------:|------------------:|--------:|
| W0 | 10 min | 0 | 0 | 0 | 0 |
| W1 | 60-80 min | 5 | 1 | 3 + asserts middleware | 1 |
| W2 | 40-60 min | 2 | 1 | 2 | 1 |
| W3 | 45-60 min | 1 | 6 | 0 | 1 |
| W4 | 10 min | 1 | 0 | 0 | 1 |
| **Total** | **~2.5-3h** | **9 únicos** | **8 nuevos** | **6 modificados** | **4** |

---

## 5. Test catalog completo (8 nuevos + 6 modificados)

### Tests NUEVOS (8)

| # | Archivo | Nombre | AC cubierto | Mock setup | Aserción clave |
|---|---------|--------|-------------|------------|----------------|
| N1 | `src/services/budget.test.ts` | `throws OwnershipMismatchError when owner mismatch (AC-3)` | AC-3 | `mock.single → { data: null, error: { code: 'PGRST116' } }` | `rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' })` + `mock.eq` llamado con `('owner_ref', 'user-A')` |
| N2 | `src/services/identity.test.ts` | `throws OwnershipMismatchError when owner mismatch (AC-4)` | AC-4 | `mock.select → { data: [], error: null }` | `rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' })` |
| N3 | `src/services/security/ownership.test.ts` | `owner A cannot read balance of owner B — rejects with OwnershipMismatchError (AC-1)` | AC-1 | `mock.single → PGRST116` | `rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' })` |
| N4 | `src/services/security/ownership.test.ts` | `calls .eq("owner_ref", ownerId) on the query chain (AC-3)` | AC-3 | `mock.single → { data: { budget: {...} } }` | `mock.eq.toHaveBeenCalledWith('owner_ref', OWNER_A)` |
| N5 | `src/services/security/ownership.test.ts` | `owner A reads own balance successfully (AC-6)` | AC-6 | `mock.single → { data: { budget: { '2368': '42.00' } } }` | `balance === '42.00'` |
| N6 | `src/services/security/ownership.test.ts` | `owner A cannot deactivate key of owner B — rejects with OwnershipMismatchError (AC-2)` | AC-2 | `mock.select → { data: [], error: null }` | `rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' })` |
| N7 | `src/services/security/ownership.test.ts` | `calls .eq("owner_ref", ownerId) on the UPDATE chain (AC-4)` | AC-4 | `mock.select → { data: [{ id: KEY_OF_A }], error: null }` | `mock.eq.toHaveBeenCalledWith('owner_ref', OWNER_A)` |
| N8 | `src/services/security/ownership.test.ts` | `owner A deactivates own key successfully (AC-6)` | AC-6 | `mock.select → { data: [{ id: KEY_OF_A }], error: null }` | `resolves.toBeUndefined()` |

### Tests MODIFICADOS (6)

| # | Archivo | Test | Cambio exacto | AC |
|---|---------|------|--------------|----|
| M1 | `src/services/budget.test.ts` | `returns "0" for missing chain entry (AC-8)` | `getBalance('key-1', 2368)` → `getBalance('key-1', 2368, 'user-1')` | AC-7 |
| M2 | `src/services/budget.test.ts` | `returns correct balance for existing chain (AC-8)` | ídem | AC-7 |
| M3 | `src/services/budget.test.ts` | `throws on DB error` | `getBalance('x', 1)` → `getBalance('x', 1, 'user-1')` | AC-7 |
| M4 | `src/services/identity.test.ts` | test 1 de `describe('deactivate')` | reescribir: firma con `'user-A'`, mock con `.select('id')` que resuelve promesa | AC-4, AC-7 |
| M5 | `src/services/identity.test.ts` | test 2 de `describe('deactivate')` (throws on DB error) | ajustar mock: promesa resuelve desde `.select`, no `.eq` | AC-7 |
| M6 | `src/middleware/a2a-key.test.ts` | asserts de `mockGetBalance` | `toHaveBeenCalledWith(kid, chainId)` → `toHaveBeenCalledWith(kid, chainId, 'user-1')` | AC-7 |

---

## 6. `OwnershipMismatchError` + `logOwnershipMismatch` — código exacto

Archivo: `src/services/security/errors.ts` (NUEVO). Copiar literal:

```ts
/**
 * Security Errors — WKH-53
 *
 * Central tipo de error para ownership guards en app-layer.
 * PROHIBIDO lanzar new Error('...') genérico en paths de ownership (CD-A2).
 */
import crypto from 'node:crypto';

export class OwnershipMismatchError extends Error {
  readonly code = 'OWNERSHIP_MISMATCH' as const;
  constructor() {
    super('Ownership mismatch');
    this.name = 'OwnershipMismatchError';
  }
}

/**
 * PII-safe logger para cross-owner attempts.
 * Loguea hash SHA-256 truncado — nunca el keyId/ownerId en claro (CD-A3).
 */
export function logOwnershipMismatch(
  op: 'getBalance' | 'deactivate',
  keyId: string,
  ownerId: string,
): void {
  const hash = (v: string): string =>
    crypto.createHash('sha256').update(v).digest('hex').slice(0, 16);
  console.warn('[security] ownership mismatch', {
    op,
    keyIdHash: hash(keyId),
    ownerIdHash: hash(ownerId),
    ts: new Date().toISOString(),
  });
}
```

**Reglas no-negociables de este archivo**:
- `message` literal = `"Ownership mismatch"` (CD-A6)
- `code` literal = `'OWNERSHIP_MISMATCH'` (as const, readonly)
- `name` literal = `"OwnershipMismatchError"`
- Hash truncado a **16 chars hex** (no más, no menos)
- Nivel log = `console.warn` (no `error`, no `log`, no `fastify.log`)
- Prefijo log = `'[security] ownership mismatch'` (exacto)
- Campos del log = `{ op, keyIdHash, ownerIdHash, ts }` (nada más, nada menos)

---

## 7. `CLAUDE.md` — sección exacta a agregar (W4)

Agregar al **final** de `CLAUDE.md` (después de la sección "Reglas de proceso —
NexusAgil QUALITY", línea ~127 aprox. — agregar `---` como separator).

Copiar el bloque siguiente **literal** (incluyendo markdown):

````markdown
---

## Security Conventions — Ownership Guard

**Regla obligatoria (WKH-53):** toda query o mutación sobre `a2a_agent_keys`
hecha desde `src/services/` DEBE filtrar por `owner_ref` además del `id`.

El cliente de Supabase usa `SUPABASE_SERVICE_ROLE_KEY`, que **bypassea RLS**.
Por eso el ownership check vive en la capa de aplicación: si un service hace
`.eq('id', keyId)` sin cruzar con `.eq('owner_ref', callerOwnerRef)`, cualquier
caller autenticado puede leer o modificar datos de otro owner (IDOR).

### Patrón obligatorio

```ts
// OK
async getBalance(keyId: string, chainId: number, ownerId: string): Promise<string> {
  const { data, error } = await supabase
    .from('a2a_agent_keys')
    .select('budget')
    .eq('id', keyId)
    .eq('owner_ref', ownerId)   // <- imprescindible
    .single();
  if (error?.code === 'PGRST116') throw new OwnershipMismatchError();
  // ...
}

// MAL — cross-tenant leak
async getBalance(keyId: string, chainId: number): Promise<string> {
  const { data } = await supabase
    .from('a2a_agent_keys')
    .select('budget')
    .eq('id', keyId)
    .single();
  // sin .eq('owner_ref', ...) → cualquier owner puede leer cualquier balance
}
```

### Cómo obtener el `ownerId`

En rutas autenticadas post-middleware `requirePaymentOrA2AKey`, el row del
caller está en `request.a2aKeyRow`. El `owner_ref` se pasa como argumento
al service:

```ts
const balance = await budgetService.getBalance(
  keyRow.id,
  chainId,
  keyRow.owner_ref,  // <- el owner_ref del caller autenticado
);
```

### Qué debe detectar Adversary Review (AR) / Code Review (CR)

En cualquier PR que modifique `src/services/*.ts` y toque queries sobre
`a2a_agent_keys`:

1. Buscar `.from('a2a_agent_keys')` y verificar que la cadena incluye
   `.eq('owner_ref', <value>)` antes del `.single()` / `.maybeSingle()` /
   resolución de la promise.
2. Si el service agrega una nueva función que recibe un `keyId`, su firma
   DEBE incluir un `ownerId: string` (no `string | undefined`).
3. Si detectás una violación, marcalo **BLOQUEANTE** en el AR. El bug es
   equivalente a un IDOR (Insecure Direct Object Reference).

### Tablas con ownership en app-layer (hoy)

| Tabla | Columna owner | Protegida en services |
|-------|--------------|----------------------|
| `a2a_agent_keys` | `owner_ref` | SI (WKH-53) |
| `tasks` | — (no tiene, pending WKH-54) | no |
| `a2a_events` | — (telemetría global) | N/A |
| `registries` | — (admin global) | N/A |

### RLS real (Postgres-level)

Hoy la defensa es **solo app-layer**. El plan de `ALTER TABLE a2a_agent_keys
ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` está trackeado en **WKH-SEC-02**
(TD-SEC-01). Hasta que se implemente, la app es la única línea de defensa.
La **Fase B** (WKH-54) agrega `owner_ref` a `tasks` + RPC update.
````

---

## 8. Readiness Check pre-F3 (Dev ejecuta esto antes de W1)

Marcá cada checkbox **con el comando ejecutado y su output en el log
de la wave**. Si alguno falla, **STOP** y escalá al orquestador.

### Preparación de la branch
- [ ] `pwd` → `/home/ferdev/.openclaw/workspace/wasiai-a2a`
- [ ] `git status` → working tree clean (sin cambios uncommitted relevantes)
- [ ] `git checkout main && git pull origin main` → HEAD @ `87f0053` o más reciente
- [ ] `git checkout -b feat/wkh-53-rls-ownership` → branch creada
- [ ] `git branch -a | grep feat/wkh-53-rls-ownership` → presente local

### Baseline verde (W0)
- [ ] `npm ci` → exit 0, dependencias instaladas
- [ ] `npm run lint` → exit 0 (Biome clean)
- [ ] `npx tsc --noEmit` → exit 0 (TypeScript strict clean)
- [ ] `npm test` → exit 0 (100% tests pasan)

### Environment
- [ ] `.env` existe en la raíz (no commiteado) con `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` + `ANTHROPIC_API_KEY` (al menos para que los tests no aborten por env vars faltantes)
- [ ] `cat .env | grep SUPABASE_SERVICE_KEY | head -c 25` → muestra el prefijo (no el secreto completo)

### Contexto de lectura
- [ ] Leíste este story file completo (§1 a §11)
- [ ] Entendiste los 14 CDs (§3) y que **no podés** violar ninguno
- [ ] Entendiste las 4 waves (§4) y el orden obligatorio W0 → W1 → W2 → W3 → W4
- [ ] Sabés que al cerrar cada wave corrés `npm test` completo (CD-A7)

### Branches remotas conflictivas
- [ ] `git branch -r | grep -E "(wkh-53|ownership)"` → no hay remotas conflictivas activas

**Sólo cuando TODOS los checkboxes estén marcados → arrancá W1.**

---

## 9. Anti-Hallucination Contract (NO inventar)

El Dev NO debe inventar ni adivinar estos valores. Si la implementación
los cambia, es **violación de CD** y el AR los va a marcar BLOQUEANTE:

| Elemento | Valor exacto | NO usar |
|----------|-------------|---------|
| Nombre de columna owner | `owner_ref` | ❌ `owner_id`, `user_id`, `agent_key_id`, `owner` |
| Clase de error | `OwnershipMismatchError` | ❌ `AuthError`, `ForbiddenError`, `UnauthorizedError`, `IDORError` |
| Mensaje del error | `"Ownership mismatch"` (literal, sin interpolación) | ❌ `"Ownership mismatch for key X"`, `"Forbidden"`, `"Not found"` |
| `code` del error | `'OWNERSHIP_MISMATCH'` (readonly, as const) | ❌ `'FORBIDDEN'`, `'NOT_FOUND'`, `'PGRST116'` |
| `name` del error | `"OwnershipMismatchError"` | ❌ default `"Error"` |
| Firma `getBalance` | `(keyId: string, chainId: number, ownerId: string): Promise<string>` | ❌ `ownerId?: string`, `chainId: string`, args reordenados |
| Firma `deactivate` | `(keyId: string, ownerId: string): Promise<void>` | ❌ `ownerId?: string`, args reordenados |
| Caller a actualizar | **SOLO** `src/middleware/a2a-key.ts:196-199` | ❌ No hay otros callers productivos. Si encontrás otro, confirmá con grep — probablemente es un test. |
| Archivo suite security | `src/services/security/ownership.test.ts` | ❌ `src/__tests__/...`, `src/services/ownership.security.test.ts`, `tests/...` |
| Archivo errors | `src/services/security/errors.ts` | ❌ `src/types/errors.ts`, `src/lib/errors.ts` |
| PII hash algo | SHA-256, truncado a 16 chars hex | ❌ MD5, SHA-1, base64, sin truncar, truncar a 8 o 32 |
| Log level | `console.warn` | ❌ `console.error`, `console.log`, `fastify.log.warn` |
| Log prefix | `'[security] ownership mismatch'` (exacto) | ❌ otros prefijos |
| Log fields | `{ op, keyIdHash, ownerIdHash, ts }` | ❌ agregar `keyId`, `ownerId` en claro (VIOLA CD-A3) |
| Import path | `./security/errors.js` (desde `budget.ts`/`identity.ts`) y `./errors.js` (desde `ownership.test.ts`) | ❌ path aliases, require absolutos |
| Orden de `.eq()` chain | `.eq('id', keyId).eq('owner_ref', ownerId)` (id primero) | ❌ owner_ref primero (rompe diff review — DD-5) |
| `deactivate` — detectar 0 rows | `.select('id')` + check `data.length === 0` | ❌ `.select('*')`, check `!data`, check length de otra col |

### Valores de tests (no inventar)

| Elemento | Valor exacto |
|----------|-------------|
| `ownerId` en tests de `budget.test.ts` existentes | `'user-1'` (match con fixture del middleware a2a-key.test.ts:90) |
| `ownerId` en tests nuevos de `budget.test.ts` | `'user-A'` (negativo cross-owner) |
| `ownerId` en tests de `identity.test.ts` | `'user-A'` |
| `OWNER_A` / `OWNER_B` en ownership.test.ts | `'owner-A-uuid'` / `'owner-B-uuid'` |
| `KEY_OF_A` / `KEY_OF_B` en ownership.test.ts | `'key-belongs-to-A'` / `'key-belongs-to-B'` |
| `chainId` default | `2368` (Kite testnet — patrón del codebase) |

---

## 10. Scope OUT — lo que el Dev debe RECHAZAR

Si durante F3 el humano o AR pide cualquiera de estos, el Dev responde
**"Fuera de scope — WKH-XX"** y NO lo implementa en esta HU:

| Pedido | Razón | Tracked en |
|--------|-------|-----------|
| Agregar `ENABLE ROW LEVEL SECURITY` / `CREATE POLICY` en migraciones SQL | CD-5 del work-item — RLS Postgres-level fuera de scope | WKH-SEC-02 |
| Agregar columna `owner_ref` a tabla `tasks` | Schema change fuera de scope — requiere migración + update de lógica de creación | WKH-54 (Fase B) |
| Modificar RPC `increment_a2a_key_spend` para que verifique `owner_ref` | DD-6 del SDD — requiere firma distinta de la función PG | WKH-54 (Fase B) |
| Cambiar auth model (x-a2a-key → JWT / session / OAuth) | CD-1 — prohibición permanente | (no scope) |
| Refactor de `budgetService`/`identityService` más allá del `.eq('owner_ref', ...)` | CD-2 | N/A |
| Cambiar `owner_ref TEXT` a `owner_id UUID` | DT-B resuelto — columna existente no se toca | N/A |
| Helper `ownedBy(keyId)` o wrapper `SecureQueryBuilder` | DT-A resuelto — patrón inline es la decisión | N/A |
| Agregar narrow handling del `OwnershipMismatchError` en el middleware (distinguir 404 vs 503) | R5 del SDD — aceptado como residual. El throw colapsa a 503 SERVICE_ERROR genérico en el try/catch actual | WKH-SEC-02 si aparece un endpoint que lo requiera |
| Tests de `debit`/`registerDeposit` en `ownership.test.ts` | DD-6 — RPC no verifica owner_ref, tests acá serían engañosos | WKH-54 |

---

## 11. Definition of Done (F3)

El Dev marca la HU como **"F3 DONE — ready for AR"** cuando **todos** los
siguientes son verdaderos:

### Archivos
- [ ] `src/services/security/errors.ts` existe y contiene `OwnershipMismatchError` + `logOwnershipMismatch` **exactamente** como en §6
- [ ] `src/services/security/ownership.test.ts` existe y contiene los 6 tests descritos en §5 (N3–N8)
- [ ] `src/services/budget.ts` tiene la firma nueva de `getBalance` (§2 Target) + import de errors
- [ ] `src/services/identity.ts` tiene la firma nueva de `deactivate` (§2 Target) + import de errors
- [ ] `src/middleware/a2a-key.ts:196` llama `getBalance` con 3 args (`keyRow.id, chainId, keyRow.owner_ref`)
- [ ] `CLAUDE.md` contiene la sección **Security Conventions — Ownership Guard** exactamente como §7

### Tests
- [ ] `npm test` → 100% PASS (exit 0), incluyendo los 8 nuevos + 6 modificados + resto del suite (zero regression — CD-A7)
- [ ] `npm test -- src/services/security/ownership.test.ts` → 6 PASS
- [ ] `npm test -- src/services/budget.test.ts` → todos PASS (incluye N1)
- [ ] `npm test -- src/services/identity.test.ts` → todos PASS (incluye N2)

### Quality gates
- [ ] `npx tsc --noEmit` → exit 0 (0 errores, 0 warnings)
- [ ] `npm run lint` → exit 0 (Biome clean)
- [ ] `grep -rn "getBalance(" src/ | grep -v test | grep -v "^\s*//"` → solo 1 match (el caller en middleware)
- [ ] `grep -rn "identityService.deactivate(" src/ | grep -v test` → 0 matches (sin callers productivos)
- [ ] `grep -rn "\.from('a2a_agent_keys')" src/services/ | grep -v test` → toda línea retornada debe tener **también** un `.eq('owner_ref'` en las siguientes 5 líneas (AR lo verificará manualmente)

### Anti-violation checks
- [ ] NO existen strings `'AuthError'`, `'ForbiddenError'`, `'IDORError'` en código nuevo (usá solo `OwnershipMismatchError`)
- [ ] NO existe `keyId` ni `ownerId` en claro dentro de `console.warn` / `console.log` en services modificados
- [ ] NO modificaste migraciones SQL (`ls supabase/migrations/ | wc -l` igual antes y después)
- [ ] NO modificaste tests de `createKey`, `lookupByHash`, `debit`, `registerDeposit` (CD-A4)

### Git
- [ ] 4 commits en la branch (W1, W2, W3, W4) con los mensajes sugeridos (o equivalentes que citen WKH-53 y los CDs)
- [ ] `git log --oneline main..HEAD | wc -l` ≥ 4
- [ ] Branch pusheada a remote: `git push -u origin feat/wkh-53-rls-ownership`
- [ ] NO pusheaste a `main` directamente

### Readiness para AR
- [ ] Actualizaste (o tenés listo el update de) `doc/sdd/_INDEX.md` con status `AR ready` (el orquestador lo hará, vos dejalo preparado)
- [ ] Tenés resumen ejecutivo 3-5 líneas listo para el orquestador: path de los archivos, cantidad de tests, confirmación de CDs respetados

---

## 12. Resumen ejecutivo (para reportar al cerrar F3)

Al terminar F3 reportá al orquestador con este formato:

```
F3 DONE — WKH-53 Supabase RLS + Ownership Checks
Branch: feat/wkh-53-rls-ownership (4 commits, pushed)
Archivos modificados: 5 (budget.ts, identity.ts, a2a-key.ts, CLAUDE.md + 2 tests)
Archivos creados: 2 (security/errors.ts, security/ownership.test.ts)
Tests: +8 nuevos, 6 modificados — 100% PASS
tsc --noEmit + lint: clean
CDs respetados: 14/14 (CD-1..CD-7 work-item + CD-A1..CD-A7 SDD)
Ready for AR.
```

---

**FIN DEL STORY FILE. No leer más allá.**
