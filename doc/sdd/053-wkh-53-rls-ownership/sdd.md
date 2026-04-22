# SDD — [WKH-53] Supabase RLS + ownership checks en queries

> Fase: F2 Architecture
> Modo: QUALITY (AR + CR obligatorios)
> Branch: `feat/wkh-53-rls-ownership`
> Base: `main` @ `87f0053` (WKH-52 PYUSD migration merged)
> Estimación F3: **M (2.5–3h)** — 4 archivos src + 3 tests + CLAUDE.md

---

## 0. Resumen ejecutivo

La HU agrega ownership guards a nivel aplicación sobre `a2a_agent_keys` — única
tabla con columna de ownership real (`owner_ref TEXT NOT NULL`) en el schema
actual. Concretamente:

1. `budgetService.getBalance(keyId, chainId)` → recibe un 3er parámetro
   `ownerId: string` y agrega `.eq('owner_ref', ownerId)` a la query.
2. `identityService.deactivate(keyId)` → recibe un 2do parámetro
   `ownerId: string` y agrega `.eq('owner_ref', ownerId)` al UPDATE.
3. Único caller productivo a actualizar: `src/middleware/a2a-key.ts:196`
   (pasa `keyRow.owner_ref`).
4. Se crea un suite de seguridad nuevo:
   `src/services/security/ownership.test.ts` con ≥1 test negativo por op.
5. `CLAUDE.md` gana una sección **Security Conventions — Ownership Guard**
   con la regla obligatoria + ejemplo + cómo AR/CR lo detectan.

NO se tocan migrations SQL, NO se cambia el auth model, NO se tocan `tasks` /
`a2a_events` / `registries` (no tienen columna owner en el schema actual).

---

## 1. Codebase Grounding — evidencia real

Archivos leídos con referencias exactas (verificados con Read/Glob/Grep
durante F2):

| Archivo | Línea(s) | Por qué |
|---------|----------|---------|
| `src/services/budget.ts` | 11–26 | `getBalance` actual: `.eq('id', keyId).single()` — SIN owner filter. Firma actual `(keyId, chainId)`. |
| `src/services/identity.ts` | 74–86 | `deactivate` actual: `.update({is_active:false}).eq('id', keyId)` — SIN owner filter. Firma actual `(keyId)`. |
| `src/middleware/a2a-key.ts` | 178–200 | Único caller productivo de `getBalance` (línea 196) y del `debit` (línea 179). `keyRow.owner_ref` está disponible en el alcance (línea 125 hace `lookupByHash`). |
| `src/services/budget.test.ts` | 43–91 (describe getBalance), 93–138 (describe debit), 140–168 (describe registerDeposit) | Patrón mock del chain: `chainMock()` helper línea 25–39 — replica `.select().eq().single()`. Cada test mockea `mockFrom.mockReturnValue(mock)`. |
| `src/services/identity.test.ts` | 195–223 (describe deactivate), 24–39 (helper `chainMock`) | Patrón mock del UPDATE: `mock.update = vi.fn().mockReturnValue(mock); mock.eq = vi.fn().mockResolvedValue(...)` — la promesa se resuelve desde `.eq()`, no desde `.single()`. |
| `src/middleware/a2a-key.test.ts` | 31–37 (mock budget), 70–76 (mocked service) | Los tests del middleware ya mockean `budgetService.getBalance`/`debit` como `vi.fn()`. Al cambiar la firma, los mocks siguen siendo válidos (vi.fn() no valida aridad estricta) — sólo las `toHaveBeenCalledWith(...)` que comprueben args necesitan update. |
| `supabase/migrations/20260406000000_a2a_agent_keys.sql` | 8–10 | Confirma `owner_ref TEXT NOT NULL` como columna de ownership (DT-B resuelto). |
| `src/types/a2a-key.ts` | 7–28 | `A2AAgentKeyRow` expone `owner_ref: string` (NOT NULL en DB, no nullable en TS). Firma `string` pura — no `string \| null`. |
| `src/services/fee-charge.ts` | 183, 284, 329 | **Exemplar válido** de patrón `.eq('<col>', <value>)` sobre una columna que actúa como filtro de autorización (acá `orchestration_id` para idempotencia; la forma sintáctica es idéntica a la que usaremos para `owner_ref`). |
| `src/routes/auth.ts` | 98–108 (POST /deposit 501), 146–155 (POST /bind 501) | Confirma que **NO existe** ruta `DELETE /auth/keys/:id` ni similar que exponga `identityService.deactivate(keyId)` directamente. El cambio de firma es **defense-in-depth** para rutas futuras. |

### Grep sistemático de callers (evidencia)

Ejecutado `grep -rn "identityService.deactivate\|budgetService.getBalance" --include="*.ts" src/`:

- `src/middleware/a2a-key.ts:196` → `budgetService.getBalance(keyRow.id, chainId)` — **caller productivo único**.
- `src/services/budget.test.ts:59,73,87` → tests unitarios.
- `src/services/identity.test.ts:206,219` → tests unitarios.
- `src/middleware/a2a-key.test.ts:75` → `mockGetBalance = vi.mocked(budgetService.getBalance)` — mock del service, no caller real.

**Conclusión**: el impacto en el grafo de callers es mínimo (1 caller productivo
+ 2 suites de tests + 1 mock). El compilador TypeScript strict atrapará
cualquier caller que se agregue sin `ownerId` (CD-3 del work-item).

### Exemplars a seguir (patrón inline)

- **`src/services/fee-charge.ts:180–187`** (idempotency check):
  ```ts
  const { data: existing, error } = (await supabase
    .from(FEES_TABLE)
    .select('status, tx_hash')
    .eq('orchestration_id', orchestrationId)
    .maybeSingle()) as { ... };
  ```
  Mismo estilo que vamos a aplicar con `owner_ref` en `getBalance`/`deactivate`.

