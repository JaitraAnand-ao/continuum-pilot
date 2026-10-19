/* migration-committed: a schema without committed generated migrations fails.
 * Passes on the bare scaffold (no schema yet); from CMP-5's first part on, every
 * schema change must arrive with its generated SQL migration. */
import { readdir } from 'node:fs/promises'

const list = (path) =>
  readdir(path).then(
    (names) => names,
    () => [],
  )

const schema = (await list('packages/db/src')).filter((name) => name.startsWith('schema'))
if (schema.length === 0) {
  console.log('no schema yet — nothing to have migrated')
  process.exit(0)
}
const migrations = (await list('packages/db/migrations')).filter((name) => name.endsWith('.sql'))
if (migrations.length === 0) {
  console.error(`packages/db/src has ${schema.join(', ')} but packages/db/migrations holds no committed .sql migration`)
  process.exit(1)
}
console.log(`${schema.length} schema file(s), ${migrations.length} committed migration(s)`)
