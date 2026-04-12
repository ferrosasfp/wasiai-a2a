# Work Item — [WKH-QG-LINT] Biome Linter + Formatter

## Resumen
Instalar y configurar Biome como linter y formatter del proyecto wasiai-a2a. El proyecto tiene TypeScript strict y 272 tests pero carece de linter, lo que fue detectado por el nexus-quality-gate scan. Biome reemplaza al script `eslint` que figura en `package.json` pero nunca fue instalado.

## Sizing
- SDD_MODE: mini (FAST — sin SDD completo, sin Story File)
- Estimación: S
- Branch sugerido: feat/038-biome-linter

## Acceptance Criteria (EARS)

- AC-1: WHEN `npm run lint` is executed, the system SHALL invoke `biome check src/` and exit with code 0 when no lint errors exist.
- AC-2: WHEN `npm run format` is executed, the system SHALL invoke `biome format --write src/` and apply formatting in-place.
- AC-3: IF Biome finds lint violations in `src/`, THEN the system SHALL exit with a non-zero code and print each violation with file path and line number.

## Scope IN

| Archivo | Acción |
|---------|--------|
| `package.json` | Reemplazar script `lint` por `biome check src/`, agregar script `format`, agregar `@biomejs/biome` a `devDependencies` |
| `biome.json` | Crear config file en raíz con reglas TypeScript strict |
| `.nexus/project-context.md` | Actualizar línea `Lint: eslint` → `Lint: biome` |

## Scope OUT

- NO tocar ningún archivo en `src/` (Biome puede autofix pero eso es decisión del dev al correr `--write`)
- NO configurar pre-commit hooks (Husky, lint-staged) — fuera de scope de esta HU
- NO instalar ESLint ni ningún paquete ESLint
- NO modificar `tsconfig.json`

## Decisiones técnicas (DT-N)

- DT-1: Biome sobre ESLint — single binary, zero-config base, ~10-20x más rápido, compatible con TypeScript strict sin plugins adicionales. Confirmado por el humano como preferencia explícita.
- DT-2: `biome check src/` como comando `lint` — combina lint + format check en un solo pass, compatible con CI.
- DT-3: Biome config activará `recommended` ruleset con `javascript.formatter` y `typescript` habilitados. La regla `noExplicitAny` SHALL estar habilitada para alinear con Golden Path (TypeScript strict, sin `any`).

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO instalar `eslint` o cualquier paquete `@eslint/*` — el proyecto lo tenía como script vacío, se reemplaza limpiamente.
- CD-2: OBLIGATORIO que `npm run lint` sea ejecutable en CI sin flags adicionales.
- CD-3: OBLIGATORIO que `biome.json` declare explícitamente `"$schema"` para soporte de IDE.

## Missing Inputs

- Ninguno. Scope completamente definido.

## Notas de implementación (para el dev)

```bash
npm install --save-dev @biomejs/biome
npx @biomejs/biome init   # genera biome.json base
```

Config mínima esperada en `biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/1.x.x/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": { "noExplicitAny": "error" }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2
  },
  "files": {
    "include": ["src/**/*.ts"]
  }
}
```
