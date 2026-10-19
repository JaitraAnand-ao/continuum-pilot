/* keyboard-pass-recorded: fails once screens exist without a recorded manual keyboard
 * and screen-reader pass at docs/keyboard-pass.md. Passes on the bare scaffold. */
import { readdir, access } from 'node:fs/promises'

const screens = await readdir('packages/web/src').then(
  (names) => names.filter((name) => name !== 'index.ts'),
  () => [],
)
if (screens.length === 0) {
  console.log('no screens yet — nothing for a keyboard pass to cover')
  process.exit(0)
}
try {
  await access('docs/keyboard-pass.md')
  console.log('keyboard pass recorded at docs/keyboard-pass.md')
} catch {
  console.error(
    'packages/web has screens but no manual keyboard and screen-reader pass is recorded at docs/keyboard-pass.md',
  )
  process.exit(1)
}
