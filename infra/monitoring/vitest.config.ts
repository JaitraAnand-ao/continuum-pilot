import { defineConfig } from 'vitest/config'

/* The root vitest.config.ts only collects packages/* and testing/*; this config runs the
   CMP-11 plan assertions: npx vitest run --config infra/monitoring/vitest.config.ts */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['test/**/*.test.ts'],
  },
})
