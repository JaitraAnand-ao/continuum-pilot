import { defineConfig } from 'drizzle-kit'

/* Generation only: migrations are written to migrations/ and committed, never pushed. */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
})
