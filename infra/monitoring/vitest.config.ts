import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/* CMP-11 is Terraform, not a workspace package, so the root config does not collect it.
   Run with: npx vitest run --config infra/monitoring/vitest.config.ts */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['test/**/*.test.ts'],
  },
})
