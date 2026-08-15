import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'test/**/*.test.mjs'],
    exclude: ['dist/**', 'node_modules/**', 'packages/**'],
    // Explícito aunque hoy sea el default: si los globs de `include` dejan de
    // matchear (un rename, un exclude de más), queremos exit 1, NO un "no tests"
    // que en la salida de CI se lee igual que un éxito.
    //
    // Ojo con el vecino de esta trampa, verificado a mano: una suite entera con
    // `describe.skip` sale con código 0. O sea que "poner CI en verde" saltando la
    // suite huérfana habría apagado la alarma y encima dado sensación de cobertura.
    // vitest SÍ falla ruidosamente ante un import irresoluble (Failed Suites +
    // exit 1); eso es lo que había que arreglar de raíz, no silenciar.
    passWithNoTests: false,
    env: {
      SUPABASE_URL: 'http://localhost:54321',
      SUPABASE_SERVICE_KEY: 'test-key-for-vitest',
    },
    coverage: {
      provider: 'v8',
      // Piso de regresión, NO la medición del día. El 2026-08-15 la suite daba
      // 87.49 / 79.64 / 92.48 / 89.02, o sea entre 7.5 y 12.5 puntos por encima
      // de estos cuatro. Un piso pegado a la medición pone en rojo cada refactor.
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 80,
        lines: 80,
      },
    },
  },
})