- **`src/services/identity.ts:58–72`** (`lookupByHash`): muestra el patrón de
  encadenar `.eq()` antes de `.single()` con manejo explícito de
  `PGRST116 = no rows`. Vamos a reusar **exactamente este mismo patrón** para
  la nueva rama "owner mismatch" en `getBalance`.

### Auto-Blindajes de HUs previas aplicados

Leí las 3 últimas HUs DONE (052, 044, 043) y las más relevantes de los
servicios afectados (024 — la HU original que creó `budget.ts`/`identity.ts`):

- **AB-044#2** (`doc/sdd/044-wkh-44-protocol-fee/auto-blindaje.md:27–46`):
  "el mock del chain de Supabase debe replicar EXACTAMENTE la cadena del impl,
  no una más larga, no una más corta". Ver **CD-A1** abajo.
- **AB-024#1** (`doc/sdd/024-agentic-economy-l3/auto-blindaje.md:3–7`):
  `mock as unknown as ReturnType<typeof supabase.from>` (double cast). Los
  tests existentes ya lo respetan; el nuevo suite debe seguir el mismo patrón.
- **AB-043#1** (`doc/sdd/043-wkh-sec-01/auto-blindaje.md`): generics de
  Fastify. No aplica en esta HU (no tocamos routes).

---

## 2. Scope IN (expandido desde work-item)

| # | Artefacto | Cambio exacto |
|---|-----------|--------------|
| 1 | `src/services/budget.ts` | Firma `getBalance(keyId, chainId)` → `getBalance(keyId, chainId, ownerId)`. Agregar `.eq('owner_ref', ownerId)` en la query chain. Cambiar `.single()` por manejo `PGRST116 → OwnershipMismatchError` (DD-1). |
| 2 | `src/services/identity.ts` | Firma `deactivate(keyId)` → `deactivate(keyId, ownerId)`. Agregar `.eq('owner_ref', ownerId)` en el UPDATE. Inspeccionar `data` devuelto para detectar "0 rows updated" → `OwnershipMismatchError` (DD-2). |
| 3 | `src/middleware/a2a-key.ts:196` | Llamada actual `getBalance(keyRow.id, chainId)` → `getBalance(keyRow.id, chainId, keyRow.owner_ref)`. Sin más cambios en el middleware. |
| 4 | `src/services/security/ownership.test.ts` | **Nuevo archivo**. Suite de seguridad con ≥1 test negativo por op (getBalance cross-owner + deactivate cross-owner) + 1 test positivo por op (mismo owner). |
| 5 | `src/services/security/errors.ts` | **Nuevo archivo pequeño**. Define `export class OwnershipMismatchError extends Error` + `readonly code = 'OWNERSHIP_MISMATCH' as const`. Tipado, sin `any`. |
| 6 | `src/services/budget.test.ts` | Actualizar los 3 tests de `getBalance` para pasar `ownerId` + agregar assertion de que `.eq('owner_ref', expectedOwner)` fue llamado. NO tocar tests de `debit`/`registerDeposit`. |
| 7 | `src/services/identity.test.ts` | Actualizar los 2 tests de `deactivate` para pasar `ownerId` + agregar assertion de `.eq('owner_ref', expectedOwner)`. NO tocar tests de `createKey`/`lookupByHash`. |
| 8 | `src/middleware/a2a-key.test.ts` | Ajustar `toHaveBeenCalledWith('...', chainId)` → `toHaveBeenCalledWith('...', chainId, 'user-1')` donde aplique. **Solo** los asserts que tocan `getBalance`. |
| 9 | `CLAUDE.md` | Agregar sección **Security Conventions — Ownership Guard** (ver §7 de este SDD — contenido completo especificado). |

### Scope OUT (reafirmado)

- SQL `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` → WKH-SEC-02.
- Ownership en `tasks` (schema change) → WKH-54 (Fase B tracked formalmente).
- Cambio de `owner_ref` a `owner_id` o de tipo TEXT → UUID → no.
- RPC `increment_a2a_key_spend` con verificación de `owner_ref` → WKH-54
  (requiere firma distinta de la función PG).
- Auth model change (x-a2a-key → JWT) → fuera de scope permanente.

---

## 3. Decisiones técnicas (DT-N)

Heredadas del work-item (inmutables):

- **DT-A (RESUELTO)**: Sin helper `ownedBy(keyId)` — patrón inline `.eq('owner_ref', ownerId)` por método.
- **DT-B (RESUELTO)**: Columna es `owner_ref TEXT NOT NULL`.
- **DT-C (RESUELTO)**: Runtime tests con mock del builder (no AST).
- **DT-D**: `ownerId` es el `owner_ref` del caller autenticado, disponible en `request.a2aKeyRow.owner_ref`.

### Decisiones técnicas nuevas de F2 (DESIGN DECISIONS)

- **DD-1 (`getBalance` — error semantics, NEW)**: Cuando el `keyId` no matchea
  con el `owner_ref` provisto, la query `.eq('id', keyId).eq('owner_ref', ownerId).single()`
  retorna `PGRST116` ("no rows"). **Decisión**: lanzar un error tipado
  `OwnershipMismatchError` con code `'OWNERSHIP_MISMATCH'`. **Justificación**:
  - No podemos distinguir "key inexistente" vs "key de otro owner" a nivel
    query (y no debemos — es info leak). Ambos casos colapsan en "no rows".
  - Retornar `null` o `'0'` silenciosamente esconde una **posible señal de
    ataque** (un agente probando `keyId`s ajenos). Un throw explícito permite
    al middleware loguearlo (ver DD-4).
  - Throw (no null) mantiene consistencia con la convención actual de
    `getBalance` que ya hace `throw new Error('Failed to get balance: ...')`
    ante cualquier error (línea 22 actual).
  - **Fallout en middleware**: el try/catch de `a2a-key.ts:201–213` ya está
    preparado para capturar cualquier throw y devolver `503 SERVICE_ERROR`.
    **NO es ideal** — en el caso cross-owner el middleware nunca debería
    disparar `getBalance` con una key ajena (el `keyRow` viene del
    `lookupByHash` del propio caller). Si el throw ocurre, es un bug de
    programación, **no un caso legítimo**. Por eso un throw tipado es mejor
    que un null silencioso.
