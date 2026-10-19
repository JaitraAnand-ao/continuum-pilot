import { defineConfig } from 'drizzle-kit'

/* Generation only: migrations are committed and applied by runMigrations, never pushed. */
export default defineConfig({
  dialect: 'postgresql',
  schema: './packages/db/src/schema.ts',
  out: './packages/db/migrations',
})
