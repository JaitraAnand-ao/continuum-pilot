import { defineConfig } from 'vitest/config'

/* The root vitest.config.ts collects packages/* and testing/* only; infra/keycloak holds no
   TypeScript source, so its realm and image tests run from this config:
   npx vitest run --config infra/keycloak/vitest.config.ts */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['test/**/*.test.ts'],
  },
})