- **DD-2 (`deactivate` — error semantics, NEW)**: El `UPDATE ... WHERE id=$1 AND
  owner_ref=$2` con key ajena afecta 0 rows pero **NO retorna error** en
  PostgREST — retorna `{ data: [], error: null }`. **Decisión**: agregar
  `.select('id')` al chain y verificar `data.length === 0` → lanzar
  `OwnershipMismatchError`. **Justificación**:
  - Sin el check, una llamada cross-owner es un no-op silencioso (devuelve
    `void` como siempre) — peor UX que un throw explícito y no es detectable
    por test.
  - El caller legítimo (si llega a existir — hoy no hay ninguno productivo)
    espera que `deactivate` realmente desactive. Un silent no-op es un bug.
  - `.select('id')` sobre un UPDATE es el patrón PostgREST standard para
    obtener las rows afectadas.
- **DD-3 (Ubicación de `OwnershipMismatchError`, NEW)**: el error vive en
  `src/services/security/errors.ts` (nuevo archivo, ≤30 líneas). **Justificación**:
  carpeta `security/` ya obligatoria por CD-7 del work-item; centralizar los
  tipos de error de seguridad facilita el AR + futuras extensiones
  (WKH-SEC-02 tendrá más).
- **DD-4 (Logging de cross-owner attempts, NEW)**: cuando `OwnershipMismatchError`
  se dispara, el service llama a `console.warn` con estructura
  `{ op: 'getBalance'|'deactivate', keyIdHash: sha256(keyId).slice(0,16), ownerIdHash: sha256(ownerId).slice(0,16), ts }`.
  **Justificación**:
  - **PII redaction obligatoria** (CD-A3, ver §4) — NO loggear `keyId`
    completo en claro. Hash SHA-256 truncado a 16 chars es suficiente para
    correlacionar sin exponer el UUID.
  - `console.warn` (no `fastify.log`) porque el service no tiene acceso al
    logger de fastify sin inyección de dependencia (refactor fuera de scope).
    Consistente con `fee-charge.ts:191, 236, 256`.
  - Nivel `warn` (no `error`) porque **puede ser** un bug legítimo (caller
    pasó mal el ownerId) o un intento cross-owner — no podemos distinguir.
    Un SOC verá todos los warns y decidirá.
- **DD-5 (Orden del chain `.eq()`, NEW)**: primero `.eq('id', keyId)`, después
  `.eq('owner_ref', ownerId)`. **Justificación**: orden preserva el patrón
  actual del codebase (`id` primero en `lookupByHash`, `getBalance`,
  `deactivate`). Semánticamente equivalente para Postgres (el optimizer
  re-ordena), pero diff mínimo en review.
- **DD-6 (Tests de `debit`/`registerDeposit` NO se modifican en esta HU, NEW)**:
  el work-item dice "Scope OUT: RPC changes". `debit` llama a una RPC que no
  expone `owner_ref` como param. Agregar un test negativo en app-layer sería
  engañoso (la app no hace nada para bloquear cross-owner en `debit`). **Decisión**:
  documentar el gap como **residual risk** (ver §9), trackear en WKH-54. NO
  agregar tests falsos. En `ownership.test.ts` solo hay tests de `getBalance`
  y `deactivate`.

---

## 4. Constraint Directives (CD-N)

### Heredados del work-item (inmutables — hay que releerlos en F3)

- **CD-1**: PROHIBIDO cambiar el auth model (sigue `x-a2a-key` + `lookupByHash`).
- **CD-2**: PROHIBIDO refactorizar servicios completos — solo agregar `.eq('owner_ref', ownerId)` + ajuste de firmas.
- **CD-3**: OBLIGATORIO TypeScript strict — `ownerId: string` (no `string | undefined`).
- **CD-4**: OBLIGATORIO ≥1 test negativo por operación protegida.
- **CD-5**: PROHIBIDO tocar migrations SQL de RLS.
- **CD-6**: OBLIGATORIO actualizar **todos** los callers de `getBalance`/`deactivate` que el compilador marque como rotos.
- **CD-7**: El nuevo suite DEBE vivir en `src/services/security/`.

### Nuevos CDs de F2 (Architect → Dev)

- **CD-A1 (Test Mock Fidelity — Auto-Blindaje heredado)**: el mock del chain
  de supabase debe replicar **EXACTAMENTE** la cadena del impl. Si el impl
  hace `.select().eq().eq().single()`, el mock debe replicar esos 4 métodos,
  ni más ni menos. Si el impl hace `.update({...}).eq().eq().select('id')`,
  el mock debe replicar. Referencia histórica: **AB-WKH-44 auto-blindaje#2**
  (`doc/sdd/044-wkh-44-protocol-fee/auto-blindaje.md:27–46`).
- **CD-A2 (Error de ownership es tipado)**: PROHIBIDO lanzar
  `new Error('...')` genérico cuando detectás cross-owner. OBLIGATORIO usar
  `new OwnershipMismatchError(...)` importado desde
  `src/services/security/errors.ts`. Justificación: permite al caller hacer
  `instanceof OwnershipMismatchError` si alguna vez necesita distinguir.
- **CD-A3 (PII redaction en logs)**: PROHIBIDO loggear `keyId` completo o
  `ownerId` completo en claro cuando se detecta cross-owner. OBLIGATORIO
  hashear con `crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)`
  antes de loggear. Aplica solo al path de `OwnershipMismatchError` (los
  logs normales del flujo no cambian).
- **CD-A4 (No tocar tests fuera de scope)**: PROHIBIDO modificar tests de
  `createKey`, `lookupByHash`, `debit`, `registerDeposit` — esos tests NO
  deben romperse por este cambio. Si se rompen, es señal de un refactor
  fuera de scope (violación de CD-2).
