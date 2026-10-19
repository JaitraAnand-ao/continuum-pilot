import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      'testing/*/src/**/*.test.ts',
      'testing/*/test/**/*.test.ts',
    ],
    /* The scaffold ships before the first test; the first part's red commit removes the need for this. */
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      /* The 90% line-and-branch per-package thresholds arrive with the first tested part;
         on an empty scaffold they would fail vacuously. */
    },
  },
})
