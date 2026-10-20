import { defineConfig } from 'vitest/config'

/* CMP-6 lives outside the npm workspaces, so the root config's include globs do not reach it.
 * Run with: npx vitest run --config infra/keycloak/vitest.config.ts */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['scripts/**'],
      thresholds: { lines: 90, branches: 90 },
    },
  },
})