- **CD-A5 (Firma exacta)**: la firma nueva DEBE ser:
  ```ts
  getBalance(keyId: string, chainId: number, ownerId: string): Promise<string>
  deactivate(keyId: string, ownerId: string): Promise<void>
  ```
  — no `ownerId?: string`, no genéricos, no overloads. Parámetro `ownerId`
  siempre al final (extensión aditiva).
- **CD-A6 (Mensaje de error estandarizado)**: cuando
  `OwnershipMismatchError` se lanza, el `message` debe ser literalmente
  `"Ownership mismatch"` (sin interpolación del keyId ni ownerId, que son
  PII). El `code` del error es `'OWNERSHIP_MISMATCH'`. Ambos valores son
  strings fijos, testeables por equality exacta.
- **CD-A7 (Baseline de tests — zero regression)**: al terminar W2, el
  comando `npm run test` DEBE pasar el 100% de los tests (incluyendo los no
  modificados). Es el primer filtro de regresión antes de cerrar cada wave.

---

## 5. Waves de implementación

### W0 — Baseline (serial, gate obligatorio)

**Objetivo**: confirmar que el codebase en `main` + branch fresca está verde
antes de tocar nada.

| Paso | Comando | Criterio de éxito |
|------|---------|-------------------|
| 0.1 | `git checkout -b feat/wkh-53-rls-ownership origin/main` | Branch creada desde `87f0053` (último merge WKH-52). |
| 0.2 | `npm ci` | Dependencias instaladas sin errores. |
| 0.3 | `npm run lint` | Biome check en verde (0 errors, 0 warnings relevantes). |
| 0.4 | `npx tsc --noEmit` | TypeScript strict en verde — 0 errores. |
| 0.5 | `npm test` | Todos los tests actuales pasan (baseline). |

**Entregable W0**: log de los 5 comandos con output. Si alguno falla, STOP
y escalar — no es problema de esta HU.

**Commits**: ninguno (es baseline de verificación).

---

### W1 — `budget.ts` + sus tests + caller middleware (serial)

**Objetivo**: extender `getBalance` con ownership guard + actualizar el único
caller productivo + tests.

**Archivos tocados**:
1. `src/services/security/errors.ts` (**crear**)
2. `src/services/budget.ts` (modificar `getBalance` — líneas 11–26)
3. `src/services/budget.test.ts` (modificar `describe('getBalance')` — líneas 48–91)
4. `src/middleware/a2a-key.ts` (modificar línea 196)
5. `src/middleware/a2a-key.test.ts` (ajustar asserts de `mockGetBalance`)

**Criterios de éxito**:
- `npx tsc --noEmit` en verde (el cambio de firma propaga correctamente).
- `npm test -- src/services/budget.test.ts` en verde.
- `npm test -- src/middleware/a2a-key.test.ts` en verde.
- `npm test` completo en verde (zero regression — CD-A7).
- `grep -rn "getBalance(.*,.*)" src/ | grep -v test` muestra solo el caller
  del middleware con 3 args.

**Plan técnico de `getBalance`**:

```ts
// src/services/budget.ts
import { OwnershipMismatchError } from './security/errors.js';

async getBalance(keyId: string, chainId: number, ownerId: string): Promise<string> {
  const { data, error } = await supabase
    .from('a2a_agent_keys')
    .select('budget')
    .eq('id', keyId)
    .eq('owner_ref', ownerId)  // <- NEW
    .single();

  if (error) {
    if (error.code === 'PGRST116') {  // no rows — ownership mismatch or missing
      // PII-safe log (CD-A3) + throw tipado (CD-A2, CD-A6)
      logOwnershipMismatch('getBalance', keyId, ownerId);
      throw new OwnershipMismatchError();
    }
    throw new Error(`Failed to get balance: ${error.message}`);
  }

  const budget = (data as Pick<A2AAgentKeyRow, 'budget'>).budget;
  return budget[chainId.toString()] ?? '0';
}
```

Donde `logOwnershipMismatch` es un helper local (o en `security/errors.ts`):

```ts
// src/services/security/errors.ts
import crypto from 'node:crypto';

export class OwnershipMismatchError extends Error {
  readonly code = 'OWNERSHIP_MISMATCH' as const;
  constructor() {
    super('Ownership mismatch');
    this.name = 'OwnershipMismatchError';
  }
}

export function logOwnershipMismatch(
  op: 'getBalance' | 'deactivate',
  keyId: string,
  ownerId: string,
): void {
  const hash = (v: string) =>
    crypto.createHash('sha256').update(v).digest('hex').slice(0, 16);
  console.warn('[security] ownership mismatch', {
    op,
    keyIdHash: hash(keyId),
    ownerIdHash: hash(ownerId),
    ts: new Date().toISOString(),
  });
}
```

**Plan técnico del caller `src/middleware/a2a-key.ts:196`**:

```ts
// antes
const postDebitBalance = await budgetService.getBalance(keyRow.id, chainId);
// después
const postDebitBalance = await budgetService.getBalance(
  keyRow.id,
  chainId,
  keyRow.owner_ref,
);
```

**Tests a actualizar en `budget.test.ts`**:

Los 3 tests de `describe('getBalance')` (líneas 48–91) ya pasan el chain
`.select().eq().single()`. Agregar un `.eq()` más al setup del mock + pasar
`'user-1'` al call + agregar un 4to test negativo cross-owner:

```ts
// test nuevo dentro de describe('getBalance')
it('throws OwnershipMismatchError when owner mismatch (AC-3)', async () => {
  const mock = chainMock();
  mock.single = vi.fn().mockResolvedValue({
    data: null,
    error: { code: 'PGRST116', message: 'no rows' },
  });
  mockFrom.mockReturnValue(mock as unknown as ReturnType<typeof supabase.from>);

  await expect(
    budgetService.getBalance('key-of-other-owner', 2368, 'user-A'),
  ).rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' });

  // CD-A1: verificar que .eq fue llamado con owner_ref
  expect(mock.eq).toHaveBeenCalledWith('owner_ref', 'user-A');
});
```

