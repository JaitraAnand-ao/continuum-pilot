import { COPY } from '../copy'
import { FOCUS_IDS } from '../presentation'
import { StatusIcon } from './StatusIcon'

export function UnavailableScreen({ onTryAgain }: { onTryAgain: () => void }) {
  return (
    <main className="frame">
      <h1 id={FOCUS_IDS.unavailableHeading} tabIndex={-1}>
        <StatusIcon kind="warning" />
        {COPY.unavailable.heading}
      </h1>
      <p>{COPY.unavailable.detail}</p>
      <button type="button" className="button button--primary" onClick={onTryAgain}>
        {COPY.unavailable.tryAgain}
      </button>
    </main>
  )
}
