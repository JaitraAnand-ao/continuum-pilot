import { COPY } from '../copy'
import { FOCUS_IDS } from '../presentation'
import type { SignInFailure } from '../session/failure'
import { StatusIcon } from './StatusIcon'

export function SignInFailedScreen({ failure, onTryAgain }: { failure: SignInFailure; onTryAgain: () => void }) {
  return (
    <main className="frame">
      <h1 id={FOCUS_IDS.failedHeading} tabIndex={-1}>
        <StatusIcon kind="error" />
        {COPY.failed.heading}
      </h1>
      <p>
        {COPY.failed.errorCode} <code>{failure.code}</code>.
      </p>
      <p>{COPY.failed.nothingChanged}</p>
      <dl className="details">
        <dt>{COPY.failed.reference}</dt>
        <dd>
          <code className="copyable">{failure.reference}</code>
        </dd>
        <dt>{COPY.failed.time}</dt>
        <dd>
          <code className="copyable">{failure.occurredAt}</code>
        </dd>
      </dl>
      <button type="button" className="button button--primary" onClick={onTryAgain}>
        {COPY.failed.tryAgain}
      </button>
    </main>
  )
}