**Tests a actualizar en `a2a-key.test.ts`**:

Los tests que verifican `mockGetBalance` deben ajustar
`toHaveBeenCalledWith(TEST_KEY_ID, chainId)` →
`toHaveBeenCalledWith(TEST_KEY_ID, chainId, 'user-1')` (el `owner_ref` del
`TEST_KEY_ID` fixture está hardcodeado a `'user-1'` — línea 90).

**Commit recomendado al cerrar W1**:
```
feat(WKH-53 W1): owner-ref guard en getBalance + caller middleware

- budgetService.getBalance recibe ownerId y filtra por owner_ref
- OwnershipMismatchError + logOwnershipMismatch (PII-safe)
- a2a-key middleware propaga keyRow.owner_ref
- tests de getBalance + a2a-key actualizados + test negativo cross-owner

Refs: WKH-53 CD-A1/A2/A3/A5/A6
```

---

### W2 — `identity.ts` `deactivate` + sus tests (serial)

**Objetivo**: extender `deactivate` con ownership guard + tests.

**Archivos tocados**:
1. `src/services/identity.ts` (modificar `deactivate` — líneas 74–86)
2. `src/services/identity.test.ts` (modificar `describe('deactivate')` — líneas 195–223)

**Criterios de éxito**:
- `npx tsc --noEmit` en verde.
- `npm test -- src/services/identity.test.ts` en verde.
- `npm test` completo en verde (CD-A7).
- `grep -rn "identityService.deactivate" src/ | grep -v test` muestra 0 callers
  productivos (confirmado en F2 — solo tests).

**Plan técnico de `deactivate`**:

```ts
// src/services/identity.ts
import { OwnershipMismatchError, logOwnershipMismatch } from './security/errors.js';

async deactivate(keyId: string, ownerId: string): Promise<void> {
  const { data, error } = await supabase
    .from('a2a_agent_keys')
    .update({ is_active: false })
    .eq('id', keyId)
    .eq('owner_ref', ownerId)  // <- NEW
    .select('id');              // <- NEW (para saber si afectó algo)

  if (error)
    throw new Error(`Failed to deactivate agent key: ${error.message}`);

  // DD-2: UPDATE con owner mismatch afecta 0 rows, no error.
  if (!data || data.length === 0) {
    logOwnershipMismatch('deactivate', keyId, ownerId);
    throw new OwnershipMismatchError();
  }
}
```

**Tests a actualizar en `identity.test.ts`**:

Los 2 tests actuales (líneas 195–223) usan el chain
`mock.update(...).eq(...) → promise`. Con `.select('id')` agregado, la
promesa se resuelve desde `.select()`, no desde `.eq()`. **Ajuste
obligatorio del mock** (CD-A1):

```ts
describe('deactivate', () => {
  it('calls update with is_active = false AND owner_ref filter (AC-4)', async () => {
    const mock = chainMock();
    const mockUpdate = vi.fn().mockReturnValue(mock);
    mock.update = mockUpdate;
    mock.select = vi.fn().mockResolvedValue({
      data: [{ id: 'key-id-1' }],
      error: null,
    });
    mockFrom.mockReturnValue(mock as unknown as ReturnType<typeof supabase.from>);

    await identityService.deactivate('key-id-1', 'user-A');

    expect(mockUpdate).toHaveBeenCalledWith({ is_active: false });
    expect(mock.eq).toHaveBeenCalledWith('id', 'key-id-1');
    expect(mock.eq).toHaveBeenCalledWith('owner_ref', 'user-A');
  });

  it('throws OwnershipMismatchError when owner mismatch (AC-4)', async () => {
    const mock = chainMock();
    mock.update = vi.fn().mockReturnValue(mock);
    mock.select = vi.fn().mockResolvedValue({ data: [], error: null });
    mockFrom.mockReturnValue(mock as unknown as ReturnType<typeof supabase.from>);

    await expect(
      identityService.deactivate('other-key', 'user-A'),
    ).rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' });
  });

  it('throws on DB error', async () => {
    const mock = chainMock();
    mock.update = vi.fn().mockReturnValue(mock);
    mock.select = vi.fn().mockResolvedValue({ error: { message: 'fail' } });
    mockFrom.mockReturnValue(mock as unknown as ReturnType<typeof supabase.from>);

    await expect(identityService.deactivate('x', 'user-A')).rejects.toThrow(
      'Failed to deactivate agent key: fail',
    );
  });
});
```

**Commit recomendado al cerrar W2**:
```
feat(WKH-53 W2): owner-ref guard en identityService.deactivate

- deactivate recibe ownerId y filtra por owner_ref
- detección de 0-rows-updated → OwnershipMismatchError (DD-2)
- tests de deactivate actualizados + negativo cross-owner

Refs: WKH-53 CD-A1/A2/A5/A6
```

---

### W3 — Security test suite (serial, dependiente de W1+W2)

**Objetivo**: crear `src/services/security/ownership.test.ts` como suite de
seguridad consolidado + auditable por AR.

**Archivos tocados**:
1. `src/services/security/ownership.test.ts` (**crear**)

**Criterios de éxito**:
- `npm test -- src/services/security/ownership.test.ts` en verde.
- `grep "describe\|it(" src/services/security/ownership.test.ts | wc -l` ≥ 6
  (2 describe blocks × ≥2 tests cada uno + 2 tests positivos por op = ≥6).
- El suite contiene ≥1 test negativo cross-owner por cada op (getBalance,
  deactivate) — CD-4 del work-item.

**Plan de tests** (ver §6 para el mapping exacto AC ↔ test):

