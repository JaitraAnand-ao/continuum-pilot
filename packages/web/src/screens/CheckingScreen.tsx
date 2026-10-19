import { copy } from '../copy'
import { StatusIcon } from './StatusIcon'

/* SCR-1 while the BFF checks group and role claims (AC-4). The announcement goes through
 * the shared polite live region, not this frame. */
export function CheckingScreen() {
  return (
    <main className="signin" aria-busy="true">
      <h1 id="page-heading" tabIndex={-1}>
        <StatusIcon tone="progress" /> {copy.checking.heading}
      </h1>
      <p>{copy.checking.detail}</p>
    </main>
  )
}
