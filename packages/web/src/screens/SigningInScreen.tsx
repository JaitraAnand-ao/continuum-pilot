import { COPY } from '../copy'
import { FOCUS_IDS } from '../presentation'
import { StatusIcon } from './StatusIcon'

export function SigningInScreen() {
  return (
    <main className="frame" aria-busy="true">
      <h1 id={FOCUS_IDS.signingInHeading} tabIndex={-1}>
        <StatusIcon kind="info" />
        {COPY.signingIn.heading}
      </h1>
      <p>{COPY.signingIn.detail}</p>
      <p role="status" aria-live="polite" className="visually-hidden">
        {COPY.signingIn.announcement}
      </p>
    </main>
  )
}