```ts
// src/services/security/ownership.test.ts
/**
 * Security Suite — Ownership Guard (WKH-53)
 *
 * Verifica defensa contra cross-tenant access en a2a_agent_keys.
 * Estos tests DEBEN fallar si alguien quita el .eq('owner_ref', ...) de
 * los services modificados.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnershipMismatchError } from './errors.js';

vi.mock('../../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

import { supabase } from '../../lib/supabase.js';
import { budgetService } from '../budget.js';
import { identityService } from '../identity.js';

const mockFrom = vi.mocked(supabase.from);

function chainMock(overrides: Record<string, unknown> = {}) {
  // idéntico patrón a budget.test.ts (CD-A1, fidelity)
  // ...
}

describe('Ownership Guard — budgetService.getBalance', () => {
  beforeEach(() => vi.clearAllMocks());

  it('owner A cannot read balance of owner B — rejects with OwnershipMismatchError', async () => { ... });
  it('calls .eq("owner_ref", ownerId) on the query chain', async () => { ... });
  it('owner A reads own balance successfully', async () => { ... });
});

describe('Ownership Guard — identityService.deactivate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('owner A cannot deactivate key of owner B — key remains active', async () => { ... });
  it('calls .eq("owner_ref", ownerId) on the UPDATE chain', async () => { ... });
  it('owner A deactivates own key successfully', async () => { ... });
});
```

**Nota importante (DD-6)**: NO incluir tests de `debit`/`registerDeposit` en
este suite. La RPC PG no verifica `owner_ref` — agregar un test "exitoso" de
`debit` cross-owner confirmaría el hallazgo sobre el RPC y **sería
engañoso** (el test pasaría verde pero no refleja protección real).
Documentar el gap en §9 como residual risk.

**Commit recomendado al cerrar W3**:
```
test(WKH-53 W3): security suite ownership.test.ts

- 6 tests: 2 negativos cross-owner + 2 chain assertions + 2 positivos
- vive en src/services/security/ (CD-7 del work-item)
- referencia obligatoria para AR + CR

Refs: WKH-53 AC-5, AC-6, CD-4, CD-7
```

---

### W4 — Documentación (paralelizable con W3 opcionalmente, serial si Dev prefiere)

**Objetivo**: agregar sección **Security Conventions — Ownership Guard** a
`CLAUDE.md` como guardrail para PRs futuros (AC-8).

**Archivos tocados**:
1. `CLAUDE.md` (agregar sección al final, después de "Reglas de proceso")

**Criterios de éxito**:
- La sección existe (`grep "Security Conventions — Ownership Guard" CLAUDE.md`).
- Contiene: (a) la regla, (b) ejemplo de código, (c) señal para AR.

**Contenido exacto** (ver §7).

**Commit recomendado al cerrar W4**:
```
docs(WKH-53 W4): CLAUDE.md — Security Conventions — Ownership Guard

- Regla obligatoria: toda query sobre a2a_agent_keys lleva owner_ref filter
- Ejemplo de patrón
- Señal para AR / CR

Refs: WKH-53 AC-8
```

---

### Resumen de waves

| Wave | Duración | Archivos | Tests nuevos | Tests modificados | Commits |
|------|---------:|---------:|-------------:|------------------:|--------:|
| W0 | 10m | 0 | 0 | 0 | 0 |
| W1 | 60–80m | 5 | 0 | 4 (+1 nuevo en budget.test.ts) | 1 |
| W2 | 40–60m | 2 | 0 | 2 (+1 nuevo en identity.test.ts) | 1 |
| W3 | 45–60m | 1 | 6 | 0 | 1 |
| W4 | 10m | 1 | 0 | 0 | 1 |
| **Total** | **~2.5h–3h** | **9 únicos** (errors.ts compartido) | **8 nuevos** | **6 modificados** | **4** |

Estimación original M (2–3h) se mantiene.

---

## 6. Test plan — AC ↔ test mapping

Cada AC del work-item se valida por al menos un test específico. Archivo +
nombre exacto del test:

| AC | Test archivo | Nombre describe/it | Tipo |
|----|-------------|-------------------|------|
| **AC-1** (getBalance cross-owner → 403/404) | `src/services/security/ownership.test.ts` | `describe('Ownership Guard — budgetService.getBalance')` > `it('owner A cannot read balance of owner B — rejects with OwnershipMismatchError')` | unit (negativo) |
| **AC-2** (deactivate cross-owner → 403/404 + key sigue activa) | `src/services/security/ownership.test.ts` | `describe('Ownership Guard — identityService.deactivate')` > `it('owner A cannot deactivate key of owner B — key remains active')` | unit (negativo) |
| **AC-3** (.eq('owner_ref', ownerId) en getBalance) | `src/services/security/ownership.test.ts` | `it('calls .eq("owner_ref", ownerId) on the query chain')` + `src/services/budget.test.ts` nuevo caso `it('throws OwnershipMismatchError when owner mismatch (AC-3)')` | unit (chain-assert) |
| **AC-4** (.eq('owner_ref', ownerId) en deactivate UPDATE) | `src/services/security/ownership.test.ts` | `it('calls .eq("owner_ref", ownerId) on the UPDATE chain')` + `src/services/identity.test.ts` caso `it('calls update with is_active = false AND owner_ref filter (AC-4)')` | unit (chain-assert) |
| **AC-5** (ownership.test.ts ≥1 negativo por op) | `src/services/security/ownership.test.ts` | existencia del archivo con 2 `describe` blocks, cada uno con ≥1 negativo | structural |
| **AC-6** (dos owners A/B, todos los tests pasan) | `src/services/security/ownership.test.ts` | **todos** los tests del suite (cada uno usa fixture `OWNER_A` + `OWNER_B`) | suite |
| **AC-7** (zero regression en tests previos) | `npm test` (comando completo) | exit code 0, todos los tests pre-W1 siguen verdes | integration (gate de cada wave — CD-A7) |
| **AC-8** (patrón documentado en CLAUDE.md) | `CLAUDE.md` | sección "Security Conventions — Ownership Guard" presente | doc |

**Total nuevos tests**: 6 en `ownership.test.ts` + 1 en `budget.test.ts` + 1 en
`identity.test.ts` = **8 tests nuevos**.

