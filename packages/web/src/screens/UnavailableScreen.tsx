import { copy } from '../copy'
import { StatusIcon } from './StatusIcon'

/* SCR-1 when /api/v1/me answers outside its contract or not at all. */
export function UnavailableScreen({ onTryAgain }: { onTryAgain: () => void }) {
  return (
    <main className="signin">
      <h1 id="page-heading" tabIndex={-1}>
        <StatusIcon tone="error" /> {copy.unavailable.heading}
      </h1>
      <p>{copy.unavailable.detail}</p>
      <button type="button" className="button button--primary" onClick={onTryAgain}>
        {copy.unavailable.tryAgain}
      </button>
    </main>
  )
}
