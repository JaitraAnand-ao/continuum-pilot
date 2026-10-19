/* Applies the committed migrations in ../migrations, forward-only (AD-10). Run by the
 * migrate service as the database owner, once, before the deployables start. */
import { fileURLToPath } from 'node:url'
import type { Db } from './db.js'
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator'

export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url))

export async function migrate(db: Db): Promise<void> {
  await drizzleMigrate(db, { migrationsFolder })
}
