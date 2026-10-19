import { defineConfig } from 'drizzle-kit'

/* Generate only: migrations are applied by src/migrate.ts, never pushed to a live database. */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
})