**Total tests modificados**: 3 en `budget.test.ts` (pasar `ownerId`), 2 en
`identity.test.ts` (ajustar mock chain + pasar `ownerId`), ~1 en
`a2a-key.test.ts` (assert `toHaveBeenCalledWith` actualizado).

---

## 7. Contenido exacto de la sección en `CLAUDE.md` (W4)

Agregar al final de `CLAUDE.md` (después de línea 127, "Entre gates el
pipeline corre solo"):

```markdown
---

## Security Conventions — Ownership Guard

**Regla obligatoria (WKH-53):** toda query o mutación sobre `a2a_agent_keys`
hecha desde `src/services/` DEBE filtrar por `owner_ref` además del `id`.

El cliente de Supabase usa `SUPABASE_SERVICE_ROLE_KEY`, que **bypassea RLS**.
Por eso el ownership check vive en la capa de aplicación: si un service hace
`.eq('id', keyId)` sin cruzar con `.eq('owner_ref', callerOwnerRef)`, cualquier
caller autenticado puede leer o modificar datos de otro owner.

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
  keyRow.owner_ref,  // <- el callerownerRef
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
```

---

## 8. Error handling strategy (consolidado)

| Operación | Caso | Comportamiento |
|-----------|------|----------------|
| `getBalance(keyId, chainId, ownerId)` | owner match, balance existe | retorna balance string (comportamiento actual) |
| `getBalance(...)` | owner match, no entry para ese chain | retorna `'0'` (comportamiento actual) |
| `getBalance(...)` | owner mismatch **o** keyId inexistente | log warn (PII-safe) + `throw new OwnershipMismatchError()` |
| `getBalance(...)` | error de DB (otro código ≠ PGRST116) | `throw new Error('Failed to get balance: <msg>')` (comportamiento actual) |
| `deactivate(keyId, ownerId)` | owner match | UPDATE afecta 1 row, retorna `void` |
| `deactivate(...)` | owner mismatch **o** keyId inexistente | UPDATE afecta 0 rows → log warn (PII-safe) + `throw new OwnershipMismatchError()` |
| `deactivate(...)` | error de DB | `throw new Error('Failed to deactivate agent key: <msg>')` (comportamiento actual) |

**`OwnershipMismatchError`**:
- `message`: `"Ownership mismatch"` (fijo, sin interpolación — CD-A6)
- `code`: `"OWNERSHIP_MISMATCH"` (readonly)
- `name`: `"OwnershipMismatchError"`
- Exporta desde `src/services/security/errors.ts`
- Caller puede hacer `if (err instanceof OwnershipMismatchError)` para
  narrow typing. No hay callers productivos que lo hagan hoy (middleware ya
  tiene try/catch genérico → 503 SERVICE_ERROR). Si en WKH-SEC-02 se expone
  un endpoint DELETE /auth/keys/:id, ese handler hará el narrow y devolverá
  404.

---

## 9. Logging strategy (PII-safe)

| Evento | Nivel | Estructura | Canal |
|--------|-------|-----------|-------|
| Ownership mismatch en `getBalance` | `warn` | `{ op: 'getBalance', keyIdHash, ownerIdHash, ts }` | `console.warn` |
| Ownership mismatch en `deactivate` | `warn` | `{ op: 'deactivate', keyIdHash, ownerIdHash, ts }` | `console.warn` |
| Flujo normal | (sin log adicional) | — | — |
| DB error (no PGRST116) | `error` | throw propaga al caller | handler (middleware → 503) |

**Reglas**:
- `keyIdHash` = SHA-256 del `keyId` truncado a 16 chars hex.
- `ownerIdHash` = mismo patrón.
- Prefijo `[security]` para grep fácil en logs de producción.
- `console.warn` (no `fastify.log`) porque el service no recibe el logger de
  fastify (CD-2: no refactor). Consistente con `fee-charge.ts:191, 236, 256, 333`.

---

## 10. Migration / schema impact

**NINGUNO.** Esta HU es **app-layer only** (Fase A).

- Columna `owner_ref TEXT NOT NULL` ya existe en `supabase/migrations/20260406000000_a2a_agent_keys.sql:10`.
- No se crean, modifican ni eliminan migraciones.
- No se modifican funciones PG (`increment_a2a_key_spend`, `register_a2a_key_deposit`) — eso es **WKH-54 (Fase B)**.
- No se agrega `ENABLE ROW LEVEL SECURITY` — eso es **WKH-SEC-02**.

**Confirmación de preconditions**:
- `git show main:supabase/migrations/20260406000000_a2a_agent_keys.sql | grep 'owner_ref'`
  → línea 10: `owner_ref TEXT NOT NULL` ✅.

---

## 11. Riesgos refinados (heredados + expandidos)

| # | Riesgo | Prob. | Impacto | Mitigación F2 | Residual post-F3 |
|---|--------|-------|---------|--------------|------------------|
| R1 | `budgetService.debit` llama RPC PG que NO verifica `owner_ref` | Media | Medio | Middleware ya pasa `keyRow.id` (propio del caller) — el vector requiere que el caller obtenga `keyId` ajeno, lo cual no es posible sin otra vulnerabilidad | **Residual** — tracked en WKH-54 (Fase B). Documentado en §9 `CLAUDE.md` ("Tablas con ownership en app-layer") y en DD-6 |
| R2 | Callers desconocidos de `deactivate` se rompen con el cambio de firma | Baja | Alto | Grep confirmó 0 callers productivos + TS strict atrapa cualquier caller futuro (CD-3, CD-6) | **Mitigado** — zero impacto en rutas productivas |
| R3 | Tests existentes con mock del builder necesitan ajuste | Alta | Bajo | Plan técnico de W1/W2 detalla qué líneas se tocan. CD-A1 fuerza fidelity del mock | **Mitigado** — cubierto por CD-A1 |
| R4 (NEW) | `deactivate` con `.select('id')` agrega 1 row-trip extra a Postgres | Alta | Mínimo (<1ms) | Es el trade-off para detectar cross-owner. Aceptable dado que `deactivate` no es hot path (≤1 call/key/lifetime) | Aceptado |
| R5 (NEW) | `OwnershipMismatchError` del middleware colapsa a 503 en el try/catch genérico de `a2a-key.ts:201–213` | Media | Bajo (en el flujo productivo nunca se dispara porque el middleware usa `keyRow.owner_ref` propio del caller) | Si alguna vez una ruta llama `getBalance` con el owner equivocado, el 503 es subóptimo pero no incorrecto. WKH-SEC-02 puede agregar narrow handling si aparece un endpoint que lo requiera | Aceptado |
| R6 (NEW) | Auto-Blindaje AB-044#2 — mock chain fidelity | Media | Medio | CD-A1 explícito. `.select('id')` agregado a `deactivate` obliga a actualizar los mocks existentes — riesgo conocido, cubierto en W2 plan técnico | Mitigado |

---

## 12. Readiness Check — pre-F3

Checklist que el Dev DEBE verificar antes de arrancar W1:

- [ ] `git status` limpio en `/home/ferdev/.openclaw/workspace/wasiai-a2a`.
- [ ] Branch `feat/wkh-53-rls-ownership` creada desde `origin/main` (commit base: `87f0053` — WKH-52 PYUSD merged).
- [ ] `npm ci` exitoso (lockfile sin conflicts).
- [ ] W0 baseline pasado: `npm run lint` + `npx tsc --noEmit` + `npm test` todos verdes **antes** de tocar cualquier archivo.
- [ ] Dev tiene leído este SDD completo — en particular §5 (waves), §6 (test plan) y §7 (contenido exacto CLAUDE.md).
- [ ] Dev entendió los 4 CDs nuevos de F2 (CD-A1 mock fidelity, CD-A2 error tipado, CD-A3 PII-safe logs, CD-A6 message fijo).
- [ ] Dev NO va a modificar migraciones SQL (CD-5).
- [ ] Dev NO va a tocar tests de `createKey`, `lookupByHash`, `debit`, `registerDeposit` (CD-A4).
- [ ] Dev va a correr `npm test` completo al cerrar cada wave (CD-A7).
- [ ] Dev no-mergeará sin PR + AR + CR aprobados (QUALITY pipeline).

**Sin ambigüedades pendientes** — no hay `[NEEDS CLARIFICATION]`. Todos los
puntos marcados como `[DESIGN DECISION]` (DD-1 a DD-6) fueron resueltos por
el Architect con justificación. El orquestador los revisa en el gate
SPEC_APPROVED y puede vetar alguno antes de F2.5.

---

## 13. Exemplars verificados (paths reales)

Todos los paths fueron `Read`/`Glob` durante F2 — confirmados en disco:

| Patrón | Exemplar | Uso |
|--------|----------|-----|
| `.eq('<col>', <value>).single()` | `src/services/identity.ts:58–72` (`lookupByHash`) | estructura de `getBalance` nuevo |
| `.eq('<col>', <value>).maybeSingle()` con `as { data, error }` cast | `src/services/fee-charge.ts:180–187` | tipado estricto en query result |
| Custom Error class con `readonly code` | `src/services/fee-charge.ts:53–59` (`ProtocolFeeError`) | plantilla de `OwnershipMismatchError` |
| `console.warn` con estructura `{ op, id, ts }` | `src/services/fee-charge.ts:191, 236, 256, 333` | patrón de log |
| Test `chainMock()` helper | `src/services/budget.test.ts:25–39` y `src/services/identity.test.ts:24–39` | base para `ownership.test.ts` |
| Test assertion `toHaveBeenCalledWith(...)` con mock del chain | `src/services/budget.test.ts:99–104` | patrón de chain-assert |
| Double-cast `as unknown as ReturnType<typeof supabase.from>` (AB-024#1) | `src/services/budget.test.ts:55–57` (y múltiples lugares) | regla de tipado del mock — CD heredado AB-024 |
| `crypto.createHash('sha256').update(...).digest('hex')` | `src/services/identity.ts:27` y `src/middleware/a2a-key.ts:122` | plantilla de `hash()` en `logOwnershipMismatch` |

---

## 14. Resumen para orquestador (gate SPEC_APPROVED)

- **4 waves definidas** (W0 baseline, W1 budget, W2 identity, W3 security suite, W4 CLAUDE.md).
- **8 tests nuevos** (6 en `ownership.test.ts` + 1 en `budget.test.ts` + 1 en `identity.test.ts`).
- **6 tests modificados** (3 getBalance + 2 deactivate + 1 a2a-key middleware assertion).
- **9 archivos únicos tocados** (2 services + 1 middleware + 2 tests existentes + 1 test middleware + 2 nuevos en `security/` + CLAUDE.md).
- **6 `[DESIGN DECISION]` resueltos por Architect**: DD-1 (getBalance error semantics — throw tipado), DD-2 (deactivate 0-rows detection vía `.select('id')`), DD-3 (ubicación `security/errors.ts`), DD-4 (logging PII-safe), DD-5 (orden del chain `.eq()`), DD-6 (NO tests de debit en ownership suite).
- **7 CDs nuevos F2**: A1 (mock fidelity), A2 (error tipado), A3 (PII redaction), A4 (no tocar tests fuera de scope), A5 (firma exacta), A6 (mensaje fijo), A7 (zero regression gate).
- **Sin `[NEEDS CLARIFICATION]`**. Sin ambigüedades.
- **Estimación F3 refinada: M (2.5–3h)** — sin cambios vs work-item original.
- **Readiness Check completo** (§12): 10 pre-condiciones para el Dev.
- **Auto-Blindajes aplicados**: AB-044#2 (mock chain fidelity) + AB-024#1 (double-cast).

El SDD está listo para SPEC_APPROVED. Si el orquestador / humano veta
alguna DD, iterar y re-publicar; caso contrario, avanzar a F2.5 (Story
File) con `/nexus-p3-f2-5 WKH-53`.
