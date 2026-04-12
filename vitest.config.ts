import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    env: {
      SUPABASE_URL: 'http://localhost:54321',
      SUPABASE_SERVICE_KEY: 'test-key-for-vitest',
    },
  },
})
