import { copy } from '../copy'
import { StatusIcon } from './StatusIcon'

export interface SignInFailedScreenProps {
  code: string
  reference: string | null
  timestamp: string
  onTryAgain: () => void
}

/* "2026-10-19T14:03:07.000Z" -> "2026-10-19 14:03:07 UTC" */
export function formatUtc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`
}

/* SCR-1 when Microsoft returns an error to the callback (AC-6). */
export function SignInFailedScreen({ code, reference, timestamp, onTryAgain }: SignInFailedScreenProps) {
  return (
    <main className="signin">
      <h1 id="page-heading" tabIndex={-1}>
        <StatusIcon tone="error" /> {copy.failed.heading}
      </h1>
      <p>{copy.failed.errorCode(code)}</p>
      <p>{copy.failed.nothingChanged}</p>
      <dl className="signin__details">
        <dt>{copy.failed.reference}</dt>
        <dd>
          <code>{reference ?? copy.failed.notProvided}</code>
        </dd>
        <dt>{copy.failed.time}</dt>
        <dd>
          <time dateTime={timestamp}>{formatUtc(timestamp)}</time>
        </dd>
      </dl>
      <button type="button" className="button button--primary" onClick={onTryAgain}>
        {copy.failed.tryAgain}
      </button>
    </main>
  )
}
