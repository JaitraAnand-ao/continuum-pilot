/* contracts-honoured, until the first consumer test lands: every committed contract
 * must parse and declare itself an OpenAPI document. The parts that consume each
 * interface replace this with real contract tests against the Prism mocks. */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const dir = 'contracts'
const files = (await readdir(dir)).filter((name) => name.endsWith('.json'))
if (files.length === 0) {
  console.error('contracts/ holds no contract files; the scaffold commits the build plan’s interfaces there')
  process.exit(1)
}
let failed = false
for (const name of files) {
  try {
    const document = JSON.parse(await readFile(join(dir, name), 'utf8'))
    if (typeof document.openapi !== 'string') throw new Error('no openapi version field')
    console.log(`${name}: OpenAPI ${document.openapi}, ${Object.keys(document.paths ?? {}).length} path(s)`)
  } catch (problem) {
    console.error(`${name}: ${problem instanceof Error ? problem.message : String(problem)}`)
    failed = true
  }
}
process.exit(failed ? 1 : 0)
