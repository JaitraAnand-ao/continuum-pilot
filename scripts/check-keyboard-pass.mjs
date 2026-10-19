/* keyboard-pass-recorded: a servable UI must carry a recorded manual keyboard and
 * screen-reader pass at docs/keyboard-pass.md. Until the app has an entry point
 * (packages/web/index.html), there is nothing a person could tab through, so
 * components and tests alone do not fire the gate — the platform records the pass
 * per story at acceptance regardless, where a person does it (rule 12). */
import { access } from 'node:fs/promises'

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  )

if (!(await exists('packages/web/index.html'))) {
  console.log('no servable UI yet (packages/web/index.html absent) — nothing for a keyboard pass to cover')
  process.exit(0)
}
if (await exists('docs/keyboard-pass.md')) {
  console.log('keyboard pass recorded at docs/keyboard-pass.md')
} else {
  console.error(
    'packages/web is servable but no manual keyboard and screen-reader pass is recorded at docs/keyboard-pass.md',
  )
  process.exit(1)
}
