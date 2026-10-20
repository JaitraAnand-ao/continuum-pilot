import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/* infra/edge is not an npm workspace, so the root vitest include does not reach it.
 * Run with: npx vitest run --config infra/edge/vitest.config.ts */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['test/**/*.test.ts'],
  },
})
