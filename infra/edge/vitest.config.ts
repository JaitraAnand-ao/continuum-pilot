import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/* The root config only collects packages/* and testing/*; infra/edge carries no
 * package.json, so its routing tests run with: npx vitest run --config infra/edge/vitest.config.ts */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['test/**/*.test.ts'],
  },
})
